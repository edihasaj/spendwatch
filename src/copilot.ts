// Read only the CLI's usage ledger. Session transcripts and credentials stay local.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, platform } from "node:os";
import { projectFromCwd } from "./projects";
import type { Event } from "./parse";
import type { Usage } from "./pricing";
import type { SourceFile } from "./sources";

interface SessionRow { id: string; cwd: string | null }
interface UsageRow {
  id: number;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_nano_aiu: number | null;
  token_details_json: string | null;
  created_at: string;
}

/** Sessions whose usage rows are read together. */
const BATCH = 50;

/**
 * A store written less than this long ago may be written again within the file system's timestamp granularity, which
 * a size and a modification time cannot tell apart; it is read as often as it is asked for.
 */
const SETTLED_MS = 2_000;

/** What an idle `watch` tick needs of a store it has read: while the store is as it was, nothing in it is read again. */
interface Read {
  stamp: string;
  sinceMs: number;
  selection: string;
  sessions: SessionRow[];
  /** The version of each session's rows, once read. */
  versions: Map<string, string>;
}
const reads = new Map<string, Read>();

/**
 * The size and modification time of the store and its write-ahead log, or undefined when they cannot vouch that the
 * store is unchanged: it was written a moment ago, or a write is in progress (a rollback journal exists).
 */
function stampOf(path: string): string | undefined {
  const parts: string[] = [];
  for (const file of [path, `${path}-wal`]) {
    try {
      const stat = statSync(file);
      if (Date.now() - stat.mtimeMs < SETTLED_MS) return undefined;
      parts.push(`${stat.size}:${stat.mtimeMs}`);
    } catch { parts.push("-"); }
  }
  return existsSync(`${path}-journal`) ? undefined : parts.join("|");
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function defaultCopilotRoots(): string[] {
  const home = homedir();
  const appData = platform() === "win32" ? process.env.APPDATA ?? join(home, "AppData/Roaming")
    : platform() === "darwin" ? join(home, "Library/Application Support") : join(home, ".config");
  return [join(home, ".copilot"), ...["Code", "Code - Insiders", "Cursor"].map((app) =>
    join(appData, app, "User/globalStorage/github.copilot-chat/session-store.db"))];
}

export function copilotUsage(row: UsageRow): Usage {
  let details: Array<{ tokenType?: string; tokenCount?: number }> = [];
  try { details = JSON.parse(row.token_details_json ?? "[]"); } catch {}
  if (!Array.isArray(details)) details = [];
  const tokens = (kind: string): number | undefined => {
    const matching = details.filter((detail) => detail && typeof detail === "object" && detail.tokenType === kind);
    return matching.length ? matching.reduce((sum, detail) => sum + count(detail.tokenCount), 0) : undefined;
  };
  const cacheRead = tokens("cache_read") ?? count(row.cache_read_tokens);
  const cacheWrite = tokens("cache_write") ?? count(row.cache_write_tokens);
  return {
    input: tokens("input") ?? Math.max(0, count(row.input_tokens) - cacheRead - cacheWrite),
    output: tokens("output") ?? count(row.output_tokens),
    cacheRead, cache5m: cacheWrite, cache1h: 0,
  };
}

// Shared with the gateway ledger, whose Copilot rows belong to the same account.
export function accountLabel(): string {
  if (process.env.SPENDWATCH_COPILOT_ACCOUNT) return process.env.SPENDWATCH_COPILOT_ACCOUNT;
  try {
    const text = readFileSync(join(homedir(), ".config/gh/hosts.yml"), "utf8");
    return text.match(/^\s+user:\s*([A-Za-z0-9-]+)\s*$/m)?.[1] ?? "default";
  } catch { return "default"; }
}

/**
 * The Copilot login under one `COPILOT_HOME`, which a gateway provider names as its `authDirectory`: the CLI
 * records it as `lastLoggedInUser.login` in that directory's `config.json`. A directory with no login is named by
 * the directory itself, never mistaken for the default account, whose turns are billed elsewhere.
 */
export function copilotAccountIn(directory: string): string {
  try {
    // The CLI heads its config with `//` comment lines, which JSON does not allow.
    const text = readFileSync(join(directory, "config.json"), "utf8")
      .split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    const login: unknown = JSON.parse(text)?.lastLoggedInUser?.login;
    if (typeof login === "string" && login.trim()) return login.trim();
  } catch {}
  return basename(directory) || "default";
}

function timestamp(raw: string): number {
  const value = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  return Date.parse(value);
}

export function collectCopilot(root: string, sinceMs: number, account?: string): SourceFile[] {
  const path = root.endsWith(".db") ? root : join(root, "session-store.db");
  if (!existsSync(path)) return [];
  const stamp = stampOf(path);
  const before = reads.get(path);
  // A store as it was at the last discovery has the same sessions and the same rows, so a tick that finds it so reads nothing.
  const same = before && before.stamp === stamp && before.sinceMs === sinceMs ? before : undefined;
  let db: Database | undefined;
  try {
    let read = same;
    if (!read) {
      db = new Database(path, { readonly: true, create: false });
      const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(assistant_usage_events)").all().map((row) => row.name));
      if (!["id", "session_id", "model", "created_at"].every((column) => columns.has(column))) return [];
      const optional = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_nano_aiu", "token_details_json"];
      const found = db.query<SessionRow, [string]>(`
        SELECT s.id, s.cwd FROM sessions s WHERE EXISTS (
          SELECT 1 FROM assistant_usage_events u WHERE u.session_id=s.id
          AND julianday(u.created_at) >= julianday(?)
        ) ORDER BY s.id
      `).all(new Date(sinceMs).toISOString());
      read = { stamp: stamp ?? "", sinceMs, selection: optional.map((column) => columns.has(column) ? column : `NULL AS ${column}`).join(", "), sessions: found, versions: new Map() };
      if (stamp !== undefined) reads.set(path, read);
    }
    const { selection, sessions, versions } = read;
    const stored = read;
    // Every read opens the store afresh: the CLI keeps writing to it while Spendwatch watches. The table has no index
    // on the session, so each read scans all of it: a session's rows are read together with those of the next
    // `BATCH - 1` sessions, once per discovery, and each file takes its own when it is polled.
    const readRows = (sessionIds: string[]): Map<string, UsageRow[]> => {
      const reader = new Database(path, { readonly: true, create: false });
      try {
        const bySession = new Map<string, UsageRow[]>(sessionIds.map((id) => [id, []]));
        const rows = reader.query<UsageRow & { session_id: string }, string[]>(`
          SELECT session_id, id, model, ${selection}, created_at
          FROM assistant_usage_events WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY id
        `).all(...sessionIds);
        for (const { session_id, ...row } of rows) bySession.get(String(session_id))?.push(row);
        return bySession;
      } finally { reader.close(); }
    };
    const ids = sessions.map((session) => session.id);
    const loaded = new Set<number>();
    const waiting = new Map<string, UsageRow[]>();
    const usageOf = (index: number): UsageRow[] => {
      const first = index - (index % BATCH);
      if (!loaded.has(first)) {
        for (const [id, rows] of readRows(ids.slice(first, first + BATCH))) waiting.set(id, rows);
        // Only a batch that was read is loaded: after a failed read the next session tries the batch again, rather than
        // scanning the whole table for itself alone.
        loaded.add(first);
      }
      const rows = waiting.get(ids[index]!);
      waiting.delete(ids[index]!);
      // A file polled again in the same discovery has taken its rows already: read them afresh, they may have changed.
      return rows ?? readRows([ids[index]!]).get(ids[index]!)!;
    };
    return sessions.map((session, index): SourceFile => {
      const project = session.cwd ? projectFromCwd(session.cwd) : "?";
      function* lazyEvents(id: string): Generator<Event> {
        yield* eventsOf(readRows([id]).get(id)!);
      }
      function* eventsOf(rows: UsageRow[]): Generator<Event> {
        yield { t: "meta", sessionId: session.id, project, ts: 0 };
        for (const row of rows) {
          const ts = timestamp(row.created_at);
          if (!Number.isFinite(ts)) continue;
          const nano = row.total_nano_aiu;
          yield { t: "api", sessionId: session.id, requestId: String(row.id), model: row.model,
            usage: copilotUsage(row), costUsd: nano !== null && Number.isFinite(nano) && nano >= 0 ? nano / 100_000_000_000 : undefined,
            sidechain: false, ts };
        }
      }
      return {
        path, key: `copilot-session:${session.id}`, project, source: "copilot", account: account ?? accountLabel(),
        parse: () => [], ctx: null,
        // One read of the session gives its events and what they depend on, so a `watch` tick that finds the session
        // unchanged folds nothing and draws nothing. A finalized charge updates a row in place, so the whole row
        // counts, not only how many there are. A store that cannot be read now is skipped until the next tick.
        snapshot: () => {
          // A store unchanged since the version was taken has the same rows: they are read only if a reader that has
          // not folded this version asks for the events. A store written since, or a moment ago, is read again.
          const current = stampOf(path);
          const unchanged = current === stored.stamp;
          const known = unchanged ? versions.get(session.id) : undefined;
          if (known !== undefined) return { version: known, events: lazyEvents(session.id) };
          let rows: UsageRow[];
          try { rows = usageOf(index); } catch { return undefined; }
          const version = `${Bun.hash(JSON.stringify(rows))}`;
          if (unchanged) versions.set(session.id, version);
          return { version, events: eventsOf(rows) };
        },
      };
    });
  } catch { return []; } finally { db?.close(); }
}

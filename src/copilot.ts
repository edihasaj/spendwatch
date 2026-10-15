// Read only the CLI's usage ledger. Session transcripts and credentials stay local.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
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
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(assistant_usage_events)").all().map((row) => row.name));
    if (!["id", "session_id", "model", "created_at"].every((column) => columns.has(column))) return [];
    const optional = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_nano_aiu", "token_details_json"];
    const selection = optional.map((column) => columns.has(column) ? column : `NULL AS ${column}`).join(", ");
    const sessions = db.query<SessionRow, [string]>(`
      SELECT s.id, s.cwd FROM sessions s WHERE EXISTS (
        SELECT 1 FROM assistant_usage_events u WHERE u.session_id=s.id
        AND julianday(u.created_at) >= julianday(?)
      ) ORDER BY s.id
    `).all(new Date(sinceMs).toISOString());
    // Every read of a session's usage opens the store afresh: the CLI keeps writing to it while Spendwatch watches.
    const usageOf = (sessionId: string): UsageRow[] => {
      const reader = new Database(path, { readonly: true, create: false });
      try {
        return reader.query<UsageRow, [string]>(`
          SELECT id, model, ${selection}, created_at
          FROM assistant_usage_events WHERE session_id=? ORDER BY id
        `).all(sessionId);
      } finally { reader.close(); }
    };
    return sessions.map((session): SourceFile => {
      const seen = new Map<number, string>();
      const project = session.cwd ? projectFromCwd(session.cwd) : "?";
      let unreadable = 0;
      return {
        path, key: `copilot-session:${session.id}`, project, source: "copilot", account: account ?? accountLabel(),
        parse: () => [], ctx: null,
        // What the session's events depend on, so a `watch` tick that finds the session unchanged folds nothing and
        // draws nothing. A finalized charge updates a row in place, so the whole row counts, not only how many there are.
        version: () => {
          try { return `${Bun.hash(JSON.stringify(usageOf(session.id)))}`; } catch { return `unreadable:${unreadable++}`; }
        },
        events: function* (): Generator<Event> {
          const rows = usageOf(session.id);
          yield { t: "meta", sessionId: session.id, project, ts: 0 };
          for (const row of rows) {
            const signature = JSON.stringify(row);
            if (seen.get(row.id) === signature) continue;
            const ts = timestamp(row.created_at);
            if (!Number.isFinite(ts)) continue;
            const nano = row.total_nano_aiu;
            yield { t: "api", sessionId: session.id, requestId: String(row.id), model: row.model,
              usage: copilotUsage(row), costUsd: nano !== null && Number.isFinite(nano) && nano >= 0 ? nano / 100_000_000_000 : undefined,
              sidechain: false, ts };
            seen.set(row.id, signature);
          }
        },
      };
    });
  } catch { return []; } finally { db?.close(); }
}

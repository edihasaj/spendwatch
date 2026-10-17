// Reads Mission Runtime's own usage records, in its authority SQLite store and in read-only mode. Only the rows
// `mission_run_outputs` keeps under `usage:*` are read, plus each run's repository key and start time: no prompt,
// transcript or spec text enters this process.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { asUsageRecord, entryAccount, inProject, projectName, usageEvents, type EntryEvents } from "./agent-usage";
import type { Event } from "./parse";
import type { SourceFile } from "./sources";

interface UsageRow { run_id: string; output_key: string; output_json: string; updated_at: string }
/** What a run says about itself: its project, and when it started (undefined when the store does not say). */
interface RunInfo { project: string; startedMs?: number }

const expand = (path: string): string => path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

export function defaultMissionRoots(): string[] {
  const env = process.env.MISSION_RUNTIME_DB_PATH;
  return [env ? expand(env) : join(homedir(), "Projects", "mission-runtime", ".mission-runtime", "authority.sqlite")];
}

/** A store timestamp: ISO, or SQLite's own `YYYY-MM-DD HH:MM:SS` (UTC). */
function timeOf(raw: unknown): number {
  if (typeof raw !== "string") return NaN;
  return Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
}

/**
 * Opens the store read-only. Mission Runtime runs SQLite in WAL mode and removes the `-wal` and `-shm` files when it
 * closes cleanly; a read-only connection cannot create them, so on a store with no `-wal` the open is retried as
 * immutable, which needs neither and writes nothing. A store whose `-wal` exists but cannot be opened is in use or
 * damaged, and throws.
 */
function openStore(path: string): Database {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (error) {
    db?.close();
    if (existsSync(`${path}-wal`)) throw error;
  }
  db = new Database(`${pathToFileURL(path).href}?immutable=1`, { readonly: true, create: false });
  try { db.query("SELECT 1 FROM sqlite_master LIMIT 1").get(); return db; } catch (error) { db.close(); throw error; }
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

/**
 * The project and start time of each run, read one run at a time: only the repository key is taken out of the spec
 * (`json_extract`), never the spec itself. A run, table or column that is missing, or a spec that is not JSON, leaves
 * the project "?" and the start unknown.
 */
function runInfo(db: Database): (runId: string) => RunInfo {
  const columns = columnsOf(db, "mission_runs");
  const has = columns.has("run_id");
  const repo = has && columns.has("spec_json")
    ? db.query<{ repo: unknown }, [string]>("SELECT json_extract(spec_json, '$.executor.repository_key') AS repo FROM mission_runs WHERE run_id=?") : undefined;
  const started = has && columns.has("created_at")
    ? db.query<{ created_at: unknown }, [string]>("SELECT created_at FROM mission_runs WHERE run_id=?") : undefined;
  const known = new Map<string, RunInfo>();
  return (runId) => {
    let info = known.get(runId);
    if (!info) {
      info = { project: "?" };
      try { info.project = projectName(repo?.get(runId)?.repo); } catch {}
      try {
        const ms = timeOf(started?.get(runId)?.created_at);
        if (Number.isFinite(ms)) info.startedMs = ms;
      } catch {}
      known.set(runId, info);
    }
    return info;
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * A record is cumulative for its attempt and rewritten on every turn, so it is dated where the attempt began: the
 * run's start, else the row's last update. Dated at its last update it would move to a new month when an attempt runs
 * past the 1st, and a history that keeps the old month would count it twice.
 */
function datedAt(row: UsageRow, info: RunInfo): number {
  return info.startedMs ?? timeOf(row.updated_at);
}

function eventsOf(row: UsageRow, info: RunInfo, entryId: string): { version: string; events: Event[] } | undefined {
  const ts = datedAt(row, info);
  if (!Number.isFinite(ts) || !Number.isFinite(timeOf(row.updated_at))) return undefined;
  const found = usageEvents(safeJson(row.output_json), { ts, project: info.project }).find((entry) => entry.id === entryId);
  return found ? { version: `${Bun.hash(row.updated_at + row.output_json + found.index)}`, events: found.events } : undefined;
}

/** One usage row and its run, read afresh: Mission Runtime rewrites the row on every turn while Spendwatch watches. */
function readRow(path: string, runId: string, outputKey: string): { row: UsageRow; info: RunInfo } | undefined {
  let db: Database | undefined;
  try {
    db = openStore(path);
    const row = db.query<UsageRow, [string, string]>(
      "SELECT run_id, output_key, output_json, updated_at FROM mission_run_outputs WHERE run_id=? AND output_key=?",
    ).get(runId, outputKey);
    return row ? { row, info: runInfo(db)(runId) } : undefined;
  } catch { return undefined; } finally { db?.close(); }
}

export interface MissionRead {
  files: SourceFile[];
  /** The store exists but could not be opened or queried (as opposed to being absent or of another shape). */
  unreadable: boolean;
}

/** A Mission Runtime store is a file; one that is missing or of another shape reports nothing, and none throws. */
export function readMission(path: string, sinceMs: number, account?: string, project?: string): MissionRead {
  if (!existsSync(path)) return { files: [], unreadable: false };
  let db: Database | undefined;
  try {
    db = openStore(path);
    const columns = columnsOf(db, "mission_run_outputs");
    if (!["run_id", "output_key", "output_json", "updated_at"].every((column) => columns.has(column))) return { files: [], unreadable: false };
    const info = runInfo(db);
    const rows = db.query<UsageRow, [string]>(`
      SELECT run_id, output_key, output_json, updated_at FROM mission_run_outputs
      WHERE output_key LIKE 'usage:%' AND julianday(updated_at) >= julianday(?) ORDER BY run_id, output_key
    `).all(new Date(sinceMs).toISOString());
    const files: SourceFile[] = [];
    for (const row of rows) {
      const record = asUsageRecord(safeJson(String(row.output_json)));
      const run = info(row.run_id);
      const ts = datedAt(row, run);
      if (!record || !Number.isFinite(ts) || !Number.isFinite(timeOf(row.updated_at)) || !inProject(run.project, project)) continue;
      for (const found of usageEvents(record, { ts, project: run.project })) files.push(fileOf(path, row, record.attempt_id, found, run.project, account));
    }
    return { files, unreadable: false };
  } catch { return { files: [], unreadable: true }; } finally { db?.close(); }
}

export function collectMission(path: string, sinceMs: number, account?: string, project?: string): SourceFile[] {
  return readMission(path, sinceMs, account, project).files;
}

function fileOf(path: string, row: UsageRow, attempt: string, found: EntryEvents, project: string, account?: string): SourceFile {
  return {
    path, key: `mission:${row.run_id}:${attempt}:${found.id}`, project, source: "mission",
    account: entryAccount(found.entry, account), parse: () => [], ctx: null,
    // The attempt's row holds its totals so far and is rewritten on every turn, so a read gives the entry as it is now
    // and replaces the last one. A store that cannot be read now is skipped until the next tick.
    snapshot: () => {
      const current = readRow(path, row.run_id, row.output_key);
      return current ? eventsOf(current.row, current.info, found.id) : undefined;
    },
  };
}

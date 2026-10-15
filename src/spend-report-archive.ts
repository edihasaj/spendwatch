import { Database } from "bun:sqlite";
import type { Report } from "./aggregate";
import { settleAcrossMacs } from "./gateway-settle";
import { mergeReports } from "./reports";

export function initReportArchive(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spend_installation (
      source TEXT NOT NULL, installation_id TEXT NOT NULL,
      archive_source TEXT NOT NULL UNIQUE,
      PRIMARY KEY (source, installation_id)
    );
    CREATE TABLE IF NOT EXISTS spend_report (
      month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL,
      observed_calls INTEGER,
      report_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (month, source)
    );
    CREATE TABLE IF NOT EXISTS spend_token_day (
      day TEXT NOT NULL, source TEXT NOT NULL, time_zone TEXT NOT NULL,
      model TEXT NOT NULL, tokens INTEGER NOT NULL, measured_at INTEGER NOT NULL,
      PRIMARY KEY(day,source,time_zone,model)
    );
    CREATE TABLE IF NOT EXISTS spend_token_capture (
      source TEXT NOT NULL, time_zone TEXT NOT NULL, month TEXT NOT NULL,
      measured_at INTEGER NOT NULL, PRIMARY KEY(source,time_zone,month)
    );
  `);
  addArchiveColumns(db, "spend_report");
}

/**
 * Archives predate these columns; ALTER is the only way to add them without a rebuild.
 * - `observed_calls`: the calls the agent itself counted; see `fullerRead`.
 * - `ledger`: whether this Mac's gateway ledger was read for the month (NULL on older rows: it was not).
 * - `routed_calls`: the gateway-routed calls that read billed through the ledger (NULL on older rows: none).
 */
export function addArchiveColumns(db: Database, table: string): void {
  for (const column of ["observed_calls", "ledger", "routed_calls"]) {
    const named = db.query<{ name: string }, [string, string]>(
      "SELECT name FROM pragma_table_info(?) WHERE name = ?",
    ).get(table, column);
    if (!named) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
  }
}

/**
 * When an incoming read may replace the stored one. The fullest read wins, by the calls the agent observed, so
 * a read of rotated transcripts never shrinks a month. And a read may not bill fewer routed calls through the
 * gateway ledger than the stored one did: those calls were taken out of Codex and billed to Claude or Copilot
 * there, and a read that routed fewer (the source switched off, a pruned ledger month, a rollout that vouched for
 * a row gone) counts them in Codex again while the other source's stored row keeps them.
 */
export const fullerRead = (table: string) =>
  `excluded.observed_calls >= COALESCE(${table}.observed_calls, ${table}.calls)` +
  ` AND COALESCE(excluded.routed_calls, 0) >= COALESCE(${table}.routed_calls, 0)`;

/**
 * The archive source an installation's reports of `source` are stored under, without recording anything: undefined
 * for an installation the archive has not seen, which has nothing stored yet. Mirrors `archiveSource`.
 */
export function storedArchiveSource(db: Database, source: string, installationId?: string): string | undefined {
  const existing = db.query<{ installation_id: string; archive_source: string }, [string]>(
    "SELECT installation_id, archive_source FROM spend_installation WHERE source = ? ORDER BY rowid",
  ).all(source);
  if (!existing.length) return source;
  if (!installationId) return existing[0]!.archive_source;
  const match = existing.find((row) => row.installation_id === installationId);
  if (match) return match.archive_source;
  return existing.length === 1 && existing[0]!.installation_id === "legacy" ? existing[0]!.archive_source : undefined;
}

/** Bind old unlabeled measurements to the first installation, without copying totals. */
export function archiveSource(db: Database, report: Report): string {
  const existing = db.query<{ installation_id: string; archive_source: string }, [string]>(
    "SELECT installation_id, archive_source FROM spend_installation WHERE source = ? ORDER BY rowid",
  ).all(report.source);
  const id = report.installationId;
  if (!id && existing.length) return existing[0]!.archive_source;
  const match = existing.find((row) => row.installation_id === id);
  if (match) return match.archive_source;
  if (id && existing.length === 1 && existing[0]!.installation_id === "legacy") {
    db.prepare("UPDATE spend_installation SET installation_id = ? WHERE source = ? AND installation_id = 'legacy'")
      .run(id, report.source);
    return existing[0]!.archive_source;
  }
  const split = report.source.lastIndexOf(":");
  const suffix = ` (installation ${existing.length + 1})`;
  const storageSource = !existing.length ? report.source : split > 0
    ? report.source.slice(0, split) + suffix + report.source.slice(split)
    : report.source + suffix;
  db.prepare("INSERT INTO spend_installation VALUES (?,?,?)").run(report.source, id ?? "legacy", storageSource);
  return storageSource;
}

/**
 * What happened to a report offered to the archive.
 * - "accepted": this read replaced the stored one.
 * - "fewer": the stored read saw more calls, so this one is a partial re-read of the same kind of month.
 * - "placement": the stored read billed more routed calls through the gateway ledger, so the two reads count
 *   some routed turns in different sources and their figures must never be blended.
 */
export type ArchiveOutcome = "accepted" | "fewer" | "placement";

/** `force` writes the report whatever is stored: the caller has already decided for the month's sources together. */
export function archiveReport(db: Database, report: Report, source: string, generatedAt: number, force = false): ArchiveOutcome {
  const result = db.prepare(`
    INSERT INTO spend_report(month, source, calls, observed_calls, ledger, routed_calls, report_json, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(month, source) DO UPDATE SET
      calls = excluded.calls, observed_calls = excluded.observed_calls, ledger = excluded.ledger,
      routed_calls = excluded.routed_calls, report_json = excluded.report_json, updated_at = excluded.updated_at
    WHERE ${force ? "1" : fullerRead("spend_report")}
  `).run(report.period!.key, source, report.apiCalls, report.observedCalls ?? report.apiCalls, report.ledger ? 1 : 0,
    report.routedCalls ?? 0, JSON.stringify(report), generatedAt);
  if (result.changes > 0) return "accepted";
  const stored = db.query<{ routed: number }, [string, string]>(
    "SELECT COALESCE(routed_calls, 0) AS routed FROM spend_report WHERE month = ? AND source = ?",
  ).get(report.period!.key, source);
  return (report.routedCalls ?? 0) < (stored?.routed ?? 0) ? "placement" : "fewer";
}

/**
 * Restore the fullest reports for every installation, merged under the original machine. Each was archived as its
 * Mac read it; read back together, a Codex call another Mac's gateway billed is taken out of the client's report.
 */
export function loadArchivedReports(path: string): Report[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const groups = new Map<string, Report[]>();
    const archived = db.query<{ report_json: string }, []>("SELECT report_json FROM spend_report ORDER BY month, source").all()
      .map((row) => JSON.parse(row.report_json) as Report);
    for (const report of settleAcrossMacs(archived)) {
      const key = JSON.stringify([report.period!.key, report.source]);
      const group = groups.get(key) ?? [];
      group.push(report);
      groups.set(key, group);
    }
    return [...groups.values()].map((reports) => reports.length === 1
      ? reports[0]!
      : mergeReports(reports, reports[0]!.source, "service", true));
  } finally {
    db.close();
  }
}

export function archivedSourceLabels(db: Database): Map<string, string> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'spend_installation'").get()) return new Map();
  return new Map(db.query<{ source: string; archive_source: string }, []>(
    "SELECT source, archive_source FROM spend_installation",
  ).all().map((row) => [row.archive_source, row.source]));
}

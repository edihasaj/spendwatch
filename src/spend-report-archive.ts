import { Database } from "bun:sqlite";
import type { Report } from "./aggregate";
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

export function archiveReport(db: Database, report: Report, source: string, generatedAt: number): void {
  db.prepare(`
    INSERT INTO spend_report VALUES (?,?,?,?,?)
    ON CONFLICT(month, source) DO UPDATE SET
      calls = excluded.calls, report_json = excluded.report_json, updated_at = excluded.updated_at
    WHERE excluded.calls >= spend_report.calls
  `).run(report.period!.key, source, report.apiCalls, JSON.stringify(report), generatedAt);
}

/** Restore the fullest reports for every installation, merged under the original machine. */
export function loadArchivedReports(path: string): Report[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const groups = new Map<string, Report[]>();
    for (const row of db.query<{ report_json: string }, []>("SELECT report_json FROM spend_report ORDER BY month, source").all()) {
      const report = JSON.parse(row.report_json) as Report;
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

// Per-calendar-month spend, persisted so the history dashboard can show closed
// months after the transcripts behind them have rotated away.
import { Database } from "./database";
import type { Report } from "./aggregate";
import { monthLabel } from "./periods";
import { planLedgerMonths } from "./archive-ledger";
import { archivedCoverage, byMonthSource, callTotals, settledDifference } from "./gateway-settle";
import { addArchiveColumns, archivedSourceLabels, archiveReport, archiveSource, fullerRead, initReportArchive } from "./spend-report-archive";
import {archiveTokenDays} from "./token-days";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_month (
  month TEXT NOT NULL,
  source TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  calls INTEGER NOT NULL,
  observed_calls INTEGER,
  ledger INTEGER,
  routed_calls INTEGER,
  sessions INTEGER NOT NULL,
  first_ts INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month, source)
);
CREATE INDEX IF NOT EXISTS idx_spend_month ON spend_month(month);
CREATE TABLE IF NOT EXISTS spend_month_project (
  month TEXT NOT NULL,
  source TEXT NOT NULL,
  project TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month, source, project)
);
CREATE INDEX IF NOT EXISTS idx_spend_month_project ON spend_month_project(month);
`;

/** Projects kept per month and source. Enough to show where the month went. */
const PROJECTS_PER_SOURCE = 20;

export interface MonthlySpendSource {
  source: string;
  tokens: number;
  cost: number;
  calls: number;
  sessions: number;
}

export interface MonthlySpendProject {
  project: string;
  tokens: number;
  cost: number;
}

export interface MonthlySpend {
  month: string;
  label: string;
  tokens: number;
  cost: number;
  calls: number;
  sessions: number;
  firstTs?: number;
  updatedAt: number;
  sources: MonthlySpendSource[];
  projects: MonthlySpendProject[];
}

/**
 * Records one row per (month, source). Two guards keep a closed month from
 * decaying: a source that reported nothing is skipped entirely, and a row is
 * only rewritten when the incoming run saw at least as many calls as the one
 * already stored. Session files rotate away, so re-reading July next year finds
 * less of it than today — the archive should keep the fullest measurement it
 * ever made, while still accepting a genuine correction upward. A read that billed fewer
 * routed calls through the gateway ledger never replaces one that billed more (see
 * `fullerRead`), and the month the ledger takes over moves its sources together (see
 * `planLedgerMonths`).
 */
export function writeMonthlySpend(
  path: string,
  reports: Report[],
  opts: { generatedAt: number },
): { months: string[]; rows: number } {
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    initReportArchive(db);
    addArchiveColumns(db, "spend_month");
    const upsert = (force: boolean) => db.prepare(`
      INSERT INTO spend_month(month, source, tokens, cost, calls, observed_calls, ledger, routed_calls, sessions, first_ts, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(month, source) DO UPDATE SET
        tokens = excluded.tokens, cost = excluded.cost, calls = excluded.calls,
        observed_calls = excluded.observed_calls, ledger = excluded.ledger, routed_calls = excluded.routed_calls,
        sessions = excluded.sessions, first_ts = excluded.first_ts, updated_at = excluded.updated_at
      WHERE ${force ? "1" : fullerRead("spend_month")}
    `);
    // A source rewrites its own project rows wholesale, so a project that went
    // quiet disappears from the month instead of lingering at a stale total.
    const clearProjects = db.prepare("DELETE FROM spend_month_project WHERE month = ? AND source = ?");
    const insertProject = db.prepare(`
      INSERT INTO spend_month_project(month, source, project, tokens, cost, updated_at)
      VALUES (?,?,?,?,?,?)
    `);
    const months = new Set<string>();
    let rows = 0;
    const tx = db.transaction(() => {
      // Decided before anything is written: the sources of a month the ledger takes over move together.
      const together = planLedgerMonths(db, reports);
      for (const report of reports) {
        // A month whose every call was routed to the gateway bills nothing here but still observed calls:
        // it has to replace a stale row that counted those turns, so observed calls decide, not billed ones.
        if (!report.period?.month || (report.observedCalls ?? report.apiCalls) <= 0) continue;
        const verdict = together.get(report);
        // Left out with its month's other sources: nothing of it is written, its days included.
        if (verdict === "reject") continue;
        const force = verdict === "accept";
        const source = archiveSource(db, report);
        // The full report decides first: its acceptance says whether this run
        // really saw the whole month, which picks the daily detail's mode.
        const outcome = archiveReport(db, report, source, opts.generatedAt, force);
        // Days from reads that bill routed turns in different sources must not be maxed into each other, or
        // those turns would count twice; such a read leaves the days alone.
        if (outcome !== "placement") archiveTokenDays(db, report, source, outcome === "accepted" ? "replace" : "merge");
        const result = upsert(force).run(
          report.period.key,
          source,
          Math.round(report.totalTokens),
          report.totalCost,
          report.apiCalls,
          report.observedCalls ?? report.apiCalls,
          report.ledger ? 1 : 0,
          report.routedCalls ?? 0,
          report.sessions,
          report.sinceTs || null,
          opts.generatedAt,
        );
        // A rejected month row means the archive already holds a fuller read of
        // it, so its projects are the fuller ones too — leave them alone.
        if (!result.changes) continue;
        months.add(report.period.key);
        rows++;
        clearProjects.run(report.period.key, source);
        for (const project of report.projects.slice(0, PROJECTS_PER_SOURCE)) {
          if (project.tokens <= 0) continue;
          insertProject.run(
            report.period.key,
            source,
            project.project,
            Math.round(project.tokens),
            project.cost,
            opts.generatedAt,
          );
          rows++;
        }
      }
    });
    tx();
    return { months: [...months].sort(), rows };
  } finally {
    db.close();
  }
}

interface Row {
  month: string;
  source: string;
  tokens: number;
  cost: number;
  calls: number;
  sessions: number;
  firstTs: number | null;
  updatedAt: number;
}

/**
 * Every recorded month, newest first, with its per-source and per-project breakdown. A Codex call another Mac's
 * gateway billed is taken out of the client's rows here, as `loadArchivedReports` takes it out of its report.
 */
export function loadMonthlySpend(path: string, limit = 120, projectsPerMonth = 12): MonthlySpend[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const exists = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='spend_month'")
      .get();
    if (!exists) return [];
    const sourceLabels = archivedSourceLabels(db);
    const rows = db
      .query<Row, []>(`
        SELECT month, source, tokens, cost, calls, sessions, first_ts AS firstTs, updated_at AS updatedAt
        FROM spend_month ORDER BY month DESC, tokens DESC
      `)
      .all();
    const coverage = archivedCoverage(db);
    for (const row of rows) {
      const calls = byMonthSource(coverage, row.month, row.source);
      if (!calls.length) continue;
      const covered = callTotals(calls);
      // Never below zero: the calls were part of this read, so a smaller row is not the read they came from.
      row.tokens = Math.max(0, row.tokens - covered.tokens);
      row.cost = Math.max(0, settledDifference(row.cost, covered.cost));
      row.calls = Math.max(0, row.calls - covered.calls);
    }
    if (coverage.size) rows.sort((a, b) => b.month.localeCompare(a.month) || b.tokens - a.tokens);
    const projectRows = monthProjects(db, coverage);
    const months = new Map<string, MonthlySpend>();
    for (const row of rows) {
      let month = months.get(row.month);
      if (!month) {
        if (months.size >= limit) continue;
        month = {
          month: row.month,
          label: monthLabel(row.month),
          tokens: 0,
          cost: 0,
          calls: 0,
          sessions: 0,
          updatedAt: 0,
          sources: [],
          projects: [],
        };
        months.set(row.month, month);
      }
      month.tokens += row.tokens;
      month.cost += row.cost;
      month.calls += row.calls;
      month.sessions += row.sessions;
      month.updatedAt = Math.max(month.updatedAt, row.updatedAt);
      if (row.firstTs) month.firstTs = Math.min(month.firstTs ?? row.firstTs, row.firstTs);
      const source = sourceLabels.get(row.source) ?? row.source;
      const existingSource = month.sources.find((item) => item.source === source);
      if (existingSource) {
        existingSource.tokens += row.tokens;
        existingSource.cost += row.cost;
        existingSource.calls += row.calls;
        existingSource.sessions += row.sessions;
      } else month.sources.push({
        source,
        tokens: row.tokens,
        cost: row.cost,
        calls: row.calls,
        sessions: row.sessions,
      });
    }
    for (const row of projectRows) {
      const month = months.get(row.month);
      if (!month || month.projects.length >= projectsPerMonth) continue;
      month.projects.push({ project: row.project, tokens: row.tokens, cost: row.cost });
    }
    return [...months.values()];
  } finally {
    db.close();
  }
}

/** Project totals per month across sources, largest first, less the calls another Mac's gateway billed. */
function monthProjects(db: Database, coverage: ReturnType<typeof archivedCoverage>): Array<{ month: string; project: string; tokens: number; cost: number }> {
  const totals = new Map<string, { month: string; project: string; tokens: number; cost: number }>();
  const rows = db.query<{ month: string; source: string; project: string; tokens: number; cost: number }, []>(
    "SELECT month, source, project, tokens, cost FROM spend_month_project",
  ).all();
  for (const row of rows) {
    const calls = byMonthSource(coverage, row.month, row.source).filter((call) => call.project.toLowerCase() === row.project.toLowerCase());
    const covered = callTotals(calls);
    const key = JSON.stringify([row.month, row.project]);
    const total = totals.get(key) ?? { month: row.month, project: row.project, tokens: 0, cost: 0 };
    total.tokens += calls.length ? Math.max(0, row.tokens - covered.tokens) : row.tokens;
    total.cost += calls.length ? Math.max(0, settledDifference(row.cost, covered.cost)) : row.cost;
    totals.set(key, total);
  }
  return [...totals.values()]
    .filter((row) => row.tokens > 0 || row.cost > 0)
    .sort((a, b) => b.month.localeCompare(a.month) || b.tokens - a.tokens);
}

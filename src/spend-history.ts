// Per-calendar-month spend, persisted so the history dashboard can show closed
// months after the transcripts behind them have rotated away.
import { Database } from "bun:sqlite";
import type { Report } from "./aggregate";
import { monthLabel } from "./periods";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_month (
  month TEXT NOT NULL,
  source TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  calls INTEGER NOT NULL,
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
 * ever made, while still accepting a genuine correction upward.
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
    const upsert = db.prepare(`
      INSERT INTO spend_month(month, source, tokens, cost, calls, sessions, first_ts, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(month, source) DO UPDATE SET
        tokens = excluded.tokens, cost = excluded.cost, calls = excluded.calls,
        sessions = excluded.sessions, first_ts = excluded.first_ts, updated_at = excluded.updated_at
      WHERE excluded.calls >= spend_month.calls
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
      for (const report of reports) {
        if (!report.period?.month || report.apiCalls <= 0) continue;
        const result = upsert.run(
          report.period.key,
          report.source,
          Math.round(report.totalTokens),
          report.totalCost,
          report.apiCalls,
          report.sessions,
          report.sinceTs || null,
          opts.generatedAt,
        );
        // A rejected month row means the archive already holds a fuller read of
        // it, so its projects are the fuller ones too — leave them alone.
        if (!result.changes) continue;
        months.add(report.period.key);
        rows++;
        clearProjects.run(report.period.key, report.source);
        for (const project of report.projects.slice(0, PROJECTS_PER_SOURCE)) {
          if (project.tokens <= 0) continue;
          insertProject.run(
            report.period.key,
            report.source,
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

/** Every recorded month, newest first, with its per-source and per-project breakdown. */
export function loadMonthlySpend(path: string, limit = 120, projectsPerMonth = 12): MonthlySpend[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const exists = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='spend_month'")
      .get();
    if (!exists) return [];
    const rows = db
      .query<Row, []>(`
        SELECT month, source, tokens, cost, calls, sessions, first_ts AS firstTs, updated_at AS updatedAt
        FROM spend_month ORDER BY month DESC, tokens DESC
      `)
      .all();
    const projectRows = db
      .query<{ month: string; project: string; tokens: number; cost: number }, []>(`
        SELECT month, project, SUM(tokens) AS tokens, SUM(cost) AS cost
        FROM spend_month_project GROUP BY month, project ORDER BY month DESC, tokens DESC
      `)
      .all();
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
      month.sources.push({
        source: row.source,
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

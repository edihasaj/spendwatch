// Per-calendar-month spend, persisted so the history dashboard can show closed
// months after the transcripts behind them have rotated away.
import { Database } from "./database";
import type { Report } from "./aggregate";
import { monthLabel } from "./periods";
import { planLedgerMonths } from "./archive-ledger";
import { archivedCoverage, byMonthSource, callTotals, settledDifference, withoutCalls } from "./gateway-settle";
import { installationRowKey, restoredMonthlySuppression, type ArchivedInstallationReport } from "./installation-lineage";
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

/** Account totals only where the archived day rows can prove their token sum. */
export interface MonthlySpendAccount {
  account: string;
  source: string;
  tokens: number;
}

/** Day totals retain their source; account evidence is never inferred from a monthly split. */
export interface MonthlySpendAccountDay extends MonthlySpendAccount {
  day: string;
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
  accounts?: MonthlySpendAccount[];
  accountDays?: MonthlySpendAccountDay[];
  lineageNotes?: string[];
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
      WHERE ${force ? "1 = 1" : fullerRead("spend_month")}
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
  reportJson: string | null;
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
    const hasReports = Boolean(db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='spend_report'")
      .get());
    let rows = db
      .query<Row, []>(`
        SELECT m.month, m.source, m.tokens, m.cost, m.calls, m.sessions, m.first_ts AS firstTs, m.updated_at AS updatedAt
          ${hasReports ? ", r.report_json AS reportJson" : ", NULL AS reportJson"}
        FROM spend_month m ${hasReports ? "LEFT JOIN spend_report r ON r.month = m.month AND r.source = m.source" : ""}
        ORDER BY m.month DESC, m.tokens DESC
      `)
      .all();
    const lineageRows = rows.flatMap((row): ArchivedInstallationReport[] => {
      if (!row.reportJson) return [];
      try {
        return [{ month: row.month, archiveSource: row.source, storedTokens: row.tokens, report: JSON.parse(row.reportJson) as Report }];
      } catch {
        return [];
      }
    });
    const lineage = restoredMonthlySuppression(lineageRows);
    const shadowWinners = new Set(lineage.lineage.shadows.map((shadow) => shadow.winner));
    rows = rows.filter((row) => !lineage.suppressed.has(installationRowKey(row.month, row.source)));
    const coverage = archivedCoverage(db, lineage.suppressed);
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
    const projectRows = monthProjects(db, coverage, lineage.suppressed);
    const months = new Map<string, MonthlySpend>();
    for (const row of rows) {
      const covered = byMonthSource(coverage, row.month, row.source);
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
      if (shadowWinners.has(installationRowKey(row.month, row.source))) {
        const notes = month.lineageNotes ?? (month.lineageNotes = []);
        const note = lineage.uncertain.has(installationRowKey(row.month, row.source))
          ? "Restored installation snapshots overlap, but stored totals disagree with report detail; both remain visible. Exact historical overlap unavailable."
          : "Restored installation snapshots overlap; fullest retained snapshot shown. Exact historical overlap unavailable.";
        if (!notes.includes(note)) notes.push(note);
      }
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
      addAccountEvidence(month, row, source, covered);
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

const UNKNOWN_ACCOUNT = "Unknown account";
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

type AccountEvidence = {
  totalTokens: number;
  accounts: Array<{ account: string; tokens: number }>;
  days: Array<{ day: string; account: string; tokens: number }>;
};

/**
 * Account rows are accepted only when they exactly reconcile with both the
 * archived report total and its global day/model rows. A bad/newer report JSON
 * therefore cannot make the monthly total look attributed when it is not.
 */
function accountEvidence(reportJson: string | null): AccountEvidence | undefined {
  if (!reportJson) return;
  let report: Report;
  try {
    report = JSON.parse(reportJson) as Report;
  } catch {
    return;
  }
  const days = report.tokenDays;
  if (!days || !Array.isArray(days.rows) || !Array.isArray(days.accountRows) ||
      !Number.isSafeInteger(report.totalTokens) || report.totalTokens < 0) return;
  const totals = new Map<string, number>();
  let total = 0;
  for (const row of days.rows) {
    if (!dayPattern.test(row.day) || typeof row.model !== "string" || !Number.isSafeInteger(row.tokens) || row.tokens < 0) return;
    const key = JSON.stringify([row.day, row.model]);
    if (totals.has(key)) return;
    totals.set(key, row.tokens);
    total += row.tokens;
  }
  if (total !== report.totalTokens) return;
  const accountTotals = new Map<string, number>();
  const accountDays = new Map<string, { day: string; account: string; tokens: number }>();
  const accountKeys = new Set<string>();
  let accountTotal = 0;
  for (const row of days.accountRows) {
    if (!dayPattern.test(row.day) || typeof row.model !== "string" || typeof row.account !== "string" || !row.account.trim() ||
        !Number.isSafeInteger(row.tokens) || row.tokens < 0) return;
    const key = JSON.stringify([row.day, row.model, row.account]);
    if (accountKeys.has(key)) return;
    accountKeys.add(key);
    const modelDay = JSON.stringify([row.day, row.model]);
    if (!totals.has(modelDay)) return;
    accountTotals.set(modelDay, (accountTotals.get(modelDay) ?? 0) + row.tokens);
    const account = accountDays.get(JSON.stringify([row.day, row.account])) ?? { day: row.day, account: row.account, tokens: 0 };
    account.tokens += row.tokens;
    accountDays.set(JSON.stringify([row.day, row.account]), account);
    accountTotal += row.tokens;
  }
  if (accountTotal !== report.totalTokens || [...totals].some(([key, tokens]) => accountTotals.get(key) !== tokens)) return;
  const accounts = new Map<string, number>();
  for (const row of days.accountRows) accounts.set(row.account, (accounts.get(row.account) ?? 0) + row.tokens);
  return {
    totalTokens: report.totalTokens,
    accounts: [...accounts].map(([account, tokens]) => ({ account, tokens })),
    days: [...accountDays.values()],
  };
}

/** Global daily rows can be honestly labelled Unknown when account evidence was not collected yet. */
function unknownDailyEvidence(reportJson: string | null, expectedTokens: number): AccountEvidence | undefined {
  if (!reportJson) return;
  let report: Report;
  try {
    report = JSON.parse(reportJson) as Report;
  } catch {
    return;
  }
  const rows = report.tokenDays?.rows;
  if (!rows || !Number.isSafeInteger(report.totalTokens) || report.totalTokens !== expectedTokens) return;
  let total = 0;
  const days = new Map<string, { day: string; account: string; tokens: number }>();
  const keys = new Set<string>();
  for (const row of rows) {
    if (!dayPattern.test(row.day) || typeof row.model !== "string" || !Number.isSafeInteger(row.tokens) || row.tokens < 0) return;
    const key = JSON.stringify([row.day, row.model]);
    if (keys.has(key)) return;
    keys.add(key);
    total += row.tokens;
    const day = days.get(row.day) ?? { day: row.day, account: UNKNOWN_ACCOUNT, tokens: 0 };
    day.tokens += row.tokens;
    days.set(row.day, day);
  }
  if (total !== expectedTokens) return;
  return { totalTokens: expectedTokens, accounts: [{ account: UNKNOWN_ACCOUNT, tokens: expectedTokens }], days: [...days.values()] };
}

function addAccountEvidence(
  month: MonthlySpend,
  row: Row,
  source: string,
  covered: ReturnType<typeof byMonthSource>,
): void {
  const settled = covered.length ? settledReportJson(row.reportJson, covered) : row.reportJson;
  const attributed = accountEvidence(settled);
  const evidence = attributed?.totalTokens === row.tokens ? attributed : unknownDailyEvidence(settled, row.tokens) ??
    (row.tokens > 0 ? { totalTokens: row.tokens, accounts: [{ account: UNKNOWN_ACCOUNT, tokens: row.tokens }], days: [] } : undefined);
  if (!evidence) return;
  const accounts = month.accounts ?? (month.accounts = []);
  for (const detail of evidence.accounts) {
    const existing = accounts.find((item) => item.account === detail.account && item.source === source);
    if (existing) existing.tokens += detail.tokens;
    else accounts.push({ ...detail, source });
  }
  if (!evidence.days.length) return;
  const days = month.accountDays ?? (month.accountDays = []);
  for (const detail of evidence.days) {
    const existing = days.find((item) => item.day === detail.day && item.account === detail.account && item.source === source);
    if (existing) existing.tokens += detail.tokens;
    else days.push({ ...detail, source });
  }
}

/** Settling happens before validating attribution, exactly as it does for the report and token-summary readers. */
function settledReportJson(reportJson: string | null, calls: ReturnType<typeof byMonthSource>): string | null {
  if (!reportJson) return null;
  try {
    const report = JSON.parse(reportJson) as Report;
    return JSON.stringify(withoutCalls(report, calls));
  } catch {
    return null;
  }
}

/** Project totals per month across sources, largest first, less the calls another Mac's gateway billed. */
function monthProjects(
  db: Database,
  coverage: ReturnType<typeof archivedCoverage>,
  suppressed: ReadonlySet<string> = new Set(),
): Array<{ month: string; project: string; tokens: number; cost: number }> {
  const totals = new Map<string, { month: string; project: string; tokens: number; cost: number }>();
  const rows = db.query<{ month: string; source: string; project: string; tokens: number; cost: number }, []>(
    "SELECT month, source, project, tokens, cost FROM spend_month_project",
  ).all();
  for (const row of rows) {
    if (suppressed.has(installationRowKey(row.month, row.source))) continue;
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

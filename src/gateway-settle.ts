// Where the reports of several Macs meet.
//
// A Codex client whose turn another Mac's gateway served keeps that turn in its own report, labelled, because
// nothing on the client proves that a ledger counts it (see codex.ts). The serving Mac's report bills the same turn
// from its ledger. Both reports name the call by the same content-free id (the part of `resp_gl_<id>` after the
// marker), so wherever their reports are combined, the client's copy is taken out here: each routed turn is then
// counted once, on the serving Mac, under the provider's account. A client turn that no report in the set billed
// stays where it is, so a serving Mac that does not run Spendwatch loses nothing.
//
// Reports are archived as each Mac read them, and settled whenever they are read back together, so the archive's
// fullest-read rules (spend-report-archive.ts) never see a figure that depends on which other Macs were collected.
import type { Database } from "bun:sqlite";
import type { Report, UnconfirmedCall } from "./aggregate";

/** The calendar day of `ts` in `timeZone`, as the daily token rows key it. */
export function dayIn(timeZone: string, ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}

/** A difference that should be zero is zero, not a float residue that renders as "-$0.00". */
export function settledDifference(value: number, minus: number): number {
  const left = value - minus;
  return Math.abs(left) < 1e-9 ? 0 : left;
}
const less = settledDifference;

/**
 * Takes out of every report the unconfirmed calls that another report in the set billed. Settling twice changes
 * nothing: a call taken out also leaves the report's list.
 */
export function settleAcrossMacs(reports: Report[]): Report[] {
  const billed = new Set(reports.flatMap((report) => report.gatewayBilled ?? []));
  if (!billed.size) return reports;
  return reports.map((report) => {
    const covered = report.gatewayUnconfirmed?.filter((call) => billed.has(call.id)) ?? [];
    return covered.length ? withoutCalls(report, covered) : report;
  });
}

/**
 * `shown`, settled against every report measured with it. Every period takes part, because a call at a month
 * boundary can sit in one month on the client and in the next on the serving Mac.
 */
export function settledAmong(shown: Report[], measured: Report[]): Report[] {
  const settled = new Map(settleAcrossMacs(measured).map((report, i) => [measured[i]!, report]));
  return shown.map((report) => settled.get(report) ?? report);
}

/** The covered calls of one archived month and source (see `archivedCoverage`). */
export function byMonthSource(coverage: Map<string, UnconfirmedCall[]>, month: string, source: string): UnconfirmedCall[] {
  return coverage.get(JSON.stringify([month, source])) ?? [];
}

/** The covered calls of one archived source, whatever month's report holds them. */
export function bySource(coverage: Map<string, UnconfirmedCall[]>, source: string): UnconfirmedCall[] {
  return [...coverage].flatMap(([key, calls]) => (JSON.parse(key) as [string, string])[1] === source ? calls : []);
}

/**
 * This report without `calls`, which must be among its `gatewayUnconfirmed`: its totals, model, account, project and
 * daily token rows lose exactly what those calls added, and they count as routed. Prompt and tool rows describe the
 * client's own work, which did happen there, so they are left as they are.
 */
export function withoutCalls(report: Report, calls: UnconfirmedCall[]): Report {
  const ids = new Set(calls.map((call) => call.id));
  const own = calls.filter((call) => report.gatewayUnconfirmed?.some((kept) => kept.id === call.id));
  if (!own.length) return report;
  const models = report.models.map((row) => ({ ...row }));
  const accounts = report.accounts.map((row) => ({ ...row }));
  const projects = report.projects.map((row) => ({ ...row }));
  const days = report.tokenDays ? report.tokenDays.rows.map((row) => ({ ...row })) : undefined;
  let tokens = 0;
  let cost = 0;
  for (const call of own) {
    tokens += call.tokens;
    cost += call.cost;
    const model = models.find((row) => row.model === call.model);
    if (model) {
      model.calls -= 1;
      model.inTok -= call.inTok;
      model.outTok -= call.outTok;
      model.cacheReadTok -= call.cacheReadTok;
      model.cacheWriteTok -= call.cacheWriteTok;
      model.cost = less(model.cost, call.cost);
    }
    const account = accounts.find((row) => row.account === call.account);
    if (account) {
      account.tokens -= call.tokens;
      account.cost = less(account.cost, call.cost);
      account.calls -= 1;
    }
    // Project rows are merged case-insensitively (projects.ts), so the spelling kept may differ.
    const project = projects.find((row) => row.project.toLowerCase() === call.project.toLowerCase());
    if (project) {
      project.tokens -= call.tokens;
      project.cost = less(project.cost, call.cost);
    }
    if (days && report.tokenDays && Number.isFinite(call.ts) && call.ts > 0) {
      const day = dayIn(report.tokenDays.timeZone, call.ts);
      const row = days.find((item) => item.day === day && item.model === call.model);
      if (row) row.tokens -= call.tokens;
    }
  }
  const rest = report.gatewayUnconfirmed!.filter((call) => !ids.has(call.id));
  const { gatewayUnconfirmed: _taken, ...base } = report;
  return {
    ...base,
    totalTokens: report.totalTokens - tokens,
    totalCost: less(report.totalCost, cost),
    apiCalls: report.apiCalls - own.length,
    routedCalls: (report.routedCalls ?? 0) + own.length,
    ...(rest.length ? { gatewayUnconfirmed: rest } : {}),
    models: models.filter((row) => row.calls > 0),
    accounts,
    projects: projects.filter((row) => row.tokens > 0 || row.cost > 0),
    ...(report.tokenDays ? { tokenDays: { ...report.tokenDays, rows: days!.filter((row) => row.tokens > 0) } } : {}),
  };
}

/**
 * The archive's side of `settleAcrossMacs`: the unconfirmed calls of every archived report that another archived
 * report billed, keyed by `JSON.stringify([month, archive source])`. The monthly rows and the daily token rows are
 * kept apart from the reports, so their readers take these calls out of them as `withoutCalls` does.
 */
export function archivedCoverage(db: Database): Map<string, UnconfirmedCall[]> {
  const out = new Map<string, UnconfirmedCall[]>();
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spend_report'").get()) return out;
  const marked = (field: string) => `
    FROM (SELECT month, source, report_json FROM spend_report
          WHERE instr(report_json, '"${field}"') > 0 AND json_valid(report_json)) r,
         json_each(r.report_json, '$.${field}') j`;
  const billed = new Set(db.query<{ id: string }, []>(`SELECT DISTINCT j.value AS id ${marked("gatewayBilled")}`).all().map((row) => row.id));
  if (!billed.size) return out;
  const rows = db.query<{ month: string; source: string; call: string }, []>(`SELECT r.month, r.source, j.value AS call ${marked("gatewayUnconfirmed")}`).all();
  for (const row of rows) {
    const call = JSON.parse(row.call) as UnconfirmedCall;
    if (!billed.has(call.id)) continue;
    const key = JSON.stringify([row.month, row.source]);
    const list = out.get(key) ?? [];
    list.push(call);
    out.set(key, list);
  }
  return out;
}

/** What a set of calls adds up to, for a monthly row that keeps only totals. */
export function callTotals(calls: UnconfirmedCall[]): { tokens: number; cost: number; calls: number } {
  return calls.reduce((sum, call) => ({ tokens: sum.tokens + call.tokens, cost: sum.cost + call.cost, calls: sum.calls + 1 }), { tokens: 0, cost: 0, calls: 0 });
}

import {Database} from "./database";
import type {Report} from "./aggregate";
import {archivedCoverage, byMonthSource, bySource, callTotals, dayIn, withoutCalls} from "./gateway-settle";

export interface TokenCounts {total: number; cloud: number; local: number; unclassified: number}
export interface TokenPeriod {
  key: string;
  counts: TokenCounts | null;
  sources: number;
  expectedSources: number;
  measuredAt: string | null;
}
export interface TokenSummary {
  version: 1;
  timeZone: string;
  generatedAt: string;
  status: "snapshot";
  periods: {day: TokenPeriod; month: TokenPeriod; year: TokenPeriod};
  notes: string[];
}
const empty = (): TokenCounts => ({total: 0, cloud: 0, local: 0, unclassified: 0});
const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
const normalize = (name: string) => name.toLowerCase().replace(/^(codex|claude)\//, "");
const sum = (a: TokenCounts, b: TokenCounts) => {
  for (const key of ["total", "cloud", "local", "unclassified"] as const) {
    a[key] += b[key];
    if (!validCount(a[key])) throw new Error("Token aggregate exceeds safe integer range");
  }
};

/** Read only the existing archive. No provider calls or transcript/identity export. */
export function tokenSummary(path: string, options: {
  now?: number; timeZone?: string; localModels?: string[]; cloudModels?: string[];
} = {}): TokenSummary {
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"})
    .formatToParts(now);
  const value = (key: string) => parts.find(p => p.type === key)!.value;
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const month = day.slice(0, 7), year = day.slice(0, 4);
  const local = new Set((options.localModels || []).map(normalize));
  const cloud = new Set((options.cloudModels || []).map(normalize));
  if ([...local].some(model => cloud.has(model))) throw new Error("A model cannot be both cloud and local");
  const classify = (model: string): keyof Omit<TokenCounts, "total"> => {
    const key = normalize(model);
    if (local.has(key)) return "local";
    // Open-weight models and unknown routes need an explicit operator mapping.
    if (cloud.has(key) || /^(gpt-|claude-|gemini-|grok-)/.test(key)) return "cloud";
    return "unclassified";
  };
  const modelCounts = (rows: Array<{model: string; tokens: number}>): TokenCounts => {
    const result = empty();
    for (const row of rows) {
      if (!validCount(row.tokens) || typeof row.model !== "string") throw new Error("Invalid recorded token count");
      const n = empty(); n.total = row.tokens; n[classify(row.model)] = row.tokens; sum(result, n);
    }
    return result;
  };
  type Archived = {month: string; source: string; tokens: number; updated_at: number; report_json: string | null};
  const db = new Database(path, {readonly: true, create: false});
  let rows: Archived[];
  let captures: Array<{source: string; measured_at: number}> = [];
  let dailyRows: Array<{source: string; model: string; tokens: number}> = [];
  let coverage: ReturnType<typeof archivedCoverage>;
  try {
    // A Codex call another Mac's gateway billed comes out of the client's figures, as in every merged view.
    coverage = archivedCoverage(db);
    rows = db.query<Archived, [string, string]>(`
      SELECT m.month, m.source, m.tokens, m.updated_at, r.report_json
      FROM spend_month m LEFT JOIN spend_report r ON r.month=m.month AND r.source=m.source
      WHERE m.month LIKE ? AND m.month <= ? ORDER BY m.month, m.source
    `).all(`${year}-%`, month);
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='spend_token_capture'").get()) {
      captures = db.query<{source: string; measured_at: number}, [string, string]>(
        "SELECT source,measured_at FROM spend_token_capture WHERE time_zone=? AND month=?",
      ).all(timeZone, month);
      dailyRows = db.query<{source: string; model: string; tokens: number}, [string, string]>(
        "SELECT source,model,tokens FROM spend_token_day WHERE time_zone=? AND day=?",
      ).all(timeZone, day).map(row => {
        // The day's own calls, whichever month's report holds them: report months follow the reporting Mac's zone.
        const covered = bySource(coverage, row.source)
          .filter(call => call.model === row.model && Number.isFinite(call.ts) && call.ts > 0 && dayIn(timeZone, call.ts) === day);
        return covered.length ? {...row, tokens: Math.max(0, row.tokens - callTotals(covered).tokens)} : row;
      });
    }
  } finally {db.close();}
  const period = (key: string): TokenPeriod => ({key, counts: null, sources: 0, expectedSources: 0, measuredAt: null});
  const periods = {day: period(day), month: period(month), year: period(year)};
  const times: Record<keyof typeof periods, number[]> = {day: [], month: [], year: []};
  const yearSources = new Set<string>(), daySources = new Set<string>();
  for (const row of rows) {
    if (!validCount(row.tokens)) throw new Error("Invalid archived token total");
    const covered = byMonthSource(coverage, row.month, row.source);
    if (covered.length) row.tokens = Math.max(0, row.tokens - callTotals(covered).tokens);
    const stored = row.report_json ? JSON.parse(row.report_json) as Report : undefined;
    const report = stored && covered.length ? withoutCalls(stored, covered) : stored;
    let counts = report ? modelCounts(report.models.map(m => ({
      model: m.model, tokens: m.inTok + m.outTok + m.cacheReadTok + m.cacheWriteTok,
    }))) : empty();
    if (counts.total > row.tokens) counts = empty(); // inconsistent detail cannot invent a split
    counts.unclassified += row.tokens - counts.total;
    counts.total = row.tokens; // retain fuller legacy monthly totals
    sum(periods.year.counts ||= empty(), counts);
    yearSources.add(row.source);
    if (row.month !== month) continue;
    periods.month.expectedSources++;
    periods.day.expectedSources++;
    sum(periods.month.counts ||= empty(), counts);
    periods.month.sources++;
    const measuredAt = report?.tokenDays?.measuredAt;
    if (measuredAt && Number.isFinite(measuredAt) && measuredAt <= now + 60000) {
      times.month.push(measuredAt);
      times.year.push(measuredAt);
    }
    const daily = report?.tokenDays;
    if (!daily || daily.timeZone !== timeZone || !measuredAt || measuredAt > now + 60000) continue;
    const allDaily = modelCounts(daily.rows);
    if (allDaily.total !== row.tokens) continue; // partial/malformed detail is not a daily zero
    const measuredDayParts = new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"})
      .formatToParts(measuredAt);
    const measuredPart = (key: string) => measuredDayParts.find(p => p.type === key)!.value;
    if (`${measuredPart("year")}-${measuredPart("month")}-${measuredPart("day")}` !== day) continue;
    sum(periods.day.counts ||= empty(), modelCounts(daily.rows.filter(r => r.day === day)));
    daySources.add(row.source);
    times.day.push(measuredAt);
  }
  periods.day.sources = daySources.size;
  // Independent day high-water marks survive partial rereads of a full month.
  // Only a source actually captured today can contribute a daily zero.
  const dayFormat = new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"});
  const eligible = captures.filter(c => {
    if (!Number.isSafeInteger(c.measured_at) || c.measured_at > now + 60000) return false;
    const p = dayFormat.formatToParts(c.measured_at);
    const v = (key: string) => p.find(item => item.type === key)!.value;
    return `${v("year")}-${v("month")}-${v("day")}` === day;
  });
  if (eligible.length) {
    const sources = new Set(eligible.map(c => c.source));
    periods.day.counts = modelCounts(dailyRows.filter(r => sources.has(r.source)));
    periods.day.sources = sources.size;
    periods.day.expectedSources = Math.max(periods.day.expectedSources, sources.size);
    times.day = eligible.map(c => c.measured_at);
  }
  periods.year.sources = periods.year.expectedSources = yearSources.size;
  for (const key of ["day", "month", "year"] as const) {
    if (times[key].length) periods[key].measuredAt = new Date(Math.min(...times[key])).toISOString();
  }
  return {
    version: 1, timeZone, generatedAt: new Date(now).toISOString(), status: "snapshot", periods,
    notes: [
      "Recorded input, output and cache tokens; not cost-derived estimates. Device collection is on demand.",
      "Totals cover available archived sources, not every AI request. Daily coverage may be partial.",
      "Local models use explicit operator mappings; unmapped routes remain unclassified, never inferred from price.",
      "Monthly/yearly totals retain legacy archive counts; missing earlier months are not assumed to be zero.",
    ],
  };
}

export function runTokenCommand(argv: string[]): boolean {
  if (argv[0] !== "tokens") return false;
  let path: string | undefined, timeZone: string | undefined;
  const localModels: string[] = [], cloudModels: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i], v = argv[++i];
    if (!v || v.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--sqlite") path = v;
    else if (flag === "--time-zone") timeZone = v;
    else if (flag === "--local-model") localModels.push(v);
    else if (flag === "--cloud-model") cloudModels.push(v);
    else throw new Error(`Unknown token summary option: ${flag}`);
  }
  if (!path) throw new Error("tokens requires --sqlite PATH");
  console.log(JSON.stringify(tokenSummary(path, {timeZone, localModels, cloudModels}), null, 2));
  return true;
}

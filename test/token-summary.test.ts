import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Aggregator, type Report} from "../src/aggregate";
import {monthPeriod} from "../src/periods";
import {writeMonthlySpend} from "../src/spend-history";
import {TokenDayAccumulator} from "../src/token-days";
import {tokenSummary} from "../src/token-summary";

const now = Date.parse("2026-10-13T20:00:00Z");
const options = {now, timeZone: "Europe/Berlin", localModels: ["qwen3.8-flash-next"]};
const path = () => join(mkdtempSync(join(tmpdir(), "token-summary-")), "data.db");
function report(source: string, tokens = 100, model = "gpt-6.1-sol", month = "2026-10"): Report {
  return {source, period: monthPeriod(month), totalTokens: tokens, totalCost: 0, apiCalls: 1, sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], projects: [], accounts: [], sinceTs: now,
    models: [{model, calls: 1, inTok: tokens, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, cost: 0}],
    tokenDays: {timeZone: "Europe/Berlin", measuredAt: now, rows: [{day: "2026-10-13", model, tokens}]}};
}

test("calendar days use the declared timezone across midnight and DST", () => {
  const days = new TokenDayAccumulator("Europe/Berlin");
  days.add(Date.parse("2026-10-13T22:30:00Z"), "gpt", 10);
  days.add(Date.parse("2026-10-25T23:30:00Z"), "gpt", 20);
  expect(days.snapshot(now).rows.map(r => r.day)).toEqual(["2026-10-14", "2026-10-26"]);
});

test("streamed requests count their final provider usage once, including cache tokens", () => {
  const agg = new Aggregator();
  const fold = agg.stream("one", "private", "codex");
  for (const input of [10, 20]) fold({t: "api", sessionId: "private-session", requestId: "same",
    model: "gpt-6.1-sol", usage: {input, output: 2, cacheRead: 3, cache5m: 4, cache1h: 5},
    sidechain: false, ts: now});
  const r = agg.report();
  expect(r.totalTokens).toBe(34);
  expect(r.tokenDays!.rows.reduce((n, row) => n + row.tokens, 0)).toBe(34);
});

test("splits verified local models without inferring execution location from zero cost", () => {
  const db = path();
  writeMonthlySpend(db, [report("mac:codex"), report("spark:pi", 30, "qwen3.8-flash-next"),
    report("mac:omp", 7, "unmapped-open-model")], {generatedAt: now});
  const s = tokenSummary(db, options);
  expect(s.periods.day.counts).toEqual({total: 137, cloud: 100, local: 30, unclassified: 7});
  expect(s.periods.month.counts).toEqual(s.periods.day.counts);
  expect(s.periods.day.sources).toBe(3);
  expect(JSON.stringify(s)).not.toMatch(/private-session|private|gpt-6|spark:pi/);
});

test("retains legacy totals but missing daily detail is unavailable, never zero", () => {
  const db = path();
  const old = report("studio:codex", 500);
  delete old.tokenDays;
  old.models = [];
  writeMonthlySpend(db, [old], {generatedAt: now});
  const s = tokenSummary(db, options);
  expect(s.periods.day.counts).toBeNull();
  expect(s.periods.day.expectedSources).toBe(1);
  expect(s.periods.month.counts).toEqual({total: 500, cloud: 0, local: 0, unclassified: 500});
});

test("reimports and installation resets do not double count or erase historical usage", () => {
  const db = path();
  const old = {...report("mac:codex", 100), installationId: "one"};
  const fresh = {...report("mac:codex", 30), installationId: "two"};
  writeMonthlySpend(db, [old, fresh], {generatedAt: now});
  writeMonthlySpend(db, [old, fresh], {generatedAt: now});
  expect(tokenSummary(db, options).periods.month.counts!.total).toBe(130);
});

test("old captures, other timezones and inconsistent detail cannot masquerade as today's zero", () => {
  for (const change of ["old", "timezone", "inconsistent"]) {
    const db = path(), r = report("mac:codex");
    if (change === "old") r.tokenDays!.measuredAt = now - 86400000;
    if (change === "timezone") r.tokenDays!.timeZone = "UTC";
    if (change === "inconsistent") r.tokenDays!.rows[0]!.tokens = 10;
    writeMonthlySpend(db, [r], {generatedAt: now});
    expect(tokenSummary(db, options).periods.day.counts).toBeNull();
  }
});

test("year excludes other years and future months", () => {
  const db = path();
  writeMonthlySpend(db, [report("mac:codex", 100), report("mac:codex", 50, "gpt-6", "2026-09"),
    report("mac:codex", 1000, "gpt-6", "2026-11"),
    report("mac:codex", 300, "gpt-6", "2025-12")], {generatedAt: now});
  expect(tokenSummary(db, options).periods.year.counts!.total).toBe(150);
});

test("rejects contradictory model mappings and malformed numeric usage", () => {
  const db = path();
  writeMonthlySpend(db, [report("mac:codex")], {generatedAt: now});
  expect(() => tokenSummary(db, {...options, cloudModels: ["qwen3.8-flash-next"]})).toThrow();
  const connection = new Database(db);
  connection.exec("UPDATE spend_month SET tokens=-1");
  connection.close();
  expect(() => tokenSummary(db, options)).toThrow();
});

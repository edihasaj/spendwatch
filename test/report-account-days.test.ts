import { expect, test } from "bun:test";
import type { Report } from "../src/aggregate";
import { mergeReports } from "../src/reports";

function report(account: string, tokens: number, source = "studio:codex"): Report {
  return {
    source, totalTokens: tokens, totalCost: 0, apiCalls: 1, sessions: 1, sinceTs: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], projects: [],
    accounts: [{ account, tokens, cost: 0, calls: 1, sessions: 1 }],
    tokenDays: {
      timeZone: "Europe/Belgrade", measuredAt: 100,
      rows: [{ day: "2026-10-19", model: "gpt-test", tokens }],
      accountRows: [{ day: "2026-10-19", model: "gpt-test", account, tokens }],
    },
  };
}

test("account-day detail survives installation merging without changing totals", () => {
  const a = report("personal@example.com", 120);
  const b = report("work@example.com", 80);
  const merged = mergeReports([a, b], a.source, "service", true);
  expect(merged.totalTokens).toBe(200);
  expect(merged.tokenDays?.rows).toEqual([{ day: "2026-10-19", model: "gpt-test", tokens: 200 }]);
  expect(merged.tokenDays?.accountRows).toEqual([
    { day: "2026-10-19", model: "gpt-test", account: "personal@example.com", tokens: 120 },
    { day: "2026-10-19", model: "gpt-test", account: "work@example.com", tokens: 80 },
  ]);
  expect(a.tokenDays?.rows[0]?.tokens).toBe(120);
});

test("legacy daily detail stays unknown rather than inheriting a monthly account", () => {
  const a = report("personal@example.com", 120);
  delete a.tokenDays!.accountRows;
  const merged = mergeReports([a, report("work@example.com", 80)], "all");
  expect(merged.tokenDays?.accountRows?.map(row => [row.account, row.tokens])).toEqual([
    ["Codex · Unknown account", 120], ["Codex · work@example.com", 80],
  ]);
});

test("incomplete, incompatible or inconsistent daily detail is never presented as a full merged measurement", () => {
  const missing = report("unknown", 80);
  delete missing.tokenDays;
  expect(mergeReports([report("personal", 120), missing]).tokenDays).toBeUndefined();
  const incompatible = report("work", 80);
  incompatible.tokenDays!.timeZone = "UTC";
  expect(mergeReports([report("personal", 120), incompatible]).tokenDays).toBeUndefined();
  const inconsistent = report("work", 80);
  inconsistent.tokenDays!.accountRows![0]!.tokens = 79;
  expect(mergeReports([report("personal", 120), inconsistent]).tokenDays).toBeUndefined();
});

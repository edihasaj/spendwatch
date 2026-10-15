import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { monthPeriod } from "../src/periods";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { loadArchivedReports } from "../src/spend-report-archive";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "spendwatch-months-")), "spendwatch.db");
}

function report(
  month: string,
  source: string,
  tokens: number,
  calls = 10,
  projects: Array<{ project: string; tokens: number; cost: number }> = [],
): Report {
  return {
    period: monthPeriod(month),
    totalTokens: tokens,
    totalCost: tokens / 1_000_000,
    apiCalls: calls,
    sessions: 3,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], accounts: [],
    projects,
    source,
    sinceTs: monthPeriod(month).from,
  };
}

/** Day buckets that add up to a report's totalTokens, which the archiver requires. */
function dayRows(month: string, rows: Array<[day: string, tokens: number]>) {
  return {
    timeZone: "UTC",
    measuredAt: monthPeriod(month).from + 3_600_000,
    rows: rows.map(([day, tokens]) => ({ day, model: "gpt-5.5", tokens })),
  };
}

function storedDays(path: string): Array<{ day: string; tokens: number }> {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return db.query<{ day: string; tokens: number }, []>("SELECT day, tokens FROM spend_token_day ORDER BY day").all();
  } finally {
    db.close();
  }
}

describe("monthly spend archive", () => {
  test("a reset adds new chats immediately and keeps old detail after an empty export", () => {
    const path = dbPath();
    const old = { ...report("2026-10", "macbook:codex", 20_000, 900,
      [{ project: "manager", tokens: 20_000, cost: 20 }]), installationId: "before-reset",
      accounts: [{ account: "edi@example.com (work)", tokens: 20_000, cost: 20, calls: 900, sessions: 3 }],
      prompts: [{ key: "old", text: "old chat", project: "manager", tokens: 20_000, cost: 20, toolCalls: 0, outTok: 100, ts: 1 }],
    };
    const fresh = { ...report("2026-10", "macbook:codex", 500, 2,
      [{ project: "manager", tokens: 500, cost: 0.5 }]), installationId: "after-reset",
      accounts: [{ account: "edi@example.com (work)", tokens: 500, cost: 0.5, calls: 2, sessions: 3 }],
      prompts: [{ key: "new", text: "new chat", project: "manager", tokens: 500, cost: 0.5, toolCalls: 0, outTok: 5, ts: 2 }],
    };
    writeMonthlySpend(path, [old], { generatedAt: 1 });
    writeMonthlySpend(path, [{ ...fresh, apiCalls: 0, totalTokens: 0 }], { generatedAt: 2 });
    expect(loadArchivedReports(path)[0]!.prompts[0]!.text).toBe("old chat");
    writeMonthlySpend(path, [fresh], { generatedAt: 3 });
    // Re-importing either installation must neither double count nor drop one.
    writeMonthlySpend(path, [fresh, old], { generatedAt: 4 });
    const [month] = loadMonthlySpend(path);
    expect(month!.tokens).toBe(20_500);
    expect(month!.calls).toBe(902);
    expect(month!.sources).toHaveLength(1);
    expect(month!.projects).toEqual([{ project: "manager", tokens: 20_500, cost: 20.5 }]);
    const [detail] = loadArchivedReports(path);
    expect(detail!.totalTokens).toBe(20_500);
    expect(detail!.accounts).toEqual([{ account: "edi@example.com (work)", tokens: 20_500, cost: 20.5, calls: 902, sessions: 6 }]);
    expect(detail!.prompts.map((row) => row.text)).toEqual(["old chat", "new chat"]);
  });

  test("adding installation identity adopts legacy totals without double counting", () => {
    const path = dbPath();
    const old = report("2026-09", "macbook:claude", 20_000, 900);
    writeMonthlySpend(path, [old], { generatedAt: 1 });
    writeMonthlySpend(path, [{ ...old, installationId: "current" }], { generatedAt: 2 });
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_000);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(20_000);
    writeMonthlySpend(path, [{ ...old, installationId: "new", totalTokens: 500, apiCalls: 2 }], { generatedAt: 3 });
    writeMonthlySpend(path, [old], { generatedAt: 4 });
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_500);
  });

  test("partial rereads keep the strongest detail for each installation", () => {
    const path = dbPath();
    const old = { ...report("2026-09", "macbook:claude", 20_000, 900), installationId: "one" };
    writeMonthlySpend(path, [old], { generatedAt: 1 });
    writeMonthlySpend(path, [{ ...old, totalTokens: 500, apiCalls: 2 }], { generatedAt: 2 });
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(20_000);
  });
  test("keeps one row per month and source, newest month first", () => {
    const path = dbPath();
    writeMonthlySpend(path, [
      report("2026-08", "studio:claude", 8_000),
      report("2026-08", "mbp:codex", 2_000),
      report("2026-09", "studio:claude", 50),
    ], { generatedAt: 1 });

    const months = loadMonthlySpend(path);
    expect(months.map((month) => month.month)).toEqual(["2026-09", "2026-08"]);
    expect(months[0]!.label).toBe("September 2026");
    const august = months[1]!;
    expect(august.tokens).toBe(10_000);
    expect(august.calls).toBe(20);
    expect(august.sources.map((row) => row.source)).toEqual(["studio:claude", "mbp:codex"]);
  });

  test("a later run corrects a month rather than appending a second copy", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-08", "studio:claude", 8_000)], { generatedAt: 1 });
    writeMonthlySpend(path, [report("2026-08", "studio:claude", 9_500)], { generatedAt: 2 });

    const [august] = loadMonthlySpend(path);
    expect(august!.sources).toHaveLength(1);
    expect(august!.tokens).toBe(9_500);
    expect(august!.updatedAt).toBe(2);
  });

  test("a run that collected nothing leaves the recorded month alone", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-08", "studio:claude", 8_000)], { generatedAt: 1 });
    const written = writeMonthlySpend(path, [report("2026-08", "studio:claude", 0, 0)], { generatedAt: 2 });

    expect(written.rows).toBe(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(8_000);
  });

  test("a thinner re-read of a closed month does not shrink it", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-07", "studio:codex", 20_000, 900)], { generatedAt: 1 });
    // Session files rotate, so next month's re-read finds only part of July.
    const written = writeMonthlySpend(path, [report("2026-07", "studio:codex", 500, 20)], { generatedAt: 2 });

    expect(written.rows).toBe(0);
    expect(written.months).toEqual([]);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_000);
  });

  test("keeps per-project usage, summed across the machines that reported it", () => {
    const path = dbPath();
    writeMonthlySpend(path, [
      report("2026-08", "studio:codex", 8_000, 10, [
        { project: "spendwatch", tokens: 5_000, cost: 5 },
        { project: "manager", tokens: 3_000, cost: 3 },
      ]),
      report("2026-08", "mbp:codex", 2_000, 10, [{ project: "spendwatch", tokens: 2_000, cost: 2 }]),
    ], { generatedAt: 1 });

    const [august] = loadMonthlySpend(path);
    expect(august!.projects).toEqual([
      { project: "spendwatch", tokens: 7_000, cost: 7 },
      { project: "manager", tokens: 3_000, cost: 3 },
    ]);
  });

  test("a re-read replaces a source's projects rather than stacking them", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-08", "studio:codex", 8_000, 10, [
      { project: "spendwatch", tokens: 5_000, cost: 5 },
      { project: "retired", tokens: 3_000, cost: 3 },
    ])], { generatedAt: 1 });
    // The later read no longer sees "retired", so it must not linger.
    writeMonthlySpend(path, [report("2026-08", "studio:codex", 9_000, 12, [
      { project: "spendwatch", tokens: 9_000, cost: 9 },
    ])], { generatedAt: 2 });

    expect(loadMonthlySpend(path)[0]!.projects).toEqual([{ project: "spendwatch", tokens: 9_000, cost: 9 }]);
  });

  test("a rejected month keeps the projects it was recorded with", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-07", "studio:codex", 20_000, 900, [
      { project: "spendwatch", tokens: 20_000, cost: 20 },
    ])], { generatedAt: 1 });
    writeMonthlySpend(path, [report("2026-07", "studio:codex", 500, 20, [
      { project: "spendwatch", tokens: 500, cost: 0.5 },
    ])], { generatedAt: 2 });

    expect(loadMonthlySpend(path)[0]!.projects).toEqual([{ project: "spendwatch", tokens: 20_000, cost: 20 }]);
  });

  test("observed calls replace a month that fewer billed calls would lose", () => {
    const path = dbPath();
    writeMonthlySpend(path, [report("2026-08", "studio:codex", 20_000, 900)], { generatedAt: 1 });
    // The gateway billed 800 of the 900 calls it observed, so the deduped report
    // still saw the whole month and should win.
    const fuller = { ...report("2026-08", "studio:codex", 25_000, 800), observedCalls: 900 };
    expect(writeMonthlySpend(path, [fuller], { generatedAt: 2 }).rows).toBeGreaterThan(0);

    const [august] = loadMonthlySpend(path);
    expect(august!.tokens).toBe(25_000);
    expect(august!.calls).toBe(800);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(25_000);
  });

  test("a thin re-read with a lower observed count is rejected", () => {
    const path = dbPath();
    writeMonthlySpend(path, [{ ...report("2026-08", "studio:codex", 20_000, 800), observedCalls: 900 }], { generatedAt: 1 });
    const thinner = { ...report("2026-08", "studio:codex", 500, 10), observedCalls: 20 };

    expect(writeMonthlySpend(path, [thinner], { generatedAt: 2 }).rows).toBe(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_000);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(20_000);
  });

  test("an accepted run replaces its days instead of maxing them", () => {
    const path = dbPath();
    const august = (tokens: number, calls: number, days: Array<[string, number]>): Report => ({
      ...report("2026-08", "studio:codex", tokens, calls),
      observedCalls: calls,
      tokenDays: dayRows("2026-08", days),
    });
    writeMonthlySpend(path, [august(1_000, 900, [["2026-08-05", 1_000]])], { generatedAt: 1 });
    // The next read re-buckets the same month: day 5 was really 600 of it.
    writeMonthlySpend(path, [august(1_000, 900, [["2026-08-05", 600], ["2026-08-06", 400]])], { generatedAt: 2 });

    expect(storedDays(path)).toEqual([
      { day: "2026-08-05", tokens: 600 },
      { day: "2026-08-06", tokens: 400 },
    ]);
  });

  test("a rejected run merges its days without shrinking the month", () => {
    const path = dbPath();
    const august = (tokens: number, calls: number, days: Array<[string, number]>): Report => ({
      ...report("2026-08", "studio:codex", tokens, calls),
      observedCalls: calls,
      tokenDays: dayRows("2026-08", days),
    });
    writeMonthlySpend(path, [august(1_000, 900, [["2026-08-05", 1_000]])], { generatedAt: 1 });
    // A partial re-read saw less of the 5th but found a day the archive missed.
    writeMonthlySpend(path, [august(700, 20, [["2026-08-05", 200], ["2026-08-07", 500]])], { generatedAt: 2 });

    expect(storedDays(path)).toEqual([
      { day: "2026-08-05", tokens: 1_000 },
      { day: "2026-08-07", tokens: 500 },
    ]);
  });

  test("a month read with the gateway ledger is never replaced by a read without it", () => {
    const path = dbPath();
    // With the ledger, 50 routed calls were billed to Claude and Copilot and dropped from Codex.
    const codex = (tokens: number, ledger: boolean): Report => ({ ...report("2026-10", "studio:codex", tokens, 900), observedCalls: 900, ...(ledger ? { ledger: true, routedCalls: 50 } : {}) });
    // With the ledger, routed turns are counted there and dropped from the rollouts: 20,000 tokens.
    writeMonthlySpend(path, [codex(20_000, true)], { generatedAt: 1 });
    // The gateway source was switched off: the same 900 observed calls now include the routed turns again.
    expect(writeMonthlySpend(path, [codex(26_000, false)], { generatedAt: 2 }).rows).toBe(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_000);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(20_000);
    // Reading the month with the ledger again replaces it as usual, and the guard survives a rewrite.
    expect(writeMonthlySpend(path, [codex(21_000, true)], { generatedAt: 3 }).rows).toBeGreaterThan(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(21_000);
    expect(writeMonthlySpend(path, [codex(26_000, false)], { generatedAt: 4 }).rows).toBe(0);
  });

  test("a read without the ledger leaves a ledger month's days alone as well as its totals", () => {
    const path = dbPath();
    const codex = (tokens: number, ledger: boolean, days: Array<[string, number]>): Report => ({
      ...report("2026-10", "studio:codex", tokens, 900), observedCalls: 900, tokenDays: dayRows("2026-10", days), ...(ledger ? { ledger: true, routedCalls: 50 } : {}),
    });
    writeMonthlySpend(path, [codex(20_000, true, [["2026-10-05", 20_000]])], { generatedAt: 1 });
    // The source was switched off: the routed turns are back in the rollouts, 6,000 more tokens on the 5th.
    expect(writeMonthlySpend(path, [codex(26_000, false, [["2026-10-05", 26_000]])], { generatedAt: 2 }).rows).toBe(0);
    // Maxing that day would count the routed turns here and again in the Copilot and Claude days.
    expect(storedDays(path)).toEqual([{ day: "2026-10-05", tokens: 20_000 }]);
    // A partial re-read that did use the ledger still merges its days as before.
    writeMonthlySpend(path, [{ ...codex(700, true, [["2026-10-05", 200], ["2026-10-07", 500]]), observedCalls: 20 }], { generatedAt: 3 });
    expect(storedDays(path)).toEqual([{ day: "2026-10-05", tokens: 20_000 }, { day: "2026-10-07", tokens: 500 }]);
  });

  test("a thin ledger read cannot add days to a month stored without the ledger", () => {
    const path = dbPath();
    const codex = (tokens: number, calls: number, ledger: boolean, days: Array<[string, number]>): Report => ({
      ...report("2026-10", "studio:codex", tokens, calls), observedCalls: calls, tokenDays: dayRows("2026-10", days), ...(ledger ? { ledger: true, routedCalls: 5 } : {}),
    });
    writeMonthlySpend(path, [codex(26_000, 900, false, [["2026-10-05", 26_000]])], { generatedAt: 1 });
    // Fewer observed calls, and routed calls the stored read billed in Codex: the stored month wins, and its days go with its totals.
    expect(writeMonthlySpend(path, [codex(1_000, 20, true, [["2026-10-06", 1_000]])], { generatedAt: 2 }).rows).toBe(0);
    expect(storedDays(path)).toEqual([{ day: "2026-10-05", tokens: 26_000 }]);
  });

  test("a month whose every call was routed replaces the stale month that billed those turns", () => {
    const path = dbPath();
    // The serving Mac's own Codex month, read before its gateway kept a ledger: all 50 turns billed in Codex.
    const stale = { ...report("2026-10", "studio:codex", 26_000, 50), observedCalls: 50, tokenDays: dayRows("2026-10", [["2026-10-05", 26_000]]) };
    writeMonthlySpend(path, [stale], { generatedAt: 1 });
    // Read with its ledger, which holds a row for every one of them: the ledger bills all 50, Codex none.
    const routed: Report = { ...report("2026-10", "studio:codex", 0, 0), observedCalls: 50, ledger: true, routedCalls: 50, tokenDays: dayRows("2026-10", []) };
    expect(writeMonthlySpend(path, [routed], { generatedAt: 2 }).rows).toBeGreaterThan(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(0);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(0);
    expect(storedDays(path)).toEqual([]);
    // A report that observed nothing at all is still not a month.
    expect(writeMonthlySpend(path, [{ ...routed, observedCalls: 0 }], { generatedAt: 3 }).rows).toBe(0);
  });

  test("a month first read without the ledger takes the ledger read, and archives from before the column still load", () => {
    const path = dbPath();
    const old = new Database(path);
    old.exec(`CREATE TABLE spend_month (month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL,
      sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));
      CREATE TABLE spend_report (month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL, report_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));`);
    old.close();
    writeMonthlySpend(path, [{ ...report("2026-09", "studio:codex", 26_000, 900), observedCalls: 900 }], { generatedAt: 1 });
    expect(writeMonthlySpend(path, [{ ...report("2026-09", "studio:codex", 20_000, 900), observedCalls: 900, ledger: true }], { generatedAt: 2 }).rows).toBeGreaterThan(0);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(20_000);
  });

  test("rolling-window reports are not filed as a month", () => {
    const path = dbPath();
    const rolling = { ...report("2026-08", "studio:claude", 8_000), period: undefined };
    expect(writeMonthlySpend(path, [rolling], { generatedAt: 1 }).rows).toBe(0);
    expect(loadMonthlySpend(path)).toEqual([]);
  });
});

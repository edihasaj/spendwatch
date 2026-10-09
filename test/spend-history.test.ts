import { describe, expect, test } from "bun:test";
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

  test("rolling-window reports are not filed as a month", () => {
    const path = dbPath();
    const rolling = { ...report("2026-08", "studio:claude", 8_000), period: undefined };
    expect(writeMonthlySpend(path, [rolling], { generatedAt: 1 }).rows).toBe(0);
    expect(loadMonthlySpend(path)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { monthPeriod } from "../src/periods";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "spendwatch-months-")), "spendwatch.db");
}

function report(month: string, source: string, tokens: number, calls = 10): Report {
  return {
    period: monthPeriod(month),
    totalTokens: tokens,
    totalCost: tokens / 1_000_000,
    apiCalls: calls,
    sessions: 3,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], projects: [], accounts: [],
    source,
    sinceTs: monthPeriod(month).from,
  };
}

describe("monthly spend archive", () => {
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

  test("rolling-window reports are not filed as a month", () => {
    const path = dbPath();
    const rolling = { ...report("2026-08", "studio:claude", 8_000), period: undefined };
    expect(writeMonthlySpend(path, [rolling], { generatedAt: 1 }).rows).toBe(0);
    expect(loadMonthlySpend(path)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import type { Report } from "../src/aggregate";
import { monthPeriod } from "../src/periods";
import { groupImported, newestPopulated, primaryPeriod, resolvePeriods } from "../src/report-window";

const NOW = new Date(2026, 8, 1, 6, 5, 0).getTime();
const base = { days: 30, daysExplicit: false, months: 1 };

function imported(source: string, month?: string, apiCalls = 5): Report {
  return {
    ...(month ? { period: monthPeriod(month) } : {}),
    totalTokens: 1, totalCost: 1, apiCalls, sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], projects: [], accounts: [],
    source, sinceTs: NOW,
  };
}

describe("report window", () => {
  test("defaults to the current calendar month", () => {
    const periods = resolvePeriods(base, NOW);
    expect(periods.map((period) => period.key)).toEqual(["2026-09"]);
    expect(primaryPeriod(periods).month).toBe(true);
  });

  test("backfills earlier months, reporting the current one last", () => {
    const periods = resolvePeriods({ ...base, months: 3 }, NOW);
    expect(periods.map((period) => period.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(primaryPeriod(periods).key).toBe("2026-09");
  });

  test("an explicit window or month wins over the calendar default", () => {
    expect(resolvePeriods({ ...base, days: 7, daysExplicit: true }, NOW)[0]!.key).toBe("7d");
    expect(resolvePeriods({ ...base, month: "2026-08" }, NOW)[0]!.key).toBe("2026-08");
    // An explicit month beats an explicit window: it is the more specific ask.
    expect(resolvePeriods({ ...base, month: "2026-08", days: 7, daysExplicit: true }, NOW)[0]!.key).toBe("2026-08");
  });

  test("reports everything when there is no clock to build a calendar from", () => {
    expect(resolvePeriods(base, 0)[0]!.key).toBe("all");
  });

  test("files imported reports under the month their machine recorded", () => {
    const september = monthPeriod("2026-09");
    const grouped = groupImported(
      [imported("studio:claude", "2026-08"), imported("mbp:codex", "2026-08"), imported("studio:claude", "2026-09")],
      september,
    );
    expect(grouped.get("2026-08")).toHaveLength(2);
    expect(grouped.get("2026-09")).toHaveLength(1);
  });

  test("untagged exports from an older spendwatch stay visible", () => {
    const september = monthPeriod("2026-09");
    const grouped = groupImported([imported("studio:claude")], september);
    expect(grouped.get("2026-09")).toHaveLength(1);
    expect(newestPopulated(grouped, september.key)).toBe("2026-09");
  });

  test("opens on the newest imported month that holds traffic", () => {
    const september = monthPeriod("2026-09");
    const grouped = groupImported(
      [imported("studio:claude", "2026-07"), imported("studio:claude", "2026-08"), imported("idle:grok", "2026-09", 0)],
      september,
    );
    // September is present but silent, so August is what the page should show.
    expect(newestPopulated(grouped, september.key)).toBe("2026-08");
  });
});

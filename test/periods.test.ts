import { describe, expect, test } from "bun:test";
import { monthKeyOf, monthLabel, monthPeriod, recentMonths, rollingDays, unbounded } from "../src/periods";

describe("periods", () => {
  test("resolves a calendar month to local-time bounds", () => {
    const august = monthPeriod("2026-08");
    expect(august.month).toBe(true);
    expect(august.label).toBe("August 2026");
    expect(new Date(august.from).getDate()).toBe(1);
    expect(new Date(august.from).getMonth()).toBe(7);
    expect(new Date(august.to).getMonth()).toBe(8);
    expect(monthKeyOf(august.from)).toBe("2026-08");
    expect(monthKeyOf(august.to - 1)).toBe("2026-08");
    // Exclusive end: the first instant of September belongs to September.
    expect(monthKeyOf(august.to)).toBe("2026-09");
  });

  test("rejects malformed months instead of reporting an empty window", () => {
    expect(() => monthPeriod("2026-13")).toThrow(/01-12/);
    expect(() => monthPeriod("aug-2026")).toThrow(/YYYY-MM/);
    expect(() => rollingDays(Date.now(), 0)).toThrow(/positive/);
    expect(() => recentMonths(Date.now(), 0)).toThrow(/positive integer/);
  });

  test("walks back across a year boundary, oldest first", () => {
    const months = recentMonths(new Date(2026, 0, 14).getTime(), 3);
    expect(months.map((period) => period.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(monthLabel("2025-12")).toBe("December 2025");
  });

  test("falls back to an all-time window when there is no clock", () => {
    const all = unbounded();
    expect(all.month).toBe(false);
    expect(all.from).toBe(0);
    // Wide enough that no real timestamp is filtered out of it.
    expect(all.to).toBeGreaterThan(Date.now());
  });

  test("keeps the rolling window available for live tails", () => {
    const now = new Date(2026, 8, 1, 6, 0, 0).getTime();
    const window = rollingDays(now, 1);
    expect(window.month).toBe(false);
    expect(window.label).toBe("the last 1 day");
    expect(window.to - window.from).toBe(86_400_000);
  });
});

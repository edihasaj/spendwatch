import { expect, test } from "bun:test";
import { staleAfterMs, windowFreshness } from "../src/capacity-freshness";

test("a clock-ahead quota sample is never considered live before its timestamp", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  expect(windowFreshness(
    { usedPercent: 12, windowMinutes: 300, resetsAt: "2026-10-19T16:00:00Z" },
    "2026-10-19T12:01:00Z",
    now,
  )).toBe("stale");
});

test("weekly and five-hour windows go stale after the seven-minute accuracy cap", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  for (const windowMinutes of [300, 10080]) {
    const window = { usedPercent: 12, windowMinutes, resetsAt: "2026-10-27T12:00:00Z" };
    expect(windowFreshness(window, new Date(now - 6 * 60_000 - 59_000).toISOString(), now)).toBe("live");
    expect(windowFreshness(window, new Date(now - 7 * 60_000 - 1_000).toISOString(), now)).toBe("stale");
  }
});

test("short windows retain the five-minute freshness floor and expired resets win", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  expect(staleAfterMs(60)).toBe(5 * 60_000);
  expect(windowFreshness(
    { usedPercent: 12, windowMinutes: 300, resetsAt: "2026-10-20T11:59:59Z" },
    "2026-10-20T11:59:59Z",
    now,
  )).toBe("expired");
});

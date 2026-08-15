import { expect, test } from "bun:test";
import { paceFor } from "../src/capacity-current";

const HOUR = 3_600_000;

test("pace is null without a reset time, since elapsed time is unknowable", () => {
  expect(paceFor({ usedPercent: 50, windowMinutes: 10080 })).toBeNull();
});

test("halfway through a window, usage at 50% is exactly on pace", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  const pace = paceFor(
    { usedPercent: 50, windowMinutes: 7 * 24 * 60, resetsAt: new Date(now + 84 * HOUR).toISOString() },
    now,
  )!;
  expect(pace.expectedUsedPercent).toBeCloseTo(50, 5);
  expect(pace.deltaPercent).toBeCloseTo(0, 5);
  expect(pace.willLastToReset).toBe(true);
});

test("burning faster than the window reports over pace and will not last", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  const pace = paceFor(
    { usedPercent: 90, windowMinutes: 7 * 24 * 60, resetsAt: new Date(now + 84 * HOUR).toISOString() },
    now,
  )!;
  expect(pace.deltaPercent).toBeGreaterThan(0);
  expect(pace.willLastToReset).toBe(false);
  expect(pace.etaSeconds).toBeGreaterThan(0);
});

test("a reset further away than the window itself is rejected as inconsistent", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  expect(paceFor({ usedPercent: 10, windowMinutes: 60, resetsAt: new Date(now + 5 * HOUR).toISOString() }, now)).toBeNull();
});

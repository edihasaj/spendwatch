import { expect, test } from "bun:test";
import { burnForecast, burnLookbackMinutes, currentCycleSamples, type BurnSample } from "../src/capacity-burn";
import type { LimitWindow } from "../src/limits";

const NOW = Date.parse("2026-02-01T12:00:00.000Z");

function window(overrides: Partial<LimitWindow> = {}): LimitWindow {
  return {
    windowMinutes: 300,
    usedPercent: 50,
    resetsAt: "2026-02-01T14:00:00.000Z",
    ...overrides,
  } as LimitWindow;
}

function samples(points: [minutesAgo: number, usedPercent: number][], resetsAt: number | null = Date.parse("2026-02-01T14:00:00.000Z")): BurnSample[] {
  return points.map(([minutesAgo, usedPercent]) => ({ sampledAt: NOW - minutesAgo * 60_000, usedPercent, resetsAt }));
}

test("lookback scales with the window but stays within readable bounds", () => {
  expect(burnLookbackMinutes(300)).toBe(30);
  expect(burnLookbackMinutes(10_080)).toBe(360);
});

test("slope survives quantized readings that repeat the same integer", () => {
  const forecast = burnForecast(samples([[24, 40], [18, 40], [12, 45], [6, 45], [0, 50]]), window(), NOW);
  expect(forecast).toBeDefined();
  expect(forecast!.ratePerHour).toBeGreaterThan(20);
  expect(forecast!.ratePerHour).toBeLessThan(30);
  expect(forecast!.sampleCount).toBe(5);
});

test("burn compares against the rate the remaining allowance affords", () => {
  const forecast = burnForecast(samples([[20, 44], [10, 47], [0, 50]]), window(), NOW)!;
  // 50% left across the 2 hours to reset is 25%/h; 6 points in 20 minutes is 18%/h.
  expect(forecast.ratePerHour).toBeCloseTo(18, 5);
  expect(forecast.sustainableRatePerHour).toBeCloseTo(25, 5);
  expect(forecast.budgetMultiple).toBeCloseTo(forecast.ratePerHour / 25, 5);
  expect(forecast.lastsToReset).toBe(true);
  expect(forecast.runsOutAt).toBeUndefined();
});

test("a burst reports a run-out before the reset", () => {
  const forecast = burnForecast(samples([[20, 30], [10, 55], [0, 80]]), window({ usedPercent: 80 }), NOW)!;
  expect(forecast.lastsToReset).toBe(false);
  expect(Date.parse(forecast.runsOutAt!)).toBeGreaterThan(NOW);
  expect(Date.parse(forecast.runsOutAt!)).toBeLessThan(Date.parse("2026-02-01T14:00:00.000Z"));
  expect(forecast.earlyByMinutes).toBeGreaterThan(0);
});

test("fewer than three samples cannot support a slope", () => {
  expect(burnForecast(samples([[10, 40], [0, 50]]), window(), NOW)).toBeUndefined();
});

test("an exhausted window has nothing left to pace", () => {
  expect(burnForecast(samples([[20, 98], [10, 99], [0, 100]]), window({ usedPercent: 100 }), NOW)).toBeUndefined();
});

test("a window whose reset already passed is not forecast", () => {
  const past = window({ resetsAt: "2026-02-01T11:00:00.000Z" });
  expect(burnForecast(samples([[20, 40], [10, 45], [0, 50]], Date.parse("2026-02-01T11:00:00.000Z")), past, NOW)).toBeUndefined();
});

test("samples from an earlier cycle are excluded", () => {
  const previous = samples([[400, 10], [380, 20]], Date.parse("2026-02-01T09:00:00.000Z"));
  const current = samples([[20, 40], [10, 45], [0, 50]]);
  expect(currentCycleSamples([...previous, ...current], window())).toHaveLength(3);
});

test("sub-second reset jitter does not split a cycle", () => {
  const jittered: BurnSample[] = [
    { sampledAt: NOW - 20 * 60_000, usedPercent: 40, resetsAt: Date.parse("2026-02-01T14:00:00.000Z") - 400 },
    { sampledAt: NOW - 10 * 60_000, usedPercent: 45, resetsAt: Date.parse("2026-02-01T14:00:00.000Z") + 250 },
    { sampledAt: NOW, usedPercent: 50, resetsAt: Date.parse("2026-02-01T14:00:00.000Z") },
  ];
  expect(currentCycleSamples(jittered, window())).toHaveLength(3);
});

test("a provider-side rollover inside the matched cycle restarts the measurement", () => {
  const rolled = samples([[25, 90], [20, 95], [15, 4], [10, 9], [0, 14]]);
  expect(currentCycleSamples(rolled, window())).toHaveLength(3);
});

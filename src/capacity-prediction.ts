import type { CapacityPrediction, LimitWindow } from "./limits";

export function predictWindow(window: LimitWindow, nowMs: number): CapacityPrediction | undefined {
  if (window.prediction) return window.prediction;
  if (!window.resetsAt) return undefined;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt <= nowMs || window.windowMinutes <= 0) return undefined;
  const durationMs = window.windowMinutes * 60_000;
  const elapsedMs = durationMs - (resetsAt - nowMs);
  if (elapsedMs <= 0 || elapsedMs / durationMs < 0.03) return undefined;
  const actual = Math.min(100, Math.max(0, window.usedPercent));
  const expected = Math.min(100, Math.max(0, elapsedMs / durationMs * 100));
  const deltaPercent = actual - expected;
  if (actual <= 0) return { deltaPercent, expectedUsedPercent: expected, willLastToReset: true, source: "linear" };
  if (actual >= 100) {
    return {
      deltaPercent,
      expectedUsedPercent: expected,
      willLastToReset: false,
      runsOutAt: new Date(nowMs).toISOString(),
      source: "linear",
    };
  }
  const etaMs = (100 - actual) / (actual / elapsedMs);
  const willLastToReset = etaMs >= resetsAt - nowMs;
  return {
    deltaPercent,
    expectedUsedPercent: expected,
    willLastToReset,
    runsOutAt: willLastToReset ? undefined : new Date(nowMs + etaMs).toISOString(),
    source: "linear",
  };
}

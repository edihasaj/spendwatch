// A quota snapshot only describes the cycle it was taken in. Once the cycle
// resets, or the collector stops refreshing, the stored percentage stops being
// an answer to "how much is left right now" — it becomes history. Rendering it
// as current capacity is worse than rendering nothing, because it reads as a
// live measurement.
import type { LimitWindow } from "./limits";

export type WindowFreshness = "live" | "stale" | "expired";

const STALE_FLOOR_MS = 5 * 60_000;
const STALE_CEILING_MS = 60 * 60_000;
const STALE_WINDOW_FRACTION = 0.05;

/** A sample may lag by 5% of its window, bounded to 5–60 minutes. */
export function staleAfterMs(windowMinutes: number): number {
  const budget = windowMinutes * 60_000 * STALE_WINDOW_FRACTION;
  return Math.min(STALE_CEILING_MS, Math.max(STALE_FLOOR_MS, budget));
}

export function windowFreshness(window: LimitWindow, updatedAt: string | undefined, nowMs: number): WindowFreshness {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (Number.isFinite(resetsAt) && resetsAt <= nowMs) return "expired";
  const sampledAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(sampledAt)) return "stale";
  if (nowMs - sampledAt > staleAfterMs(window.windowMinutes)) return "stale";
  return "live";
}

export function isWindowLive(window: LimitWindow, updatedAt: string | undefined, nowMs: number): boolean {
  return windowFreshness(window, updatedAt, nowMs) === "live";
}

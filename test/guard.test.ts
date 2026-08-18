import { describe, expect, test } from "bun:test";
import { crossedWeeklyThreshold } from "../src/capacity-alerts";
import { evaluateGuard } from "../src/guard";
import type { CodexLimitAccount } from "../src/limits";

const nowMs = Date.parse("2026-08-12T12:00:00Z");
const account: CodexLimitAccount = {
  provider: "codex",
  email: "work@example.com",
  plan: "Pro",
  devices: ["studio"],
  updatedAt: "2026-08-12T11:58:00Z",
  session: { usedPercent: 100, windowMinutes: 300, resetsAt: "2026-08-12T15:00:00Z" },
  weekly: { usedPercent: 86, windowMinutes: 10080, resetsAt: "2026-08-17T00:00:00Z" },
};

describe("capacity guard", () => {
  test("blocks below minimum and uses distinct unavailable exit code", () => {
    expect(evaluateGuard([account], { account: "work", window: "weekly", minimumPercent: 15, nowMs }).exitCode).toBe(1);
    expect(evaluateGuard([account], { account: "missing", window: "weekly", minimumPercent: 15, nowMs }).exitCode).toBe(69);
    expect(evaluateGuard([account], { account: "missing", window: "weekly", minimumPercent: 15, failOpen: true, nowMs }).exitCode).toBe(0);
  });

  test("reports unknown instead of ok when the reading is not current", () => {
    const stale = evaluateGuard([account], { provider: "codex", window: "weekly", minimumPercent: 14, nowMs: nowMs + 4 * 3600_000 });
    expect(stale.decision).toBe("unknown");
    expect(stale.exitCode).toBe(69);
    expect(stale.reason).toBe("weekly reading is not current");
    const expired = evaluateGuard([account], { provider: "codex", window: "session", minimumPercent: 14, nowMs: Date.parse("2026-08-12T15:00:01Z") });
    expect(expired.decision).toBe("unknown");
    expect(expired.reason).toBe("session window already reset; no current reading");
  });

  test("allows capacity at or above the minimum", () => {
    const result = evaluateGuard([account], { provider: "codex", window: "weekly", minimumPercent: 14, nowMs });
    expect(result.decision).toBe("ok");
    expect(result.remainingPercent).toBe(14);
  });
});

describe("capacity alerts", () => {
  test("uses sparse thresholds and collapses large jumps", () => {
    expect(crossedWeeklyThreshold(31, 29)).toBe(30);
    expect(crossedWeeklyThreshold(29, 14)).toBe(15);
    expect(crossedWeeklyThreshold(16, 9)).toBe(10);
    expect(crossedWeeklyThreshold(11, 4)).toBe(5);
    expect(crossedWeeklyThreshold(4, 0)).toBe(0);
    expect(crossedWeeklyThreshold(31, 4)).toBe(5);
    expect(crossedWeeklyThreshold(14, 14)).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { crossedWeeklyThreshold } from "../src/capacity-alerts";
import { evaluateGuard } from "../src/guard";
import type { CodexLimitAccount } from "../src/limits";

const account: CodexLimitAccount = {
  provider: "codex",
  email: "work@example.com",
  plan: "Pro",
  devices: ["studio"],
  session: { usedPercent: 100, windowMinutes: 300 },
  weekly: { usedPercent: 86, windowMinutes: 10080 },
};

describe("capacity guard", () => {
  test("blocks below minimum and uses distinct unavailable exit code", () => {
    expect(evaluateGuard([account], { account: "work", window: "weekly", minimumPercent: 15 }).exitCode).toBe(1);
    expect(evaluateGuard([account], { account: "missing", window: "weekly", minimumPercent: 15 }).exitCode).toBe(69);
    expect(evaluateGuard([account], { account: "missing", window: "weekly", minimumPercent: 15, failOpen: true }).exitCode).toBe(0);
  });

  test("allows capacity at or above the minimum", () => {
    const result = evaluateGuard([account], { provider: "codex", window: "weekly", minimumPercent: 14 });
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

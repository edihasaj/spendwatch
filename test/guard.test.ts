import { describe, expect, test } from "bun:test";
import { capacityAlertTransitions, type CapacityAlertState } from "../src/capacity-alerts";
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
  test("detects exhaustion, recovery, forecast flips, and weekly thresholds", () => {
    const state = (key: string, window: "session" | "weekly", left: number, willLastToReset?: boolean): CapacityAlertState => ({
      key, window, left, willLastToReset, account: "work@example.com", provider: "codex",
    });
    const alerts = capacityAlertTransitions([
      state("session", "session", 10, true),
      state("weekly", "weekly", 20, true),
      state("recovered", "session", 0, false),
    ], [
      state("session", "session", 0, false),
      state("weekly", "weekly", 14, false),
      state("recovered", "session", 100, true),
    ], 15);
    expect(alerts.map((alert) => alert.kind)).toEqual(["ran-out", "run-out-risk", "low-weekly", "available"]);
  });
});

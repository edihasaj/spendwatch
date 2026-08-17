import { describe, expect, test } from "bun:test";
import { buildUtilizationPlans, planWindowUtilization } from "../src/capacity-planner";
import type { CodexLimitAccount, LimitWindow } from "../src/limits";

const reset = Date.parse("2026-08-18T00:00:00Z");
const window = (usedPercent: number): LimitWindow => ({
  usedPercent,
  resetsAt: new Date(reset).toISOString(),
  windowMinutes: 7 * 24 * 60,
});

describe("90% capacity utilization planning", () => {
  test("calculates the pace required from now to the target", () => {
    const plan = planWindowUtilization(window(45), Date.parse("2026-08-12T12:00:00Z"));
    expect(plan?.targetPercent).toBe(90);
    expect(plan?.remainingToTargetPercent).toBe(45);
    expect(plan?.rateUnit).toBe("day");
    expect(plan?.requiredRate).toBeCloseTo(8.18, 1);
    expect(plan?.projectedUsedPercent).toBeCloseTo(210, 0);
    expect(plan?.action).toBe("more");
  });

  test("uses live pace for routing during an early cycle", () => {
    const plan = planWindowUtilization(window(1), Date.parse("2026-08-11T06:00:00Z"));
    expect(plan?.confidence).toBe("early");
    expect(plan?.projectedUsedPercent).toBeCloseTo(28, 0);
    expect(plan?.action).toBe("rebalance");
  });

  test("shifts work away immediately when early live pace predicts exhaustion", () => {
    const plan = planWindowUtilization(window(29), Date.parse("2026-08-11T06:00:00Z"));
    expect(plan?.confidence).toBe("early");
    expect(plan?.projectedUsedPercent).toBeGreaterThan(100);
    expect(plan?.action).toBe("more");
  });

  test("recommends less only after a mature, deeply underused cycle", () => {
    const plan = planWindowUtilization(window(25), Date.parse("2026-08-15T12:00:00Z"));
    expect(plan?.elapsedFraction).toBeGreaterThan(0.5);
    expect(plan?.projectedUsedPercent).toBeLessThan(60);
    expect(plan?.action).toBe("less");
  });

  test("keeps a plan projected into the target band", () => {
    const plan = planWindowUtilization(window(50), Date.parse("2026-08-15T00:00:00Z"));
    expect(plan?.projectedUsedPercent).toBeCloseTo(87.5, 1);
    expect(plan?.action).toBe("keep");
  });

  test("treats an exhausted allowance as a capacity shortage", () => {
    const accounts: CodexLimitAccount[] = [
      { provider: "claude", email: "maxed@example.com", plan: "Max", weekly: window(100), devices: [] },
    ];
    const [plan] = buildUtilizationPlans(accounts, Date.parse("2026-08-15T00:00:00Z"));
    expect(plan?.action).toBe("more");
    expect(plan?.detail).toContain("Allowance exhausted before reset");
  });

  test("plans only subscription-backed capacity", () => {
    const accounts: CodexLimitAccount[] = [
      { provider: "codex", email: "codex@example.com", plan: "Pro", weekly: window(30), devices: [] },
      {
        provider: "copilot",
        email: "org (Business)",
        plan: "Business",
        devices: [],
        copilot: {
          chatUnlimited: false,
          completionsUnlimited: false,
          premiumUnlimited: false,
          premiumCreditsUsed: 42_000,
          overagePermitted: true,
          tokenBasedBilling: true,
        },
      },
      {
        provider: "lokai",
        email: "Kimi K3 Cloud",
        plan: "Moonshot API",
        devices: [],
        route: {
          ready: true,
          detail: "Cloud API",
          balances: [{ currency: "USD", total: 7.81, granted: 2.81, toppedUp: 5 }],
        },
      },
    ];
    const plans = buildUtilizationPlans(accounts, Date.parse("2026-08-15T00:00:00Z"));
    expect(plans).toHaveLength(2);
    expect(plans[1]?.resource).toBe("Monthly AI credit budget");
    expect(plans[1]?.currentValue).toBe("42,000 of 400,000 credits used");
    expect(plans[1]?.window?.currentUsedPercent).toBeCloseTo(10.5, 1);
    expect(plans[1]?.action).toBe("rebalance");
    expect(plans.some((plan) => plan.provider === "lokai")).toBe(false);
  });
});

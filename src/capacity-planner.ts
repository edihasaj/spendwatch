import type { CapacitySourceHealth } from "./capacity-dashboard";
import { predictWindow } from "./capacity-prediction";
import type { CapacityProvider, CodexLimitAccount, LimitWindow } from "./limits";

export const UTILIZATION_TARGET_PERCENT = 90;

export type UtilizationAction = "more" | "keep" | "less" | "rebalance" | "measure";
export type UtilizationConfidence = "early" | "live" | "learned" | "unavailable";

export interface WindowUtilizationPlan {
  targetPercent: number;
  currentUsedPercent: number;
  projectedUsedPercent?: number;
  remainingToTargetPercent: number;
  requiredRate?: number;
  rateUnit: "hour" | "day";
  resetsAt: string;
  elapsedFraction: number;
  action: Exclude<UtilizationAction, "measure">;
  confidence: Exclude<UtilizationConfidence, "unavailable">;
}

export interface AccountUtilizationPlan {
  provider: CapacityProvider;
  account: string;
  resource: string;
  action: UtilizationAction;
  confidence: UtilizationConfidence;
  window?: WindowUtilizationPlan;
  currentValue?: string;
  paceValue?: string;
  resetsAt?: string;
  detail: string;
}

export interface CapacityRecommendation {
  provider: "codex" | "claude";
  account: string;
  weeklyLeft: number;
  sessionLeft?: number;
  willLastToReset: boolean;
}

function validReset(window: LimitWindow, nowMs: number): number | undefined {
  if (!window.resetsAt || window.windowMinutes <= 0) return undefined;
  const resetAt = Date.parse(window.resetsAt);
  return Number.isFinite(resetAt) && resetAt > nowMs ? resetAt : undefined;
}

export function planWindowUtilization(
  window: LimitWindow,
  nowMs: number,
  targetPercent = UTILIZATION_TARGET_PERCENT,
): WindowUtilizationPlan | undefined {
  const resetAt = validReset(window, nowMs);
  if (resetAt === undefined) return undefined;
  const durationMs = window.windowMinutes * 60_000;
  const remainingMs = resetAt - nowMs;
  const elapsedFraction = Math.min(1, Math.max(0, 1 - remainingMs / durationMs));
  const currentUsedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const target = Math.min(100, Math.max(1, targetPercent));
  const remainingToTargetPercent = Math.max(0, target - currentUsedPercent);
  const rateUnit = window.windowMinutes <= 6 * 60 ? "hour" : "day";
  const unitMs = rateUnit === "hour" ? 60 * 60_000 : 24 * 60 * 60_000;
  const requiredRate = remainingMs > 0 ? remainingToTargetPercent / (remainingMs / unitMs) : undefined;
  const prediction = predictWindow(window, nowMs);
  const learned = prediction?.source === "reported";
  const minimumElapsed = rateUnit === "hour" ? 0.1 : 0.15;
  const projectedUsedPercent = elapsedFraction > 0
    ? currentUsedPercent / Math.max(elapsedFraction, 0.001)
    : undefined;
  const confidence: WindowUtilizationPlan["confidence"] = elapsedFraction < minimumElapsed
    ? "early"
    : learned ? "learned" : "live";

  let action: WindowUtilizationPlan["action"] = "keep";
  if (currentUsedPercent >= 100) action = "more";
  else if (prediction && !prediction.willLastToReset) action = "more";
  else if (projectedUsedPercent === undefined) action = "rebalance";
  else if (projectedUsedPercent > 105) action = "more";
  else if (projectedUsedPercent < 60 && elapsedFraction >= 0.5) action = "less";
  else if (projectedUsedPercent < 80) action = "rebalance";

  return {
    targetPercent: target,
    currentUsedPercent,
    projectedUsedPercent,
    remainingToTargetPercent,
    requiredRate,
    rateUnit,
    resetsAt: window.resetsAt!,
    elapsedFraction,
    action,
    confidence,
  };
}

function windowDetail(plan: WindowUtilizationPlan): string {
  if (plan.currentUsedPercent >= 100) return "Allowance exhausted before reset. Rebalance immediately, then add capacity if this pace is required.";
  if (plan.currentUsedPercent >= plan.targetPercent) return "Target reached. Preserve the 10% buffer until reset.";
  if (plan.confidence === "early" && plan.action === "more") return "Live pace would exhaust this allowance. Shift work to spare accounts now; wait for more cycle data before buying capacity.";
  if (plan.confidence === "early" && plan.action === "rebalance") return "Live pace is below the target. Route more suitable work here now; wait for more cycle data before changing the subscription.";
  if (plan.confidence === "early") return "Live pace is near the target. Keep routing here; wait for more cycle data before changing the subscription.";
  if (plan.action === "more") return "Projected to exceed the allowance. Shift work to spare accounts first, then add capacity or overage.";
  if (plan.action === "less") return "Projected below 60%. Confirm this for another cycle before downgrading or removing capacity.";
  if (plan.action === "rebalance") return "Below the 90% target pace. Route more suitable work here before buying more capacity elsewhere.";
  return "Projected near the 90% target. Keep the current subscription and pace.";
}

export function buildUtilizationPlans(
  accounts: CodexLimitAccount[],
  nowMs: number,
  targetPercent = UTILIZATION_TARGET_PERCENT,
): AccountUtilizationPlan[] {
  const plans: AccountUtilizationPlan[] = [];
  for (const account of accounts) {
    if ((account.provider === "codex" || account.provider === "claude") && account.weekly) {
      const window = planWindowUtilization(account.weekly, nowMs, targetPercent);
      if (window) {
        plans.push({
          provider: account.provider,
          account: account.email,
          resource: "Weekly allowance",
          action: window.action,
          confidence: window.confidence,
          window,
          detail: windowDetail(window),
        });
        continue;
      }
    }
    if (account.provider === "copilot" && account.copilot) {
      plans.push({
        provider: account.provider,
        account: account.email,
        resource: "Monthly AI credit pool",
        action: "measure",
        confidence: "unavailable",
        currentValue: `${Math.max(0, account.copilot.premiumCreditsUsed).toLocaleString()} credits used`,
        paceValue: "Pool total needed",
        resetsAt: account.copilot.resetsAt,
        detail: "Need organization seat count, shared-pool value, and paid-overage budget before a 90% target or purchase call is honest.",
      });
      continue;
    }
    if (account.provider === "codex" || account.provider === "claude") {
      plans.push({
        provider: account.provider,
        account: account.email,
        resource: "Capacity",
        action: "measure",
        confidence: "unavailable",
        detail: "A reset window or allowance total is required to calculate a 90% target.",
      });
    }
  }
  return plans;
}

function isFresh(account: CodexLimitAccount, sources: CapacitySourceHealth[], nowMs: number): boolean {
  const updatedAt = account.updatedAt ? Date.parse(account.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt) || nowMs - updatedAt > 5 * 60_000) return false;
  if (!sources.length || !account.devices.length) return true;
  const health = new Map(sources.map((source) => [source.device, source.status]));
  return account.devices.some((device) => health.get(device) === "live");
}

export function recommendAccount(
  accounts: CodexLimitAccount[],
  sources: CapacitySourceHealth[],
  nowMs: number,
): CapacityRecommendation | undefined {
  const ranked = accounts.flatMap((account) => {
    if ((account.provider !== "codex" && account.provider !== "claude") || !account.weekly || !isFresh(account, sources, nowMs)) return [];
    const weeklyLeft = Math.round(100 - account.weekly.usedPercent);
    const sessionLeft = account.session ? Math.round(100 - account.session.usedPercent) : undefined;
    if (weeklyLeft <= 0 || sessionLeft === 0) return [];
    const predictions = [account.session, account.weekly].flatMap((window) => window ? [predictWindow(window, nowMs)] : []).filter(Boolean);
    const willLastToReset = predictions.every((prediction) => prediction!.willLastToReset);
    const limitingLeft = Math.min(weeklyLeft, sessionLeft ?? 100);
    const score = weeklyLeft * 1.5 + limitingLeft - (willLastToReset ? 0 : 120);
    return [{ account, weeklyLeft, sessionLeft, willLastToReset, score }];
  }).sort((a, b) => b.score - a.score || a.account.email.localeCompare(b.account.email));
  const best = ranked[0];
  if (!best) return undefined;
  return {
    provider: best.account.provider as "codex" | "claude",
    account: best.account.email,
    weeklyLeft: best.weeklyLeft,
    sessionLeft: best.sessionLeft,
    willLastToReset: best.willLastToReset,
  };
}

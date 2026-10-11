import type { CodexLimitAccount, LimitWindow } from "./limits";

/** Manual monthly ceiling: 40,000 AI credits for $400. No seat maths, no promo windows. */
export const COPILOT_MONTHLY_CREDIT_BUDGET = 40_000;
export const COPILOT_MONTHLY_USD_BUDGET = 400;

export interface CopilotBudget {
  /** AI credits allowed per calendar month. */
  credits: number;
  /** Money allowed per calendar month. */
  usd: number;
  /** Derived price of one AI credit. */
  creditUsd: number;
  currency?: "EUR";
  amount?: number;
  usdToCurrency?: number;
  rateDate?: string;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function copilotBudget(env: Record<string, string | undefined> = process.env): CopilotBudget {
  const eur = positiveNumber(env.SPENDWATCH_COPILOT_MONTHLY_EUR);
  if (eur !== undefined) {
    const rate = positiveNumber(env.SPENDWATCH_USD_EUR_RATE);
    if (rate === undefined) throw new Error("EUR Copilot budget requires SPENDWATCH_USD_EUR_RATE");
    const creditUsd = 0.01;
    const usd = eur / rate;
    return { credits: Math.floor(usd / creditUsd + 1e-8), usd, creditUsd,
      currency: "EUR", amount: eur, usdToCurrency: rate, rateDate: env.SPENDWATCH_FX_RATE_DATE };
  }
  const credits = positiveNumber(env.SPENDWATCH_COPILOT_MONTHLY_CREDITS) ?? COPILOT_MONTHLY_CREDIT_BUDGET;
  const usd = positiveNumber(env.SPENDWATCH_COPILOT_MONTHLY_USD) ?? COPILOT_MONTHLY_USD_BUDGET;
  return { credits, usd, creditUsd: usd / credits };
}

export function formatCopilotMoney(usd: number, budget: CopilotBudget, maximumFractionDigits = 2): string {
  const value = usd * (budget.usdToCurrency ?? 1);
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: budget.currency ?? "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(value);
}

/** Reported monthly reset, or the next UTC month boundary when GitHub does not report one. */
export function copilotCycleReset(account: CodexLimitAccount, nowMs: number): { ms: number; iso: string } {
  const reported = account.copilot?.resetsAt;
  const reportedMs = reported ? Date.parse(reported) : Number.NaN;
  if (Number.isFinite(reportedMs) && reportedMs > nowMs) return { ms: reportedMs, iso: reported! };
  const now = new Date(nowMs);
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { ms, iso: new Date(ms).toISOString() };
}

/**
 * The monthly credit budget expressed as a normal capacity window so Copilot gets the same
 * pace, projection, and utilization treatment as the subscription providers.
 */
export function copilotCreditWindow(
  account: CodexLimitAccount,
  nowMs: number,
  budget: CopilotBudget = copilotBudget(),
): LimitWindow | undefined {
  if (account.provider !== "copilot" || !account.copilot) return undefined;
  const cycle = copilotCycleReset(account, nowMs);
  const reset = new Date(cycle.ms);
  const cycleStartMs = Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, reset.getUTCDate());
  const windowMinutes = Math.round((cycle.ms - cycleStartMs) / 60_000);
  const used = Math.max(0, account.copilot.premiumCreditsUsed);
  return {
    usedPercent: Math.min(100, (used / budget.credits) * 100),
    resetsAt: cycle.iso,
    windowMinutes,
  };
}

export interface CopilotBudgetStatus {
  budget: CopilotBudget;
  creditsUsed: number;
  usdSpent: number;
  /** Unclamped share of the monthly ceiling, so overspend stays visible. */
  usedPercent: number;
  /** Credits still inside the ceiling. */
  creditsLeft: number;
  /** Credits spent past the ceiling; 0 while inside it. */
  creditsOver: number;
  usdOver: number;
  over: boolean;
}

/**
 * The budget is a reporting ceiling, never an enforced stop: spending past it is allowed and
 * reported as an overspend rather than clamped away.
 */
export function copilotBudgetStatus(
  account: CodexLimitAccount,
  budget: CopilotBudget = copilotBudget(),
): CopilotBudgetStatus {
  const creditsUsed = Math.max(0, account.copilot?.premiumCreditsUsed ?? 0);
  const creditsOver = Math.max(0, creditsUsed - budget.credits);
  return {
    budget,
    creditsUsed,
    usdSpent: creditsUsed * budget.creditUsd,
    usedPercent: (creditsUsed / budget.credits) * 100,
    creditsLeft: Math.max(0, budget.credits - creditsUsed),
    creditsOver,
    usdOver: creditsOver * budget.creditUsd,
    over: creditsOver > 0,
  };
}

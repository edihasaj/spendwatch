import { windowFreshness } from "./capacity-freshness";
import type { CapacityProvider, CodexLimitAccount } from "./limits";

export type GuardWindow = "session" | "weekly";
export type GuardDecision = "ok" | "blocked" | "unknown";

export interface GuardResult {
  decision: GuardDecision;
  exitCode: 0 | 1 | 69;
  provider?: CapacityProvider;
  account?: string;
  window: GuardWindow;
  remainingPercent?: number;
  minimumPercent: number;
  reason: string;
}

export function evaluateGuard(
  accounts: CodexLimitAccount[],
  options: { account?: string; provider?: CapacityProvider; window: GuardWindow; minimumPercent: number; failOpen?: boolean; nowMs?: number },
): GuardResult {
  const nowMs = options.nowMs ?? Date.now();
  const matches = accounts.filter((account) => {
    if (options.provider && account.provider !== options.provider) return false;
    return !options.account || account.email.toLowerCase().includes(options.account.toLowerCase());
  });
  const unknown = (reason: string): GuardResult => ({
    decision: "unknown",
    exitCode: options.failOpen ? 0 : 69,
    window: options.window,
    minimumPercent: options.minimumPercent,
    reason,
  });
  if (!matches.length) return unknown("no matching account");
  if (matches.length > 1) return unknown("account match is ambiguous");
  const account = matches[0]!;
  const window = account[options.window];
  if (!window) return { ...unknown(`${options.window} window unavailable`), provider: account.provider, account: account.email };
  // Deciding on an expired or unrefreshed sample would let a spent quota look
  // healthy, which is the exact failure a guard exists to prevent.
  const freshness = windowFreshness(window, account.updatedAt, nowMs);
  if (freshness !== "live") {
    return {
      ...unknown(freshness === "expired"
        ? `${options.window} window already reset; no current reading`
        : `${options.window} reading is not current`),
      provider: account.provider,
      account: account.email,
    };
  }
  const remainingPercent = Math.max(0, 100 - window.usedPercent);
  const blocked = remainingPercent < options.minimumPercent;
  return {
    decision: blocked ? "blocked" : "ok",
    exitCode: blocked ? 1 : 0,
    provider: account.provider,
    account: account.email,
    window: options.window,
    remainingPercent,
    minimumPercent: options.minimumPercent,
    reason: blocked ? "remaining capacity is below minimum" : "remaining capacity meets minimum",
  };
}

export function renderGuardResult(result: GuardResult): string {
  const remaining = result.remainingPercent === undefined ? "unavailable" : `${Math.round(result.remainingPercent)}%`;
  const target = result.account ? `${result.provider} · ${result.account}` : "capacity";
  return `${result.decision.toUpperCase()}\t${target}\t${result.window} ${remaining}\tminimum ${result.minimumPercent}%\t${result.reason}\n`;
}

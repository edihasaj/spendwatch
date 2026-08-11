import { predictWindow } from "./capacity-prediction";
import type { CodexLimitAccount } from "./limits";

export interface CapacityAlertState {
  key: string;
  account: string;
  provider: string;
  window: "session" | "weekly";
  left: number;
  resetsAt?: string;
  willLastToReset?: boolean;
}

export interface CapacityAlert {
  kind: "ran-out" | "available" | "run-out-risk" | "low-weekly";
  title: string;
  body: string;
}

export function capacityAlertSnapshot(accounts: CodexLimitAccount[], nowMs: number): CapacityAlertState[] {
  return accounts.flatMap((account) => ([
    ["session", account.session],
    ["weekly", account.weekly],
  ] as const).flatMap(([kind, window]) => {
    if (!window) return [];
    return [{
      key: `${account.provider}:${account.email.toLowerCase()}:${kind}`,
      account: account.email,
      provider: account.provider,
      window: kind,
      left: Math.round(100 - window.usedPercent),
      resetsAt: window.resetsAt,
      willLastToReset: predictWindow(window, nowMs)?.willLastToReset,
    }];
  }));
}

export function capacityAlertTransitions(
  previous: CapacityAlertState[],
  current: CapacityAlertState[],
  weeklyThreshold = 15,
): CapacityAlert[] {
  const before = new Map(previous.map((state) => [state.key, state]));
  const alerts: CapacityAlert[] = [];
  for (const state of current) {
    const prior = before.get(state.key);
    if (!prior) continue;
    const label = `${state.provider} · ${state.account}`;
    const window = state.window === "session" ? "5-hour window" : "weekly window";
    if (prior.left > 0 && state.left <= 0) {
      alerts.push({ kind: "ran-out", title: `${window} ran out`, body: label });
    } else if (prior.left <= 0 && state.left > 0) {
      alerts.push({ kind: "available", title: `${window} available`, body: `${label} · ${state.left}% left` });
    }
    if (prior.willLastToReset === true && state.willLastToReset === false && state.left > 0) {
      alerts.push({ kind: "run-out-risk", title: "Run-out forecast changed", body: `${label} · ${window} may run out early` });
    }
    if (state.window === "weekly" && prior.left > weeklyThreshold && state.left <= weeklyThreshold && state.left > 0) {
      alerts.push({ kind: "low-weekly", title: `${state.left}% weekly capacity left`, body: label });
    }
  }
  return alerts;
}

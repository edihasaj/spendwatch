// Pace from the whole cycle answers "how have I been spending", which is the
// wrong question when a burst starts: the average hides it until the damage is
// done. This measures the recent slope inside the current cycle and compares it
// with the rate the remaining allowance can actually afford, so a change in
// behaviour is visible while there is still time to act on it.
import { Database } from "./database";
import { windowFreshness } from "./capacity-freshness";
import type { CodexLimitAccount, LimitWindow } from "./limits";

export type BurnWindowKind = "session" | "weekly";

export interface BurnForecast {
  /** Recent spend, percentage points of the allowance per hour. */
  ratePerHour: number;
  /** Rate the remaining allowance affords from now until reset. */
  sustainableRatePerHour: number;
  /** ratePerHour / sustainableRatePerHour; 1 means exactly on budget. */
  budgetMultiple?: number;
  lookbackMinutes: number;
  sampleCount: number;
  lastsToReset: boolean;
  runsOutAt?: string;
  /** How long before the reset the allowance runs out at this rate. */
  earlyByMinutes?: number;
}

export interface AccountBurnForecasts {
  session?: BurnForecast;
  weekly?: BurnForecast;
}

export interface BurnSample {
  sampledAt: number;
  usedPercent: number;
  resetsAt: number | null;
}

const MIN_SAMPLES = 3;
const CYCLE_BUCKET_MS = 60_000;
// A drop this large within a cycle means the provider rolled the window over.
const RESET_DROP_PERCENT = 8;

export function burnLookbackMinutes(windowMinutes: number): number {
  return Math.min(360, Math.max(30, Math.round(windowMinutes * 0.1)));
}

function cycleBucket(resetsAt: number | null | undefined): number | undefined {
  return resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)
    ? undefined
    : Math.round(resetsAt / CYCLE_BUCKET_MS);
}

/** Samples from the current cycle only, newest last. */
export function currentCycleSamples(samples: BurnSample[], window: LimitWindow): BurnSample[] {
  const cycle = cycleBucket(window.resetsAt ? Date.parse(window.resetsAt) : undefined);
  const ordered = [...samples].sort((a, b) => a.sampledAt - b.sampledAt);
  const matching = cycle === undefined
    ? ordered
    : ordered.filter((sample) => cycleBucket(sample.resetsAt) === cycle);
  let start = 0;
  for (let index = 1; index < matching.length; index++) {
    if (matching[index]!.usedPercent + RESET_DROP_PERCENT < matching[index - 1]!.usedPercent) start = index;
  }
  return matching.slice(start);
}

/** Least squares slope in percentage points per hour; quantized readings make endpoint deltas jumpy. */
function slopePerHour(samples: BurnSample[]): number | undefined {
  if (samples.length < MIN_SAMPLES) return undefined;
  const meanTime = samples.reduce((total, sample) => total + sample.sampledAt, 0) / samples.length;
  const meanUsed = samples.reduce((total, sample) => total + sample.usedPercent, 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of samples) {
    const timeDelta = sample.sampledAt - meanTime;
    covariance += timeDelta * (sample.usedPercent - meanUsed);
    variance += timeDelta * timeDelta;
  }
  if (variance <= 0) return undefined;
  return (covariance / variance) * 3_600_000;
}

export function burnForecast(samples: BurnSample[], window: LimitWindow, nowMs: number): BurnForecast | undefined {
  if (!window.resetsAt) return undefined;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt <= nowMs) return undefined;
  // An exhausted window has nothing left to pace, and dividing by it would
  // report a meaningless "0%/h vs safe 0%/h".
  const remaining = Math.max(0, 100 - window.usedPercent);
  if (remaining <= 0) return undefined;
  const lookbackMinutes = burnLookbackMinutes(window.windowMinutes);
  const cycle = currentCycleSamples(samples, window);
  const recent = cycle.filter((sample) => sample.sampledAt >= nowMs - lookbackMinutes * 60_000);
  const slope = slopePerHour(recent);
  if (slope === undefined) return undefined;

  const ratePerHour = Math.max(0, slope);
  const hoursToReset = (resetsAt - nowMs) / 3_600_000;
  const sustainableRatePerHour = remaining / hoursToReset;
  const hoursLeftAtRate = ratePerHour > 0 ? remaining / ratePerHour : Number.POSITIVE_INFINITY;
  const lastsToReset = hoursLeftAtRate >= hoursToReset;
  return {
    ratePerHour,
    sustainableRatePerHour,
    budgetMultiple: sustainableRatePerHour > 0 ? ratePerHour / sustainableRatePerHour : undefined,
    lookbackMinutes,
    sampleCount: recent.length,
    lastsToReset,
    runsOutAt: lastsToReset ? undefined : new Date(nowMs + hoursLeftAtRate * 3_600_000).toISOString(),
    earlyByMinutes: lastsToReset ? undefined : Math.round((hoursToReset - hoursLeftAtRate) * 60),
  };
}

export function loadBurnForecasts(
  path: string,
  accounts: CodexLimitAccount[],
  nowMs: number,
): Map<string, AccountBurnForecasts> {
  const forecasts = new Map<string, AccountBurnForecasts>();
  const windows = accounts.flatMap((account) => (["session", "weekly"] as const).flatMap((kind) => {
    const window = account[kind];
    return window && windowFreshness(window, account.updatedAt, nowMs) === "live"
      ? [{ account, kind, window, sinceMs: nowMs - burnLookbackMinutes(window.windowMinutes) * 60_000 }]
      : [];
  }));
  // Old readings still age on every render without opening a remote connection.
  if (!windows.length) return forecasts;
  const db = new Database(path, { readonly: true });
  try {
    type Row = BurnSample & { provider: string; account: string; kind: BurnWindowKind };
    const rows = db.query<Row, (string | number)[]>(`
      SELECT provider, account COLLATE NOCASE AS account, window_kind AS kind,
        sampled_at_ms AS sampledAt, MAX(used_percent) AS usedPercent, MAX(resets_at_ms) AS resetsAt
      FROM capacity_history
      WHERE ${windows.map(() =>
        "(provider = ? AND account = ? COLLATE NOCASE AND window_kind = ? AND sampled_at_ms >= ?)").join(" OR ")}
      GROUP BY provider, account COLLATE NOCASE, window_kind, sampled_at_ms
      ORDER BY sampled_at_ms
    `).all(...windows.flatMap(({ account, kind, sinceMs }) => [account.provider, account.email, kind, sinceMs]));
    const samples = new Map<string, BurnSample[]>();
    const key = (provider: string, email: string, kind: string) => JSON.stringify([provider, email.toLowerCase(), kind]);
    for (const row of rows) {
      const identity = key(row.provider, row.account, row.kind);
      const group = samples.get(identity) ?? [];
      group.push(row); samples.set(identity, group);
    }
    for (const { account, kind, window } of windows) {
      const forecast = burnForecast(samples.get(key(account.provider, account.email, kind)) ?? [], window, nowMs);
      if (!forecast) continue;
      const identity = `${account.provider}:${account.email.toLowerCase()}`;
      const entry = forecasts.get(identity) ?? {};
      entry[kind] = forecast;
      forecasts.set(identity, entry);
    }
  } finally {
    db.close();
  }
  return forecasts;
}

export function attachBurnForecasts(path: string, accounts: CodexLimitAccount[], nowMs: number): void {
  const forecasts = loadBurnForecasts(path, accounts, nowMs);
  for (const account of accounts) {
    const entry = forecasts.get(`${account.provider}:${account.email.toLowerCase()}`);
    if (account.session) account.session.burn = entry?.session;
    if (account.weekly) account.weekly.burn = entry?.weekly;
  }
}

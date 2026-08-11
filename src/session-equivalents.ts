import { Database } from "bun:sqlite";
import type { CodexLimitAccount, SessionEquivalentForecast } from "./limits";

interface PairedRow {
  provider: string;
  account: string;
  sampledAt: number;
  sessionUsed: number;
  sessionReset: number | null;
  weeklyUsed: number;
  weeklyReset: number | null;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function loadSessionEquivalentForecasts(
  path: string,
  accounts: CodexLimitAccount[],
  nowMs: number,
): Map<string, SessionEquivalentForecast> {
  const db = new Database(path, { readonly: true });
  const rows = db.query<PairedRow, []>(`
    SELECT s.provider, s.account, s.sampled_at_ms AS sampledAt,
      s.used_percent AS sessionUsed, s.resets_at_ms AS sessionReset,
      w.used_percent AS weeklyUsed, w.resets_at_ms AS weeklyReset
    FROM capacity_history s
    JOIN capacity_history w ON w.provider = s.provider AND w.account = s.account
      AND w.sampled_at_ms = s.sampled_at_ms AND w.window_kind = 'weekly'
    WHERE s.window_kind = 'session'
    ORDER BY s.provider, s.account, s.sampled_at_ms
  `).all();
  db.close();

  const grouped = new Map<string, PairedRow[]>();
  for (const row of rows) {
    const key = `${row.provider}:${row.account.toLowerCase()}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const forecasts = new Map<string, SessionEquivalentForecast>();
  for (const account of accounts) {
    if (!account.weekly) continue;
    const key = `${account.provider}:${account.email.toLowerCase()}`;
    const samples = grouped.get(key) ?? [];
    const burns: number[] = [];
    let start = samples[0];
    let previous = samples[0];
    for (const sample of samples.slice(1)) {
      if (!start || !previous) break;
      if (sample.weeklyReset !== start.weeklyReset) {
        start = sample;
        previous = sample;
        continue;
      }
      const reset = sample.sessionReset !== previous.sessionReset || sample.sessionUsed + 8 < previous.sessionUsed;
      if (reset) {
        const burn = sample.weeklyUsed - start.weeklyUsed;
        if (burn >= 0.1 && burn <= 100) burns.push(burn);
        start = sample;
      }
      previous = sample;
    }
    const recent = burns.slice(-20);
    if (recent.length < 3) continue;
    const medianWeeklyBurn = median(recent);
    const weeklyLeft = Math.max(0, 100 - account.weekly.usedPercent);
    const resetAt = account.weekly.resetsAt ? Date.parse(account.weekly.resetsAt) : Number.NaN;
    forecasts.set(key, {
      estimatedQuotasLeft: Math.max(0, Math.floor(weeklyLeft / medianWeeklyBurn)),
      sampleCount: recent.length,
      medianWeeklyBurn,
      windowsUntilReset: Number.isFinite(resetAt) ? Math.max(0, Math.ceil((resetAt - nowMs) / (5 * 60 * 60_000))) : undefined,
    });
  }
  return forecasts;
}

export function attachSessionEquivalentForecasts(path: string, accounts: CodexLimitAccount[], nowMs: number): void {
  const forecasts = loadSessionEquivalentForecasts(path, accounts, nowMs);
  for (const account of accounts) account.sessionEquivalent = forecasts.get(`${account.provider}:${account.email.toLowerCase()}`);
}

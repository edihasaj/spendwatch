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
  const grouped = new Map<string, PairedRow[]>();
  const pairedSamples = db.query<PairedRow, [string, string]>(`
    WITH session_samples AS (
      SELECT provider, account, sampled_at_ms,
        MAX(used_percent) AS used_percent, MAX(resets_at_ms) AS resets_at_ms
      FROM capacity_history
      WHERE provider = ?1 AND account = ?2 AND window_kind = 'session'
      GROUP BY provider, account, sampled_at_ms
    ), weekly_samples AS (
      SELECT provider, account, sampled_at_ms,
        MAX(used_percent) AS used_percent, MAX(resets_at_ms) AS resets_at_ms
      FROM capacity_history
      WHERE provider = ?1 AND account = ?2 AND window_kind = 'weekly'
      GROUP BY provider, account, sampled_at_ms
    )
    SELECT s.provider, s.account, s.sampled_at_ms AS sampledAt,
      s.used_percent AS sessionUsed, s.resets_at_ms AS sessionReset,
      w.used_percent AS weeklyUsed, w.resets_at_ms AS weeklyReset
    FROM session_samples s
    JOIN weekly_samples w ON w.sampled_at_ms = s.sampled_at_ms
    ORDER BY s.sampled_at_ms DESC
    LIMIT 5000
  `);
  for (const account of accounts) {
    if (!account.weekly) continue;
    const key = `${account.provider}:${account.email.toLowerCase()}`;
    grouped.set(key, pairedSamples.all(account.provider, account.email).reverse());
  }
  db.close();
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

export interface TokenDays {
  timeZone: string;
  measuredAt: number;
  rows: Array<{day: string; model: string; tokens: number}>;
}

/** Calendar buckets of deduplicated provider usage, never prompt-size estimates. */
export class TokenDayAccumulator {
  private rows = new Map<string, {day: string; model: string; tokens: number}>();
  private format: Intl.DateTimeFormat;
  constructor(private timeZone = process.env.SPENDWATCH_TOKEN_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.format = new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit"});
  }
  add(ts: number, model: string, tokens: number): void {
    if (!Number.isFinite(ts) || ts <= 0 || !Number.isSafeInteger(tokens) || tokens < 0) return;
    const parts = this.format.formatToParts(ts);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const key = JSON.stringify([day, model]);
    const row = this.rows.get(key) || {day, model, tokens: 0};
    row.tokens += tokens;
    this.rows.set(key, row);
  }
  snapshot(measuredAt = Date.now()): TokenDays {
    return {timeZone: this.timeZone, measuredAt, rows: [...this.rows.values()].sort((a, b) =>
      a.day.localeCompare(b.day) || a.model.localeCompare(b.model))};
  }
}
import type {Database} from "bun:sqlite";
import type {Report} from "./aggregate";


/**
 * How a run's daily buckets meet what the archive already holds.
 * - "replace": this run saw the whole month (its full report was accepted), so
 *   its own days are the truth and the previous rows for them are stale.
 * - "merge": the archive kept a fuller read, so only raise a day that this run
 *   measured higher — never shrink one from a partial re-read.
 */
export function archiveTokenDays(db: Database, report: Report, source: string, mode: "replace" | "merge" = "merge"): void {
  const daily = report.tokenDays;
  if (!daily || !Number.isSafeInteger(daily.measuredAt) || daily.measuredAt <= 0) return;
  new Intl.DateTimeFormat("en-CA", {timeZone: daily.timeZone}).format(daily.measuredAt);
  const keys = new Set<string>();
  let total = 0;
  for (const row of daily.rows) {
    const key = JSON.stringify([row.day, row.model]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || typeof row.model !== "string" ||
        !Number.isSafeInteger(row.tokens) || row.tokens < 0 || keys.has(key)) return;
    keys.add(key); total += row.tokens;
  }
  if (total !== report.totalTokens) return; // missing timestamps are not measured zero
  if (mode === "replace" && report.period) {
    // Day keys are ISO in this timezone, so a text range covers the period.
    const day = (ts: number) => new Intl.DateTimeFormat("en-CA", {timeZone: daily.timeZone}).format(ts);
    db.prepare("DELETE FROM spend_token_day WHERE source = ? AND time_zone = ? AND day >= ? AND day <= ?")
      .run(source, daily.timeZone, day(report.period.from), day(report.period.to - 1));
  }
  db.prepare(`
    INSERT INTO spend_token_capture VALUES (?,?,?,?)
    ON CONFLICT(source,time_zone,month) DO UPDATE SET
      measured_at=MAX(spend_token_capture.measured_at,excluded.measured_at)
  `).run(source, daily.timeZone, report.period!.key, daily.measuredAt);
  const upsert = db.prepare(`
    INSERT INTO spend_token_day VALUES (?,?,?,?,?,?)
    ON CONFLICT(day,source,time_zone,model) DO UPDATE SET
      measured_at=CASE WHEN excluded.tokens>=spend_token_day.tokens THEN excluded.measured_at ELSE spend_token_day.measured_at END,
      tokens=MAX(spend_token_day.tokens,excluded.tokens)
  `);
  for (const row of daily.rows) upsert.run(row.day, source, daily.timeZone, row.model, row.tokens, daily.measuredAt);
}

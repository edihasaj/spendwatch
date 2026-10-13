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

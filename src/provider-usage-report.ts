/**
 * Per-provider evidence recorded beside a normal machine report. It is a
 * projection of the report's own calls, never an account API total: OpenRouter
 * activity has no machine key and must stay separate from this data.
 */
export interface ProviderUsageRow {
  day: string;
  model: string;
  tokens: number;
  cost: number;
  calls: number;
  /** Calls with no matching dated catalog rate. Their $ estimate is unavailable, not zero. */
  unpricedCalls: number;
}

export interface ProviderUsage {
  provider: "openrouter";
  /** Fixed UTC buckets make reports from different machines safely mergeable. */
  timeZone: "UTC";
  tokens: number;
  cost: number;
  calls: number;
  unpricedCalls: number;
  rows: ProviderUsageRow[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown, max = 300): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const whole = (value: unknown): value is number => Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Reject malformed nested archived JSON before it reaches a page or a merge. */
export function validateProviderUsage(value: unknown, report?: { totalTokens: number; totalCost: number; apiCalls: number }): ProviderUsage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seenProviders = new Set<string>();
  const result: ProviderUsage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const usage = entry as Partial<ProviderUsage>;
    if (usage.provider !== "openrouter" || usage.timeZone !== "UTC" || seenProviders.has(usage.provider) ||
        !whole(usage.tokens) || !amount(usage.cost) || !whole(usage.calls) || !whole(usage.unpricedCalls) || usage.unpricedCalls > usage.calls || !Array.isArray(usage.rows)) return undefined;
    seenProviders.add(usage.provider);
    const keys = new Set<string>();
    let tokens = 0, cost = 0, calls = 0, unpricedCalls = 0;
    const rows: ProviderUsageRow[] = [];
    for (const candidate of usage.rows) {
      if (!candidate || typeof candidate !== "object") return undefined;
      const row = candidate as Partial<ProviderUsageRow>;
      if (!text(row.day, 10) || !DAY.test(row.day) || !text(row.model) || !whole(row.tokens) || !amount(row.cost) || !whole(row.calls) || !whole(row.unpricedCalls) || row.unpricedCalls > row.calls) return undefined;
      const key = JSON.stringify([row.day, row.model]);
      if (keys.has(key)) return undefined;
      keys.add(key); tokens += row.tokens; cost += row.cost; calls += row.calls; unpricedCalls += row.unpricedCalls;
      rows.push({ day: row.day, model: row.model, tokens: row.tokens, cost: row.cost, calls: row.calls, unpricedCalls: row.unpricedCalls });
    }
    if (tokens !== usage.tokens || calls !== usage.calls || unpricedCalls !== usage.unpricedCalls || Math.abs(cost - usage.cost) > 1e-8) return undefined;
    result.push({ provider: "openrouter", timeZone: "UTC", tokens, cost, calls, unpricedCalls, rows: rows.sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)) });
  }
  if (report) {
    if (!whole(report.totalTokens) || !amount(report.totalCost) || !whole(report.apiCalls)) return undefined;
    const totals = result.reduce((sum, item) => ({ tokens: sum.tokens + item.tokens, cost: sum.cost + item.cost, calls: sum.calls + item.calls }), { tokens: 0, cost: 0, calls: 0 });
    if (totals.tokens > report.totalTokens || totals.calls > report.apiCalls || totals.cost > report.totalCost + 1e-8) return undefined;
  }
  return result;
}

export class ProviderUsageAccumulator {
  private rows = new Map<string, ProviderUsageRow>();

  add(provider: string | undefined, timestamp: number, model: string | undefined, tokens: number, cost: number, priceKnown: boolean): void {
    if (provider?.toLowerCase() !== "openrouter" || !Number.isFinite(timestamp) || timestamp <= 0 || !text(model) ||
        !whole(tokens) || !amount(cost)) return;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const key = JSON.stringify([day, model]);
    const row = this.rows.get(key) ?? { day, model, tokens: 0, cost: 0, calls: 0, unpricedCalls: 0 };
    row.tokens += tokens; row.cost += cost; row.calls++; if (!priceKnown) row.unpricedCalls++;
    this.rows.set(key, row);
  }

  snapshot(): ProviderUsage[] | undefined {
    const rows = [...this.rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
    if (!rows.length) return undefined;
    return [{ provider: "openrouter", timeZone: "UTC", tokens: rows.reduce((n, row) => n + row.tokens, 0), cost: rows.reduce((n, row) => n + row.cost, 0), calls: rows.reduce((n, row) => n + row.calls, 0), unpricedCalls: rows.reduce((n, row) => n + row.unpricedCalls, 0), rows }];
  }
}

/** Combines only already-validated report-local call evidence. */
export function mergeProviderUsage(values: Array<ProviderUsage[] | undefined>): ProviderUsage[] | undefined {
  const rows = new Map<string, ProviderUsageRow>();
  for (const value of values) for (const usage of value ?? []) for (const row of usage.rows) {
    const key = JSON.stringify([row.day, row.model]);
    const current = rows.get(key) ?? { ...row, tokens: 0, cost: 0, calls: 0, unpricedCalls: 0 };
    current.tokens += row.tokens; current.cost += row.cost; current.calls += row.calls; current.unpricedCalls += row.unpricedCalls;
    rows.set(key, current);
  }
  const list = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
  return list.length ? [{ provider: "openrouter", timeZone: "UTC", tokens: list.reduce((n, row) => n + row.tokens, 0), cost: list.reduce((n, row) => n + row.cost, 0), calls: list.reduce((n, row) => n + row.calls, 0), unpricedCalls: list.reduce((n, row) => n + row.unpricedCalls, 0), rows: list }] : undefined;
}

/** Remove exactly the settled calls identified by their UTC day/model/vector. */
export function withoutProviderUsageCalls(value: ProviderUsage[] | undefined, calls: Array<{ provider?: string; priceKnown?: boolean; ts: number; model: string; tokens: number; cost: number }>): ProviderUsage[] | undefined {
  const valid = validateProviderUsage(value);
  if (!valid?.length) return valid;
  const remaining = valid.map((usage) => ({ ...usage, rows: usage.rows.map((row) => ({ ...row })) }));
  for (const call of calls) {
    if (call.provider?.toLowerCase() !== "openrouter" || !Number.isFinite(call.ts) || call.ts <= 0) continue;
    const day = new Date(call.ts).toISOString().slice(0, 10);
    const row = remaining[0]!.rows.find((item) => item.day === day && item.model === call.model && item.tokens >= call.tokens && item.calls > 0);
    if (!row) continue; // Preserve ambiguous evidence rather than subtract a guess.
    row.tokens -= call.tokens; row.cost = Math.max(0, row.cost - call.cost); row.calls--; if (call.priceKnown === false) row.unpricedCalls--;
  }
  const rows = remaining[0]!.rows.filter((row) => row.calls > 0);
  return rows.length ? [{ provider: "openrouter", timeZone: "UTC", tokens: rows.reduce((n, row) => n + row.tokens, 0), cost: rows.reduce((n, row) => n + row.cost, 0), calls: rows.reduce((n, row) => n + row.calls, 0), unpricedCalls: rows.reduce((n, row) => n + row.unpricedCalls, 0), rows }] : undefined;
}

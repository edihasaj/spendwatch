// Reads the `agent-usage.v1` record an agent writes about its own usage, for agents that leave no transcripts
// (Mission Runtime, AutoReview). A record is cumulative for one attempt and holds one entry per driver and model.
import type { Event } from "./parse";

export interface AgentUsageEntry {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
  cost_usd_micros?: unknown;
  driver_id?: unknown;
  provider_id?: unknown;
  model?: unknown;
  turns?: unknown;
}

export interface AgentUsageRecord {
  usage_version: "agent-usage.v1";
  attempt_id: string;
  updated_at?: unknown;
  project?: unknown;
  entries: AgentUsageEntry[];
}

/** What one entry of a record bills: its place in the record, a name unique within it, and the events that fold it. */
export interface EntryEvents {
  entry: AgentUsageEntry;
  /** Position in `record.entries`, whatever is skipped. */
  index: number;
  /** `<driver_id>:<model>`; a repeat of the same pair within one record gets `#2`, `#3`, ... so no entry is lost. */
  id: string;
  events: Event[];
}

/** A finite, non-negative number, else 0. */
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const text = (value: unknown): string => typeof value === "string" && value ? value : "unknown";

/** The last segment of `owner/repo`, or "?" when there is none. */
export function projectName(repository: unknown): string {
  if (typeof repository !== "string") return "?";
  const last = repository.split("/").map((part) => part.trim()).filter(Boolean).pop();
  return last ?? "?";
}

/** The record in `value` (a parsed object or JSON text), or undefined when it is not an `agent-usage.v1` record. */
export function asUsageRecord(value: unknown): AgentUsageRecord | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.usage_version !== "agent-usage.v1") return undefined;
    if (typeof record.attempt_id !== "string" || !record.attempt_id || !Array.isArray(record.entries)) return undefined;
    return record as unknown as AgentUsageRecord;
  } catch { return undefined; }
}

/**
 * The events of each billable entry of a record, billed at `ts` under `project`. `input_tokens` is gross (it holds the
 * cached and cache-write tokens), so the uncached input is what is left of it. An entry that reports no tokens is
 * skipped, and a malformed record gives nothing; this never throws.
 */
export function usageEvents(record: unknown, ctx: { ts: number; project: string }): EntryEvents[] {
  const parsed = asUsageRecord(record);
  if (!parsed) return [];
  const out: EntryEvents[] = [];
  const seen = new Map<string, number>();
  parsed.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const input = count(entry.input_tokens), cached = count(entry.cached_input_tokens);
    const cacheWrite = count(entry.cache_write_input_tokens), output = count(entry.output_tokens);
    if (!(input || cached || cacheWrite || output)) return;
    const name = `${text(entry.driver_id)}:${text(entry.model)}`;
    const times = (seen.get(name) ?? 0) + 1;
    seen.set(name, times);
    const id = times > 1 ? `${name}#${times}` : name;
    const sessionId = parsed.attempt_id;
    const cost = entry.cost_usd_micros;
    out.push({
      entry, index, id,
      events: [
        { t: "meta", sessionId, project: ctx.project, ts: 0 },
        { t: "api", sessionId, requestId: `${sessionId}:${id}`, model: text(entry.model),
          usage: { input: Math.max(0, input - cached - cacheWrite), output, cacheRead: cached, cache5m: cacheWrite, cache1h: 0 },
          costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost / 1e6 : undefined,
          sidechain: false, ts: ctx.ts },
      ],
    });
  });
  return out;
}

/** The account an entry belongs to: the one a config names, else the provider it ran on. */
export function entryAccount(entry: AgentUsageEntry, account?: string): string {
  return account ?? (typeof entry.provider_id === "string" && entry.provider_id ? entry.provider_id : "default");
}

/** Whether `project` contains the `--project` filter, ignoring case; no filter keeps everything. */
export function inProject(project: string, filter?: string): boolean {
  return !filter || project.toLowerCase().includes(filter.toLowerCase());
}

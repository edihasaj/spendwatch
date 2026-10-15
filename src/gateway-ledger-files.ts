// Reading the gateway's month ledger files (`usage/usage-YYYY-MM.jsonl`) into rows. Only the fields below are read,
// so a field the gateway adds later stays out of every report.
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_TYPES, vendorIn, type GatewayVendor } from "./gateway-config";

/** A gateway-routed response carries this marker on its id; anything else is an ordinary provider call. */
export const MARKER = "resp_gl_";
export const GATEWAY_ORIGIN = "gateway";
export const TELEMETRY_ORIGIN = "telemetry";

export interface LedgerRow {
  at: number;
  host: string;
  requestId: string;
  responseId: string;
  model: string;
  origin: string;
  vendor: GatewayVendor;
  /** The route id the gateway served the call through; it names the account the call was billed to. */
  provider: string;
  session?: boolean;
  input: number; // gross input tokens, cache included, as the transcript reports them
  cached: number;
  cacheWrite: number;
  output: number;
  /** Reasoning tokens are a subset of output, so they are read but never added. */
  reasoning: number;
  nanoAiu: number | null;
  nanoAiuStatus?: string;
  claimed: boolean;
  /** A rollout already billed this call (see `GatewayLedger.adopt`), so the ledger must not. */
  rolloutBilled: boolean;
}

/** One call, however many rows record it. */
export const callKey = (row: LedgerRow): string => `${row.host}:${row.requestId}`;

/**
 * A token count. The gateway writes whole numbers from 0 up, so a number outside that (negative, fractional, infinite,
 * beyond what a double counts exactly) is not a count it wrote: `undefined`, and the row is dropped rather than
 * billed. A field that is missing or not a number at all reads as 0.
 */
function tokens(value: unknown): number | undefined {
  if (typeof value !== "number") return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Credits in nano-AIU: a figure the ledger could not have written is no figure at all (the call is `unpriced`). */
const credits = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

/** Milliseconds since the epoch, or NaN when the value is no time a `Date` can hold (a number past ±8.64e15 too). */
function timestamp(raw: unknown): number {
  const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return new Date(ms).getTime();
}

/** Month ledgers overlapping [sinceMs, now], oldest file first. */
export function ledgerFiles(usage: string, sinceMs: number): string[] {
  const now = Date.now();
  return safeReaddir(usage)
    .filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name))
    .filter((name) => inWindow(name.slice(6, 13), sinceMs, now))
    .sort()
    .map((name) => join(usage, name));
}

// The gateway names its month files by UTC month (usage-YYYY-MM.jsonl), so the window is UTC too: east
// of UTC the previous UTC month holds the first hours of the new local month.
function inWindow(key: string, sinceMs: number, nowMs: number): boolean {
  const [year, month] = key.split("-").map(Number);
  const from = Date.UTC(year!, month! - 1, 1);
  if (!Number.isFinite(from)) return false;
  return Date.UTC(year!, month!, 1) > sinceMs && from <= nowMs;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The rows of one month file from byte `from` on, and where the next read starts: after the last complete line. A
 * line the gateway is still appending is read again next time, whole; a row it holds twice is deduped by `callKey`.
 * `mtime` is the file's modification time at that read (undefined when it could not be opened): a row the gateway
 * rewrites in place keeps the file's length, and this is what shows it.
 */
export function readRows(path: string, map: Record<string, GatewayVendor>, from = 0): { rows: LedgerRow[]; end: number; mtime?: number } {
  let body: Buffer;
  let mtime: number | undefined;
  try {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      mtime = stat.mtimeMs;
      if (size <= from) return { rows: [], end: size < from ? 0 : from, mtime };
      body = Buffer.alloc(size - from);
      let read = 0;
      while (read < body.length) {
        const n = readSync(fd, body, read, body.length - read, from + read);
        if (n <= 0) break;
        read += n;
      }
      body = body.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { rows: [], end: from };
  }
  const rows: LedgerRow[] = [];
  for (const line of body.toString("utf8").split("\n")) {
    if (line[0] !== "{") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // a torn write at the tail; every later line is intact
    }
    const row = toRow(raw, map);
    if (row) rows.push(row);
  }
  const lastLine = body.lastIndexOf(10);
  return { rows, end: lastLine < 0 ? from : from + lastLine + 1, mtime };
}

/** Only these fields are read: a new ledger field stays out of reports. */
function toRow(raw: unknown, map: Record<string, GatewayVendor>): LedgerRow | undefined {
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return undefined;
  const origin = str(d.origin);
  if (origin !== GATEWAY_ORIGIN && origin !== TELEMETRY_ORIGIN) return undefined;
  const at = timestamp(d.at);
  const requestId = str(d.requestId);
  if (!Number.isFinite(at) || !requestId) return undefined;
  // A count the gateway could not have written drops the row: billing it would add or subtract tokens it never spent.
  const input = tokens(d.inputTokens);
  const output = tokens(d.outputTokens);
  const cached = tokens(d.cachedTokens);
  const cacheWrite = tokens(d.cacheWriteTokens);
  const reasoning = tokens(d.reasoningTokens);
  if (input === undefined || output === undefined || cached === undefined || cacheWrite === undefined || reasoning === undefined) return undefined;
  if (input + output > Number.MAX_SAFE_INTEGER) return undefined;
  const providerType = str(d.providerType);
  // A row only matters when it names a subscription this ledger can bill. Its type says so; only an imported
  // telemetry row may lack one, and then the provider name it carries decides.
  const vendor = providerType ? vendorIn(PROVIDER_TYPES, providerType) : origin === TELEMETRY_ORIGIN ? vendorIn(map, str(d.provider)) : undefined;
  if (!vendor) return undefined;
  return {
    at,
    host: str(d.host),
    requestId,
    responseId: str(d.responseId),
    model: str(d.model) || "unknown",
    origin,
    vendor,
    provider: str(d.provider),
    session: flag(d.session),
    input,
    // Cache reads and writes are part of the gross input, so together they can never exceed it.
    cached: Math.min(cached, input),
    cacheWrite: Math.min(cacheWrite, input - Math.min(cached, input)),
    output,
    reasoning,
    nanoAiu: credits(d.nanoAiu),
    nanoAiuStatus: d.nanoAiuStatus === undefined ? undefined : str(d.nanoAiuStatus),
    claimed: false,
    rolloutBilled: false,
  };
}

// Two rows for one call — the gateway's and its telemetry echo — must not both
// count, and the gateway's own record wins because it carries the charge.
export function dedupe(rows: LedgerRow[]): LedgerRow[] {
  const byCall = new Map<string, LedgerRow>();
  for (const row of rows) {
    const key = callKey(row);
    const keep = byCall.get(key);
    if (keep && (keep.origin === GATEWAY_ORIGIN || row.origin !== GATEWAY_ORIGIN)) continue;
    byCall.set(key, row);
  }
  return [...byCall.values()];
}

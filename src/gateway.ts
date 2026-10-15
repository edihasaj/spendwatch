// Bookkeeping for calls that a subscription gateway routed and billed.
//
// The gateway keeps its own month ledger (`usage/usage-YYYY-MM.jsonl`) beside the
// rollouts it served, so a gateway-routed turn is written twice: once by the
// gateway, and once inside the transcript it proxied. Counting both would bill
// one turn twice, so this index resolves the pair two ways:
//
//   * a gateway-origin row carrying a `resp_gl_*` id IS the billed record, so it
//     is counted here and the transcript's copy of it is skipped (`skipMarked`);
//   * a transcript turn with no gateway row of its own is matched against a
//     telemetry-origin row by `claim()`, which proves those tokens were already
//     accounted for on the subscription side.
//
// Telemetry rows are also the ledger's own fallback: the gateway writes them for
// calls it served without a response of its own — a turn inside a session it
// tracks (`session: true`), or one it never saw the end of (`session: false`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { accountLabel } from "./copilot";
import { claudeAccount, type SourceFile } from "./sources";
import type { Event } from "./parse";

export interface ClaimOptions {
  /**
   * Also match the ledger's own billed rows (marked `resp_gl_*`). Only for a transcript line that
   * carries no response id to compare, such as a token_count: with an id, `skipMarked` already decides.
   */
  gatewayRows?: boolean;
}

export interface GatewayIndex {
  /** Returns true when this usage has already been recorded elsewhere. */
  claim(model: string, input: number, output: number, tsMs: number, options?: ClaimOptions): boolean;
}

export type GatewayVendor = "claude" | "copilot";

// A gateway-routed response carries this marker on its id; anything else is an
// ordinary provider call the transcript already counts.
const MARKER = "resp_gl_";
// How far apart the ledger's clock and the transcript's may be for one call.
const CLAIM_WINDOW_MS = 30_000;
const GATEWAY_ORIGIN = "gateway";
const TELEMETRY_ORIGIN = "telemetry";
const PROVIDER_TYPES: Record<string, GatewayVendor> = {
  "copilot-subscription": "copilot",
  "claude-subscription": "claude",
};

interface LedgerRow {
  at: number;
  host: string;
  requestId: string;
  responseId: string;
  model: string;
  origin: string;
  vendor: GatewayVendor;
  session?: boolean;
  /** HTTP status, read for context only: counting never depends on it. */
  status?: number;
  input: number; // gross input tokens, cache included, as the transcript reports them
  cached: number;
  cacheWrite: number;
  output: number;
  /** Reasoning tokens are a subset of output, so they are read but never added. */
  reasoning: number;
  nanoAiu: number | null;
  nanoAiuStatus?: string;
  claimed: boolean;
}

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

function timestamp(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  return typeof raw === "string" ? Date.parse(raw) : NaN;
}

function home(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Where the gateway keeps its files: one product, two platform conventions. */
function configDirectory(): string {
  const at = homedir();
  return platform() === "darwin"
    ? join(at, "Library", "Application Support", "Subscription Gateway")
    : join(at, ".config", "subscription-gateway");
}

/**
 * The ledger home, in order of who says so: an explicit root, the gateway's own
 * config (only `stateDirectory` is read from it), then the default beside it.
 */
function stateDirectory(override?: string): string | undefined {
  const direct = override ?? process.env.SPENDWATCH_GATEWAY_STATE;
  if (direct) return home(direct);
  try {
    const dir = str(JSON.parse(readFileSync(join(configDirectory(), "gateway.json"), "utf8"))?.stateDirectory);
    if (dir) return home(dir);
  } catch {}
  const fallback = join(configDirectory(), "state");
  return existsSync(fallback) ? fallback : undefined;
}

/** `SPENDWATCH_GATEWAY_PROVIDER_MAP` retargets the provider names telemetry rows carry. */
function providerMap(): Record<string, GatewayVendor> {
  const map: Record<string, GatewayVendor> = { copilot: "copilot", claude: "claude" };
  const raw = process.env.SPENDWATCH_GATEWAY_PROVIDER_MAP?.trim();
  if (!raw) return map;
  let pairs: Array<[string, unknown]>;
  try {
    pairs = raw.startsWith("{")
      ? Object.entries(JSON.parse(raw) as Record<string, unknown>)
      : raw.split(",").map((entry) => {
        const at = entry.indexOf("=");
        return at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)] as [string, unknown];
      });
  } catch {
    return map;
  }
  for (const [key, value] of pairs) {
    const vendor = str(value);
    if (!key) continue;
    if (vendor === "claude" || vendor === "copilot") map[key] = vendor;
    else delete map[key];
  }
  return map;
}

export class GatewayLedger implements GatewayIndex {
  private readonly rows: LedgerRow[];
  readonly stateDir: string;

  private constructor(rows: LedgerRow[], stateDir: string) {
    this.stateDir = stateDir;
    this.rows = rows.sort((a, b) => a.at - b.at); // oldest first, like a transcript
  }

  /**
   * The transcript's copy of this call was already billed: take one telemetry row. With `gatewayRows`, a
   * billed gateway row can be taken too. Taking it only drops the transcript's copy; the ledger still
   * bills the row, because it is the record that carries the charge (see `counts`).
   */
  claim(model: string, input: number, output: number, tsMs: number, options: ClaimOptions = {}): boolean {
    for (const row of this.rows) {
      if (row.claimed) continue;
      if (row.origin === TELEMETRY_ORIGIN ? row.session !== true : !(options.gatewayRows && row.responseId.startsWith(MARKER))) continue;
      if (row.model !== model || row.input !== input || row.output !== output) continue;
      if (Math.abs(row.at - tsMs) > CLAIM_WINDOW_MS) continue;
      row.claimed = true;
      return true;
    }
    return false;
  }

  /**
   * One file per vendor, read on demand: by the time its events run, every
   * rollout has had its chance to claim what the ledger and the transcript share.
   */
  files(vendor: GatewayVendor): SourceFile[] {
    const rows = this.rows.filter((row) => row.vendor === vendor);
    if (!rows.length) return [];
    const account = vendor === "copilot" ? accountLabel() : claudeAccount();
    return [{
      path: join(this.stateDir, "usage"),
      key: `gateway:${vendor}`,
      project: "gateway",
      source: vendor,
      account,
      parse: () => [],
      ctx: null,
      events: (): Generator<Event> => eventsFor(vendor, rows),
    }];
  }

  /** Every month ledger the window touches. No gateway installed → nothing to count. */
  static load(opts: { sinceMs: number; stateDir?: string }): GatewayLedger {
    const dir = stateDirectory(opts.stateDir);
    if (!dir) return new GatewayLedger([], configDirectory());
    const map = providerMap();
    const rows = ledgerFiles(dir, opts.sinceMs).flatMap((file) => readRows(file, map));
    return new GatewayLedger(dedupe(rows), dir);
  }
}

/** Rows the ledger is responsible for billing; see the module header. */
function counts(row: LedgerRow): boolean {
  if (row.origin === GATEWAY_ORIGIN) return row.responseId.startsWith(MARKER);
  return row.claimed || row.session === false;
}

function* eventsFor(vendor: GatewayVendor, rows: LedgerRow[]): Generator<Event> {
  const sessionId = `gateway-${vendor}`;
  yield { t: "meta", sessionId, project: "gateway", ts: 0 };
  for (const row of rows) {
    if (!counts(row)) continue;
    const { model, costUsd } = price(vendor, row);
    yield {
      t: "api",
      sessionId,
      requestId: `${row.host}:${row.requestId}`,
      model,
      usage: {
        input: Math.max(0, row.input - row.cached - row.cacheWrite),
        output: row.output,
        cacheRead: row.cached,
        cache5m: row.cacheWrite,
        cache1h: 0,
      },
      costUsd,
      sidechain: false,
      ts: row.at,
    };
  }
}

// Copilot reports what a call actually cost in AI credits, so that figure wins
// and the model keeps its plain alias. Where credits ran short or never arrived,
// the row is labelled as what it is instead of priced from a token table.
// Claude rows carry no credit figure at all, so the alias is priced from tokens.
function price(vendor: GatewayVendor, row: LedgerRow): { model: string; costUsd?: number } {
  const alias = row.model;
  if (row.origin === TELEMETRY_ORIGIN) {
    return vendor === "copilot"
      ? { model: `${alias} (telemetry backfill, unpriced)`, costUsd: 0 }
      : { model: `${alias} (telemetry backfill)` };
  }
  if (vendor !== "copilot") return { model: alias };
  const credits = row.nanoAiu !== null && row.nanoAiu >= 0 ? row.nanoAiu / 1e11 : undefined;
  if (credits === undefined) return { model: `${alias} (unpriced)`, costUsd: 0 };
  return row.nanoAiuStatus === "partial"
    ? { model: `${alias} (partial credits)`, costUsd: credits }
    : { model: alias, costUsd: credits };
}

/** Month ledgers overlapping [sinceMs, now], oldest file first. */
function ledgerFiles(dir: string, sinceMs: number): string[] {
  const usage = join(dir, "usage");
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

function readRows(path: string, map: Record<string, GatewayVendor>): LedgerRow[] {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const line of body.split("\n")) {
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
  return rows;
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
  const providerType = str(d.providerType);
  // A row only matters when it names a subscription this ledger can bill.
  const vendor = providerType ? PROVIDER_TYPES[providerType] : origin === TELEMETRY_ORIGIN ? map[str(d.provider)] : undefined;
  if (!vendor) return undefined;
  return {
    at,
    host: str(d.host),
    requestId,
    responseId: str(d.responseId),
    model: str(d.model) || "unknown",
    origin,
    vendor,
    session: flag(d.session),
    status: typeof d.status === "number" ? d.status : undefined,
    input: num(d.inputTokens),
    cached: num(d.cachedTokens),
    cacheWrite: num(d.cacheWriteTokens),
    output: num(d.outputTokens),
    reasoning: num(d.reasoningTokens),
    nanoAiu: typeof d.nanoAiu === "number" && Number.isFinite(d.nanoAiu) ? d.nanoAiu : null,
    nanoAiuStatus: d.nanoAiuStatus === undefined ? undefined : str(d.nanoAiuStatus),
    claimed: false,
  };
}

// Two rows for one call — the gateway's and its telemetry echo — must not both
// count, and the gateway's own record wins because it carries the charge.
function dedupe(rows: LedgerRow[]): LedgerRow[] {
  const byCall = new Map<string, LedgerRow>();
  for (const row of rows) {
    const key = `${row.host}:${row.requestId}`;
    const keep = byCall.get(key);
    if (keep && (keep.origin === GATEWAY_ORIGIN || row.origin !== GATEWAY_ORIGIN)) continue;
    byCall.set(key, row);
  }
  return [...byCall.values()];
}

// Parsers hold the structural `GatewayIndex` contract above, so the ledger ships
// behind this value rather than as the class the interface names.
export const GatewayIndex: {
  load(opts: { sinceMs: number; stateDir?: string }): GatewayLedger;
} = { load: (opts) => GatewayLedger.load(opts) };

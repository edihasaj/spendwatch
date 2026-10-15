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
// Telemetry rows are not written per call: the gateway imports its pre-ledger
// request history once, when the ledger is first created. `session` says whether
// that request carried a Codex session id. A row without one (`session: false`,
// a client that is not Codex) has no rollout to dedupe against, so it counts
// directly; a row with one counts only when a rollout on this Mac claims it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accountLabel } from "./copilot";
import { claudeAccount, claudeAccountIn, type SourceFile } from "./sources";
import type { Event } from "./parse";
import { PROVIDER_TYPES, providerMap, readGatewayConfig, resolveStateDirectory, type GatewayVendor } from "./gateway-config";

export type { GatewayVendor };

export interface ClaimOptions {
  /**
   * Also match the ledger's own billed rows (marked `resp_gl_*`). Only for a transcript line that
   * carries no response id to compare, such as a token_count: with an id, `skipMarked` already decides.
   */
  gatewayRows?: boolean;
}

/** A call a rollout billed because the ledger held no row for it yet. */
export interface BilledCall {
  model: string;
  input: number;
  output: number;
  ts: number;
}

export interface GatewayIndex {
  /** Returns true when this usage has already been recorded elsewhere. */
  claim(model: string, input: number, output: number, tsMs: number, options?: ClaimOptions): boolean;
  /**
   * Calls a rollout billed on an earlier watch tick, before the gateway had appended their ledger row.
   * Their rows must not bill them again: the rollout's bill stands.
   */
  adopt?(calls: Iterable<BilledCall>): void;
}

// A gateway-routed response carries this marker on its id; anything else is an
// ordinary provider call the transcript already counts.
const MARKER = "resp_gl_";
// How far apart the ledger's clock and the transcript's may be for one call.
const CLAIM_WINDOW_MS = 30_000;
const GATEWAY_ORIGIN = "gateway";
const TELEMETRY_ORIGIN = "telemetry";

interface LedgerRow {
  at: number;
  host: string;
  requestId: string;
  responseId: string;
  model: string;
  origin: string;
  vendor: GatewayVendor;
  /** The route id the gateway served the call through; it names the account for Claude rows. */
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
  /** A rollout already billed this call (see `adopt`), so the ledger must not. */
  rolloutBilled: boolean;
}

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

function timestamp(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  return typeof raw === "string" ? Date.parse(raw) : NaN;
}

export class GatewayLedger implements GatewayIndex {
  private readonly rows: LedgerRow[];
  readonly stateDir: string;
  private readonly claudeDirectories: ReadonlyMap<string, string>;

  private constructor(rows: LedgerRow[], stateDir: string, claudeDirectories: ReadonlyMap<string, string> = new Map()) {
    this.stateDir = stateDir;
    this.claudeDirectories = claudeDirectories;
    this.rows = rows.sort((a, b) => a.at - b.at); // oldest first, like a transcript
  }

  /**
   * The transcript's copy of this call was already billed: take one telemetry row. With `gatewayRows`, a
   * billed gateway row can be taken too. Taking it only drops the transcript's copy; the ledger still
   * bills the row, because it is the record that carries the charge (see `counts`).
   */
  claim(model: string, input: number, output: number, tsMs: number, options: ClaimOptions = {}): boolean {
    for (const row of this.rows) {
      if (row.claimed || row.rolloutBilled) continue;
      if (row.origin === TELEMETRY_ORIGIN ? row.session !== true : !(options.gatewayRows && row.responseId.startsWith(MARKER))) continue;
      if (row.model !== model || row.input !== input || row.output !== output) continue;
      if (Math.abs(row.at - tsMs) > CLAIM_WINDOW_MS) continue;
      row.claimed = true;
      return true;
    }
    return false;
  }

  /**
   * `watch` loads the ledger afresh on every tick, so a rollout line that was read before its row existed
   * has already billed its call. Offered those calls again, each takes the billed gateway row nearest in
   * time (one row per call) and keeps it out of `counts`: one bill, never two.
   */
  adopt(calls: Iterable<BilledCall>): void {
    for (const call of calls) {
      let best: LedgerRow | undefined;
      for (const row of this.rows) {
        if (row.rolloutBilled || row.origin !== GATEWAY_ORIGIN || !row.responseId.startsWith(MARKER)) continue;
        if (row.model !== call.model || row.input !== call.input || row.output !== call.output) continue;
        const gap = Math.abs(row.at - call.ts);
        if (gap <= CLAIM_WINDOW_MS && (!best || gap < Math.abs(best.at - call.ts))) best = row;
      }
      if (best) best.rolloutBilled = true;
    }
  }

  /**
   * One file per vendor and account, read on demand: by the time its events run, every
   * rollout has had its chance to claim what the ledger and the transcript share.
   */
  files(vendor: GatewayVendor): SourceFile[] {
    const byAccount = new Map<string, LedgerRow[]>();
    for (const row of this.rows) {
      if (row.vendor !== vendor) continue;
      const account = this.accountFor(row);
      byAccount.set(account, [...(byAccount.get(account) ?? []), row]);
    }
    const primary = vendor === "copilot" ? accountLabel() : claudeAccount();
    return [...byAccount].map(([account, rows]) => ({
      path: join(this.stateDir, "usage"),
      // The usual account keeps the plain key; another Claude account gets its own stream.
      key: account === primary ? `gateway:${vendor}` : `gateway:${vendor}:${account}`,
      project: "gateway",
      source: vendor,
      account,
      parse: () => [],
      ctx: null,
      events: (): Generator<Event> => eventsFor(vendor, account === primary ? "" : account, rows),
    }));
  }

  /**
   * Who paid for a row. Copilot rows go to the signed-in Copilot account. A Claude provider can keep its
   * login in its own `authDirectory`, and its turns are billed to that Claude account, not the default one.
   */
  private accountFor(row: LedgerRow): string {
    if (row.vendor === "copilot") return accountLabel();
    const directory = this.claudeDirectories.get(row.provider);
    return directory ? claudeAccountIn(directory) : claudeAccount();
  }

  /** Every month ledger the window touches. No gateway installed → nothing to count. */
  static load(opts: { sinceMs: number; stateDir?: string }): GatewayLedger {
    const config = readGatewayConfig();
    const dir = resolveStateDirectory(config, opts.stateDir);
    if (!dir) return new GatewayLedger([], config.directory);
    const map = providerMap();
    const rows = ledgerFiles(dir, opts.sinceMs).flatMap((file) => readRows(file, map));
    return new GatewayLedger(dedupe(rows), dir, config.claudeDirectories);
  }

  /** Whether any telemetry row is waiting for a rollout to claim it, so reading rollouts can change a report. */
  hasClaimable(): boolean {
    return this.rows.some((row) => row.origin === TELEMETRY_ORIGIN && row.session === true);
  }
}

/** Rows the ledger is responsible for billing; see the module header. */
function counts(row: LedgerRow): boolean {
  if (row.rolloutBilled) return false;
  if (row.origin === GATEWAY_ORIGIN) return row.responseId.startsWith(MARKER);
  return row.claimed || row.session === false;
}

function* eventsFor(vendor: GatewayVendor, account: string, rows: LedgerRow[]): Generator<Event> {
  const sessionId = account ? `gateway-${vendor}:${account}` : `gateway-${vendor}`;
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
// the row is labelled as what it is instead of priced from a token table. A
// telemetry-origin row is priced the same way when it carries credits (the gateway
// copies them in its one-time import) and says it came from telemetry.
// Claude rows carry no credit figure at all, so the alias is priced from tokens.
function price(vendor: GatewayVendor, row: LedgerRow): { model: string; costUsd?: number } {
  const alias = row.model;
  const telemetry = row.origin === TELEMETRY_ORIGIN;
  if (vendor !== "copilot") return { model: telemetry ? `${alias} (telemetry backfill)` : alias };
  const credits = row.nanoAiu !== null && row.nanoAiu >= 0 ? row.nanoAiu / 1e11 : undefined;
  const tags = [
    ...(telemetry ? ["telemetry backfill"] : []),
    ...(credits === undefined ? ["unpriced"] : row.nanoAiuStatus === "partial" ? ["partial credits"] : []),
  ];
  return { model: tags.length ? `${alias} (${tags.join(", ")})` : alias, costUsd: credits ?? 0 };
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
    provider: str(d.provider),
    session: flag(d.session),
    input: num(d.inputTokens),
    cached: num(d.cachedTokens),
    cacheWrite: num(d.cacheWriteTokens),
    output: num(d.outputTokens),
    reasoning: num(d.reasoningTokens),
    nanoAiu: typeof d.nanoAiu === "number" && Number.isFinite(d.nanoAiu) ? d.nanoAiu : null,
    nanoAiuStatus: d.nanoAiuStatus === undefined ? undefined : str(d.nanoAiuStatus),
    claimed: false,
    rolloutBilled: false,
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

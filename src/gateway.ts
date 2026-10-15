// Bookkeeping for calls that a subscription gateway routed and billed.
//
// The gateway keeps its own month ledger (`usage/usage-YYYY-MM.jsonl`) beside the
// rollouts it served, so a gateway-routed turn is written twice: once by the
// gateway, and once inside the transcript it proxied. Counting both would bill
// one turn twice, so this index resolves the pair two ways:
//
//   * a gateway-origin row carrying a `resp_gl_*` id IS the billed record, so it
//     is counted here, and a rollout record with that exact response id is
//     dropped (`covers`). A marked record whose row this Mac's ledger does not
//     hold is kept by the rollout: nothing here proves another ledger bills it;
//   * a transcript turn with no gateway row of its own is matched against a
//     telemetry-origin row by `claim()`, which proves those tokens were already
//     accounted for on the subscription side.
//
// Telemetry rows are not written per call: the gateway imports its pre-ledger
// request history once, when the ledger is first created. `session` says whether
// that request carried a Codex session id. A row without one (`session: false`,
// a client that is not Codex) has no rollout to dedupe against, so it counts
// directly; a row with one counts only when a rollout on this Mac claims it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountLabel, copilotAccountIn } from "./copilot";
import { claudeAccount, claudeAccountIn, type SourceFile } from "./sources";
import type { Event } from "./parse";
import { PROVIDER_TYPES, providerMap, readGatewayConfig, resolveStateDirectory, vendorIn, type AuthDirectory, type GatewayVendor } from "./gateway-config";

export type { GatewayVendor };

export interface ClaimOptions {
  /**
   * Also match the ledger's own billed rows (marked `resp_gl_*`). Only for a transcript line that
   * carries no response id to compare, such as a token_count: with an id, `covers` already decides.
   */
  gatewayRows?: boolean;
}

/** A call a rollout billed itself because the ledger held no row for it when the line was read. */
export interface BilledCall {
  model: string;
  input: number;
  output: number;
  ts: number;
  /** The gateway's marked response id, when the rollout recorded one. */
  responseId?: string;
}

/**
 * What a rollout decided about one routed call, in the order it decided: it claimed a ledger row, or billed the
 * call itself. `watch` loads a fresh ledger on every tick and replays these, so the new ledger agrees with what
 * the reports already hold.
 */
export type LedgerDecision =
  | { kind: "claimed"; model: string; input: number; output: number; ts: number; gatewayRows: boolean }
  | ({ kind: "billed" } & BilledCall);

export interface GatewayIndex {
  /** Returns true when this usage has already been recorded elsewhere. */
  claim(model: string, input: number, output: number, tsMs: number, options?: ClaimOptions): boolean;
  /** True when this Mac's ledger holds the billed row of this marked response, so the ledger bills it. */
  covers?(responseId: string): boolean;
  /**
   * Calls a rollout billed on an earlier watch tick, before the gateway had appended their ledger row.
   * Their rows must not bill them again: the rollout's bill stands.
   */
  adopt?(calls: Iterable<BilledCall>): void;
  /** Applies a rollout's earlier decisions to this freshly loaded ledger, in their order; see `LedgerDecision`. */
  replay?(decisions: Iterable<LedgerDecision>): void;
}

/** A gateway-routed response carries this marker on its id; anything else is an ordinary provider call. */
export const MARKER = "resp_gl_";
/** How far apart the ledger's clock and the transcript's may be for one call. */
export const CLAIM_WINDOW_MS = 30_000;
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

/** A gateway-origin row the gateway marked: the record that carries the charge. */
const billedRow = (row: LedgerRow): boolean => row.origin === GATEWAY_ORIGIN && row.responseId.startsWith(MARKER);
/** A row a transcript can match by model, tokens and time. */
const matchable = (row: LedgerRow): boolean => billedRow(row) || (row.origin === TELEMETRY_ORIGIN && row.session === true);
const usageKey = (model: string, input: number, output: number): string => `${model}\u0000${input}\u0000${output}`;

/** The first index in `rows` (sorted by `at`) whose time is at least `from`. */
function firstAtOrAfter(rows: LedgerRow[], from: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.at < from) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class GatewayLedger implements GatewayIndex {
  private readonly rows: LedgerRow[];
  readonly stateDir: string;
  /** Whether this Mac has a ledger at all (a `usage` directory). Without one nothing is counted or dropped. */
  readonly present: boolean;
  private readonly authDirectories: ReadonlyMap<string, AuthDirectory>;
  /** Rows a transcript can match, by model and token counts, each list oldest first. */
  private readonly buckets = new Map<string, LedgerRow[]>();
  /** Billed rows by their marked response id. */
  private readonly byResponse = new Map<string, LedgerRow>();
  /** Account labels, resolved once per load: each one reads a credential file. */
  private readonly labels = new Map<string, string>();

  private constructor(rows: LedgerRow[], stateDir: string, present: boolean, authDirectories: ReadonlyMap<string, AuthDirectory> = new Map()) {
    this.stateDir = stateDir;
    this.present = present;
    this.authDirectories = authDirectories;
    this.rows = rows.sort((a, b) => a.at - b.at); // oldest first, like a transcript
    for (const row of this.rows) {
      if (billedRow(row) && !this.byResponse.has(row.responseId)) this.byResponse.set(row.responseId, row);
      if (!matchable(row)) continue;
      const key = usageKey(row.model, row.input, row.output);
      let bucket = this.buckets.get(key);
      if (!bucket) this.buckets.set(key, (bucket = []));
      bucket.push(row);
    }
  }

  /** Rows with this model and token counts within the claim window of `tsMs`, oldest first. */
  private *near(model: string, input: number, output: number, tsMs: number): Generator<LedgerRow> {
    const bucket = this.buckets.get(usageKey(model, input, output));
    if (!bucket) return;
    for (let i = firstAtOrAfter(bucket, tsMs - CLAIM_WINDOW_MS); i < bucket.length && bucket[i]!.at <= tsMs + CLAIM_WINDOW_MS; i++) yield bucket[i]!;
  }

  /**
   * The transcript's copy of this call was already billed: take one telemetry row. With `gatewayRows`, a
   * billed gateway row can be taken too. Taking it only drops the transcript's copy; the ledger still
   * bills the row, because it is the record that carries the charge (see `counts`).
   */
  claim(model: string, input: number, output: number, tsMs: number, options: ClaimOptions = {}): boolean {
    for (const row of this.near(model, input, output, tsMs)) {
      if (row.claimed || row.rolloutBilled) continue;
      if (row.origin === GATEWAY_ORIGIN && !options.gatewayRows) continue;
      row.claimed = true;
      return true;
    }
    return false;
  }

  covers(responseId: string): boolean {
    const row = this.byResponse.get(responseId);
    return !!row && !row.rolloutBilled;
  }

  /**
   * `watch` loads the ledger afresh on every tick, so a rollout line that was read before its row existed
   * has already billed its call. Offered those calls again, each takes its own row — by response id when the
   * rollout recorded one, else the billed row nearest in time (one row per call) — and keeps it out of
   * `counts`: one bill, never two.
   */
  adopt(calls: Iterable<BilledCall>): void {
    for (const call of calls) {
      if (call.responseId) {
        const row = this.byResponse.get(call.responseId);
        if (row) row.rolloutBilled = true;
        continue;
      }
      let best: LedgerRow | undefined;
      for (const row of this.near(call.model, call.input, call.output, call.ts)) {
        // A claimed row's rollout copy was dropped: only the ledger bills that call.
        if (row.rolloutBilled || row.claimed || !billedRow(row)) continue;
        if (!best || Math.abs(row.at - call.ts) < Math.abs(best.at - call.ts)) best = row;
      }
      if (best) best.rolloutBilled = true;
    }
  }

  replay(decisions: Iterable<LedgerDecision>): void {
    for (const decision of decisions) {
      if (decision.kind === "claimed") this.claim(decision.model, decision.input, decision.output, decision.ts, { gatewayRows: decision.gatewayRows });
      else this.adopt([decision]);
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
      let rows = byAccount.get(account);
      if (!rows) byAccount.set(account, (rows = []));
      rows.push(row);
    }
    const primary = this.label(vendor);
    return [...byAccount].map(([account, rows]) => ({
      path: join(this.stateDir, "usage"),
      // The usual account keeps the plain key; another account gets its own stream.
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
   * Who paid for a row. A provider can keep its login in its own `authDirectory` — a `CLAUDE_CONFIG_DIR` or a
   * `COPILOT_HOME` — and its turns are billed to that account; every other row goes to the signed-in default.
   */
  private accountFor(row: LedgerRow): string {
    const auth = this.authDirectories.get(row.provider);
    return this.label(row.vendor, auth?.vendor === row.vendor ? auth.directory : undefined);
  }

  private label(vendor: GatewayVendor, directory?: string): string {
    const key = `${vendor}\u0000${directory ?? ""}`;
    let label = this.labels.get(key);
    if (label === undefined) {
      label = directory
        ? vendor === "copilot" ? copilotAccountIn(directory) : claudeAccountIn(directory)
        : vendor === "copilot" ? accountLabel() : claudeAccount();
      this.labels.set(key, label);
    }
    return label;
  }

  /**
   * Every month ledger the window touches, plus the claim window before it: a call at the very end of one UTC
   * month can sit in that month's file while its rollout line is already in the next. No ledger → nothing to count.
   */
  static load(opts: { sinceMs: number; stateDir?: string }): GatewayLedger {
    const config = readGatewayConfig();
    const dir = resolveStateDirectory(config, opts.stateDir);
    const usage = dir ? join(dir, "usage") : "";
    if (!dir || !isDirectory(usage)) return new GatewayLedger([], dir ?? config.directory, false, config.authDirectories);
    const map = providerMap();
    const rows = ledgerFiles(usage, opts.sinceMs - CLAIM_WINDOW_MS).flatMap((file) => readRows(file, map));
    return new GatewayLedger(dedupe(rows), dir, true, config.authDirectories);
  }

  /** Whether any telemetry row is waiting for a rollout to claim it, so reading rollouts can change a report. */
  hasClaimable(): boolean {
    return this.rows.some((row) => row.origin === TELEMETRY_ORIGIN && row.session === true);
  }
}

/** Rows the ledger is responsible for billing; see the module header. */
function counts(row: LedgerRow): boolean {
  if (row.rolloutBilled) return false;
  if (row.origin === GATEWAY_ORIGIN) return billedRow(row);
  return row.claimed || row.session === false;
}

function* eventsFor(vendor: GatewayVendor, account: string, rows: LedgerRow[]): Generator<Event> {
  const sessionId = account ? `gateway-${vendor}:${account}` : `gateway-${vendor}`;
  yield { t: "meta", sessionId, project: "gateway", ts: 0 };
  for (const row of rows) {
    if (!counts(row)) continue;
    const { model, costUsd } = price(vendor, row);
    const requestId = `${row.host}:${row.requestId}`;
    // The archive keeps how many calls a report took over from the rollouts; see `routedCalls`.
    yield { t: "routed", sessionId, id: requestId, ts: row.at };
    yield {
      t: "api",
      sessionId,
      requestId,
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Month ledgers overlapping [sinceMs, now], oldest file first. */
function ledgerFiles(usage: string, sinceMs: number): string[] {
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

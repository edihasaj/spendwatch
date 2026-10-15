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
//     hold is kept by the rollout: nothing here proves another ledger bills it.
//     Both sides carry the id, so where a client's report meets the serving
//     Mac's, the client's copy is taken out there (gateway-settle.ts);
//   * a transcript turn with no gateway row of its own is matched against a
//     telemetry-origin row by `claim()`, which proves those tokens were already
//     accounted for on the subscription side.
//
// Telemetry rows are not written per call: the gateway imports its pre-ledger
// request history once, when the ledger is first created. `session` says whether
// that request carried a Codex session id. A row without one (`session: false`,
// a client that is not Codex) has no rollout to dedupe against, so it counts
// directly; a row with one counts only when a rollout on this Mac claims it.
import { statSync } from "node:fs";
import { join } from "node:path";
import { accountLabel, copilotAccountIn } from "./copilot";
import { claudeAccount, claudeAccountIn, type SourceFile } from "./sources";
import type { Event } from "./parse";
import { providerMap, readGatewayConfig, resolveStateDirectory, type AuthDirectory, type GatewayVendor } from "./gateway-config";
import { callKey, dedupe, GATEWAY_ORIGIN, ledgerFiles, MARKER, readRows, TELEMETRY_ORIGIN, type LedgerRow } from "./gateway-ledger-files";

export type { GatewayVendor };
export { MARKER };

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
   * Calls a rollout billed before the gateway had appended their ledger row (on an earlier watch tick, or earlier in
   * this read). Their rows must not bill them again: the rollout's bill stands, also for a row that only lands
   * after this, which `refresh` then matches.
   */
  adopt?(calls: Iterable<BilledCall>): void;
  /** Applies a rollout's earlier decisions to this freshly loaded ledger, in their order; see `LedgerDecision`. */
  replay?(decisions: Iterable<LedgerDecision>): void;
  /** When the ledger files were last read. */
  readonly readAt?: number;
  /** Reads the rows appended since then, so a call read after the ledger can still find its row. */
  refresh?(): void;
}

/** How far apart the ledger's clock and the transcript's may be for one call. */
export const CLAIM_WINDOW_MS = 30_000;

/** A gateway-origin row the gateway marked: the record that carries the charge. */
const billedRow = (row: LedgerRow): boolean => row.origin === GATEWAY_ORIGIN && row.responseId.startsWith(MARKER);
/** A row a transcript can match by model, tokens and time. */
const matchable = (row: LedgerRow): boolean => billedRow(row) || (row.origin === TELEMETRY_ORIGIN && row.session === true);
const usageKey = (model: string, input: number, output: number): string => `${model}\u0000${input}\u0000${output}`;

/** The first index in `rows` (sorted by `at`) whose time is at least `from`, or after `from` when `after`. */
function firstAtOrAfter(rows: LedgerRow[], from: number, after = false): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.at < from || (after && rows[mid]!.at === from)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Where the rows came from, so a later `refresh` reads only what was appended since. */
interface LedgerSource {
  usage: string;
  sinceMs: number;
  map: ReturnType<typeof providerMap>;
  /** Bytes of each month file already read, up to its last complete line. */
  read: Map<string, number>;
}

const streamKey = (vendor: GatewayVendor, account: string): string => `${vendor}\u0000${account}`;

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
  /** The rows each account stream bills, once `files` has made the streams. */
  private readonly streams = new Map<string, LedgerRow[]>();
  /** Every call the rows hold, by `callKey`. */
  private readonly calls = new Set<string>();
  /** Calls a rollout billed that `adopt` has already seen, so offering one twice never marks a second row. */
  private readonly adopted = new Set<BilledCall>();
  /** The adopted calls no row has matched yet: a row `refresh` finds later is theirs. */
  private readonly unmatched = new Set<BilledCall>();
  private lastRead = Date.now();

  private constructor(rows: LedgerRow[], stateDir: string, present: boolean, authDirectories: ReadonlyMap<string, AuthDirectory> = new Map(), private readonly source?: LedgerSource) {
    this.stateDir = stateDir;
    this.present = present;
    this.authDirectories = authDirectories;
    this.rows = rows.sort((a, b) => a.at - b.at); // oldest first, like a transcript
    for (const row of this.rows) this.index(row);
  }

  private index(row: LedgerRow): void {
    this.calls.add(callKey(row));
    if (billedRow(row) && !this.byResponse.has(row.responseId)) this.byResponse.set(row.responseId, row);
    if (!matchable(row)) return;
    const key = usageKey(row.model, row.input, row.output);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.splice(firstAtOrAfter(bucket, row.at, true), 0, row);
  }

  /**
   * The rows the gateway appended since the files were read. A read loads the ledger first and the rollouts after,
   * and the gateway appends a call's row just after the response ends, so a rollout line can be newer than the
   * ledger it is checked against; such a call asks for this before it is billed from the rollout. A new row joins
   * the stream of its account; one whose account has no stream in this read is left out, and so is never covered.
   */
  refresh(): void {
    const source = this.source;
    if (!source || !this.streams.size) return;
    this.lastRead = Date.now();
    let added = false;
    for (const file of ledgerFiles(source.usage, source.sinceMs - CLAIM_WINDOW_MS)) {
      const { rows, end } = readRows(file, source.map, source.read.get(file) ?? 0);
      source.read.set(file, end);
      for (const row of rows) {
        if (this.calls.has(callKey(row))) continue;
        const stream = this.streams.get(streamKey(row.vendor, this.accountFor(row)));
        if (!stream) continue;
        this.rows.push(row);
        stream.push(row);
        this.index(row);
        added = true;
      }
    }
    // A rollout of this read may have billed a call before its row existed: the row is that call's, not a second bill.
    if (added) for (const call of this.unmatched) if (this.take(call)) this.unmatched.delete(call);
  }

  /**
   * What the ledger files held when last read, and how many of a stream's rows bill. Unchanged means nothing a
   * `watch` tick would show has changed, so the reader need not fold the stream again.
   */
  private version(rows: LedgerRow[]): string {
    let bytes = 0;
    for (const end of this.source?.read.values() ?? []) bytes += end;
    return `${bytes}:${rows.length}:${rows.filter(counts).length}`;
  }

  /** When the ledger files were last read, by `load` or by `refresh`. */
  get readAt(): number {
    return this.lastRead;
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
      if (this.adopted.has(call)) continue;
      this.adopted.add(call);
      // No row yet: the gateway may append it later in this read, and `refresh` matches it then.
      if (!this.take(call)) this.unmatched.add(call);
    }
  }

  /** Marks the row of a call a rollout billed, so the ledger does not bill it too. False when no row is there yet. */
  private take(call: BilledCall): boolean {
    if (call.responseId) {
      const row = this.byResponse.get(call.responseId);
      if (!row) return false;
      row.rolloutBilled = true;
      return true;
    }
    let best: LedgerRow | undefined;
    for (const row of this.near(call.model, call.input, call.output, call.ts)) {
      // A claimed row's rollout copy was dropped: only the ledger bills that call.
      if (row.rolloutBilled || row.claimed || !billedRow(row)) continue;
      if (!best || Math.abs(row.at - call.ts) < Math.abs(best.at - call.ts)) best = row;
    }
    if (!best) return false;
    best.rolloutBilled = true;
    return true;
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
    for (const [account, rows] of byAccount) this.streams.set(streamKey(vendor, account), rows);
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
      version: () => this.version(rows),
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
    const source: LedgerSource = { usage, sinceMs: opts.sinceMs, map, read: new Map() };
    const rows = ledgerFiles(usage, opts.sinceMs - CLAIM_WINDOW_MS).flatMap((file) => {
      const { rows, end } = readRows(file, map);
      source.read.set(file, end);
      return rows;
    });
    return new GatewayLedger(dedupe(rows), dir, true, config.authDirectories, source);
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
    const requestId = callKey(row);
    // The archive keeps how many calls a report took over from the rollouts; see `routedCalls`.
    yield { t: "routed", sessionId, id: requestId, ts: row.at };
    // A client Mac's Codex report may hold this call too, when this Mac's gateway served it (gateway-settle.ts).
    const gateway = billedRow(row) ? { gateway: { id: row.responseId.slice(MARKER.length), role: "billed" as const } } : {};
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
      ...gateway,
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

// Parsers hold the structural `GatewayIndex` contract above, so the ledger ships
// behind this value rather than as the class the interface names.
export const GatewayIndex: {
  load(opts: { sinceMs: number; stateDir?: string }): GatewayLedger;
} = { load: (opts) => GatewayLedger.load(opts) };

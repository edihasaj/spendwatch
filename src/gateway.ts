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
import { callKey, dedupe, GATEWAY_ORIGIN, ledgerFiles, MARKER, readRows, TELEMETRY_ORIGIN, type LedgerRow, type RowHolder } from "./gateway-ledger-files";
import { place, stayOn } from "./gateway-match";
import { billedRow, counts, eventsFor } from "./gateway-events";
import { CLAIM_WINDOW_MS, type BilledCall, type ClaimOptions, type LedgerDecision } from "./gateway-decisions";

export type { GatewayVendor };
export type { BilledCall, ClaimOptions, LedgerDecision } from "./gateway-decisions";
export { CLAIM_WINDOW_MS, nextDecisionSeq } from "./gateway-decisions";
export { MARKER };

export interface GatewayIndex {
  /** Returns true when this usage has already been recorded elsewhere. */
  claim(model: string, input: number, output: number, tsMs: number, options?: ClaimOptions): boolean;
  /** True when this Mac's ledger holds the billed row of this marked response, so the ledger bills it. */
  covers?(responseId: string): boolean;
  /**
   * A rollout record is dropped on the strength of the row of its marked response, and says so here (it is `covers`,
   * with the row made the record's): no other call may take that row. False when this Mac's ledger holds no such row,
   * or the row is already some other call's and that call cannot be moved. `moved` is told the row's `callKey`, as for
   * a claim.
   */
  vouch?(responseId: string, moved?: (key: string) => void): boolean;
  /**
   * True when this Mac's ledger holds the billed row of this marked response, whichever call stands on it. A record
   * that no row could be given still knows whether its own row is here: a row another call stands on bills that call.
   */
  holds?(responseId: string): boolean;
  /**
   * True when a rollout already billed this marked response itself (or is waiting to): a fork copies its parent's
   * records, and the one call must not be billed from each copy.
   */
  billedBefore?(responseId: string): boolean;
  /**
   * Calls a rollout billed before the gateway had appended their ledger row (on an earlier watch tick, or earlier in
   * this read). Their rows must not bill them again: the rollout's bill stands, also for a row that only lands
   * after this, which `refresh` then matches.
   */
  adopt?(calls: Iterable<BilledCall>): void;
  /**
   * Hands this freshly loaded ledger a rollout's earlier decisions; see `LedgerDecision`. The ledger applies all it
   * has been handed together, in the order they were made, before it next answers anything, so rollouts that are
   * replayed one after another still give each decision the row it held.
   */
  replay?(decisions: Iterable<LedgerDecision>): void;
  /** When the ledger files were last read. */
  readonly readAt?: number;
  /** Reads the rows appended since then, so a call read after the ledger can still find its row. */
  refresh?(): void;
}

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
  /** Each month file's modification time at its last read: a row rewritten in place keeps the length. */
  mtimes: Map<string, number>;
}

/** The rows one account bills in one vendor's report. */
interface Stream {
  vendor: GatewayVendor;
  account: string;
  rows: LedgerRow[];
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
  /**
   * The streams of this read, one per vendor and account the rows held when it was loaded, whichever agents were
   * asked for: a row that lands later joins one of them or, with none for its account, is left out (see `refresh`).
   */
  private readonly streams = new Map<string, Stream>();
  /** Every call the rows hold, by `callKey`. */
  private readonly known = new Map<string, LedgerRow>();
  /** Calls a rollout billed that `adopt` has already seen, so offering one twice never marks a second row. */
  private readonly adopted = new Set<BilledCall>();
  /** The marked responses among them: a second copy of one of these is not billed again. */
  private readonly billedIds = new Set<string>();
  /** Rows no call can be moved off to reach a free row, for as long as the ledger gains no row (see gateway-match.ts). */
  private readonly dead = new Set<LedgerRow>();
  /** The adopted calls no row has matched yet: a row `refresh` finds later is theirs. */
  private readonly unmatched = new Set<BilledCall>();
  /** Earlier decisions handed to `replay` and not yet applied. */
  private replays: LedgerDecision[] = [];
  private lastRead = Date.now();

  private constructor(rows: LedgerRow[], stateDir: string, present: boolean, authDirectories: ReadonlyMap<string, AuthDirectory> = new Map(), private readonly source?: LedgerSource) {
    this.stateDir = stateDir;
    this.present = present;
    this.authDirectories = authDirectories;
    this.rows = rows.sort((a, b) => a.at - b.at); // oldest first, like a transcript
    for (const row of this.rows) {
      this.index(row);
      const account = this.accountFor(row);
      const key = streamKey(row.vendor, account);
      let stream = this.streams.get(key);
      if (!stream) this.streams.set(key, (stream = { vendor: row.vendor, account, rows: [] }));
      stream.rows.push(row);
    }
  }

  private index(row: LedgerRow): void {
    this.dead.clear();
    this.known.set(callKey(row), row);
    if (billedRow(row) && !this.byResponse.has(row.responseId)) this.byResponse.set(row.responseId, row);
    if (!matchable(row)) return;
    const key = usageKey(row.model, row.input, row.output);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.splice(firstAtOrAfter(bucket, row.at, true), 0, row);
  }

  /** Takes a row out of the lookups, for the row that replaces it. */
  private unindex(row: LedgerRow): void {
    if (this.byResponse.get(row.responseId) === row) this.byResponse.delete(row.responseId);
    const bucket = this.buckets.get(usageKey(row.model, row.input, row.output));
    const at = bucket?.indexOf(row) ?? -1;
    if (at >= 0) bucket!.splice(at, 1);
  }

  /**
   * The rows the gateway appended since the files were read. A read loads the ledger first and the rollouts after,
   * and the gateway appends a call's row just after the response ends, so a rollout line can be newer than the
   * ledger it is checked against; such a call asks for this before it is billed from the rollout. A new row joins
   * the stream of its account; one whose account had no stream when the ledger was loaded is left out, and so is
   * never covered. This holds for every vendor, whichever agents were asked for, so a rollout is settled the same
   * way in a run limited to some agents as in the full one.
   */
  refresh(): void {
    const source = this.source;
    if (!source) return;
    this.applyReplays();
    this.lastRead = Date.now();
    let added = false;
    for (const file of ledgerFiles(source.usage, source.sinceMs - CLAIM_WINDOW_MS)) {
      const { rows, end, mtime } = readRows(file, source.map, source.read.get(file) ?? 0);
      source.read.set(file, end);
      if (mtime !== undefined) source.mtimes.set(file, mtime);
      for (const row of rows) if (this.admit(row)) added = true;
    }
    // A rollout of this read may have billed a call before its row existed: the row is that call's, not a second bill.
    if (added) for (const call of this.unmatched) if (this.take(call)) this.unmatched.delete(call);
  }

  /** Takes in a row that landed after the load; false when it changes nothing. */
  private admit(row: LedgerRow): boolean {
    const known = this.known.get(callKey(row));
    if (known) return this.supersede(known, row);
    const stream = this.streams.get(streamKey(row.vendor, this.accountFor(row)));
    if (!stream) return false;
    this.rows.push(row);
    stream.rows.push(row);
    this.index(row);
    return true;
  }

  /**
   * The gateway's own row for a call the ledger holds only as the telemetry echo of its history import takes the
   * echo's place, as a fresh load would resolve the pair (`dedupe`): it is the row that carries the charge. It keeps
   * what a rollout already did with the echo.
   */
  private supersede(known: LedgerRow, row: LedgerRow): boolean {
    if (known.origin !== TELEMETRY_ORIGIN || row.origin !== GATEWAY_ORIGIN) return false;
    // A rollout that claimed the echo dropped its own copy of the call: only a row that bills it may take over.
    if (known.claimed && !billedRow(row)) return false;
    const account = this.accountFor(known);
    if (known.vendor !== row.vendor || account !== this.accountFor(row)) return false;
    const stream = this.streams.get(streamKey(row.vendor, account));
    const inStream = stream?.rows.indexOf(known) ?? -1;
    const inRows = this.rows.indexOf(known);
    if (!stream || inStream < 0 || inRows < 0) return false;
    // An echo is never rollout-billed (`take` marks billed rows only), so only the claim carries over.
    row.claimed = known.claimed;
    row.holder = known.holder;
    this.unindex(known);
    stream.rows[inStream] = row;
    this.rows[inRows] = row;
    this.index(row);
    return true;
  }

  /**
   * What the ledger files held when last read, and which of a stream's rows bill. Unchanged means nothing a
   * `watch` tick would show has changed, so the reader need not fold the stream again. A file the gateway rewrote
   * in place keeps its length, so its modification time counts too.
   */
  private version(rows: LedgerRow[]): string {
    this.applyReplays();
    let bytes = 0;
    for (const end of this.source?.read.values() ?? []) bytes += end;
    // Which rows bill, not how many: a claim moved to another alike row bills that row instead of this one.
    const billing = rows.filter(counts);
    return `${bytes}:${[...(this.source?.mtimes.values() ?? [])].join(",")}:${rows.length}:${billing.length}:${Bun.hash(billing.map(callKey).join("\n"))}`;
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
   * The transcript's copy of this call was already billed: take the telemetry row nearest in time. With
   * `gatewayRows`, a billed gateway row can be taken too. Taking it only drops the transcript's copy; the ledger
   * still bills the row, because it is the record that carries the charge (see `counts`). The nearest row is the
   * one a call most likely wrote, so a call another Mac's gateway served does not take the row of a neighbour.
   */
  claim(model: string, input: number, output: number, tsMs: number, options: ClaimOptions = {}): boolean {
    this.applyReplays();
    return place({ kind: "claim", model, input, output, ts: tsMs, gatewayRows: !!options.gatewayRows, ...(options.onClaim ? { moved: options.onClaim } : {}) }, this.candidates, this.dead);
  }

  /** The rows a call could stand on, nearest in time first (the oldest first among equals). */
  private readonly candidates = (holder: RowHolder): LedgerRow[] => {
    if (holder.responseId) {
      const own = this.byResponse.get(holder.responseId);
      return own ? [own] : [];
    }
    const rows: LedgerRow[] = [];
    for (const row of this.near(holder.model, holder.input, holder.output, holder.ts)) {
      // A claim takes a telemetry row, and a billed row only when it may; a bill is only ever settled against a billed row.
      if (holder.kind === "claim" ? row.origin === GATEWAY_ORIGIN && !holder.gatewayRows : !billedRow(row)) continue;
      rows.push(row);
    }
    // A claim on a billed row adds no bill (the row bills either way); a claim on a telemetry row makes it bill. A
    // token_count whose own row has not landed yet would otherwise take a history row nearby and bill the call twice.
    const rank = (row: LedgerRow): number => row.origin === TELEMETRY_ORIGIN ? 1 : 0;
    return rows.sort((a, b) => rank(a) - rank(b) || Math.abs(a.at - holder.ts) - Math.abs(b.at - holder.ts));
  };

  covers(responseId: string): boolean {
    this.applyReplays();
    const row = this.byResponse.get(responseId);
    return !!row && !row.rolloutBilled;
  }

  holds(responseId: string): boolean {
    return this.byResponse.has(responseId);
  }

  billedBefore(responseId: string): boolean {
    this.applyReplays();
    return this.billedIds.has(responseId);
  }

  vouch(responseId: string, moved?: (key: string) => void): boolean {
    this.applyReplays();
    const row = this.byResponse.get(responseId);
    if (!row) return false;
    // A record asked about again, as a call waiting for its row is, already stands on it.
    if (row.holder?.kind === "claim" && row.holder.responseId === responseId) return true;
    return place({ kind: "claim", model: row.model, input: row.input, output: row.output, ts: row.at, gatewayRows: true, responseId, ...(moved ? { moved } : {}) }, this.candidates, this.dead);
  }

  /**
   * `watch` loads the ledger afresh on every tick, so a rollout line that was read before its row existed
   * has already billed its call. Offered those calls again, each takes its own row — by response id when the
   * rollout recorded one, else the billed row nearest in time (one row per call) — and keeps it out of
   * `counts`: one bill, never two.
   */
  adopt(calls: Iterable<BilledCall>): void {
    this.applyReplays();
    for (const call of calls) {
      if (this.adopted.has(call)) continue;
      this.record(call);
      // No row yet: the gateway may append it later in this read, and `refresh` matches it then.
      if (!this.take(call)) this.unmatched.add(call);
    }
  }

  private record(call: BilledCall): void {
    this.adopted.add(call);
    if (call.responseId) this.billedIds.add(call.responseId);
  }

  /** Marks the row of a call a rollout billed, so the ledger does not bill it too. False when no row is there yet. */
  private take(call: BilledCall): boolean {
    // The same response recorded by two rollouts (a fork copies its parent's records) is one call: one copy was dropped
    // on the strength of the row, this one was billed, and that bill stands alone.
    const own = call.responseId ? this.byResponse.get(call.responseId) : undefined;
    if (own?.holder?.kind === "claim" && own.holder.responseId === call.responseId) {
      own.rolloutBilled = true;
      call.key = callKey(own);
      return true;
    }
    // A claimed row's rollout copy was dropped: only the ledger bills that call, so it is not a row to take (unless
    // the call that claimed it can stand on another). A call with a response id takes the row of that id, and no other.
    return place({ kind: "bill", model: call.model, input: call.input, output: call.output, ts: call.ts, gatewayRows: false,
      ...(call.responseId ? { responseId: call.responseId } : {}), moved: (key) => { call.key = key; } }, this.candidates, this.dead);
  }

  replay(decisions: Iterable<LedgerDecision>): void {
    this.replays.push(...decisions);
  }

  /**
   * Applies the decisions `replay` was handed, in the order they were made. A row is a call's own, so first each
   * decision takes the very row it held (`key`) if this ledger has it free; only the rest are matched afresh, oldest
   * first, against what is left. Otherwise a rollout read before another could take a row the other's decision
   * held, and the other's call would be billed twice, or by no one.
   */
  private applyReplays(): void {
    if (!this.replays.length) return;
    const todo = this.replays.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    this.replays = [];
    const afresh = todo.filter((decision) => !this.retake(decision));
    for (const decision of afresh) {
      if (decision.kind === "claimed") {
        const moved = (key: string): void => { decision.key = key; };
        if (decision.responseId) this.vouch(decision.responseId, moved);
        else this.claim(decision.model, decision.input, decision.output, decision.ts, { gatewayRows: decision.gatewayRows, onClaim: moved });
      } else {
        this.adopt([decision]);
      }
    }
  }

  /** Gives a decision the row it held before, when this ledger has that row and nobody else has it. */
  private retake(decision: LedgerDecision): boolean {
    const row = decision.key ? this.known.get(decision.key) : undefined;
    if (!row) return false;
    const moved = (key: string): void => { decision.key = key; };
    if (decision.kind === "claimed") {
      // A claim that may take a billed row looks again each time: a history row it holds is only the nearest it could
      // find while its own row had not landed, and the billed row it now has is the better one (see `candidates`).
      // A claim that may not take a billed row names one only where it took the echo this row replaced (`supersede`).
      if (!matchable(row) || (decision.gatewayRows && row.origin === TELEMETRY_ORIGIN)) return false;
      return stayOn(row, { kind: "claim", model: decision.model, input: decision.input, output: decision.output, ts: decision.ts, gatewayRows: decision.gatewayRows,
        ...(decision.responseId ? { responseId: decision.responseId } : {}), moved });
    }
    if (!billedRow(row)) return false;
    if (!stayOn(row, { kind: "bill", model: decision.model, input: decision.input, output: decision.output, ts: decision.ts, gatewayRows: false,
      ...(decision.responseId ? { responseId: decision.responseId } : {}), moved })) return false;
    this.record(decision);
    return true;
  }

  /**
   * One file per vendor and account, read on demand: by the time its events run, every
   * rollout has had its chance to claim what the ledger and the transcript share.
   */
  files(vendor: GatewayVendor): SourceFile[] {
    const primary = this.label(vendor);
    return [...this.streams.values()].filter((stream) => stream.vendor === vendor).map(({ account, rows }) => ({
      path: join(this.stateDir, "usage"),
      // The usual account keeps the plain key; another account gets its own stream.
      key: account === primary ? `gateway:${vendor}` : `gateway:${vendor}:${account}`,
      project: "gateway",
      source: vendor,
      account,
      parse: () => [],
      ctx: null,
      events: (): Generator<Event> => {
        this.applyReplays();
        return eventsFor(vendor, account === primary ? "" : account, rows);
      },
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
    const source: LedgerSource = { usage, sinceMs: opts.sinceMs, map, read: new Map(), mtimes: new Map() };
    const rows = ledgerFiles(usage, opts.sinceMs - CLAIM_WINDOW_MS).flatMap((file) => {
      const { rows, end, mtime } = readRows(file, map);
      source.read.set(file, end);
      if (mtime !== undefined) source.mtimes.set(file, mtime);
      return rows;
    });
    return new GatewayLedger(dedupe(rows), dir, true, config.authDirectories, source);
  }

  /** Whether any telemetry row is waiting for a rollout to claim it, so reading rollouts can change a report. */
  hasClaimable(): boolean {
    return this.rows.some((row) => row.origin === TELEMETRY_ORIGIN && row.session === true);
  }
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

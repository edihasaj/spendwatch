// Parses Codex CLI rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl).
// Emits the same Event model as the Claude parser so both feed one Aggregator.
import { cmdParts, type Event } from "./parse";
import type { Usage } from "./pricing";
import { projectFromCwd } from "./projects";
import { CLAIM_WINDOW_MS, isMarked, markedId, nextDecisionSeq, type GatewayIndex, type LedgerDecision } from "./gateway";
// The label of a routed call no ledger here vouches for; the Claude Code parser (claude-routed.ts) shares it.
import { UNCONFIRMED } from "./gateway-decisions";
import { legacyTurnAdmission } from "./codex-legacy-forks";

export { UNCONFIRMED };

export interface CodexCtx {
  model?: string;
  /** Where session_meta says the turn was billed, e.g. "openai" or "subscription_gateway". */
  modelProvider?: string;
  /**
   * The id of the file's own session_meta, its first. A forked rollout copies its parent's session_meta after
   * its own, and that one describes the parent thread: its provider, model and id must not replace these.
   */
  ownSession?: string;
  project?: string;
  sid: string; // per-file session id (from session_meta), for accurate session counts
  promptN: number;
  callN: number;
  callName: Map<string, { name: string; sub?: string; deep?: string }>;
  /** Set once a token_usage_record is seen: those are authoritative, token_count is noise. */
  records?: boolean;
  /** Usage of the previous token_count, to drop exact repeats. */
  lastCount?: string;
  /** The gateway ledger of this Mac, present whenever the gateway source is on (possibly with no rows). */
  gateway?: GatewayIndex;
  /**
   * Routed calls this rollout handed to the ledger (a claimed row) or billed itself (no row when read), in order.
   * Watch reloads the ledger on every tick: the new ledger replays these, so a row that lands later does not
   * bill a call a second time, and a claim is not taken again by another call.
   */
  decisions?: LedgerDecision[];
  /** Gateway-marked responses this Mac's ledger holds no row for; kept, labelled, and reported in a note. */
  unconfirmed?: number;
  /** Numbers the routed token_count calls, which have no id of their own. */
  routedN?: number;
  /**
   * Routed calls the ledger may still bill, oldest first: the gateway appends a row just after the response ends,
   * so the rollout line can be read before it. `settleRouted` decides them once a reloaded ledger holds their row,
   * once they are older than the claim window, or when the read ends.
   */
  pending?: PendingCall[];
  /**
   * New paginated subagent rollouts copy an inherited prefix into the child's
   * file. The native thread store projects only records at or after this
   * boundary. Keep that decision ahead of every parser side effect.
   */
  history?: CodexHistoryState;
  /** The first session_meta decides whether this file has an ownership gate. */
  historyHeaderSeen?: boolean;
  /** Turn ids a legacy fork's parent opened; rows in those turns are the parent's (codex-legacy-forks.ts). */
  inheritedTurns?: ReadonlySet<string>;
  activeTurn?: string;
}

/** A routed call that waits for its ledger row; see `CodexCtx.pending`. */
interface PendingCall {
  /** The marked response id, for a token_usage_record; a token_count has none. */
  responseId?: string;
  /** The model the ledger row would carry, for a claim. */
  model: string;
  /** The model the rollout bills the call under if no row turns up. */
  billedModel?: string;
  input: number;
  output: number;
  ts: number;
  usage: Usage;
}

interface CodexHistoryState {
  boundary: number;
  lastOrdinal: number;
  /** The first, file-owning session header. It must not drift later in the file. */
  header: CodexHistoryHeader;
}

interface CodexHistoryHeader {
  id: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  historyMode: string;
  boundary: number;
  parent?: string;
}

export interface CodexHistoryAdmission {
  /** The already-decoded row. Reusing it prevents a wrapper from admitting twice. */
  record: any;
  /** The record belongs to copied parent context and must not create any usage. */
  inherited: boolean;
  /**
   * The header establishes the child's identity even when it is in the copied
   * prefix. It changes context only and never emits an event in that case.
   */
  seedMetadata: boolean;
}

let codexFallback = 0;
export function newCodexCtx(gateway?: GatewayIndex): CodexCtx {
  return { sid: `codex-${codexFallback++}`, promptN: 0, callN: 0, callName: new Map(), gateway };
}

function historyError(message: string): never {
  throw new Error(`Codex paginated subagent history: ${message}`);
}

function safeOrdinal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parentReference(payload: any): string | undefined {
  const source = payload?.source;
  const subagent = source?.subagent;
  const threadSpawn = subagent?.thread_spawn;
  const candidates: Array<[string, unknown, boolean]> = [
    ["forked_from_id", payload?.forked_from_id, Object.prototype.hasOwnProperty.call(payload, "forked_from_id")],
    ["parent_thread_id", payload?.parent_thread_id, Object.prototype.hasOwnProperty.call(payload, "parent_thread_id")],
    ["source.subagent.parent_thread_id", subagent?.parent_thread_id, Object.prototype.hasOwnProperty.call(subagent ?? {}, "parent_thread_id")],
    ["source.subagent.thread_spawn.parent_thread_id", threadSpawn?.parent_thread_id, Object.prototype.hasOwnProperty.call(threadSpawn ?? {}, "parent_thread_id")],
  ];
  const refs: string[] = [];
  for (const [name, value, provided] of candidates) {
    if (!provided) continue;
    const reference = nonEmptyString(value);
    if (!reference) historyError(`session header has an invalid ${name}`);
    refs.push(reference);
  }
  if (new Set(refs).size > 1) historyError("session header has conflicting parent-thread references");
  return refs[0];
}

function historyHeader(payload: any, boundary: number): CodexHistoryHeader {
  return {
    id: nonEmptyString(payload?.id) ?? "",
    cwd: nonEmptyString(payload?.cwd),
    model: nonEmptyString(payload?.model),
    modelProvider: nonEmptyString(payload?.model_provider),
    historyMode: nonEmptyString(payload?.history_mode) ?? "",
    boundary,
    parent: parentReference(payload),
  };
}

function sameHeader(a: CodexHistoryHeader, b: CodexHistoryHeader): boolean {
  return a.id === b.id
    && a.cwd === b.cwd
    && a.model === b.model
    && a.modelProvider === b.modelProvider
    && a.historyMode === b.historyMode
    && a.boundary === b.boundary
    && a.parent === b.parent;
}

/** Reject a completed copy that ends in its inherited prefix. */
export function assertCodexHistoryComplete(ctx: CodexCtx): void {
  const history = ctx.history;
  if (history && history.lastOrdinal < history.boundary - 1) {
    historyError("ended before its child-owned ownership boundary");
  }
}

/**
 * Admit one decoded rollout row before the normal parser can touch counters,
 * gateway claims, pending calls, or metadata. Codex's native thread store
 * treats `subagent_history_start_ordinal` as the first child-owned ordinal;
 * rows before it are copied parent context only.
 */
export function admitCodexHistoryLine(line: string, ctx: CodexCtx): CodexHistoryAdmission | undefined {
  if (!line) return;
  if (line[0] !== "{") {
    if (ctx.history) historyError("contains invalid JSON after an explicit ownership header");
    return;
  }
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    if (ctx.history) historyError("contains invalid JSON after an explicit ownership header");
    return;
  }
  if (!record || typeof record !== "object") {
    if (ctx.history) historyError("contains a non-object row after an explicit ownership header");
    return;
  }

  const payload = record.payload ?? {};
  if (!ctx.history && !ctx.historyHeaderSeen && record.type === "session_meta") {
    ctx.historyHeaderSeen = true;
    const hasBoundary = Object.prototype.hasOwnProperty.call(payload, "subagent_history_start_ordinal")
      && payload.subagent_history_start_ordinal !== null;
    const paginated = payload.history_mode === "paginated";
    if (hasBoundary && !paginated) {
      historyError("has a subagent ownership boundary without paginated history mode");
    }
    if (paginated && hasBoundary) {
      const boundary = safeOrdinal(payload.subagent_history_start_ordinal);
      if (boundary === undefined) historyError("has an invalid subagent ownership boundary");
      const ordinal = safeOrdinal(record.ordinal);
      if (ordinal === undefined) historyError("header is missing a safe ordinal");
      if (!nonEmptyString(payload.id)) historyError("header is missing a non-empty child id");
      const header = historyHeader(payload, boundary);
      ctx.history = { boundary, lastOrdinal: ordinal, header };
      return { record, inherited: ordinal < boundary, seedMetadata: ordinal < boundary };
    }
  }

  const history = ctx.history;
  if (!history) return legacyTurnAdmission(record, ctx);

  const ordinal = safeOrdinal(record.ordinal);
  if (ordinal === undefined) historyError("row is missing a safe ordinal");
  if (ordinal <= history.lastOrdinal) historyError("row ordinal is not strictly increasing");
  history.lastOrdinal = ordinal;
  const inherited = ordinal < history.boundary;

  if (record.type === "session_meta" && !inherited) {
    const mode = payload.history_mode;
    const boundary = payload.subagent_history_start_ordinal;
    if (mode !== "paginated" || safeOrdinal(boundary) !== history.boundary) {
      historyError("own session metadata changed its history mode or ownership boundary");
    }
    if (!sameHeader(history.header, historyHeader(payload, history.boundary))) {
      historyError("own session metadata changed after its first header");
    }
  }
  return { record, inherited, seedMetadata: false };
}

// Where a routed rollout call is billed. Only the provider named in session_meta routes, so every other rollout
// keeps its events. A routed call is:
//   - dropped, when a ledger row on this Mac bills it: the marked row with its response id, a telemetry row it
//     claims, or for a token_count (no id to compare) a billed row with the same model, tokens and time;
//   - kept, when no row does. A marked call is labelled `<model> (UNCONFIRMED)` and keeps its id, so that where its
//     report meets the serving Mac's, that Mac's ledger bills it and this copy is taken out (gateway-settle.ts).
// The gateway writes its row just after the response ends, so a marked record or a token_count waits in `pending`
// for a row until it is older than the claim window (watch decides it on a later tick, against a reloaded ledger),
// or the read ends. An unmarked record can only match a telemetry row, which the gateway imported once, so it is
// decided at once.
const routes = (ctx: CodexCtx): boolean => ctx.modelProvider === "subscription_gateway";
const marked = isMarked;

/** True when a row on this Mac bills the call now; a claim is remembered for the next reloaded ledger. */
function ledgerBills(ctx: CodexCtx, call: PendingCall): boolean {
  const gateway = ctx.gateway;
  if (!gateway) return false;
  if (marked(call.responseId)) {
    if (!gateway.vouch) return !!gateway.covers?.(call.responseId);
    // The record is dropped on the strength of that row, which no other call may take: a token_count of the same size
    // and time would otherwise be dropped on it too.
    const decision: LedgerDecision = { seq: nextDecisionSeq(), kind: "claimed", model: call.model, input: call.input, output: call.output, ts: call.ts, gatewayRows: true, responseId: call.responseId };
    if (!gateway.vouch(call.responseId, (key) => { decision.key = key; })) return false;
    (ctx.decisions ??= []).push(decision);
    return true;
  }
  // A token_count has no response id to compare, so it may also take the ledger's billed row.
  const gatewayRows = call.responseId === undefined;
  // The decision keeps the row the claim stands on, and follows it if the ledger moves the claim to another alike row:
  // a reloaded ledger gives this call that very row back.
  const decision: LedgerDecision = { seq: nextDecisionSeq(), kind: "claimed", model: call.model, input: call.input, output: call.output, ts: call.ts, gatewayRows };
  if (!gateway.claim(call.model, call.input, call.output, call.ts, { gatewayRows, onClaim: (key) => { decision.key = key; } })) return false;
  (ctx.decisions ??= []).push(decision);
  return true;
}

function apiEvent(ctx: CodexCtx, requestId: string, model: string | undefined, usage: Usage, ts: number, gatewayId?: string): Event {
  return {
    t: "api", sessionId: ctx.sid, requestId, model, usage, sidechain: false, ts,
    ...(ctx.modelProvider ? { modelProvider: ctx.modelProvider } : {}),
    ...(gatewayId ? { gateway: { id: gatewayId, role: "unconfirmed" as const } } : {}),
  };
}

/**
 * Bills a waiting call from the rollout: no ledger row turned up for it in time. Nothing, for a copy of a marked
 * response that another copy has already billed: a fork copies its parent's records, and one call is one bill.
 */
function billHere(ctx: CodexCtx, call: PendingCall): Event | undefined {
  const { model, input, output, ts, responseId } = call;
  if (marked(responseId) && ctx.gateway?.billedBefore?.(responseId)) return undefined;
  // A row that lands after this must not bill the call again: the ledger of this read keeps the call until a
  // refresh finds its row, and a reloaded ledger replays it (see gateway.ts).
  const decision: LedgerDecision = { seq: nextDecisionSeq(), kind: "billed", model, input, output, ts, ...(responseId ? { responseId } : {}) };
  (ctx.decisions ??= []).push(decision);
  ctx.gateway?.adopt?.([decision]);
  // A record whose row this Mac's ledger holds, but under another call that cannot move (a token_count of the same
  // size that stood on it first), is billed here as the plain call it is: the row bills that other call, and a copy
  // that kept the gateway's id would be taken out where reports meet, against the very row that bills the other call.
  if (!marked(responseId) || ctx.gateway?.holds?.(responseId)) return apiEvent(ctx, `c${ctx.callN++}`, call.billedModel, call.usage, ts);
  ctx.unconfirmed = (ctx.unconfirmed ?? 0) + 1;
  return apiEvent(ctx, responseId, `${call.billedModel ?? "unknown"} (${UNCONFIRMED})`, call.usage, ts, markedId(responseId));
}

/**
 * Decides the waiting routed calls, in order: those a row on this Mac now bills are dropped, those older than the
 * claim window (or all of them, when `final`) are billed here, and the rest keep waiting. `watch` calls this on every
 * tick with the reloaded ledger; a read calls it with `final` when the file ends.
 */
export function* settleRouted(ctx: CodexCtx, final = false, now = Date.now()): Generator<Event> {
  if (final) assertCodexHistoryComplete(ctx);
  const waiting = ctx.pending;
  if (!waiting?.length) return;
  const due = (call: PendingCall): boolean => final || !(now - call.ts <= CLAIM_WINDOW_MS);
  // A call newer than its ledger lets the ledger catch up before anything is decided about it: its row, and the row of
  // a call just like it, may have landed since the read. A claim that took a neighbour's row because its own had not
  // been read yet would leave the neighbour to be billed twice. A call that has waited out its window while the file
  // was still being read counts too, so a read that takes longer than the window checks as well as one that ends.
  if (waiting.some((call) => call.ts >= (ctx.gateway?.readAt ?? Infinity) - CLAIM_WINDOW_MS)) ctx.gateway?.refresh?.();
  ctx.pending = [];
  for (const call of waiting) {
    if (ledgerBills(ctx, call)) {
      const id = call.responseId ?? `count${(ctx.routedN = (ctx.routedN ?? 0) + 1)}`;
      yield { t: "routed", sessionId: ctx.sid, id, ts: call.ts };
    } else if (due(call)) {
      const event = billHere(ctx, call);
      if (event) yield event;
    } else {
      ctx.pending.push(call);
    }
  }
}

// Same last+total usage twice in a row means a re-emission of one call, not a
// new one; the raw objects can differ in key order, so compare the numbers.
function countSignature(last: any, total: any): string {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return JSON.stringify([n(last?.input_tokens), n(last?.cached_input_tokens), n(last?.output_tokens),
    n(total?.input_tokens), n(total?.cached_input_tokens), n(total?.output_tokens)]);
}

const SHELL_FNS = new Set(["exec_command", "shell", "local_shell_call", "run_command", "container.exec"]);

export function* parseCodexLine(line: string, ctx: CodexCtx): Generator<Event> {
  const admission = admitCodexHistoryLine(line, ctx);
  if (!admission) return;
  yield* parseAdmittedCodexLine(admission, ctx);
}

/**
 * Parses an already-admitted Codex record. Source wrappers must call
 * `admitCodexHistoryLine` first and hand this function the returned admission,
 * so ownership cannot be checked twice or after a filtering side effect.
 */
export function* parseAdmittedCodexLine(admission: CodexHistoryAdmission, ctx: CodexCtx): Generator<Event> {
  const d = admission.record;
  if (admission.inherited && !admission.seedMetadata) return;
  const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
  const p = d.payload ?? {};
  
  switch (d.type) {
    case "session_meta": {
      const id = typeof p.id === "string" ? p.id : "";
      if (ctx.ownSession !== undefined && id !== ctx.ownSession) return; // the parent's meta in a fork
      ctx.ownSession = id;
      if (p.cwd) ctx.project = projectFromCwd(p.cwd);
      if (p.model) ctx.model = p.model;
      if (p.model_provider) ctx.modelProvider = p.model_provider;
      if (p.id) ctx.sid = p.id;
      // The file header names the child even when native Codex stores it before
      // a copied parent prefix. It establishes state only; that prefix must not
      // create an event in this child's report.
      if (!admission.seedMetadata) {
        yield { t: "meta", sessionId: ctx.sid, project: ctx.project, model: ctx.model, ts };
      }
      return;
    }
    case "turn_context": {
      const before = ctx.project;
      if (p.cwd) ctx.project = projectFromCwd(p.cwd);
      if (p.model) ctx.model = p.model;
      yield { t: "meta", sessionId: ctx.sid, project: ctx.project ?? before, model: ctx.model, ts };
      return;
    }
    case "event_msg": {
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
        yield { t: "prompt", sessionId: ctx.sid, promptId: `u${ctx.promptN++}`, text: p.message, sidechain: false, ts };
      } else if (p.type === "token_count") {
        const u = (p.info?.last_token_usage ?? {}) as any;
        const input = u.input_tokens ?? 0;
        const cached = u.cached_input_tokens ?? 0;
        const cacheWrite = u.cache_write_input_tokens ?? 0;
        if (input || u.output_tokens) {
          // Every token_count with usage is one call the CLI actually made — the
          // count Codex's own status line would have shown, deduped or not.
          yield { t: "observed", sessionId: ctx.sid, ts };
          // With per-response records there is nothing to reconstruct here.
          if (ctx.records) return;
          const sig = countSignature(u, p.info?.total_token_usage);
          if (sig === ctx.lastCount) return; // a re-emission of the previous call
          ctx.lastCount = sig;
          // Gross `input` still feeds the ledger claims; the bill splits it, as a token_usage_record does.
          const usage: Usage = { input: Math.max(0, input - cached - cacheWrite), output: u.output_tokens ?? 0, cacheRead: cached, cache5m: cacheWrite, cache1h: 0 };
          if (routes(ctx) && ctx.gateway) {
            (ctx.pending ??= []).push({ model: ctx.model ?? "unknown", billedModel: ctx.model, input, output: u.output_tokens ?? 0, ts, usage });
            yield* settleRouted(ctx);
            return;
          }
          yield apiEvent(ctx, `c${ctx.callN++}`, ctx.model, usage, ts);
        }
      } else if (p.type === "patch_apply_end") {
        // file edit; size approximated from the patch result if present
        const chars = typeof p.stdout === "string" ? p.stdout.length : 0;
        const id = `patch${ctx.callN}`;
        yield { t: "tooluse", sessionId: ctx.sid, requestId: `c${ctx.callN}`, id, name: "apply_patch", argChars: chars, ts };
      } else if (p.type === "mcp_tool_call_end") {
        const name = `mcp:${p.server ?? "?"}.${p.tool ?? p.invocation?.tool ?? "?"}`;
        const id = `mcp${ctx.callN}`;
        const chars = JSON.stringify(p.result ?? "").length;
        yield { t: "tooluse", sessionId: ctx.sid, requestId: `c${ctx.callN}`, id, name, argChars: 0, ts };
        yield { t: "toolresult", sessionId: ctx.sid, id, chars, ts };
      }
      return;
    }
    case "token_usage_record": {
      ctx.records = true;
      const u = (p.usage ?? p.info ?? p) as any;
      const input = u.input_tokens ?? 0;
      const cached = u.cached_input_tokens ?? 0;
      const cacheWrite = u.cache_write_input_tokens ?? 0;
      const responseId = typeof p.response_id === "string" && p.response_id ? p.response_id : `r${ctx.callN++}`;
      const output = u.output_tokens ?? 0;
      const usage: Usage = { input: Math.max(0, input - cached - cacheWrite), output, cacheRead: cached, cache5m: cacheWrite, cache1h: 0 };
      if (routes(ctx) && ctx.gateway && marked(responseId)) {
        (ctx.pending ??= []).push({ responseId, model: ctx.model ?? "unknown", billedModel: ctx.model, input, output, ts, usage });
        yield* settleRouted(ctx);
        return;
      }
      // An unmarked routed record can only match a telemetry row, imported once, so it is decided now.
      if (routes(ctx) && ledgerBills(ctx, { responseId, model: ctx.model ?? "unknown", input, output, ts, usage })) {
        yield { t: "routed", sessionId: ctx.sid, id: responseId, ts };
        return;
      }
      // With the gateway source off, a marked call still keeps its id, so the serving Mac's report can settle it.
      const gatewayId = routes(ctx) && marked(responseId) ? markedId(responseId) : undefined;
      yield apiEvent(ctx, responseId, ctx.model, usage, ts, gatewayId);
      return;
    }
    case "response_item": {
      if (p.type === "function_call") {
        const name = p.name ?? "?";
        const argChars = (p.arguments ?? "").length;
        const id = p.call_id ?? `fc${ctx.callN++}`;
        let extra: { sub?: string; deep?: string } = {};
        let detail: string | undefined;
        let toolName = name;
        if (SHELL_FNS.has(name)) {
          toolName = "exec_command";
          const cmd = readCmd(p.arguments);
          if (cmd) {
            extra = cmdParts(cmd);
            detail = cmd;
          }
        } else {
          detail = readFirstString(p.arguments);
        }
        ctx.callName.set(id, { name: toolName, ...extra });
        yield { t: "tooluse", sessionId: ctx.sid, requestId: "c0", id, name: toolName, argChars, sub: extra.sub, deep: extra.deep, detail, ts };
      } else if (p.type === "function_call_output") {
        const id = p.call_id ?? "?";
        const out = p.output;
        const chars = typeof out === "string" ? out.length : JSON.stringify(out ?? "").length;
        let exit: number | undefined;
        if (typeof out === "string") {
          const m = out.match(/exited with code (\d+)/);
          if (m) exit = Number(m[1]);
        }
        yield { t: "toolresult", sessionId: ctx.sid, id, chars, exit, error: exit !== undefined && exit !== 0, ts };
      }
      return;
    }
  }
}

function readFirstString(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const o = JSON.parse(args);
    const v = Object.values(o).find((x) => typeof x === "string") as string | undefined;
    return v?.slice(0, 120);
  } catch {
    return undefined;
  }
}

function readCmd(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const o = JSON.parse(args);
    if (typeof o.cmd === "string") return o.cmd;
    if (Array.isArray(o.command)) return o.command.join(" ");
    if (typeof o.command === "string") return o.command;
  } catch {}
  return undefined;
}

// Parses Codex CLI rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl).
// Emits the same Event model as the Claude parser so both feed one Aggregator.
import { cmdParts, type Event } from "./parse";
import type { Usage } from "./pricing";
import { projectFromCwd } from "./projects";
import { CLAIM_WINDOW_MS, MARKER, type GatewayIndex, type LedgerDecision } from "./gateway";

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

let codexFallback = 0;
export function newCodexCtx(gateway?: GatewayIndex): CodexCtx {
  return { sid: `codex-${codexFallback++}`, promptN: 0, callN: 0, callName: new Map(), gateway };
}

/** The model label of a gateway-marked call that this Mac's ledger cannot vouch for. */
export const UNCONFIRMED = "gateway-routed, not in this Mac's ledger";

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
const marked = (responseId?: string): responseId is string => !!responseId?.startsWith(MARKER);

/** True when a row on this Mac bills the call now; a claim is remembered for the next reloaded ledger. */
function ledgerBills(ctx: CodexCtx, call: PendingCall): boolean {
  const gateway = ctx.gateway;
  if (!gateway) return false;
  if (marked(call.responseId)) return !!gateway.covers?.(call.responseId);
  // A token_count has no response id to compare, so it may also take the ledger's billed row.
  const gatewayRows = call.responseId === undefined;
  if (!gateway.claim(call.model, call.input, call.output, call.ts, { gatewayRows })) return false;
  (ctx.decisions ??= []).push({ kind: "claimed", model: call.model, input: call.input, output: call.output, ts: call.ts, gatewayRows });
  return true;
}

function apiEvent(ctx: CodexCtx, requestId: string, model: string | undefined, usage: Usage, ts: number, gatewayId?: string): Event {
  return {
    t: "api", sessionId: ctx.sid, requestId, model, usage, sidechain: false, ts,
    ...(gatewayId ? { gateway: { id: gatewayId, role: "unconfirmed" as const } } : {}),
  };
}

/** Bills a waiting call from the rollout: no ledger row turned up for it in time. */
function billHere(ctx: CodexCtx, call: PendingCall): Event {
  const { model, input, output, ts, responseId } = call;
  // A row that lands after this must not bill the call again; a reloaded ledger replays this (see gateway.ts).
  (ctx.decisions ??= []).push({ kind: "billed", model, input, output, ts, ...(responseId ? { responseId } : {}) });
  if (!marked(responseId)) return apiEvent(ctx, `c${ctx.callN++}`, call.billedModel, call.usage, ts);
  ctx.unconfirmed = (ctx.unconfirmed ?? 0) + 1;
  return apiEvent(ctx, responseId, `${call.billedModel ?? "unknown"} (${UNCONFIRMED})`, call.usage, ts, responseId.slice(MARKER.length));
}

/**
 * Decides the waiting routed calls, in order: those a row on this Mac now bills are dropped, those older than the
 * claim window (or all of them, when `final`) are billed here, and the rest keep waiting. `watch` calls this on every
 * tick with the reloaded ledger; a read calls it with `final` when the file ends.
 */
export function* settleRouted(ctx: CodexCtx, final = false, now = Date.now()): Generator<Event> {
  const waiting = ctx.pending;
  if (!waiting?.length) return;
  // A read about to bill calls newer than its ledger lets the ledger catch up first: their rows may have landed since.
  if (final && waiting.some((call) => call.ts >= (ctx.gateway?.readAt ?? Infinity) - CLAIM_WINDOW_MS)) ctx.gateway?.refresh?.();
  ctx.pending = [];
  for (const call of waiting) {
    if (ledgerBills(ctx, call)) {
      const id = call.responseId ?? `count${(ctx.routedN = (ctx.routedN ?? 0) + 1)}`;
      yield { t: "routed", sessionId: ctx.sid, id, ts: call.ts };
    } else if (final || !(now - call.ts <= CLAIM_WINDOW_MS)) {
      yield billHere(ctx, call);
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
  if (!line || line[0] !== "{") return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
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
      yield { t: "meta", sessionId: ctx.sid, project: ctx.project, model: ctx.model, ts };
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
        if (input || u.output_tokens) {
          // Every token_count with usage is one call the CLI actually made — the
          // count Codex's own status line would have shown, deduped or not.
          yield { t: "observed", sessionId: ctx.sid, ts };
          // With per-response records there is nothing to reconstruct here.
          if (ctx.records) return;
          const sig = countSignature(u, p.info?.total_token_usage);
          if (sig === ctx.lastCount) return; // a re-emission of the previous call
          ctx.lastCount = sig;
          const usage: Usage = { input: Math.max(0, input - cached), output: u.output_tokens ?? 0, cacheRead: cached, cache5m: 0, cache1h: 0 };
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
      const gatewayId = routes(ctx) && marked(responseId) ? responseId.slice(MARKER.length) : undefined;
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

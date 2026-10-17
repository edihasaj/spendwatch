// Claude Code transcripts whose calls a subscription gateway routed.
//
// The gateway writes its month ledger beside the transcripts it proxies (see gateway.ts), so a Claude Code turn that
// went through a Messages provider is written twice: once by Claude Code, and once as a `msg_gl_*` row by the gateway.
// Claude Code keeps that marked id as the message id of every line of the response, so the pair resolves the way a
// Codex rollout's does (codex.ts is the model for everything here): a transcript record whose row this Mac's ledger
// holds is dropped, and one whose row it does not hold is kept and labelled, so that where the two reports meet the
// serving Mac's ledger bills it (gateway-settle.ts).
//
// Two things differ from Codex. Every routed Claude line carries an id, so nothing matches a row by model and tokens:
// only the id decides. And Claude Code writes SEVERAL assistant lines for one response, one per content block, each
// repeating the message id with usage that has grown since the last. The aggregator keeps the latest usage it sees for
// a requestId, so those lines stay one call as long as they keep the requestId the first line of the response had.
import type { Usage } from "./pricing";
import type { Event, GatewayMark } from "./parse";

/** The one kind of event this module bills with. */
type ApiEvent = Extract<Event, { t: "api" }>;
import type { GatewayIndex, LedgerDecision } from "./gateway";
import { CLAIM_WINDOW_MS, nextDecisionSeq, UNCONFIRMED } from "./gateway-decisions";
import { markedId } from "./gateway-ledger-files";

/** One gateway-marked assistant message, as the latest line of it has recorded it. */
export interface RoutedMessage {
  /** The `msg_gl_*` id Claude Code gives every line of the response. */
  id: string;
  sessionId: string;
  /** The requestId of the FIRST line of the response; a later line's own id would make the call count twice. */
  requestId: string;
  model?: string;
  usage: Usage;
  sidechain: boolean;
  ts: number;
  /** When this process read the latest line of the message, which may be long after the line was stamped. */
  seenAt: number;
}

/**
 * How far past its stamp a line may still be the one that just arrived. Claude Code writes every line of a response
 * when the response ends, but stamps each with the time its content block began, so the stamp of a line of a long
 * response can be a minute old the moment `watch` reads it. Measured from that stamp its row would look lost, and the
 * call would be billed from the transcript a moment before the ledger appends its row; `watch` would then adopt the
 * row, so nothing is double counted, but the call sits under Claude rather than under the vendor that served it.
 */
export const LINE_LAG_MS = 120_000;

/** The moment to wait from: when this process read the line, never more than `LINE_LAG_MS` past its stamp. */
const since = (message: RoutedMessage): number => Math.max(message.ts, Math.min(message.seenAt, message.ts + LINE_LAG_MS));

/** What became of a marked message, so its later lines follow the same decision. */
type Decided = { kind: "routed" } | { kind: "dropped" } | { kind: "billed"; requestId: string; model?: string; gateway?: GatewayMark };

export interface ClaudeCtx {
  /** This Mac's gateway ledger, present whenever the gateway source is on (possibly with no rows). */
  gateway?: GatewayIndex;
  /** What this transcript decided about marked messages, in order; a reloaded ledger replays them (see codex.ts). */
  decisions?: LedgerDecision[];
  /** Marked messages waiting for their ledger row, by message id, oldest first. */
  pending?: Map<string, RoutedMessage>;
  /** What became of each marked message already decided, so its later lines follow the same decision. */
  decided?: Map<string, Decided>;
  /** Marked messages billed here because this Mac's ledger holds no row for them (for the status warning). */
  unconfirmed?: number;
}

export const newClaudeCtx = (gateway?: GatewayIndex): ClaudeCtx => ({ gateway });

/** Input as the ledger counts it: gross, its `inputTokens` includes both caches the transcript splits out. */
const grossInput = (usage: Usage): number => usage.input + usage.cacheRead + usage.cache5m + usage.cache1h;

const apiEvent = (message: RoutedMessage, model: string | undefined, gateway?: GatewayMark): ApiEvent => ({
  t: "api", sessionId: message.sessionId, requestId: message.requestId, model, usage: message.usage, sidechain: message.sidechain, ts: message.ts,
  ...(gateway ? { gateway } : {}),
});

/**
 * The line of a gateway-marked message the parser cannot bill yet, if the gateway source is on; see `parse.ts`. The
 * parser gives the line as the transcript recorded it: when it was read is this process's own business (see `since`).
 */
export function* routedMessage(ctx: ClaudeCtx, line: Omit<RoutedMessage, "seenAt">): Generator<Event> {
  const message: RoutedMessage = { ...line, seenAt: Date.now() };
  const decided = ctx.decided?.get(message.id);
  if (decided) {
    // The first line decided what this response is, and these follow it: a billed one is the same call again, with the
    // usage the response has now reached, which the aggregator takes over the earlier figure.
    if (decided.kind === "billed") yield apiEvent({ ...message, requestId: decided.requestId }, decided.model, decided.gateway);
    return;
  }
  const pending = ctx.pending ?? new Map<string, RoutedMessage>();
  // `set` on a key the map holds keeps its place, so the message waits in the order its first line arrived.
  pending.set(message.id, { ...message, requestId: pending.get(message.id)?.requestId ?? message.requestId });
  ctx.pending = pending;
  yield* settleClaudeRouted(ctx);
}

/** True when this Mac's ledger holds this message's row, which is then the record that bills the call. */
function vouched(ctx: ClaudeCtx, message: RoutedMessage): boolean {
  const gateway = ctx.gateway;
  if (!gateway) return false;
  if (!gateway.vouch) return !!gateway.covers?.(message.id);
  // The record is dropped on the strength of its own row, which no other call may take. Neither the model nor the
  // tokens are compared: a Messages row is matched by its id alone (see `matchable` in gateway.ts).
  const decision: LedgerDecision = { seq: nextDecisionSeq(), kind: "claimed", model: message.model ?? "unknown", input: grossInput(message.usage), output: message.usage.output, ts: message.ts, gatewayRows: true, responseId: message.id };
  if (!gateway.vouch(message.id, (key) => { decision.key = key; })) return false;
  (ctx.decisions ??= []).push(decision);
  return true;
}

/**
 * Bills a waiting message from the transcript: no ledger row turned up for it in time. Nothing at all, for a second
 * copy of a message another copy already billed, as a resumed or forked session copies Claude Code's records.
 */
function billHere(ctx: ClaudeCtx, message: RoutedMessage): ApiEvent | undefined {
  if (ctx.gateway?.billedBefore?.(message.id)) return undefined;
  // A row that lands later must not bill the call again: the ledger of this read keeps the call until a refresh finds
  // its row, and a reloaded ledger replays the bill (see gateway.ts).
  const decision: LedgerDecision = { seq: nextDecisionSeq(), kind: "billed", model: message.model ?? "unknown", input: grossInput(message.usage), output: message.usage.output, ts: message.ts, responseId: message.id };
  (ctx.decisions ??= []).push(decision);
  ctx.gateway?.adopt?.([decision]);
  // A row this Mac's ledger holds, but under another call that cannot move, bills that call: keep this one as the plain
  // Claude call it looks like, or it would be taken out where reports meet against the very row that bills the other.
  if (ctx.gateway?.holds?.(message.id)) return apiEvent(message, message.model);
  ctx.unconfirmed = (ctx.unconfirmed ?? 0) + 1;
  // The label keeps the Claude model's name, so the call is still priced as the Claude usage it counts as, and its id
  // lets the Mac whose gateway served it take the call over.
  return apiEvent(message, `${message.model ?? "unknown"} (${UNCONFIRMED})`, { id: markedId(message.id), role: "unconfirmed" });
}

/**
 * Decides the waiting messages, in order: one this Mac's row now bills is dropped, one whose row has been waited for
 * through the claim window (or any of them, when `final`) is billed here, and the rest keep waiting. `watch` calls this
 * on every tick against the reloaded ledger; a read calls it with `final` when the file ends.
 */
export function* settleClaudeRouted(ctx: ClaudeCtx, final = false, now = Date.now()): Generator<Event> {
  const waiting = ctx.pending;
  if (!waiting?.size) return;
  // A message read since its ledger was lets the ledger catch up before anything is decided: its row, and the row of a
  // message just like it, may have landed since the files were read.
  if ([...waiting.values()].some((message) => since(message) >= (ctx.gateway?.readAt ?? Infinity) - CLAIM_WINDOW_MS)) ctx.gateway?.refresh?.();
  ctx.pending = undefined;
  for (const message of waiting.values()) {
    const decided = (ctx.decided ??= new Map());
    if (vouched(ctx, message)) {
      decided.set(message.id, { kind: "routed" });
      yield { t: "routed", sessionId: message.sessionId, id: message.id, ts: message.ts };
    } else if (final || !(now - since(message) <= CLAIM_WINDOW_MS)) {
      const event = billHere(ctx, message);
      decided.set(message.id, event ? { kind: "billed", requestId: event.requestId, model: event.model, ...(event.gateway ? { gateway: event.gateway } : {}) } : { kind: "dropped" });
      if (event) yield event;
    } else {
      (ctx.pending ??= new Map()).set(message.id, message);
    }
  }
}

/** What the transcripts' gateway-routed calls need said about how they were counted, if anything. */
export function claudeGatewayWarning(contexts: (ClaudeCtx | null | undefined)[]): string | undefined {
  return contexts.some((ctx) => ctx?.unconfirmed)
    ? `some gateway-routed calls in these transcripts had no row in this Mac's gateway ledger, so they are counted under Claude as "<model> (${UNCONFIRMED})"; where this report is combined with the report of the Mac whose gateway served them (--input, or the spend archive), that Mac's ledger bills them and they leave Claude`
    : undefined;
}

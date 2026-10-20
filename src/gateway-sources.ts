// The gateway hand-offs the transcript sources share: carrying a reloaded ledger into parser state an earlier
// read kept, building a Claude transcript file whose parse settles its marked messages against the ledger, and
// what the Codex rollouts' routed calls need said about how they were counted.
import { newClaudeCtx, settleClaudeRouted, type ClaudeCtx } from "./claude-routed";
import { UNCONFIRMED, type CodexCtx } from "./codex";
import { parseLine } from "./parse";
import type { GatewayIndex, LedgerDecision } from "./gateway";
import type { SourceFile } from "./sources";

/**
 * The reloaded ledger has not seen what a transcript already did: rows it claimed, and calls it billed before their rows
 * existed. It gets them, and the transcript carries on against it.
 */
export function carryLedger(kept: { gateway?: GatewayIndex; decisions?: LedgerDecision[] }, gateway?: GatewayIndex): void {
  kept.gateway = gateway;
  gateway?.replay?.(kept.decisions ?? []);
}

/** One Claude Code transcript, read against `gateway` with the parser state `settleClaudeRouted` decides on. */
export function claudeFile(path: string, projectName: string, account: string, gateway?: GatewayIndex, aliases: ReadonlyMap<string, string> = new Map()): SourceFile {
  // A marked message is settled against the ledger, as a rollout's marked record is: what one line decided, and
  // what a later line of the same message repeats, belongs to this file's parser, which watch keeps between ticks.
  const ctx = newClaudeCtx(gateway);
  let renewed = false;
  const normalizeModel = (model: string): string => {
    const direct = aliases.get(model);
    if (direct) return direct;
    const suffix = ` (${UNCONFIRMED})`;
    if (!model.endsWith(suffix)) return model;
    const base = model.slice(0, -suffix.length);
    return aliases.has(base) ? `${aliases.get(base)}${suffix}` : model;
  };
  const normalize = function* (events: Iterable<import("./parse").Event>) {
    for (const event of events) yield event.t === "api" && event.model ? { ...event, model: normalizeModel(event.model) } : event;
  };
  return { path, project: projectName, source: "claude", account, parse: (text: string, kept: ClaudeCtx) => normalize(parseLine(text, kept)), ctx,
    settle: (kept: ClaudeCtx, final: boolean) => normalize(settleClaudeRouted(kept, final)),
    // Once per discovery: what the kept state decided since is already known to this ledger.
    renew: (kept: ClaudeCtx) => { if (renewed) return; renewed = true; carryLedger(kept, ctx.gateway); } };
}

/** What the rollouts' gateway-routed calls need said about how they were counted, if anything. */
export function gatewayWarning(contexts: CodexCtx[]): string | undefined {
  const routed = contexts.filter((ctx) => ctx?.modelProvider === "subscription_gateway");
  // No count here: these files can reach outside the report's window, and the labelled model rows carry the figures.
  const notes = [
    routed.some((ctx) => ctx.unconfirmed) ? `some gateway-routed calls in these rollouts had no row in this Mac's gateway ledger, so they are counted under Codex as "<model> (${UNCONFIRMED})"; where this report is combined with the report of the Mac whose gateway served them (--input, or the spend archive), that Mac's ledger bills them and they leave Codex` : "",
    routed.some((ctx) => ctx.lastCount !== undefined) ? "gateway-routed rollouts recorded token_count without token_usage_record; those calls were matched against this Mac's gateway ledger by model, token counts and time, and a call it does not hold is counted from the rollout" : "",
  ].filter(Boolean);
  return notes.length ? notes.join("; ") : undefined;
}

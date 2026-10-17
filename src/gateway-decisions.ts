// What a transcript tells the gateway ledger about one routed call, and in which order: the types the ledger's index
// contract (gateway.ts) and the parsers that read one (codex.ts, claude-routed.ts) share.

/** How far apart the ledger's clock and the transcript's may be for one call. */
export const CLAIM_WINDOW_MS = 30_000;

/** The model label of a gateway-marked call that this Mac's ledger cannot vouch for. */
export const UNCONFIRMED = "gateway-routed, not in this Mac's ledger";

export interface ClaimOptions {
  /**
   * Also match the ledger's own Responses-marked rows (`resp_gl_*`; a `msg_gl_*` row is matched by its id alone, see
   * gateway.ts). Only for a transcript line that carries no response id to compare, such as a token_count: with an id,
   * `covers` already decides.
   */
  gatewayRows?: boolean;
  /**
   * Told the `callKey` of the row a successful claim took, and again whenever the ledger moves the claim to another
   * alike row (see gateway-match.ts), so a later ledger can be asked for the row the claim ended on.
   */
  onClaim?: (key: string) => void;
}

/** A call a rollout billed itself because the ledger held no row for it when the line was read. */
export interface BilledCall {
  model: string;
  input: number;
  output: number;
  ts: number;
  /** The gateway's marked response id, when the rollout recorded one. */
  responseId?: string;
  /** The `callKey` of the row this call was matched to, once matched (a call with a response id matches by that id). */
  key?: string;
}

/**
 * What a rollout decided about one routed call, in the order it decided: it claimed a ledger row, or billed the
 * call itself. `watch` loads a fresh ledger on every tick and replays these, so the new ledger agrees with what
 * the reports already hold.
 */
export type LedgerDecision =
  | { seq?: number; kind: "claimed"; model: string; input: number; output: number; ts: number; gatewayRows: boolean; responseId?: string; key?: string }
  | ({ seq?: number; kind: "billed" } & BilledCall);

let decisionSeq = 0;
/**
 * The place of a decision among all of them, across rollouts: a ledger that replays several rollouts' decisions
 * applies them in the order they were made, which is the order the one ledger of the earlier read saw them in.
 */
export const nextDecisionSeq = (): number => decisionSeq++;

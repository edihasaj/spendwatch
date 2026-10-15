import { beforeEach, describe, expect, test } from "bun:test";
import { GatewayIndex, type LedgerDecision } from "../src/gateway";
import { apiEvents, copilot, openLedger, telemetry } from "./ledger-fixtures";

// Where a claim stands when the ledger holds a billed row and a telemetry row it could take, and when the gateway's
// own row replaces the telemetry echo of the call a claim already holds.
const MODEL = "gpt-5.1-codex";

// The time of the test, taken when it starts: a call is newer than a ledger read only if both are about now.
let NOW = Date.now();
beforeEach(() => { NOW = Date.now(); });
const billed = (id: string, at = NOW) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });
const echo = (id: string, at = NOW) => telemetry({ requestId: id, at, session: true });
/** A decision a rollout made, as the ledger of an earlier tick was told it (a claim unless `kind` says it billed itself). */
const decision = (over: { ts: number; kind?: "claimed" | "billed"; gatewayRows?: boolean; key?: string; seq?: number }): LedgerDecision =>
  ({ seq: 1, kind: "claimed", model: MODEL, input: 1000, output: 50, gatewayRows: true, ...over }) as LedgerDecision;

const open = openLedger;
const bills = (ledger: ReturnType<typeof openLedger>["ledger"]): string[] => apiEvents(ledger, "copilot").map((event) => event.requestId);

describe("a token_count looking for its row", () => {
  // A telemetry row bills once a claim takes it; a billed row bills anyway. A token_count whose own row has not landed
  // yet takes a history row near it, and its own row then bills it a second time: so it prefers the billed row.
  test("takes a billed row before a telemetry row, though the telemetry row is nearer", () => {
    const { ledger } = open([echo("history", NOW), billed("own", NOW + 10_000)]);
    const keys: string[] = [];
    expect(ledger.claim(MODEL, 1000, 50, NOW + 1_000, { gatewayRows: true, onClaim: (key) => keys.push(key) })).toBe(true);
    expect(keys).toEqual(["studio:own"]);
    expect(bills(ledger)).toEqual(["studio:own"]);
  });

  test("still takes the telemetry row when no billed row is free", () => {
    const { ledger } = open([echo("history", NOW), billed("taken", NOW + 10_000)]);
    expect(ledger.vouch("resp_gl_taken")).toBe(true);
    const keys: string[] = [];
    expect(ledger.claim(MODEL, 1000, 50, NOW + 1_000, { gatewayRows: true, onClaim: (key) => keys.push(key) })).toBe(true);
    expect(keys).toEqual(["studio:history"]);
  });

  test("leaves a telemetry row for the next tick to hand back only if no billed row could have it instead", () => {
    // Last tick the call took the history row, its own row not having landed. The ledger of this tick holds both.
    const { ledger } = open([echo("history", NOW), billed("own", NOW + 10_000)]);
    ledger.replay([decision({ ts: NOW + 1_000, key: "studio:history" })]);
    expect(bills(ledger)).toEqual(["studio:own"]);
  });

  test("a claim that may not take a billed row keeps the telemetry row it held", () => {
    const { ledger } = open([echo("near", NOW), echo("far", NOW + 9_000), billed("own", NOW + 4_000)]);
    ledger.replay([decision({ ts: NOW, gatewayRows: false, key: "studio:far" })]);
    expect(bills(ledger).sort()).toEqual(["studio:far", "studio:own"]);
  });
});

describe("the gateway's own row for a call the ledger held as a telemetry echo", () => {
  // A claim that may not take a billed row (an unmarked record) took the echo; then the call's own row landed.
  const claimed = () => {
    const world = open([echo("c", NOW), echo("spare", NOW + 5_000)]);
    const claim = decision({ ts: NOW, gatewayRows: false });
    expect(world.ledger.claim(MODEL, 1000, 50, NOW, { onClaim: (key) => { claim.key = key; } })).toBe(true);
    expect(claim.key).toBe("studio:c");
    world.append(billed("c", NOW));
    world.ledger.refresh();
    return { ...world, claim };
  };

  test("keeps the claim, and the next tick's ledger gives the claim that row back instead of the spare echo", () => {
    const { dir, ledger, claim } = claimed();
    expect(bills(ledger)).toEqual(["studio:c"]);
    const next = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    next.replay([claim]);
    expect(bills(next)).toEqual(["studio:c"]);
  });

  test("lets the claim step aside for the call's own record, as for any claim on a billed row", () => {
    const { ledger } = claimed();
    expect(ledger.vouch("resp_gl_c")).toBe(true);
    // The claim moved to the spare echo; the record's row bills, and so does the echo the claim now holds.
    expect(bills(ledger).sort()).toEqual(["studio:c", "studio:spare"]);
  });
});

describe("decisions replayed on a ledger", () => {
  test("a refresh applies them before it reads on", () => {
    const { ledger } = open([echo("t", NOW)]);
    const claim = decision({ ts: NOW, gatewayRows: false });
    ledger.replay([claim]);
    ledger.refresh();
    expect(claim.key).toBe("studio:t");
  });

  test("a claim goes back to a row only while the row is free", () => {
    const { ledger } = open([echo("t1", NOW), echo("t2", NOW + 1_000)]);
    ledger.replay([decision({ ts: NOW, gatewayRows: false, key: "studio:t1", seq: 1 }), decision({ ts: NOW + 500, gatewayRows: false, key: "studio:t1", seq: 2 })]);
    expect(bills(ledger).sort()).toEqual(["studio:t1", "studio:t2"]);
  });

  test("a call a rollout billed does not go back to a row that is not a billed one", () => {
    const { ledger } = open([echo("t", NOW)]);
    ledger.replay([decision({ kind: "billed", ts: NOW, gatewayRows: false, key: "studio:t" })]);
    // The history row is still free for a claim: no rollout's bill stands on it.
    expect(ledger.claim(MODEL, 1000, 50, NOW)).toBe(true);
  });

  test("a call a rollout billed is replayed once, however often it is handed over", () => {
    const { ledger, append } = open([billed("r", NOW)]);
    const bill = decision({ kind: "billed", ts: NOW, gatewayRows: false, key: "studio:r" });
    ledger.replay([bill]);
    ledger.replay([bill]);
    expect(bills(ledger)).toEqual([]);
    // A later row of the same size is another call's: it bills, and is not taken for the bill the rollout made.
    append(billed("r2", NOW + 2_000));
    ledger.refresh();
    expect(bills(ledger)).toEqual(["studio:r2"]);
  });
});

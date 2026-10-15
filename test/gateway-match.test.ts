import { beforeEach, describe, expect, test } from "bun:test";
import type { LedgerDecision } from "../src/gateway";
import { apiEvents, copilot, load, openLedger, telemetry } from "./ledger-fixtures";

// Which row a call stands on when alike calls compete for alike rows (gateway-match.ts).
const MODEL = "gpt-5.1-codex";

// The time of the test, taken when it starts: a call is newer than a ledger read only if both are about now.
let NOW = Date.now();
beforeEach(() => { NOW = Date.now(); });
const billed = (id: string, at = NOW) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });
const echo = (id: string, at = NOW) => telemetry({ requestId: id, at, session: true });
const bills = (ledger: ReturnType<typeof load>): string[] => apiEvents(ledger, "copilot").map((event) => event.requestId);
const call = (ts: number, over: Partial<LedgerDecision> = {}): LedgerDecision =>
  ({ seq: 1, kind: "claimed", model: MODEL, input: 1000, output: 50, ts, gatewayRows: false, ...over }) as LedgerDecision;

describe("a row two copies of one call stand on", () => {
  // A fork copies its parent's records: one copy was dropped on the strength of the row, the other was billed by its
  // rollout, and the one bill is the second's. The row then holds both marks, and must keep both.
  const marked = { model: MODEL, input: 1000, output: 50, ts: NOW, responseId: "resp_gl_x" };
  const fork = () => {
    const ledger = load([billed("x")]);
    expect(ledger.vouch("resp_gl_x")).toBe(true);
    ledger.adopt([marked]);
    expect(bills(ledger)).toEqual([]);
    return ledger;
  };

  test("is not taken by an alike token_count that looks for a row, which finds none and is billed by its rollout", () => {
    const ledger = fork();
    expect(ledger.claim(MODEL, 1000, 50, NOW + 1_000, { gatewayRows: true })).toBe(false);
    expect(bills(ledger)).toEqual([]);
  });

  test("is not taken by an alike call a rollout billed either", () => {
    const ledger = fork();
    ledger.adopt([{ model: MODEL, input: 1000, output: 50, ts: NOW + 1_000 }]);
    expect(bills(ledger)).toEqual([]);
  });

  test("is left as it was by a search that fails, however long the chain it tried", () => {
    // a holds a claim that may move to b, b holds the fork: nothing gives a third call a row.
    const ledger = load([billed("a", NOW), billed("x", NOW + 10_000)]);
    const moved: string[] = [];
    expect(ledger.claim(MODEL, 1000, 50, NOW, { gatewayRows: true, onClaim: (key) => moved.push(key) })).toBe(true);
    expect(ledger.vouch("resp_gl_x")).toBe(true);
    ledger.adopt([{ ...marked, ts: NOW + 10_000 }]);
    expect(ledger.claim(MODEL, 1000, 50, NOW + 5_000, { gatewayRows: true })).toBe(false);
    // The claim was not told it moved, and the fork still bills once, through its rollout.
    expect(moved).toEqual(["studio:a"]);
    expect(bills(ledger)).toEqual(["studio:a"]);
  });
});

describe("a chain of alike calls", () => {
  const SPACING = 25_000; // each call reaches its own row and the neighbours' (30 s), no more

  test("moves as far as it goes, past any fixed number of rows", () => {
    const n = 10_000;
    const ledger = load(Array.from({ length: n + 1 }, (_, i) => billed(`r${i}`, NOW + i * SPACING)));
    // Call i stands on row i; row n is free, and only the first call can be moved onto it through all the others.
    let placed = 0;
    for (let i = 0; i < n; i++) if (ledger.claim(MODEL, 1000, 50, NOW + i * SPACING + 100, { gatewayRows: true })) placed++;
    expect(placed).toBe(n);
    expect(ledger.claim(MODEL, 1000, 50, NOW - SPACING, { gatewayRows: true })).toBe(true);
    expect(bills(ledger)).toHaveLength(n + 1);
    // Every row has a call now.
    expect(ledger.claim(MODEL, 1000, 50, NOW - SPACING, { gatewayRows: true })).toBe(false);
  });

  test("a call that cannot reach a free row through the chain gets none, and the chain stays put", () => {
    const ledger = load([billed("a", NOW), billed("b", NOW + SPACING)]);
    const keys: string[][] = [[], []];
    expect(ledger.claim(MODEL, 1000, 50, NOW, { gatewayRows: true, onClaim: (key) => keys[0]!.push(key) })).toBe(true);
    expect(ledger.claim(MODEL, 1000, 50, NOW + SPACING, { gatewayRows: true, onClaim: (key) => keys[1]!.push(key) })).toBe(true);
    expect(ledger.claim(MODEL, 1000, 50, NOW - SPACING, { gatewayRows: true })).toBe(false);
    expect(keys).toEqual([["studio:a"], ["studio:b"]]);
  });
});

describe("a call that is given back the row it held", () => {
  test("takes it only while it is free", () => {
    const ledger = load([echo("t1", NOW), echo("t2", NOW + 1_000)]);
    // Both calls held t1 in the ledger of the last tick; only one can have it now, the other stands on t2.
    ledger.replay([call(NOW, { key: "studio:t1", seq: 1 }), call(NOW + 500, { key: "studio:t1", seq: 2 })]);
    expect(bills(ledger).sort()).toEqual(["studio:t1", "studio:t2"]);
  });
});

describe("calls that find no row", () => {
  test("take a row that lands afterwards, even one only a call standing on the others can move to", () => {
    const { ledger, append } = openLedger([billed("a", NOW)]);
    expect(ledger.claim(MODEL, 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    // 28 s on, the only row in reach is a, which the first call holds and has nowhere to go from.
    expect(ledger.claim(MODEL, 1000, 50, NOW + 28_000, { gatewayRows: true })).toBe(false);
    // A row lands 25 s before the first call: out of reach of the second, but the first can step to it.
    append(billed("c", NOW - 25_000));
    ledger.refresh();
    expect(ledger.claim(MODEL, 1000, 50, NOW + 28_000, { gatewayRows: true })).toBe(true);
    expect(bills(ledger).sort()).toEqual(["studio:a", "studio:c"]);
  });

  test("do not each walk the whole chain of rows that has nowhere to go", () => {
    const n = 5_000;
    const ledger = load(Array.from({ length: n }, (_, i) => billed(`r${i}`, NOW + i * 1_000)));
    for (let i = 0; i < n; i++) ledger.claim(MODEL, 1000, 50, NOW + i * 1_000 + 10, { gatewayRows: true });
    const middle = NOW + (n / 2) * 1_000;
    const started = performance.now();
    let placed = 0;
    for (let i = 0; i < 200; i++) if (ledger.claim(MODEL, 1000, 50, middle + i, { gatewayRows: true })) placed++;
    // Every row has a call, so none of the 200 finds one; each used to look at all 5,000 rows (about two seconds in all).
    expect(placed).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

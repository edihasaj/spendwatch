import { beforeEach, describe, expect, test } from "bun:test";
import type { LedgerDecision } from "../src/gateway";
import type { LedgerRow, RowHolder } from "../src/gateway-ledger-files";
import { RowMatcher } from "../src/gateway-match";
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

describe("the search itself", () => {
  const row = (id: string, over: Partial<LedgerRow> = {}): LedgerRow => ({
    at: NOW, host: "studio", requestId: id, responseId: `resp_gl_${id}`, model: MODEL, origin: "gateway", vendor: "copilot", provider: "copilot",
    input: 1000, cached: 0, cacheWrite: 0, output: 50, reasoning: 0, nanoAiu: 0, claimed: false, rolloutBilled: false, ...over,
  });
  const holder = (name: string): RowHolder => ({ kind: "claim", model: MODEL, input: 1000, output: 50, ts: NOW, gatewayRows: true, responseId: name });
  const stand = (target: LedgerRow, who: RowHolder): void => { target.claimed = true; target.holder = who; };

  test("steps over a row that is taken and has no holder, which stays where it is", () => {
    const fixed = row("fixed", { claimed: true });
    const free = row("free");
    const keys: string[] = [];
    expect(new RowMatcher().place({ ...holder("a"), moved: (key) => keys.push(key) }, () => [fixed, free])).toBe(true);
    expect(keys).toEqual(["studio:free"]);
    expect([fixed.claimed, free.claimed]).toEqual([true, true]);
    // Nothing else is free, and the row with no holder gives nobody a place.
    expect(new RowMatcher().place(holder("b"), () => [fixed, free])).toBe(false);
  });

  test("looks at each row once, however many calls could move to it", () => {
    // 0 can vacate a or b; a's call can vacate b; b's call has nowhere to go. b is reached twice, and looked at once.
    const a = row("a");
    const b = row("b");
    const wanting = new Map<RowHolder, LedgerRow[]>();
    const [ha, hb, h0] = [holder("ha"), holder("hb"), holder("h0")];
    stand(a, ha);
    stand(b, hb);
    wanting.set(h0, [a, b]);
    wanting.set(ha, [b]);
    wanting.set(hb, []);
    const asked: RowHolder[] = [];
    expect(new RowMatcher().place(h0, (who) => { asked.push(who); return wanting.get(who)!; })).toBe(false);
    expect(asked).toEqual([h0, ha, hb]);
    expect([a.holder, b.holder, a.claimed, b.claimed]).toEqual([ha, hb, true, true]);
  });

  test("does not look at a row again after a search that found nothing, until the ledger changes", () => {
    const only = row("only");
    const holding = holder("holding");
    stand(only, holding);
    const matcher = new RowMatcher();
    let asked = 0;
    const candidates = (who: RowHolder): LedgerRow[] => { asked++; return who === holding ? [] : [only]; };
    expect(matcher.place(holder("first"), candidates)).toBe(false);
    const after = asked;
    expect(matcher.place(holder("second"), candidates)).toBe(false);
    expect(asked - after).toBe(1); // asked for the second call's candidates only: the row is known to lead nowhere
    matcher.rowsChanged();
    expect(matcher.place(holder("third"), candidates)).toBe(false);
    expect(asked - after).toBe(3); // and now the holder of the row is asked again
  });
});

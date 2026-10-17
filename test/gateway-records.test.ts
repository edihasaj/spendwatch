import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { newCodexCtx, parseCodexLine, settleRouted, UNCONFIRMED, type CodexCtx } from "../src/codex";
import { GatewayIndex } from "../src/gateway";
import type { Event } from "../src/parse";
import { apiEvents, copilot, stateDir } from "./ledger-fixtures";

// What a rollout does with the records and token_counts of calls the gateway routed, against this Mac's ledger.
const MODEL = "gpt-5.1-codex";

// The time of the test, taken when it starts: a call is newer than a ledger read only if both are about now.
let NOW = Date.now();
beforeEach(() => { NOW = Date.now(); });
const iso = (ms: number) => new Date(ms).toISOString();
const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 };
const meta = () => JSON.stringify({ timestamp: iso(NOW - 60_000), type: "session_meta", payload: { id: "s", model_provider: "subscription_gateway", model: MODEL } });
const record = (id: string, at: number) => JSON.stringify({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: `resp_gl_${id}`, usage } });
const count = (at: number, total: number) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { input_tokens: total, output_tokens: 50 } } } });
const row = (id: string, at = NOW) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });

type Api = Extract<Event, { t: "api" }>;

/** A rollout read line by line and settled at the end of the read, as a report does; the calls it billed itself. */
function read(ctx: CodexCtx, lines: string[]): Api[] {
  const events = [...lines.flatMap((text) => [...parseCodexLine(text, ctx)]), ...settleRouted(ctx, true)];
  return events.filter((event): event is Api => event.t === "api");
}

const open = (rows: Parameters<typeof stateDir>[0]) => {
  const dir = stateDir(rows);
  return { dir, ledger: GatewayIndex.load({ sinceMs: 0, stateDir: dir }) };
};
const billedKeys = (ledger: ReturnType<typeof open>["ledger"]) => apiEvents(ledger, "copilot").map((event) => event.requestId);

describe("a record whose row another call stands on", () => {
  // The token_count is read first and, with no id, takes the nearest billed row: the record's own. The row cannot be
  // moved off it to give the record the row, because no other row is there.
  test("is billed as the plain call it is, so the report that bills the row does not take it out", () => {
    const { ledger } = open([row("x")]);
    const ctx = newCodexCtx(ledger);
    const billed = read(ctx, [meta(), count(NOW + 1_000, 1000), record("x", NOW)]);
    expect(billed).toHaveLength(1);
    // Not labelled, and without the gateway's id: settling reports against each other would remove a copy that has
    // an id, against the very row that bills the other call.
    expect(billed[0]!.gateway).toBeUndefined();
    expect(billed[0]!.model).toBe(MODEL);
    expect(ctx.unconfirmed).toBeUndefined();
    expect(billedKeys(ledger)).toEqual(["studio:x"]);
  });

  test("keeps the gateway's id and the label when this Mac's ledger holds no row for it", () => {
    const { ledger } = open([row("other", NOW - 100_000)]);
    const billed = read(newCodexCtx(ledger), [meta(), record("x", NOW)]);
    expect(billed.map((event) => [event.gateway, event.model])).toEqual([[{ id: "x", role: "unconfirmed" }, `${MODEL} (${UNCONFIRMED})`]]);
  });
});

describe("a record two rollouts hold (a fork copies its parent's)", () => {
  test("is billed once when no row here bills it", () => {
    const { ledger } = open([row("other", NOW - 100_000)]);
    const bills = [read(newCodexCtx(ledger), [meta(), record("x", NOW)]), read(newCodexCtx(ledger), [meta(), record("x", NOW)])];
    expect(bills.map((list) => list.length)).toEqual([1, 0]);
  });

  test("is dropped from both copies when its row is here, and the ledger bills it once", () => {
    const { ledger } = open([row("x")]);
    const bills = [read(newCodexCtx(ledger), [meta(), record("x", NOW)]), read(newCodexCtx(ledger), [meta(), record("x", NOW)])];
    expect(bills.map((list) => list.length)).toEqual([0, 0]);
    expect(billedKeys(ledger)).toEqual(["studio:x"]);
  });

  test("is billed once when one copy was billed before the row landed and the other is read after", () => {
    const { dir, ledger } = open([row("other", NOW - 100_000)]);
    const first = read(newCodexCtx(ledger), [meta(), record("x", NOW)]);
    appendFileSync(join(dir, "usage", readdirSync(join(dir, "usage"))[0]!), JSON.stringify({ v: 1, host: "studio", ...row("x") }) + "\n");
    // The row's first bill is the first copy's, which stands alone: neither the ledger nor the second copy bills it again.
    const second = read(newCodexCtx(ledger), [meta(), record("x", NOW)]);
    expect([first.length, second.length]).toEqual([1, 0]);
    expect(billedKeys(ledger)).toEqual(["studio:other"]);
  });
});

describe("what a rollout remembers of its decisions", () => {
  test("a record dropped on the strength of its row remembers the row, for the ledger of the next tick", () => {
    const { ledger } = open([row("x")]);
    const ctx = newCodexCtx(ledger);
    read(ctx, [meta(), record("x", NOW)]);
    expect(ctx.decisions).toMatchObject([{ kind: "claimed", responseId: "resp_gl_x", key: "studio:x" }]);
  });

  test("a call billed by its rollout is replayed in the order it was made among the claims", () => {
    // Two alike token_counts and one row: the first is dropped on it, the second is billed by its rollout.
    const { dir, ledger } = open([row("r")]);
    const ctx = newCodexCtx(ledger);
    expect(read(ctx, [meta(), count(NOW, 1000), count(NOW + 1_000, 2000)])).toHaveLength(1);
    expect(ctx.decisions!.map((decision) => decision.kind)).toEqual(["claimed", "billed"]);
    // The next tick's ledger has neither held row to go back to: the claim, being older, must choose before the bill.
    const next = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    for (const decision of ctx.decisions!) delete decision.key;
    next.replay(ctx.decisions!);
    expect(billedKeys(next)).toEqual(["studio:r"]);
  });
});

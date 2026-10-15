import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import type { GatewayIndex } from "../src/gateway";
import type { Event } from "../src/parse";

const TS = "2026-10-05T09:00:00.000Z";
const MS = Date.parse(TS);

type Row = Record<string, unknown>;

// Rollout lines all carry the same timestamp; the tests are about counting, not clocks.
function collect(rows: Row[], ctx = newCodexCtx()): Event[] {
  const out: Event[] = [];
  for (const row of rows) {
    for (const e of parseCodexLine(JSON.stringify({ ...row, timestamp: TS }), ctx)) out.push(e);
  }
  return out;
}

const apis = (events: Event[]) => events.filter((e) => e.t === "api") as Extract<Event, { t: "api" }>[];
const observed = (events: Event[]) => events.filter((e) => e.t === "observed");

// One ctx per file, the way the scanner builds them, then fold every event it emits.
function fold(rows: Row[], ctx = newCodexCtx()): { report: Aggregator; events: Event[] } {
  const agg = new Aggregator();
  const sink = agg.stream("rollout-1.jsonl", "?", "codex");
  const events: Event[] = [];
  for (const e of collect(rows, ctx)) {
    events.push(e);
    sink(e);
  }
  return { report: agg, events };
}

const meta = (modelProvider = "openai", model = "gpt-5.5"): Row => ({
  type: "session_meta",
  payload: { id: "cx1", cwd: "/Users/dev/Projects/sample-app", model, model_provider: modelProvider },
});

const record = (responseId: string, usage: Row): Row => ({
  type: "token_usage_record",
  payload: { response_id: responseId, usage },
});

/** A ledger stub that holds billed rows for exactly these response ids, and nothing to claim. */
const ledgerHolding = (...ids: string[]): GatewayIndex => ({ claim: () => false, covers: (id) => ids.includes(id) });

const count = (last: Row, total: Row = last): Row => ({
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
});

describe("codex token_usage_record parsing", () => {
  test("one call per response_id, and the token_counts that follow add nothing", () => {
    const { report, events } = fold([
      meta(),
      record("resp_1", { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 50 }),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }),
      // A streamed response restates itself with fuller usage — same call.
      record("resp_1", { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 90 }),
      record("resp_2", { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }),
    ]);
    expect(apis(events).map((e) => e.requestId)).toEqual(["resp_1", "resp_1", "resp_2"]);
    expect(report.report().apiCalls).toBe(2);
    // The record's cache write is a fifth-hour bucket, and is removed from input.
    expect(apis(events)[1]!.usage).toEqual({ input: 500, output: 90, cacheRead: 400, cache5m: 100, cache1h: 0 });
  });

  test("a record skipped by the gateway marks the file as record-backed all the same", () => {
    const ctx = newCodexCtx(ledgerHolding("resp_gl_1"));
    const events = collect([
      meta("subscription_gateway"),
      record("resp_gl_1", { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }),
      count({ input_tokens: 900, cached_input_tokens: 0, output_tokens: 40 }),
    ], ctx);
    expect(apis(events)).toEqual([]);
    // token_count after a record is the same turn re-stated, never a new call.
    expect(observed(events)).toHaveLength(1);
    const rest = collect([count({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 })], ctx);
    expect(apis(rest)).toEqual([]);
  });
});

describe("codex token_usage_record fields", () => {
  test("reads the cache fields Codex writes, and no Anthropic-style aliases", () => {
    const [call] = apis(collect([meta(), record("resp_a", { input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 100, output_tokens: 50 })]));
    // Codex names them cached_input_tokens and cache_write_input_tokens; other names are not its usage.
    expect(call!.usage).toEqual({ input: 1000, output: 50, cacheRead: 0, cache5m: 0, cache1h: 0 });
  });
});

describe("codex token_count fallback", () => {
  const withWrites = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 50 };

  test("prices cache writes as cache writes and takes them out of input, as a record does", () => {
    const [call] = apis(collect([meta(), count(withWrites)]));
    expect(call!.usage).toEqual({ input: 500, output: 50, cacheRead: 400, cache5m: 100, cache1h: 0 });
  });

  test("a count without cache writes is unchanged, and writes larger than the input cannot make it negative", () => {
    const [plain] = apis(collect([meta(), count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 })]));
    expect(plain!.usage).toEqual({ input: 600, output: 50, cacheRead: 400, cache5m: 0, cache1h: 0 });
    const [odd] = apis(collect([meta(), count({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 50, output_tokens: 5 })]));
    expect(odd!.usage.input).toBe(0);
  });

  test("a routed count still claims its ledger row by gross input, with the cache writes in it", () => {
    const asked: number[] = [];
    const ledger: GatewayIndex = { claim: (_model, input) => { asked.push(input); return false; } };
    collect([meta("subscription_gateway"), count(withWrites)], newCodexCtx(ledger));
    expect(asked).toEqual([1000]);
  });

  test("a routed count the ledger never held is billed from the rollout with its cache writes priced", () => {
    const ctx = newCodexCtx({ claim: () => false });
    // The line is older than the claim window, so no row is waited for.
    const events = collect([meta("subscription_gateway"), count(withWrites)], ctx);
    expect(apis(events).map((e) => e.usage)).toEqual([{ input: 500, output: 50, cacheRead: 400, cache5m: 100, cache1h: 0 }]);
  });
});

describe("codex observed calls", () => {
  test("observed counts every call the CLI reported, repeats included", () => {
    const { report, events } = fold([
      meta(),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { input_tokens: 1000, output_tokens: 50 }),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { input_tokens: 1000, output_tokens: 50 }),
      count({ input_tokens: 700, cached_input_tokens: 100, output_tokens: 20 }, { input_tokens: 1700, output_tokens: 70 }),
    ]);
    expect(observed(events)).toHaveLength(3);
    expect(report.report()).toMatchObject({ apiCalls: 2, observedCalls: 3 });
  });

  test("a token_count that merely repeats the previous one is dropped", () => {
    const events = collect([
      meta(),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { input_tokens: 1000, output_tokens: 50 }),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { input_tokens: 1000, output_tokens: 50 }),
      // Same turn, but the running total moved — a real additional call.
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { input_tokens: 2000, output_tokens: 100 }),
    ]);
    expect(apis(events)).toHaveLength(2);
  });

  test("a token_count with no usage is neither observed nor billed", () => {
    const events = collect([meta(), count({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })]);
    expect(events.filter((e) => e.t === "observed" || e.t === "api")).toEqual([]);
  });
});

describe("codex subscription_gateway routing", () => {
  test("a marked response is skipped under subscription_gateway and kept elsewhere", () => {
    const marked = record("resp_gl_9", { input_tokens: 500, cached_input_tokens: 0, output_tokens: 25 });
    const events = collect([meta("subscription_gateway"), marked], newCodexCtx(ledgerHolding("resp_gl_9")));
    expect(apis(events)).toEqual([]);
    // The ledger bills it, so the report knows one call was routed.
    expect(events.filter((e) => e.t === "routed")).toEqual([{ t: "routed", sessionId: "cx1", id: "resp_gl_9", ts: MS }]);
    // The same marked id is an ordinary API call when nothing routed it.
    expect(apis(collect([meta("openai"), marked], newCodexCtx(ledgerHolding("resp_gl_9"))))).toHaveLength(1);
  });

  test("a marked response this Mac's ledger does not hold is kept, labelled, and remembered for a later ledger", () => {
    const marked = record("resp_gl_9", { input_tokens: 500, cached_input_tokens: 0, output_tokens: 25 });
    // Another Mac's gateway served it, or this ledger's month is gone: nothing here proves a ledger bills it.
    const ctx = newCodexCtx(ledgerHolding("resp_gl_other"));
    const [call] = apis(collect([meta("subscription_gateway"), marked], ctx));
    expect(call).toMatchObject({ requestId: "resp_gl_9", model: "gpt-5.5 (gateway-routed, not in this Mac's ledger)" });
    expect(call!.usage).toEqual({ input: 500, output: 25, cacheRead: 0, cache5m: 0, cache1h: 0 });
    expect(ctx.unconfirmed).toBe(1);
    expect(ctx.decisions).toEqual([{ kind: "billed", model: "gpt-5.5", input: 500, output: 25, ts: MS, responseId: "resp_gl_9" }]);
    // With the gateway source off there is no ledger to ask: an ordinary call, unlabelled.
    expect(apis(collect([meta("subscription_gateway"), marked]))[0]!.model).toBe("gpt-5.5");
  });

  test("the gateway index skips matching usage and keeps differing usage", () => {
    const claims: Array<[string, number, number, number]> = [];
    const gateway: GatewayIndex = {
      claim: (model, input, output, tsMs) => {
        claims.push([model, input, output, tsMs]);
        return input === 1000 && output === 50;
      },
    };
    const events = collect([
      meta("subscription_gateway"),
      count({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }),
      count({ input_tokens: 700, cached_input_tokens: 100, output_tokens: 20 }),
    ], newCodexCtx(gateway));
    expect(claims).toEqual([["gpt-5.5", 1000, 50, MS], ["gpt-5.5", 700, 20, MS]]);
    expect(apis(events)).toHaveLength(1);
    expect(observed(events)).toHaveLength(2);
  });

  test("without a gateway index, claims cannot skip anything", () => {
    const events = collect([meta("subscription_gateway"), count({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 })]);
    expect(apis(events)).toHaveLength(1);
  });
});

describe("codex session_meta", () => {
  test("a forked rollout keeps its own meta: the parent's, copied in after it, does not decide the provider", () => {
    const own = { type: "session_meta", payload: { id: "fork-1", cwd: "/Users/dev/Projects/sample-app", model: "claude-opus-5-5", model_provider: "subscription_gateway" } };
    const parent = { type: "session_meta", payload: { id: "parent-1", cwd: "/Users/dev/Projects/other", model: "gpt-5.5", model_provider: "openai" } };
    const ctx = newCodexCtx(ledgerHolding("resp_gl_f1"));
    const events = collect([own, parent, record("resp_gl_f1", { input_tokens: 300, cached_input_tokens: 0, output_tokens: 9 })], ctx);
    // The ledger bills the fork's routed call, so the rollout drops it.
    expect(apis(events)).toEqual([]);
    expect([ctx.modelProvider, ctx.model, ctx.sid]).toEqual(["subscription_gateway", "claude-opus-5-5", "fork-1"]);
    expect(events.filter((e) => e.t === "meta")).toHaveLength(1);
    // The reverse: a native fork of a routed parent never asks the ledger about its own calls.
    const native = newCodexCtx(ledgerHolding("resp_gl_n1"));
    const kept = collect([{ ...parent, payload: { ...parent.payload, id: "fork-2" } }, { ...own, payload: { ...own.payload, id: "parent-2" } },
      record("resp_gl_n1", { input_tokens: 300, cached_input_tokens: 0, output_tokens: 9 })], native);
    expect(apis(kept).map((e) => e.model)).toEqual(["gpt-5.5"]);
  });

  test("a meta line without a model keeps the model already known", () => {
    const ctx = newCodexCtx();
    const events = collect([
      meta("openai", "gpt-5.5"),
      { type: "session_meta", payload: { id: "cx1", model_provider: "subscription_gateway" } },
      count({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }),
    ], ctx);
    expect(ctx.model).toBe("gpt-5.5");
    expect(ctx.modelProvider).toBe("subscription_gateway");
    expect(apis(events)[0]!.model).toBe("gpt-5.5");
  });
});

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
    const ctx = newCodexCtx();
    ctx.skipMarked = true;
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
    const ctx = newCodexCtx();
    ctx.skipMarked = true;
    expect(apis(collect([meta("subscription_gateway"), marked], ctx))).toEqual([]);
    // The same marked id is an ordinary API call when nothing routed it.
    const other = newCodexCtx();
    other.skipMarked = true;
    expect(apis(collect([meta("openai"), marked], other))).toHaveLength(1);
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

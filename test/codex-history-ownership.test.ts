import { describe, expect, test } from "bun:test";
import type { Event } from "../src/parse";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { parseFreeCodexLocalQwen, settleFreeCodexLocalQwen } from "../src/local-qwen-sources";
import type { GatewayIndex } from "../src/gateway";

const TS = "2026-10-21T10:00:00.000Z";

type Row = Record<string, unknown>;

function explicitMeta(boundary: number, extra: Record<string, unknown> = {}): Row {
  return {
    ordinal: 0,
    type: "session_meta",
    payload: {
      id: "child-thread",
      cwd: "/Users/dev/Projects/child-project",
      model: "gpt-6.1-sol",
      model_provider: "openai",
      history_mode: "paginated",
      subagent_history_start_ordinal: boundary,
      forked_from_id: "parent-thread",
      ...extra,
    },
  };
}

function record(ordinal: number, responseId = `resp_${ordinal}`): Row {
  return {
    ordinal,
    type: "token_usage_record",
    payload: {
      response_id: responseId,
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
    },
  };
}

function count(ordinal: number): Row {
  return {
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
        total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      },
    },
  };
}

function drain(
  rows: Row[],
  ctx = newCodexCtx(),
  parse: (line: string, state: typeof ctx) => Iterable<Event> = parseCodexLine,
): Event[] {
  const events: Event[] = [];
  for (const row of rows) {
    for (const event of parse(JSON.stringify({ ...row, timestamp: TS }), ctx)) events.push(event);
  }
  return events;
}

describe("Codex paginated subagent history ownership", () => {
  test("does not emit or account copied inherited history, but seeds the child identity", () => {
    const claims: string[] = [];
    const gateway: GatewayIndex = {
      claim: () => { claims.push("claim"); return false; },
      vouch: () => { claims.push("vouch"); return false; },
    };
    const ctx = newCodexCtx(gateway);
    const events = drain([
      explicitMeta(3, { model_provider: "subscription_gateway" }),
      record(1, "resp_gl_inherited"),
      count(2),
    ], ctx);

    expect(events).toEqual([]);
    expect([ctx.sid, ctx.model, ctx.modelProvider, ctx.project]).toEqual([
      "child-thread", "gpt-6.1-sol", "subscription_gateway", "child-project",
    ]);
    expect(claims).toEqual([]);
    expect(ctx).not.toMatchObject({
      records: true,
      lastCount: expect.anything(),
      pending: expect.anything(),
      decisions: expect.anything(),
      unconfirmed: expect.anything(),
      routedN: expect.anything(),
    });
  });

  test("uses only child-owned records and does not let inherited metadata replace its model", () => {
    const ctx = newCodexCtx();
    const events = drain([
      explicitMeta(3),
      {
        ordinal: 1,
        type: "turn_context",
        payload: { cwd: "/Users/dev/Projects/parent-project", model: "claude-opus-4-6" },
      },
      record(2, "parent-call"),
      record(3, "child-call"),
    ], ctx);

    const api = events.filter((event) => event.t === "api");
    expect(api).toMatchObject([{ requestId: "child-call", model: "gpt-6.1-sol", sessionId: "child-thread" }]);
    expect([ctx.model, ctx.project]).toEqual(["gpt-6.1-sol", "child-project"]);
  });

  test("does not mark, route, queue, deduplicate, or bill inherited gateway usage", () => {
    const touched: string[] = [];
    const gateway: GatewayIndex = {
      claim: () => { touched.push("claim"); return false; },
      vouch: () => { touched.push("vouch"); return false; },
      adopt: () => { touched.push("adopt"); },
      covers: () => { touched.push("covers"); return false; },
    };
    const ctx = newCodexCtx(gateway);
    const events = drain([
      explicitMeta(3, { model_provider: "subscription_gateway" }),
      record(1, "resp_gl_inherited"),
      count(2),
    ], ctx);

    expect(events).toEqual([]);
    expect(touched).toEqual([]);
    expect(ctx.records).toBeUndefined();
    expect(ctx.lastCount).toBeUndefined();
    expect(ctx.pending).toBeUndefined();
    expect(ctx.decisions).toBeUndefined();
    expect(ctx.unconfirmed).toBeUndefined();
    expect(ctx.routedN).toBeUndefined();
  });

  test("requires every explicit row to have a safe, strictly increasing ordinal", () => {
    const missing = newCodexCtx();
    expect(() => drain([
      explicitMeta(2),
      { type: "event_msg", payload: { type: "user_message", message: "missing ordinal" } },
    ], missing)).toThrow("missing a safe ordinal");

    const unsafe = newCodexCtx();
    expect(() => drain([
      explicitMeta(2),
      { ordinal: Number.MAX_SAFE_INTEGER + 1, type: "event_msg", payload: { type: "user_message", message: "unsafe ordinal" } },
    ], unsafe)).toThrow("missing a safe ordinal");

    const regressed = newCodexCtx();
    expect(() => drain([
      explicitMeta(2),
      { ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "copied" } },
      { ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "duplicate" } },
    ], regressed)).toThrow("not strictly increasing");
  });

  test("rejects ambiguous boundaries and changed child metadata", () => {
    expect(() => drain([
      {
        ordinal: 0,
        type: "session_meta",
        payload: { id: "child-thread", subagent_history_start_ordinal: 2 },
      },
    ])).toThrow("without paginated history mode");

    expect(() => drain([
      explicitMeta(3),
      {
        ordinal: 3,
        type: "session_meta",
        payload: {
          ...explicitMeta(3).payload as Record<string, unknown>,
          model: "gpt-6.2",
        },
      },
    ])).toThrow("changed after its first header");

    expect(() => drain([
      explicitMeta(3),
      {
        ordinal: 3,
        type: "session_meta",
        payload: {
          ...explicitMeta(3).payload as Record<string, unknown>,
          subagent_history_start_ordinal: 4,
        },
      },
    ])).toThrow("changed its history mode or ownership boundary");

    expect(() => drain([
      explicitMeta(3, {
        source: { subagent: { thread_spawn: { parent_thread_id: "another-parent" } } },
      }),
    ])).toThrow("conflicting parent-thread references");
  });

  test("requires an own id and rejects every malformed supplied parent reference", () => {
    for (const id of [undefined, "", "   "]) {
      expect(() => drain([
        explicitMeta(3, { id }),
      ])).toThrow("missing a non-empty child id");
    }

    const malformed: Record<string, unknown>[] = [
      { forked_from_id: 7 },
      { parent_thread_id: "" },
      { source: { subagent: { parent_thread_id: null } } },
      { source: { subagent: { thread_spawn: { parent_thread_id: false } } } },
    ];
    for (const extra of malformed) {
      expect(() => drain([explicitMeta(3, extra)])).toThrow("invalid");
    }
  });

  test("allows absent parent provenance but requires all supplied references to agree", () => {
    const noParent = explicitMeta(2);
    delete (noParent.payload as Record<string, unknown>).forked_from_id;
    expect(drain([noParent, record(2, "owned-without-parent")])
      .filter((event) => event.t === "api")).toMatchObject([{ requestId: "owned-without-parent" }]);

    const agreed = drain([
      explicitMeta(2, {
        parent_thread_id: "parent-thread",
        source: { subagent: { parent_thread_id: "parent-thread", thread_spawn: { parent_thread_id: "parent-thread" } } },
      }),
      record(2, "owned-with-agreed-parent"),
    ]);
    expect(agreed.filter((event) => event.t === "api")).toMatchObject([{ requestId: "owned-with-agreed-parent" }]);
  });

  test("leaves legacy and root paginated records unchanged", () => {
    const legacy = drain([
      {
        type: "session_meta",
        payload: { id: "legacy", model: "gpt-6.1-sol", model_provider: "openai" },
      },
      {
        type: "token_usage_record",
        payload: { response_id: "legacy-call", usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]);
    expect(legacy.filter((event) => event.t === "api")).toHaveLength(1);

    const root = drain([
      {
        type: "session_meta",
        payload: { id: "root", model: "gpt-6.1-sol", history_mode: "paginated" },
      },
      {
        type: "token_usage_record",
        payload: { response_id: "root-call", usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]);
    expect(root.filter((event) => event.t === "api")).toHaveLength(1);
  });

  test("does not adopt a copied paginated parent header after a legacy header", () => {
    const events = drain([
      {
        type: "session_meta",
        payload: { id: "legacy-child", model: "gpt-6.1-sol", model_provider: "openai" },
      },
      {
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: "copied-parent",
          history_mode: "paginated",
          subagent_history_start_ordinal: 2,
          model: "claude-opus-4-6",
        },
      },
      {
        type: "token_usage_record",
        payload: { response_id: "legacy-call", usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]);
    expect(events.filter((event) => event.t === "api")).toMatchObject([
      { requestId: "legacy-call", model: "gpt-6.1-sol", sessionId: "legacy-child" },
    ]);
  });

  test("does not let an inherited count suppress the first matching child call", () => {
    const events = drain([
      explicitMeta(2),
      count(1),
      count(2),
    ]);
    expect(events.filter((event) => event.t === "observed")).toHaveLength(1);
    expect(events.filter((event) => event.t === "api")).toHaveLength(1);
  });

  test("checks an explicit child's ownership boundary when the read completes", () => {
    const incomplete = newCodexCtx();
    drain([explicitMeta(100), { ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "inherited" } }], incomplete);
    expect(() => [...settleRouted(incomplete, true)]).toThrow("ended before its child-owned ownership boundary");

    const exactPrefix = newCodexCtx();
    drain([explicitMeta(100), { ordinal: 99, type: "event_msg", payload: { type: "user_message", message: "last inherited" } }], exactPrefix);
    expect([...settleRouted(exactPrefix, true)]).toEqual([]);

    const owned = newCodexCtx();
    const events = drain([explicitMeta(100), record(100, "owned-at-boundary")], owned);
    expect(events.filter((event) => event.t === "api")).toMatchObject([{ requestId: "owned-at-boundary" }]);
    expect([...settleRouted(owned, true)]).toEqual([]);
  });
});

describe("free local-Qwen ownership filtering", () => {
  test("seeds a model-less child header, ignores inherited context, and validates all skipped rows", () => {
    const ctx = newCodexCtx();
    const qwenMeta = explicitMeta(3, { model: undefined });
    const events = drain([
      qwenMeta,
      {
        ordinal: 1,
        type: "turn_context",
        payload: { cwd: "/Users/dev/Projects/parent-project", model: "gpt-6.1-sol" },
      },
      record(2, "parent-cloud-call"),
      {
        ordinal: 3,
        type: "turn_context",
        payload: { cwd: "/Users/dev/Projects/child-project", model: "qwen/qwen3.8-flash-next" },
      },
      record(4, "child-qwen-call"),
    ], ctx, parseFreeCodexLocalQwen);

    expect(events.filter((event) => event.t === "api")).toMatchObject([
      { requestId: "child-qwen-call", model: "qwen/qwen3.8-flash-next", sessionId: "child-thread" },
    ]);
    expect([ctx.project, ctx.model, ctx.modelProvider]).toEqual([
      "child-project", "qwen/qwen3.8-flash-next", "openai",
    ]);

    const skippedCloud = newCodexCtx();
    expect(() => drain([
      explicitMeta(2, { model: undefined }),
      { ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "inherited" } },
      { ordinal: 2, type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      { ordinal: 2, type: "event_msg", payload: { type: "user_message", message: "duplicate cloud ordinal" } },
    ], skippedCloud, parseFreeCodexLocalQwen)).toThrow("not strictly increasing");
  });

  test("checks completion even when no Qwen call is waiting", () => {
    const ctx = newCodexCtx();
    drain([
      explicitMeta(100, { model: undefined }),
      { ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "inherited" } },
    ], ctx, parseFreeCodexLocalQwen);
    expect(() => settleFreeCodexLocalQwen(ctx, true)).toThrow("ended before its child-owned ownership boundary");
  });
});

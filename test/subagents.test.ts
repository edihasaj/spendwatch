import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import type { Event } from "../src/parse";
import { parseLine as parseClaudeLine } from "../src/parse";
import {
  agentTag, localShare, mergeSubagentUsage, SubagentAccumulator, validateSubagentUsage, withoutSubagentCalls,
} from "../src/subagents";

const J = (value: unknown) => JSON.stringify(value);
const meta = (extra: Record<string, unknown>) => J({ timestamp: "2026-11-10T10:00:00.000Z", type: "session_meta", payload: { id: "child", model: "gpt-5", model_provider: "openai", ...extra } });
const record = J({ timestamp: "2026-11-10T10:00:05.000Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 } } });

function apiEvents(lines: string[]): Event[] {
  const ctx = newCodexCtx();
  return lines.flatMap((line) => [...parseCodexLine(line, ctx)]).filter((e) => e.t === "api");
}

describe("subagent tags", () => {
  test("a Codex subagent rollout tags every call with its role, name and path", () => {
    const [call] = apiEvents([meta({ thread_source: "subagent", agent_role: "implementer", agent_nickname: "Mencius", agent_path: "/root/task" }), record]);
    expect(call).toMatchObject({ t: "api", agent: { role: "implementer", name: "Mencius", path: "/root/task" } });
  });

  test("a subagent without a role is still a subagent, and the main thread has no tag", () => {
    expect(apiEvents([meta({ source: { subagent: { thread_spawn: {} } } }), record])[0]).toMatchObject({ agent: { role: "subagent" } });
    expect((apiEvents([meta({}), record])[0] as { agent?: unknown }).agent).toBeUndefined();
  });

  test("a Claude sidechain line is a subagent named by its agent id", () => {
    const line = J({ type: "assistant", isSidechain: true, agentId: "abc123", sessionId: "s", requestId: "q", timestamp: "2026-11-10T10:00:00.000Z", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 2 } } });
    const events = [...parseClaudeLine(line)].filter((e) => e.t === "api");
    expect(events[0]).toMatchObject({ agent: { role: "subagent", name: "abc123" } });
  });
});

describe("subagent usage", () => {
  const usage = (): ReturnType<SubagentAccumulator["snapshot"]> => {
    const acc = new SubagentAccumulator();
    acc.add(undefined, "main", "gpt-5", 1000, 10);
    acc.add(agentTag("implementer", "A", "/root/a"), "s1", "qwen/qwen3.8-flash-next", 600, 0);
    acc.add(agentTag("implementer", "A", "/root/a"), "s1", "qwen/qwen3.8-flash-next", 200, 0);
    acc.add(agentTag("worker", "B"), "s2", "gpt-5", 200, 4);
    return acc.snapshot();
  };

  test("splits main from subagents by role and by agent without touching the totals", () => {
    const s = usage()!;
    expect(s.main).toEqual({ tokens: 1000, cost: 10, calls: 1 });
    expect(s.subagent).toEqual({ tokens: 1000, cost: 4, calls: 3, sessions: 2 });
    expect(s.roles.map((r) => [r.role, r.tokens, r.sessions])).toEqual([["implementer", 800, 1], ["worker", 200, 1]]);
    expect(s.agents[0]).toMatchObject({ name: "A", path: "/root/a", tokens: 800, calls: 2 });
    expect(localShare(s)).toBeCloseTo(0.8);
  });

  test("reports nothing when no call ran in a subagent", () => {
    const acc = new SubagentAccumulator();
    acc.add(undefined, "m", "gpt-5", 5, 1);
    expect(acc.snapshot()).toBeUndefined();
  });

  test("rejects malformed archived input and merges machines", () => {
    const s = usage()!;
    expect(validateSubagentUsage(s)).toEqual(s);
    expect(validateSubagentUsage({ ...s, roles: [{ role: "x", tokens: -1 }] })).toBeUndefined();
    expect(validateSubagentUsage("nope")).toBeUndefined();
    const merged = mergeSubagentUsage([s, s, undefined])!;
    expect(merged.subagent.tokens).toBe(2000);
    expect(merged.roles.find((r) => r.role === "implementer")).toMatchObject({ tokens: 1600, sessions: 2 });
  });

  test("a settled call leaves the projection with its report", () => {
    const s = usage()!;
    const left = withoutSubagentCalls(s, [{ agent: agentTag("worker", "B"), model: "gpt-5", tokens: 200, cost: 4 }])!;
    expect(left.subagent.calls).toBe(2);
    expect(left.roles.map((r) => r.role)).toEqual(["implementer"]);
    expect(withoutSubagentCalls(left, [
      { agent: agentTag("implementer"), model: "qwen/qwen3.8-flash-next", tokens: 600, cost: 0 },
      { agent: agentTag("implementer"), model: "qwen/qwen3.8-flash-next", tokens: 200, cost: 0 },
    ])).toBeUndefined();
  });

  test("the aggregate carries the tag from the event to the report", () => {
    const agg = new Aggregator();
    const fold = agg.stream("f", "p", "codex");
    const tag = agentTag("tester", "T");
    fold({ t: "api", sessionId: "s", requestId: "r1", model: "qwen/qwen3.8-flash-next", usage: { input: 10, output: 5, cacheRead: 0, cache5m: 0, cache1h: 0 }, sidechain: false, ts: Date.now(), agent: tag });
    fold({ t: "api", sessionId: "s", requestId: "r2", model: "gpt-5", usage: { input: 20, output: 5, cacheRead: 0, cache5m: 0, cache1h: 0 }, sidechain: false, ts: Date.now() });
    const out = agg.report();
    expect(out.subagents?.subagent.tokens).toBe(15);
    expect(out.subagents?.main.tokens).toBe(25);
    expect(out.totalTokens).toBe(40);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader, humanProject, humanCodexProject } from "../src/scan";
import { parseLine, commandPath } from "../src/parse";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import type { SourceFile } from "../src/sources";

const SESS = "11111111-1111-1111-1111-111111111111";
const TS = "2026-06-10T10:00:00.000Z";

function claudeFile(path: string): SourceFile {
  return { path, project: "demo", source: "claude", parse: (l) => parseLine(l), ctx: null };
}

function entries(): string[] {
  const toolId = "toolu_test1";
  return [
    JSON.stringify({ type: "user", promptId: "p1", promptSource: "typed", sessionId: SESS, timestamp: TS, message: { role: "user", content: "fix the build" } }),
    JSON.stringify({
      type: "assistant", requestId: "req1", sessionId: SESS, timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 } },
        content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "make" } }],
      },
    }),
    JSON.stringify({ type: "user", sessionId: SESS, timestamp: TS, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "x".repeat(4000) }] } }),
    JSON.stringify({
      type: "assistant", requestId: "req2", sessionId: SESS, timestamp: TS,
      message: { model: "claude-opus-4-8", usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "done" }] },
    }),
  ];
}

function makeFixture(): { file: string } {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-"));
  const file = join(root, `${SESS}.jsonl`);
  writeFileSync(file, entries().join("\n") + "\n");
  return { file };
}

describe("claude aggregate from fixture", () => {
  test("exact costs, tool ctx cost, prompt attribution", () => {
    const { file } = makeFixture();
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    reader.poll(claudeFile(file));
    const r = agg.report();

    // req1 (opus): 1000*5 + 500*25 + 10000*0.5 + 2000*6.25 = 35000 µ$
    // req2: 500*5 + 200*25 + 12000*0.5 = 13500 µ$  → total $0.0485
    expect(r.totalCost).toBeCloseTo(0.0485, 6);
    expect(r.apiCalls).toBe(2);
    expect(r.source).toBe("claude");

    const bash = r.tools.find((t) => t.name === "Bash")!;
    expect(bash.calls).toBe(1);
    expect(bash.resultTok).toBe(1000);
    expect(bash.ctxCost).toBeCloseTo(0.00675, 6); // 1000 tok * $5/M * (1.25 + 0.1*1)

    expect(r.bash[0].name).toBe("make");
    const p = r.prompts[0];
    expect(p.text).toBe("fix the build");
    expect(p.cost).toBeCloseTo(0.0485, 6);
    expect(p.toolCalls).toBe(1);
  });

  test("incremental poll picks up appended bytes (watch path)", () => {
    const { file } = makeFixture();
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const f = claudeFile(file);
    reader.poll(f);
    expect(agg.report().apiCalls).toBe(2);
    appendFileSync(
      file,
      JSON.stringify({ type: "assistant", requestId: "req3", sessionId: SESS, timestamp: TS, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }) + "\n",
    );
    expect(reader.poll(f)).toBeGreaterThan(0);
    const r = agg.report();
    expect(r.apiCalls).toBe(3);
    expect(r.totalCost).toBeCloseTo(0.0485 + 0.0018, 6); // + sonnet 100*3+100*15
  });
});

describe("codex aggregate from fixture", () => {
  function codexEntries(): string[] {
    return [
      JSON.stringify({ type: "session_meta", timestamp: TS, payload: { id: "cx1", cwd: "/Users/edihasaj/Projects/klyp", model: "gpt-5.5", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", timestamp: TS, payload: { model: "gpt-5.5", cwd: "/Users/edihasaj/Projects/klyp" } }),
      JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "user_message", message: "deploy the worker" } }),
      JSON.stringify({ type: "response_item", timestamp: TS, payload: { type: "function_call", name: "exec_command", call_id: "call_a", arguments: JSON.stringify({ cmd: "git push origin main" }) } }),
      JSON.stringify({ type: "response_item", timestamp: TS, payload: { type: "function_call_output", call_id: "call_a", output: "y".repeat(2000) } }),
      JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 800, reasoning_output_tokens: 200, total_tokens: 10800 } } } }),
      JSON.stringify({ type: "response_item", timestamp: TS, payload: { type: "function_call", name: "exec_command", call_id: "call_b", arguments: JSON.stringify({ cmd: "ssh studio tailscale status" }) } }),
      JSON.stringify({ type: "response_item", timestamp: TS, payload: { type: "function_call_output", call_id: "call_b", output: "z".repeat(1000) } }),
      JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 300, total_tokens: 5300 } } } }),
    ];
  }

  test("token usage, deep command, project from cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "spendwatch-cx-"));
    const file = join(root, "rollout-x.jsonl");
    writeFileSync(file, codexEntries().join("\n") + "\n");
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    reader.poll({ path: file, project: "?", source: "codex", parse: parseCodexLine, ctx: newCodexCtx() });
    const r = agg.report();

    expect(r.source).toBe("codex");
    expect(r.apiCalls).toBe(2);
    // gpt-5 tier $1.25/$10, cached read 0.1x:
    // call1: (10000-4000)*1.25 + 800*10 + 4000*0.125 = 7500+8000+500 = 16000 µ$
    // call2: (5000-1000)*1.25 + 300*10 + 1000*0.125 = 5000+3000+125 = 8125 µ$
    expect(r.totalCost).toBeCloseTo((16000 + 8125) / 1e6, 6);
    expect(r.projects[0].project).toBe("klyp");
    expect(r.models[0].model).toBe("gpt-5.5");

    const deepNames = r.deep.map((d) => d.name);
    expect(deepNames).toContain("git push");
    expect(deepNames).toContain("ssh tailscale"); // ssh remote command surfaced
    expect(r.tools.find((t) => t.name === "exec_command")!.calls).toBe(2);
  });
});

describe("command path", () => {
  test("deep breakdown for common shells", () => {
    expect(commandPath("git push origin main")).toEqual({ head: "git", deep: "git push" });
    expect(commandPath("cd /x && az vm create -n foo")).toEqual({ head: "az", deep: "az vm" });
    expect(commandPath("docker compose up -d")).toEqual({ head: "docker", deep: "docker compose" });
    expect(commandPath("ssh -o RequestTTY=no studio tailscale status")).toEqual({ head: "ssh", deep: "ssh tailscale" });
    expect(commandPath("node build.js")).toEqual({ head: "node", deep: "node" }); // file arg → no sub
    expect(commandPath("ENV=1 sudo systemctl restart x")).toEqual({ head: "systemctl", deep: "systemctl restart" });
  });
});

describe("project naming", () => {
  test("claude + codex", () => {
    expect(humanProject("-Users-edihasaj-Projects-paper-deck")).toBe("paper-deck");
    expect(humanProject("-Users-edihasaj-Projects")).toBe("~/Projects");
    expect(humanCodexProject("/Users/edihasaj/Projects/foretype")).toBe("foretype");
  });
});

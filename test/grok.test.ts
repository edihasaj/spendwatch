import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { grokProjectFromDir, newGrokCtx, parseGrokLine } from "../src/grok";
import { defaultGrokRoots, discover, type SourceFile } from "../src/sources";
import { grokAccountEmail } from "../src/accounts";
import { priceFor, usageCost } from "../src/pricing";

const SESS = "01a0167e-fd7f-7f92-89c5-39b750310e86";
const CALL = "call-0ea107ae-0";

function grokFile(path: string, project = "demo", account = "default"): SourceFile {
  return { path, project, source: "grok", account, parse: parseGrokLine, ctx: newGrokCtx() };
}

function update(update: unknown, agentTimestampMs = 1787083827186, method = "session/update") {
  return JSON.stringify({ timestamp: Math.floor(agentTimestampMs / 1000), method, params: { sessionId: SESS, update }, _meta: { agentTimestampMs } });
}

// One prompt-turn: a shell tool call and its result, then the turn's usage.
// Token counts are a real grok-4.6 turn captured from the CLI.
function entries(): string[] {
  return [
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "list the files" }, _meta: { modelId: "grok-4.6" } }),
    update({
      sessionUpdate: "tool_call",
      toolCallId: CALL,
      title: "run_terminal_command",
      rawInput: { command: "git status --short", description: "check the tree" },
      _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
    }),
    // Enrichment update: no status, so it must not be counted as a result.
    update({ sessionUpdate: "tool_call_update", toolCallId: CALL, kind: "execute", title: "Execute `git status --short`", rawInput: { variant: "Bash", command: "git status --short" } }),
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: CALL,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "x".repeat(4000) } }],
      rawOutput: { type: "Bash", exit_code: 0, command: "git status --short" },
    }),
    update({
      sessionUpdate: "turn_completed",
      prompt_id: "a90fe841",
      stop_reason: "end_turn",
      usage: {
        inputTokens: 51232,
        outputTokens: 454,
        totalTokens: 51686,
        cachedReadTokens: 31104,
        cacheCreationTokens: 0,
        reasoningTokens: 366,
        modelCalls: 2,
        costUsdTicks: 99504400,
        modelUsage: {
          "grok-4.6": {
            inputTokens: 51232,
            outputTokens: 454,
            cachedReadTokens: 31104,
            cacheCreationTokens: 0,
            modelCalls: 2,
            costUsdTicks: 99504400,
          },
        },
        numTurns: 2,
      },
    }, 1787083830000, "_x.ai/session/update"),
  ];
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-grok-"));
  const file = join(root, "updates.jsonl");
  writeFileSync(file, entries().join("\n") + "\n");
  return file;
}

describe("grok parser", () => {
  test("turn usage, tool drill-down, and prompt attribution", () => {
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    reader.poll(grokFile(fixture()));
    const r = agg.report();

    // grok-4.6 under 200k: 20128 uncached * $2 + 31104 cached * $0.50 + 454 out * $6
    expect(r.totalCost).toBeCloseTo(0.058532, 6);
    expect(r.totalTokens).toBe(51_686);
    expect(r.apiCalls).toBe(1); // grok reports usage once per prompt-turn
    expect(r.source).toBe("grok");
    expect(r.sessions).toBe(1);
    expect(r.models[0].model).toBe("grok-4.6");

    const tool = r.tools.find((t) => t.name === "run_terminal_command")!;
    expect(tool.calls).toBe(1);
    expect(tool.resultCalls).toBe(1); // the status-less enrichment update is not a result
    expect(tool.resultTok).toBe(1000);
    expect(tool.errCalls).toBe(0);

    expect(r.bash[0].name).toBe("git");
    expect(r.deep[0].name).toBe("git status");
    expect(tool.samples?.some((s) => s.detail === "git status --short")).toBe(true);

    const prompt = r.prompts[0];
    expect(prompt.text).toBe("list the files");
    expect(prompt.toolCalls).toBe(1);
    expect(prompt.cost).toBeCloseTo(r.totalCost, 6);
  });

  test("a failed tool call and a nonzero exit both count as errors", () => {
    const root = mkdtempSync(join(tmpdir(), "spendwatch-grok-err-"));
    const file = join(root, "updates.jsonl");
    writeFileSync(
      file,
      [
        update({ sessionUpdate: "tool_call", toolCallId: "a", title: "run_terminal_command", rawInput: { command: "npm ci" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", content: [], rawOutput: { exit_code: 127 } }),
        update({ sessionUpdate: "tool_call", toolCallId: "b", title: "read_file", rawInput: { target_file: "missing.ts" }, _meta: { "x.ai/tool": { name: "read_file" } } }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", content: [] }),
      ].join("\n") + "\n",
    );

    const agg = new Aggregator();
    new IncrementalReader(agg).poll(grokFile(file));
    const r = agg.report();

    const shell = r.tools.find((t) => t.name === "run_terminal_command")!;
    expect(shell.errCalls).toBe(1);
    expect(shell.exit127).toBe(1);
    const read = r.tools.find((t) => t.name === "read_file")!;
    expect(read.errCalls).toBe(1);
    expect(read.samples?.some((s) => s.detail === "missing.ts")).toBe(true);
  });

  test("later turns are billed on their own, not as a running total", () => {
    const root = mkdtempSync(join(tmpdir(), "spendwatch-grok-turns-"));
    const file = join(root, "updates.jsonl");
    const turn = (input: number, output: number, cached: number) =>
      update({ sessionUpdate: "turn_completed", usage: { inputTokens: input, outputTokens: output, cachedReadTokens: cached, cacheCreationTokens: 0, modelUsage: { "grok-4.6": { inputTokens: input, outputTokens: output, cachedReadTokens: cached, cacheCreationTokens: 0 } } } });
    writeFileSync(file, [turn(1000, 100, 0), turn(2000, 200, 500)].join("\n") + "\n");

    const agg = new Aggregator();
    new IncrementalReader(agg).poll(grokFile(file));
    const r = agg.report();

    expect(r.apiCalls).toBe(2);
    expect(r.totalTokens).toBe(1100 + 2200);
    // (1000*2 + 100*6) + (1500*2 + 500*0.5 + 200*6) µ$
    expect(r.totalCost).toBeCloseTo((2600 + 4450) / 1e6, 9);
  });
});

describe("grok pricing", () => {
  test("a request past 200k input tokens is billed at the higher rate", () => {
    const under = usageCost("grok-4.6", { input: 100_000, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 });
    const over = usageCost("grok-4.6", { input: 100_000, output: 0, cacheRead: 150_000, cache5m: 0, cache1h: 0 });
    expect(under).toBeCloseTo(0.2, 9);
    expect(over).toBeCloseTo((100_000 * 4 + 150_000 * 1) / 1e6, 9);
  });

  test("the agentic build variant keeps grok-4.6 pricing, not grok-build pricing", () => {
    expect(priceFor("grok-4.6-build").input).toBe(2);
    expect(priceFor("grok-build-0.1").input).toBe(1);
  });
});

describe("grok discovery", () => {
  test("finds updates.jsonl per session and reads the project from the encoded cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-grok-home-"));
    const encoded = encodeURIComponent("/Users/edi/Projects/spendwatch").replace(/%2F/g, "%2F");
    const session = join(home, ".grok", "sessions", encoded, SESS);
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "updates.jsonl"), entries().join("\n") + "\n");
    // Sibling files in the same session directory must not be picked up.
    writeFileSync(join(session, "chat_history.jsonl"), "{}\n");
    writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ "https://auth.x.ai::abc": { email: "me@example.com" } }));

    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(defaultGrokRoots(home)));
    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const grok = discover({ sinceMs: 0, agents: new Set(["grok"]) }).find((s) => s.id === "grok");
      expect(grok?.present).toBe(true);
      expect(grok?.parseable).toBe(true);
      expect(grok?.files).toHaveLength(1);
      expect(grok?.files[0].project).toBe("spendwatch");
      expect(grok?.files[0].account).toBe("me@example.com (main)");
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("labels each grok home so duplicate accounts stay distinguishable", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-grok-homes-"));
    for (const name of [".grok", ".grok-work"]) mkdirSync(join(home, name, "sessions"), { recursive: true });
    expect(defaultGrokRoots(home).map((r) => r.path)).toEqual([
      join(home, ".grok", "sessions"),
      join(home, ".grok-work", "sessions"),
    ]);
  });

  test("reads the account email out of a scope-keyed auth.json", () => {
    expect(grokAccountEmail({ "https://auth.x.ai::abc": { email: "me@example.com", refresh_token: "x" } })).toBe("me@example.com");
    expect(grokAccountEmail({ "https://auth.x.ai::abc": { user_id: "no-email" } })).toBeUndefined();
  });

  test("decodes the session directory name into a project", () => {
    expect(grokProjectFromDir("%2FUsers%2Fedi%2FProjects%2Fspendwatch")).toBe("spendwatch");
    expect(grokProjectFromDir("%2FUsers%2Fedi")).toBe("edi");
  });
});

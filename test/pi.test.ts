import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { newPiCtx, parsePiLine } from "../src/pi";
import { defaultOmpRoots, defaultPiRoots, discover, type SourceFile } from "../src/sources";
import { priceFor, usageCost } from "../src/pricing";
import { tempDir } from "./tmp";

const CWD = "/Users/edi/Projects/spendwatch";

function piFile(path: string, source: "pi" | "omp" = "pi"): SourceFile {
  return { path, project: "?", source, account: "default", parse: parsePiLine, ctx: newPiCtx() };
}

function write(lines: unknown[]): string {
  const root = tempDir("spendwatch-pi-");
  const file = join(root, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// pi: tool call arguments are a JSON string.
function piSession(): unknown[] {
  return [
    { type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", timestamp: "2026-10-06T10:00:00.000Z", cwd: CWD },
    { type: "model_change", id: "m0", parentId: null, timestamp: "2026-10-06T10:00:00.100Z", provider: "anthropic", modelId: "claude-sonnet-4-5" },
    { type: "message", id: "u1", parentId: "m0", timestamp: "2026-10-06T10:00:01.000Z", message: { role: "user", content: "list the files", timestamp: 1791280801000 } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-06T10:00:03.000Z",
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: JSON.stringify({ command: "git status --short" }) },
        ],
        usage: usage(1000, 200, 5000, 100),
        stopReason: "toolUse",
        timestamp: 1791280803000,
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-10-06T10:00:04.000Z",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) }], isError: false, timestamp: 1791280804000 },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      timestamp: "2026-10-06T10:00:06.000Z",
      message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Clean." }], usage: usage(300, 50, 6000, 0), stopReason: "stop", timestamp: 1791280806000 },
    },
    // A cache-warming call outside the conversation is still paid for.
    { type: "usage", id: "w1", parentId: "a2", timestamp: "2026-10-06T10:05:00.000Z", kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-4-5", usage: usage(0, 0, 50000, 0) },
  ];
}

// oh-my-pi: a title line before the header, "provider/model" model changes,
// object tool arguments, and model_usage for side calls.
function ompSession(): unknown[] {
  return [
    { type: "title", v: 1, title: "fix", updatedAt: "2026-10-06T10:00:00.000Z", pad: "" },
    { type: "session", version: 3, id: "019c625b-b900-7000-8000-000000000001", timestamp: "2026-10-06T10:00:00.000Z", cwd: CWD },
    { type: "model_change", id: "m0", parentId: null, timestamp: "2026-10-06T10:00:00.100Z", model: "spark/qwen3.8-flash-next" },
    { type: "message", id: "u1", parentId: "m0", timestamp: "2026-10-06T10:00:01.000Z", message: { role: "user", attribution: "user", content: [{ type: "text", text: "read the config" }], timestamp: 1791280801000 } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-06T10:00:03.000Z",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "spark",
        model: "qwen3.8-flash-next",
        content: [{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "missing.json" } }],
        usage: usage(8000, 120),
        stopReason: "toolUse",
        timestamp: 1791280803000,
      },
    },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-10-06T10:00:04.000Z", message: { role: "toolResult", toolCallId: "call_9", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] } },
    { type: "model_usage", id: "t1", parentId: "r1", timestamp: "2026-10-06T10:00:05.000Z", purpose: "title", provider: "spark", model: "qwen3.8-flash-next", usage: usage(400, 10) },
  ];
}

describe("pi parser", () => {
  test("per-call usage, shell drill-down, prompt attribution, and side calls", () => {
    const agg = new Aggregator();
    new IncrementalReader(agg).poll(piFile(write(piSession())));
    const r = agg.report();

    expect(r.source).toBe("pi");
    expect(r.sessions).toBe(1);
    expect(r.apiCalls).toBe(3); // two assistant turns + the cache-warming call
    expect(r.totalTokens).toBe(1000 + 200 + 5000 + 100 + 300 + 50 + 6000 + 50000);
    const expected =
      usageCost("claude-sonnet-4-5", { input: 1000, output: 200, cacheRead: 5000, cache5m: 100, cache1h: 0 }) +
      usageCost("claude-sonnet-4-5", { input: 300, output: 50, cacheRead: 6000, cache5m: 0, cache1h: 0 }) +
      usageCost("claude-sonnet-4-5", { input: 0, output: 0, cacheRead: 50000, cache5m: 0, cache1h: 0 });
    expect(r.totalCost).toBeCloseTo(expected, 9);
    expect(r.models[0].model).toBe("claude-sonnet-4-5");

    const bash = r.tools.find((t) => t.name === "bash")!;
    expect(bash.calls).toBe(1);
    expect(bash.resultCalls).toBe(1);
    expect(bash.resultTok).toBe(1000);
    expect(r.bash[0].name).toBe("git");
    expect(r.deep[0].name).toBe("git status");

    const prompt = r.prompts[0];
    expect(prompt.text).toBe("list the files");
    expect(prompt.project).toBe("spendwatch");
    expect(prompt.toolCalls).toBe(1);
  });

  test("oh-my-pi: provider-prefixed models, object arguments, errors, and model_usage", () => {
    const agg = new Aggregator();
    new IncrementalReader(agg).poll(piFile(write(ompSession()), "omp"));
    const r = agg.report();

    expect(r.source).toBe("omp");
    expect(r.apiCalls).toBe(2); // the assistant turn + the title side call
    expect(r.totalTokens).toBe(8000 + 120 + 400 + 10);
    expect(r.totalCost).toBe(0); // self-hosted model
    expect(r.models[0].model).toBe("qwen3.8-flash-next");

    const read = r.tools.find((t) => t.name === "read")!;
    expect(read.errCalls).toBe(1);
    expect(read.samples?.some((s) => s.detail === "missing.json")).toBe(true);
    expect(r.prompts[0].text).toBe("read the config");
  });

  test("malformed and unrelated lines are ignored", () => {
    const ctx = newPiCtx();
    expect([...parsePiLine("not json", ctx)]).toHaveLength(0);
    expect([...parsePiLine(JSON.stringify({ type: "label", id: "x", targetId: "y", label: "z" }), ctx)]).toHaveLength(0);
    expect([...parsePiLine(JSON.stringify({ type: "message", id: "a", message: { role: "assistant", usage: usage(0, 0) } }), ctx)]).toHaveLength(0);
  });
});

describe("self-hosted pricing", () => {
  test("the Spark model is free on purpose", () => {
    expect(priceFor("qwen3.8-flash-next")).toEqual({ input: 0, output: 0 });
  });
});

describe("pi discovery", () => {
  test("finds pi and oh-my-pi sessions in their per-cwd folders", () => {
    const home = tempDir("spendwatch-pi-home-");
    const piDir = join(defaultPiRoots(home)[0].path, "--Users-edi-Projects-spendwatch--");
    const ompDir = join(defaultOmpRoots(home)[0].path, "-Projects-spendwatch");
    mkdirSync(piDir, { recursive: true });
    mkdirSync(ompDir, { recursive: true });
    writeFileSync(join(piDir, "2026-10-06T10-00-00-000Z_abc.jsonl"), piSession().map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(ompDir, "2026-10-06T10-00-00-000Z_def.jsonl"), ompSession().map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(ompDir, "notes.txt"), "not a session");

    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([...defaultPiRoots(home), ...defaultOmpRoots(home)]));
    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const found = discover({ sinceMs: 0, agents: new Set(["pi", "omp"]) });
      const pi = found.find((s) => s.id === "pi");
      const omp = found.find((s) => s.id === "omp");
      expect(pi?.present).toBe(true);
      expect(pi?.files).toHaveLength(1);
      expect(omp?.files).toHaveLength(1);
      expect(omp?.files[0].source).toBe("omp");
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });
});

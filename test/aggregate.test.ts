import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader, listTranscripts, humanProject } from "../src/scan";

const SESS = "11111111-1111-1111-1111-111111111111";
const TS = "2026-06-10T10:00:00.000Z";

function entries(): string[] {
  const toolId = "toolu_test1";
  return [
    JSON.stringify({
      type: "user",
      promptId: "p1",
      promptSource: "typed",
      sessionId: SESS,
      timestamp: TS,
      message: { role: "user", content: "fix the build" },
    }),
    JSON.stringify({
      type: "assistant",
      requestId: "req1",
      sessionId: SESS,
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 2000,
          cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
        },
        content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "make" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      sessionId: SESS,
      timestamp: TS,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "x".repeat(4000) }] },
    }),
    JSON.stringify({
      type: "assistant",
      requestId: "req2",
      sessionId: SESS,
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ];
}

function makeFixture(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-"));
  const proj = join(root, "-Users-edihasaj-Projects-demo");
  mkdirSync(proj);
  const file = join(proj, `${SESS}.jsonl`);
  writeFileSync(file, entries().join("\n") + "\n");
  return { root, file };
}

describe("aggregate from fixture", () => {
  test("exact costs, tool ctx cost, prompt attribution", () => {
    const { root } = makeFixture();
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const files = listTranscripts({ dir: root, sinceMs: 0 });
    expect(files.length).toBe(1);
    expect(files[0].project).toBe("demo");
    reader.poll(files[0].path, files[0].project);
    const r = agg.report();

    // req1 (opus $5/$25): 1000*5 + 500*25 + 10000*0.5 + 2000*6.25 = 35000 µ$ = $0.035
    // req2: 500*5 + 200*25 + 12000*0.5 = 13500 µ$ = $0.0135
    expect(r.totalCost).toBeCloseTo(0.0485, 6);
    expect(r.apiCalls).toBe(2);
    expect(r.sessions).toBe(1);

    const bash = r.tools.find((t) => t.name === "Bash")!;
    expect(bash.calls).toBe(1);
    expect(bash.resultTok).toBe(1000); // 4000 chars / 4
    // ctx cost: 1000 tok * $5/M * (1.25 write + 0.1 * 1 subsequent call) = $0.00675
    expect(bash.ctxCost).toBeCloseTo(0.00675, 6);

    const p = r.prompts[0];
    expect(p.text).toBe("fix the build");
    expect(p.cost).toBeCloseTo(0.0485, 6);
    expect(p.toolCalls).toBe(1);
    expect(p.outTok).toBe(700);

    expect(r.models[0].model).toBe("claude-opus-4-8");
    expect(r.projects[0]).toEqual({ project: "demo", cost: expect.closeTo(0.0485, 6) });
  });

  test("streamed duplicate requestId counted once (latest usage wins)", () => {
    const { root, file } = makeFixture();
    // duplicate req2 entry with larger output — simulates stream rewrite
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        requestId: "req2",
        sessionId: SESS,
        timestamp: TS,
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 500, output_tokens: 400, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 },
          content: [{ type: "text", text: "done more" }],
        },
      }) + "\n",
    );
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const f = listTranscripts({ dir: root, sinceMs: 0 })[0];
    reader.poll(f.path, f.project);
    const r = agg.report();
    expect(r.apiCalls).toBe(2); // still 2 unique requests
    // req2 now 500*5 + 400*25 + 12000*0.5 = 18500 µ$; total = 35000+18500
    expect(r.totalCost).toBeCloseTo(0.0535, 6);
  });

  test("incremental poll picks up appended bytes (watch mode path)", () => {
    const { root, file } = makeFixture();
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const f = listTranscripts({ dir: root, sinceMs: 0 })[0];
    reader.poll(f.path, f.project);
    expect(agg.report().apiCalls).toBe(2);

    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        requestId: "req3",
        sessionId: SESS,
        timestamp: TS,
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [],
        },
      }) + "\n",
    );
    expect(reader.poll(file, f.project)).toBeGreaterThan(0);
    const r = agg.report();
    expect(r.apiCalls).toBe(3);
    // + sonnet: 100*3 + 100*15 = 1800 µ$ = $0.0018
    expect(r.totalCost).toBeCloseTo(0.0485 + 0.0018, 6);
    expect(r.models.some((m) => m.model === "claude-sonnet-4-6")).toBe(true);
  });
});

describe("humanProject", () => {
  test("strips machine prefix", () => {
    expect(humanProject("-Users-edihasaj-Projects-paper-deck")).toBe("paper-deck");
    expect(humanProject("-Users-edihasaj-Projects")).toBe("~/Projects");
  });
});

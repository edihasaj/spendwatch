import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { CodexRolloutCopyError, selectCodexRolloutCopies } from "../src/codex-rollout-copies";
import { codexRolloutManifestSummary, createCodexRolloutSemanticDominance } from "../src/codex-rollout-semantics";
import { parseFreeCodexLocalQwen, settleFreeCodexLocalQwen } from "../src/local-qwen-sources";
import { tempDir } from "./tmp";

// Synthetic fixtures only: nothing here copies anything from a real rollout.
const ROLLOUT = "rollout-2026-06-30T11-50-56-019f17f0-5fba-71a0-b3a9-0ee37c4773cb.jsonl";
const iso = (ms: number) => new Date(ms).toISOString();
const J = (o: unknown) => JSON.stringify(o);

const META = J({ timestamp: iso(1000), type: "session_meta", payload: { id: "s1", model: "gpt-5-test", cwd: "/tmp/project" } });
const CONTEXT = J({ timestamp: iso(1050), type: "turn_context", payload: { cwd: "/tmp/project", model: "gpt-5-test" } });
const record = (n: number, input = 100) => J({ timestamp: iso(2000 + n * 10), type: "token_usage_record", payload: { response_id: `resp-${n}`, usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 5 } } });
const prompt = (n: number) => J({ timestamp: iso(1500 + n), type: "event_msg", payload: { type: "user_message", message: `synthetic prompt ${n}` } });
const patch = (n: number) => J({ timestamp: iso(2500 + n), type: "event_msg", payload: { type: "patch_apply_end", stdout: `patched file ${n}` } });
const call = (n: number) => J({ timestamp: iso(2100 + n), type: "response_item", payload: { type: "function_call", call_id: `call-${n}`, name: "shell", arguments: J({ command: `echo step ${n}` }) } });
const result = (n: number) => J({ timestamp: iso(2150 + n), type: "response_item", payload: { type: "function_call_output", call_id: `call-${n}`, output: `ok ${n} exited with code 0` } });
const mcp = (n: number) => J({ timestamp: iso(2600 + n), type: "event_msg", payload: { type: "mcp_tool_call_end", server: "srv", tool: `t${n}`, result: { ok: n } } });
const count = (n: number) => J({ timestamp: iso(2000 + n * 10), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100 + n, cached_input_tokens: 10, output_tokens: 5 }, total_token_usage: { input_tokens: (100 + n) * 2, cached_input_tokens: 20, output_tokens: 10 } } } });

function file(root: string, dir: string, lines: readonly string[]): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, ROLLOUT);
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
  return path;
}

const FACT = "{\"fact\":true}\n";
const EMPTY_FACT = "{\"fact\":false}\n";
const factSource = {
  parse: (line: string) => line === FACT.slice(0, -1)
    ? [{ t: "prompt" as const, sessionId: "facts", promptId: "facts", ts: 1, text: "fact", sidechain: false }]
    : [],
  semanticCtx: () => null,
  semanticKey: "synthetic-facts-v1",
  project: "?",
};

function factFile(root: string, dir: string, count: number): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, ROLLOUT);
  writeFileSync(path, count === 0 ? EMPTY_FACT : FACT.repeat(count));
  return path;
}

describe("Codex semantic duplicate dominance", () => {
  test("keeps the strict default byte-prefix error for divergent complete copies", () => {
    const root = tempDir("spendwatch-sem-default-");
    const a = file(root, ".codex/sessions", [META, prompt(1), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, record(1)]);
    expect(() => selectCodexRolloutCopies([{ path: a, value: a }, { path: b, value: b }]))
      .toThrow(/divergent complete copies/);
  });

  test("selects the one copy whose nonbilling events are a superset, once, over all candidates", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-dominant-");
    const retained = file(root, ".codex/sessions", [META, call(1), result(1), record(1), record(2)]);
    const primary = file(root, ".codex-archive/archived_sessions", [META, prompt(1), call(1), result(1), record(1), patch(1), record(2)]);
    // Dominance must outrank priority: the richer copy wins even as the lower-preferred playground home.
    expect(selectCodexRolloutCopies(
      [{ path: retained, priority: 0, value: "retained" }, { path: primary, priority: 1, value: "primary" }],
      { semanticDominance: dominance },
    )).toEqual(["primary"]);
    // A second pass proves the same pair once: the dominated twin never folds alongside it.
    expect(selectCodexRolloutCopies(
      [{ path: retained, priority: 0, value: "retained" }, { path: primary, priority: 1, value: "primary" }],
      { semanticDominance: dominance },
    )).toEqual(["primary"]);
  });

  test("rejects API sequence order differences even when the API multiset matches", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-order-");
    const a = file(root, ".codex/sessions", [META, record(1), record(2)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, record(2), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects changed token vectors", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-vectors-");
    const a = file(root, ".codex/sessions", [META, record(1), record(2)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, record(1), record(2, 111)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects bilateral nonbilling extras: neither candidate dominates", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-bilateral-");
    const a = file(root, ".codex/sessions", [META, prompt(1), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, record(1), patch(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: dominance },
    )).toThrow(/divergent complete copies/);
  });

  test("rejects response-item mismatches even with matching billing", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-response-");
    const a = file(root, ".codex/sessions", [META, call(1), result(1), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, call(1), result(1), result(2), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects same-length response-item content differences", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-raw-response-");
    const a = file(root, ".codex/sessions", [META, call(1), record(1)]);
    const changedCall = J({ timestamp: iso(2101), type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: J({ command: "echo step x" }) } });
    const b = file(root, ".codex-archive/archived_sessions", [META, changedCall, record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: a }, { path: b, value: b }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("ignores response recorder ordinals and absent versus null optional content", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-response-ordinal-");
    const response = { timestamp: iso(2101), type: "response_item", payload: { type: "reasoning" } };
    const a = file(root, ".codex/sessions", [META, J({ ...response, ordinal: 41 }), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, J({ ...response, ordinal: 97, payload: { ...response.payload, content: null } }), record(1)]);
    expect(selectCodexRolloutCopies(
      [{ path: a, priority: 0, value: a }, { path: b, priority: 1, value: b }],
      { semanticDominance: dominance },
    )).toEqual([a]);
  });

  test("rejects non-null response content differences", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-response-content-");
    const a = file(root, ".codex/sessions", [
      META,
      J({ timestamp: iso(2101), type: "response_item", payload: { type: "message", content: "first" } }),
      record(1),
    ]);
    const b = file(root, ".codex-archive/archived_sessions", [
      META,
      J({ timestamp: iso(2101), type: "response_item", payload: { type: "message", content: "other" } }),
      record(1),
    ]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: a }, { path: b, value: b }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("compares leading-whitespace response items even when the source parser ignores them", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-whitespace-response-");
    const a = file(root, ".codex/sessions", [` ${J({ timestamp: iso(2101), type: "response_item", payload: { type: "message", content: "alpha" } })}`, record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [` ${J({ timestamp: iso(2101), type: "response_item", payload: { type: "message", content: "omega" } })}`, record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: a }, { path: b, value: b }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("keeps absent versus null distinct for non-reasoning response items", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-response-null-");
    const response = { timestamp: iso(2101), type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: J({ command: "echo step 1" }) } };
    const a = file(root, ".codex/sessions", [META, J(response), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, J({ ...response, payload: { ...response.payload, content: null } }), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: a }, { path: b, value: b }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects same-length patch output differences", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-raw-patch-");
    const a = file(root, ".codex/sessions", [META, J({ timestamp: iso(2501), type: "event_msg", payload: { type: "patch_apply_end", stdout: "abcde" } }), record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, J({ timestamp: iso(2501), type: "event_msg", payload: { type: "patch_apply_end", stdout: "vwxyz" } }), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: a }, { path: b, value: b }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("proves the source parser's free/Qwen filtering, not raw Codex lines", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-source-parser-");
    const paid = file(root, ".codex/sessions", [META, record(1)]);
    const free = file(root, ".codex-free/archived_sessions", [META, prompt(1), record(1)]);
    const paidSource = {
      parse: parseCodexLine,
      settle: settleRouted,
      semanticCtx: () => newCodexCtx(),
      semanticKey: "paid-v1",
      project: "?",
    };
    const freeSource = {
      parse: parseFreeCodexLocalQwen,
      settle: settleFreeCodexLocalQwen,
      semanticCtx: () => newCodexCtx(),
      semanticKey: "free-qwen-v1",
      project: "?",
    };
    expect(() => selectCodexRolloutCopies(
      [{ path: paid, value: paidSource }, { path: free, value: freeSource }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("does not use a byte-prefix fast path across paid and free parser contracts", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-source-prefix-");
    const paid = file(root, ".codex/sessions", [META, record(1)]);
    const free = file(root, ".codex-free/archived_sessions", [META, record(1), prompt(1)]);
    const paidSource = {
      parse: parseCodexLine, settle: settleRouted, semanticCtx: () => newCodexCtx(), semanticKey: "paid-v1", project: "?",
    };
    const freeSource = {
      parse: parseFreeCodexLocalQwen, settle: settleFreeCodexLocalQwen, semanticCtx: () => newCodexCtx(), semanticKey: "free-qwen-v1", project: "?",
    };
    expect(() => selectCodexRolloutCopies(
      [{ path: paid, value: paidSource }, { path: free, value: freeSource }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("ignores session and turn metadata when manifests are otherwise equal", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-meta-");
    const playground = file(root, ".codex/sessions", [META, CONTEXT, record(1)]);
    const named = file(root, ".codex-work/sessions", [META, record(1)]);
    expect(selectCodexRolloutCopies(
      [{ path: playground, priority: 1, value: "playground" }, { path: named, priority: 0, value: "named" }],
      { semanticDominance: dominance },
    )).toEqual(["named"]);
  });

  test("rejects mixed token_usage_record and token_count formats", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-format-");
    const a = file(root, ".codex/sessions", [META, record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, count(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects malformed event values and a torn semantic snapshot", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-invalid-");
    const meta = J({ timestamp: iso(1000), type: "session_meta", payload: { id: "s", model: "gpt-5" } });
    const badTime = file(root, ".codex/sessions", [meta, J({ timestamp: "bad-A", type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 100, output_tokens: 5 } } })]);
    const otherBadTime = file(root, ".codex-archive/archived_sessions", [meta, J({ timestamp: "bad-B", type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 100, output_tokens: 5 } } })]);
    expect(() => selectCodexRolloutCopies(
      [{ path: badTime, value: badTime }, { path: otherBadTime, value: otherBadTime }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);

    const negative = file(root, ".codex-negative/sessions", [meta, J({ timestamp: iso(3000), type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 100, output_tokens: -5 } } })]);
    const negativeExtra = file(root, ".codex-negative-archive/archived_sessions", [meta, prompt(1), J({ timestamp: iso(3000), type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 100, output_tokens: -5 } } })]);
    expect(() => selectCodexRolloutCopies(
      [{ path: negative, value: negative }, { path: negativeExtra, value: negativeExtra }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);

    const complete = file(root, ".codex-torn/sessions", [record(1)]);
    const torn = join(root, ".codex-torn-archive", "archived_sessions", ROLLOUT);
    mkdirSync(join(root, ".codex-torn-archive", "archived_sessions"), { recursive: true });
    writeFileSync(torn, `${prompt(1)}\n${record(1)}\n{`);
    expect(() => selectCodexRolloutCopies(
      [{ path: complete, value: complete }, { path: torn, value: torn }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects a provider-only route change and reordered raw response items", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-routing-");
    const openai = file(root, ".codex/sessions", [
      J({ timestamp: iso(1000), type: "session_meta", payload: { id: "s", model: "gpt-5", model_provider: "openai" } }),
      record(1),
    ]);
    const routed = file(root, ".codex-archive/archived_sessions", [
      J({ timestamp: iso(1000), type: "session_meta", payload: { id: "s", model: "gpt-5", model_provider: "subscription_gateway" } }),
      record(1),
    ]);
    expect(() => selectCodexRolloutCopies(
      [{ path: openai, value: openai }, { path: routed, value: routed }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);

    const ordered = file(root, ".codex-response/sessions", [META, call(1), result(1), record(1)]);
    const reordered = file(root, ".codex-response-archive/archived_sessions", [META, result(1), call(1), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: ordered, value: ordered }, { path: reordered, value: reordered }],
      { semanticDominance: dominance },
    )).toThrow(CodexRolloutCopyError);
  });

  test("rejects a file growth mutation during the proof", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-mutate-");
    const retained = file(root, ".codex/sessions", [META, record(1)]);
    const primary = file(root, ".codex-archive/archived_sessions", [META, prompt(1), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: retained, value: "retained" }, { path: primary, value: "primary" }],
      { semanticDominance: (candidates) => {
        appendFileSync(primary, `${record(9)}\n`);
        return dominance(candidates);
      } },
    )).toThrow(/semantic duplicate proof/);
  });

  test("rejects a symlink target change during the proof", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-symlink-");
    const retained = file(root, ".codex/sessions", [META, record(1)]);
    const primary = file(root, "pool", [META, prompt(1), record(1)]);
    const shifted = file(root, "pool-shifted", [META, prompt(1), prompt(2), record(1)]);
    const dir = join(root, "links");
    mkdirSync(dir, { recursive: true });
    const link = join(dir, ROLLOUT);
    symlinkSync(primary, link);
    expect(() => selectCodexRolloutCopies(
      [{ path: retained, priority: 1, value: "retained" }, { path: link, priority: 0, value: "link" }],
      { semanticDominance: (candidates) => {
        const chosen = dominance(candidates);
        unlinkSync(link);
        symlinkSync(shifted, link);
        return chosen;
      } },
    )).toThrow(CodexRolloutCopyError);
  });

  test("keeps the longest byte-prefix fast path without consulting the proof", () => {
    let consulted = 0;
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-prefix-fast-");
    const live = file(root, ".codex/sessions", [META, record(1)]);
    const archived = file(root, ".codex-archive/archived_sessions", [META, record(1), record(2)]);
    expect(selectCodexRolloutCopies(
      [{ path: live, value: "live" }, { path: archived, value: "archive" }],
      { semanticDominance: (candidates) => { consulted++; return dominance(candidates); } },
    )).toEqual(["archive"]);
    expect(consulted).toBe(0);
  });

  test("a semantic decision never authorizes the strict default path", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-contamination-");
    const retained = file(root, ".codex/sessions", [META, record(1)]);
    const primary = file(root, ".codex-archive/archived_sessions", [META, prompt(1), record(1)]);
    const copies = [{ path: retained, value: "retained" }, { path: primary, value: "primary" }];
    expect(selectCodexRolloutCopies(copies, { semanticDominance: dominance })).toEqual(["primary"]);
    expect(() => selectCodexRolloutCopies(copies)).toThrow(/divergent complete copies/);
  });

  test("a strict-default failure does not poison the semantic path", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-poison-");
    const retained = file(root, ".codex/sessions", [META, record(1)]);
    const primary = file(root, ".codex-archive/archived_sessions", [META, patch(1), record(1)]);
    const copies = [{ path: retained, value: "retained" }, { path: primary, value: "primary" }];
    expect(() => selectCodexRolloutCopies(copies)).toThrow(CodexRolloutCopyError);
    expect(selectCodexRolloutCopies(copies, { semanticDominance: dominance })).toEqual(["primary"]);
  });

  test("a callback may only return an existing candidate path", () => {
    const root = tempDir("spendwatch-sem-unknown-");
    const a = file(root, ".codex/sessions", [META, record(1)]);
    const b = file(root, ".codex-archive/archived_sessions", [META, prompt(1), record(1)]);
    expect(() => selectCodexRolloutCopies(
      [{ path: a, value: "a" }, { path: b, value: "b" }],
      { semanticDominance: () => join(root, "nowhere.jsonl") },
    )).toThrow(CodexRolloutCopyError);
  });

  test("manifests emit each billed event once and hash no content", () => {
    const root = tempDir("spendwatch-sem-summary-");
    const records = file(root, ".codex/sessions", [META, record(1), record(2)]);
    expect(codexRolloutManifestSummary(records)).toEqual({ format: "records", api: 2, observed: 0, responses: 0, nonbilling: 0 });

    // A token_count beside a per-response record must not bill the call a second time.
    const both = file(root, ".codex-both/sessions", [META, record(1), count(1)]);
    expect(codexRolloutManifestSummary(both)).toEqual({ format: "records", api: 1, observed: 1, responses: 0, nonbilling: 0 });

    // Counts alone bill each call once even when the CLI re-emits the same totals.
    const counts = file(root, ".codex-counts/sessions", [META, count(1), count(1)]);
    expect(codexRolloutManifestSummary(counts)).toEqual({ format: "counts", api: 1, observed: 2, responses: 0, nonbilling: 0 });

    const tools = file(root, ".codex-tools/sessions", [META, call(1), result(1), prompt(1), patch(1), mcp(1), record(1)]);
    expect(codexRolloutManifestSummary(tools)).toEqual({ format: "records", api: 1, observed: 0, responses: 2, nonbilling: 4 });

    expect(codexRolloutManifestSummary(file(root, ".codex-bad/sessions", ["{not json"]))).toBeUndefined();
    expect(codexRolloutManifestSummary(file(root, ".codex-empty/sessions", []))).toBeUndefined();
  });

  test("a synthetic June-shaped fixture is accepted without exposing source content", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-studio-");
    const spine: string[] = [];
    for (let n = 1; n <= 3; n++) spine.push(call(n), result(n), count(n));
    const defaults = file(root, ".codex/sessions", [META, ...spine]);
    const primary = file(root, ".codex-archive/archived_sessions", [
      META,
      spine[0]!, spine[1]!, prompt(1), spine[2]!,
      spine[3]!, spine[4]!, prompt(2), spine[5]!, patch(1),
      spine[6]!, spine[7]!, patch(2), spine[8]!, patch(3),
    ]);
    expect(selectCodexRolloutCopies(
      [{ path: defaults, priority: 0, value: "default" }, { path: primary, priority: 1, value: "primary" }],
      { semanticDominance: dominance },
    )).toEqual(["primary"]);
    // The proof reports shapes only: counts, never the prompts or patch output that made primary dominant.
    expect(codexRolloutManifestSummary(primary)).toEqual({ format: "counts", api: 3, observed: 3, responses: 6, nonbilling: 5 });
  });

  test("proves more than 250k parser facts but refuses a fact above the 1m ceiling", () => {
    const dominance = createCodexRolloutSemanticDominance();
    const root = tempDir("spendwatch-sem-event-budget-");
    const retained = factFile(root, ".codex/sessions", 0);
    const primary = factFile(root, ".codex-archive/archived_sessions", 250_001);
    const retainedSource = { ...factSource, label: "retained" };
    const primarySource = { ...factSource, label: "primary" };
    expect(selectCodexRolloutCopies(
      [{ path: retained, priority: 0, value: retainedSource }, { path: primary, priority: 1, value: primarySource }],
      { semanticDominance: dominance },
    )).toEqual([primarySource]);

    const overLimit = factFile(root, ".codex-over-limit/archived_sessions", 1_000_001);
    expect(() => selectCodexRolloutCopies(
      [{ path: retained, priority: 0, value: retainedSource }, { path: overLimit, priority: 1, value: primarySource }],
      { semanticDominance: createCodexRolloutSemanticDominance() },
    )).toThrow(CodexRolloutCopyError);
  });
});

describe("Codex semantic dominance for nonbilling differences", () => {
  const user = (n: number) => J({ timestamp: iso(1600 + n), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `u${n}` }] } });
  const assistant = (n: number) => J({ timestamp: iso(1700 + n), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `a${n}` }] } });
  const labelled = (n: number, metadata: unknown) => J({ timestamp: iso(1800 + n), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `l${n}` }], metadata } });
  const pick = (a: readonly string[], b: readonly string[]) => {
    const root = tempDir("spendwatch-sem-rules-");
    const left = file(root, ".codex/sessions", a);
    const right = file(root, ".codex-archive/archived_sessions", b);
    return selectCodexRolloutCopies([{ path: left, priority: 1, value: "left" }, { path: right, priority: 0, value: "right" }],
      { semanticDominance: createCodexRolloutSemanticDominance() });
  };

  test("a bare turn label is not content; any other metadata still differs", () => {
    expect(pick([META, labelled(1, { turn_id: "t1" }), record(1)], [META, labelled(1, undefined), record(1)])).toHaveLength(1);
    expect(() => pick([META, labelled(1, { turn_id: "t1", x: 1 }), record(1)], [META, labelled(1, undefined), record(1)])).toThrow();
  });

  test("extra user or developer messages may only add to the winner within the same billing segment", () => {
    expect(pick([META, user(1), record(1), user(2), record(2)], [META, record(1), record(2)])).toEqual(["left"]);
    expect(() => pick([META, assistant(1), record(1)], [META, record(1)])).toThrow();
    expect(() => pick([META, record(1), user(1), record(2)], [META, user(1), record(1), record(2)])).toThrow();
    expect(() => pick([META, user(1), record(1)], [META, user(2), record(1)])).toThrow();
  });

  test("an extra observed call is accepted only as a re-emission of the preceding token_count", () => {
    expect(pick([META, count(1), count(1), count(2)], [META, count(1), count(2)])).toEqual(["left"]);
    expect(() => pick([META, count(1), count(3), count(2)], [META, count(1), count(2)])).toThrow();
  });
});

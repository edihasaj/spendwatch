import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexRolloutCopyError, selectCodexRolloutCopies } from "../src/codex-rollout-copies";
import { createCodexRolloutSemanticDominance } from "../src/codex-rollout-semantics";
import { tempDir } from "./tmp";

const ROLLOUT = "rollout-2026-07-31T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
const FACT = "{\"fact\":true}\n";
const EMPTY_FACT = "{\"fact\":false}\n";
const source = {
  parse: (line: string) => line === FACT.slice(0, -1)
    ? [{ t: "prompt" as const, sessionId: "facts", promptId: "facts", ts: 1, text: "fact", sidechain: false }]
    : [],
  semanticCtx: () => null,
  semanticKey: "synthetic-resource-facts-v1",
  project: "?",
};

function factFile(root: string, dir: string, facts: number): string {
  const path = join(root, dir, ROLLOUT);
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(path, facts === 0 ? EMPTY_FACT : FACT.repeat(facts));
  return path;
}

function pair(root: string, name: string, facts: number) {
  const retained = factFile(root, `${name}/sessions`, 0);
  const primary = factFile(root, `${name}/archived_sessions`, facts);
  return {
    retained,
    primary,
    retainedValue: { ...source, name: `${name}-retained` },
    primaryValue: { ...source, name: `${name}-primary` },
  };
}

function selectPair(
  dominance: ReturnType<typeof createCodexRolloutSemanticDominance>,
  item: ReturnType<typeof pair>,
) {
  return selectCodexRolloutCopies(
    [{ path: item.retained, priority: 0, value: item.retainedValue }, { path: item.primary, priority: 1, value: item.primaryValue }],
    { semanticDominance: dominance },
  );
}

describe("Codex semantic duplicate resources", () => {
  test("streams a valid candidate above the former 128 MiB file ceiling", () => {
    const root = tempDir("spendwatch-sem-large-file-");
    const retained = factFile(root, ".codex/sessions", 0);
    const primary = join(root, ".codex-archive/archived_sessions", ROLLOUT);
    mkdirSync(join(root, ".codex-archive/archived_sessions"), { recursive: true });
    // Thousands of valid, sparse JSON rows stay far below the 16 MiB line cap
    // while proving file admission is streaming rather than a 128 MiB reject.
    const sparse = `${JSON.stringify({ ignored: "x".repeat(64 * 1024 - 64) })}\n`;
    writeFileSync(primary, "");
    while (statSync(primary).size <= 128 * 1024 * 1024) appendFileSync(primary, sparse);

    const retainedValue = { ...source, name: "retained" };
    const primaryValue = { ...source, name: "primary" };
    expect(selectCodexRolloutCopies(
      [{ path: retained, priority: 1, value: retainedValue }, { path: primary, priority: 0, value: primaryValue }],
      { semanticDominance: createCodexRolloutSemanticDominance() },
    )).toEqual([primaryValue]);
  });

  test("evicts old manifests by fact budget and still re-proves the same dominant copy", () => {
    const root = tempDir("spendwatch-sem-cache-facts-");
    const dominance = createCodexRolloutSemanticDominance();
    const first = pair(root, "first", 550_000);
    expect(selectPair(dominance, first)).toEqual([first.primaryValue]);
    for (const name of ["second", "third", "fourth"]) {
      const item = pair(root, name, 550_000);
      expect(selectPair(dominance, item)).toEqual([item.primaryValue]);
    }
    // Four 550k manifests exceed the 2m aggregate cache budget. The first
    // pair must be safely rebuilt after LRU eviction, with the same result.
    expect(selectPair(dominance, first)).toEqual([first.primaryValue]);
  });

  test("keeps the 1m per-manifest fact ceiling fail-closed", () => {
    const root = tempDir("spendwatch-sem-fact-cap-");
    const retained = factFile(root, ".codex/sessions", 0);
    const overLimit = factFile(root, ".codex-archive/archived_sessions", 1_000_001);
    expect(() => selectCodexRolloutCopies(
      [{ path: retained, value: { ...source, name: "retained" } }, { path: overLimit, value: { ...source, name: "over" } }],
      { semanticDominance: createCodexRolloutSemanticDominance() },
    )).toThrow(CodexRolloutCopyError);
  });
});

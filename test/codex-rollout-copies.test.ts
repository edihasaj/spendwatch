import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexRolloutCopyError, selectCodexRolloutCopies } from "../src/codex-rollout-copies";
import { tempDir } from "./tmp";

const ROLLOUT = "rollout-2026-10-19T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";

function json(id: string): string {
  return JSON.stringify({ type: "token_usage_record", payload: { response_id: id } });
}

function copy(root: string, lines: string[], partial = ""): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, ROLLOUT);
  writeFileSync(path, `${lines.join("\n")}${lines.length ? "\n" : ""}${partial}`);
  return path;
}

describe("Codex rollout copies", () => {
  test("chooses the newer archived extension when the live copy is its complete prefix", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const live = copy(join(home, ".codex", "sessions"), [json("one")]);
    const archived = copy(join(home, ".codex", "archived_sessions"), [json("one"), json("two")]);

    expect(selectCodexRolloutCopies([
      { path: live, value: "live" },
      { path: archived, value: "archive" },
    ])).toEqual(["archive"]);
  });

  test("keeps a named profile for identical clones independent of discovery order", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const defaultCopy = copy(join(home, ".codex", "sessions"), [json("one")]);
    const namedCopy = copy(join(home, ".codex-personal", "sessions"), [json("one")]);
    const copies = [
      { path: defaultCopy, priority: 1, value: "default" },
      { path: namedCopy, priority: 0, value: "personal" },
    ] as const;

    expect(selectCodexRolloutCopies(copies)).toEqual(["personal"]);
    expect(selectCodexRolloutCopies([...copies].reverse())).toEqual(["personal"]);
  });

  test("does not change counts for byte-identical copies", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const first = copy(join(home, ".codex-a", "sessions"), [json("one"), json("two")]);
    const second = copy(join(home, ".codex-b", "sessions"), [json("one"), json("two")]);

    expect(selectCodexRolloutCopies([
      { path: first, value: first },
      { path: second, value: second },
    ])).toHaveLength(1);
  });

  test("leaves an invalid singleton to the normal rollout parser", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const invalid = copy(join(home, ".codex", "sessions"), ["not json"]);

    expect(selectCodexRolloutCopies([{ path: invalid, value: "normal-parser" }])).toEqual(["normal-parser"]);
  });

  test("invalidates a duplicate comparison when one copy grows", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const live = copy(join(home, ".codex", "sessions"), [json("one")]);
    const archive = copy(join(home, ".codex", "archived_sessions"), [json("one")]);
    const copies = [
      { path: live, priority: 0, value: "live" },
      { path: archive, priority: 1, value: "archive" },
    ];

    expect(selectCodexRolloutCopies(copies)).toEqual(["live"]);
    appendFileSync(archive, `${json("two")}\n`);
    expect(selectCodexRolloutCopies(copies)).toEqual(["archive"]);
  });

  test("ignores a torn final line while choosing the complete prefix", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const stable = copy(join(home, ".codex", "sessions"), [json("one")]);
    const writing = copy(join(home, ".codex-archive", "archived_sessions"), [json("one")], '{"type":"token');

    expect(selectCodexRolloutCopies([
      { path: stable, priority: 0, value: "stable" },
      { path: writing, priority: 1, value: "writing" },
    ])).toEqual(["stable"]);
  });

  test("makes divergent complete copies visible instead of silently reporting one branch", () => {
    const home = tempDir("spendwatch-rollout-copies-");
    const left = copy(join(home, ".codex", "sessions"), [json("one"), json("left")]);
    const right = copy(join(home, ".codex-archive", "archived_sessions"), [json("one"), json("right")]);

    expect(() => selectCodexRolloutCopies([
      { path: left, value: "left" },
      { path: right, value: "right" },
    ])).toThrow(CodexRolloutCopyError);
  });
});

describe("Codex rollout copies with an opt-in proof", () => {
  test("never consults the callback for identical or prefix-complete copies", () => {
    const home = tempDir("spendwatch-rollout-semantic-");
    const identical = [
      copy(join(home, ".codex-a", "sessions"), [json("one")]),
      copy(join(home, ".codex-b", "sessions"), [json("one")]),
    ];
    let consulted = 0;
    const options = { semanticDominance: () => { consulted++; return undefined; } };
    expect(selectCodexRolloutCopies(identical.map((path) => ({ path, value: path })), options)).toHaveLength(1);
    const live = copy(join(home, ".codex", "sessions"), [json("one")]);
    const archived = copy(join(home, ".codex", "archived_sessions"), [json("one"), json("two")]);
    expect(selectCodexRolloutCopies([{ path: live, value: "live" }, { path: archived, value: "archive" }], options)).toEqual(["archive"]);
    expect(consulted).toBe(0);
  });

  test("a callback returning undefined keeps the divergent-copy error visible", () => {
    const home = tempDir("spendwatch-rollout-divergent-");
    const left = copy(join(home, ".codex", "sessions"), [json("one"), json("left")]);
    const right = copy(join(home, ".codex-archive", "archived_sessions"), [json("one"), json("right")]);
    expect(() => selectCodexRolloutCopies(
      [{ path: left, value: "left" }, { path: right, value: "right" }],
      { semanticDominance: () => undefined },
    )).toThrow(CodexRolloutCopyError);
  });

  test("hands the callback every inspected candidate with its stable signature", () => {
    const home = tempDir("spendwatch-rollout-signature-");
    const left = copy(join(home, ".codex", "sessions"), [json("one"), json("left")]);
    const right = copy(join(home, ".codex-archive", "archived_sessions"), [json("one"), json("right")]);
    const seen: Array<{ path: string; signature: string; size: number }> = [];
    expect(() => selectCodexRolloutCopies(
      [{ path: left, priority: 1, value: "left" }, { path: right, priority: 0, value: "right" }],
      { semanticDominance: (candidates) => {
        seen.push(...candidates.map(({ path, signature, size }) => ({ path, signature, size })));
        return undefined;
      } },
    )).toThrow(CodexRolloutCopyError);
    expect(seen.map((entry) => entry.path).sort()).toEqual([left, right].sort());
    for (const entry of seen) {
      expect(entry.signature.includes(entry.path)).toBe(true);
      expect(entry.signature.includes(String(statSync(entry.path).ino))).toBe(true);
      expect(entry.size).toBe(statSync(entry.path).size);
    }
  });

  test("does not reuse one callback's semantic verdict for another callback", () => {
    const home = tempDir("spendwatch-rollout-callback-cache-");
    const left = copy(join(home, ".codex", "sessions"), [json("one"), json("left")]);
    const right = copy(join(home, ".codex-archive", "archived_sessions"), [json("one"), json("right")]);
    const copies = [{ path: left, value: "left" }, { path: right, value: "right" }];
    expect(selectCodexRolloutCopies(copies, { semanticDominance: () => right })).toEqual(["right"]);
    let called = false;
    expect(() => selectCodexRolloutCopies(copies, {
      semanticDominance: () => {
        called = true;
        return undefined;
      },
    })).toThrow(CodexRolloutCopyError);
    expect(called).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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

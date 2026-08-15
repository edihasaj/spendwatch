import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexRoots } from "../src/sources";

describe("Codex profile discovery", () => {
  test("finds default and named profiles with session directories", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    mkdirSync(join(home, ".codex-personal", "sessions"), { recursive: true });
    mkdirSync(join(home, ".codex-work", "sessions"), { recursive: true });
    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([
      join(home, ".codex", "sessions"),
      join(home, ".codex-personal", "sessions"),
      join(home, ".codex-work", "sessions"),
    ]);
  });

  test("does not double-count symlinked session roots", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(home, ".codex-shadow"), { recursive: true });
    symlinkSync(sessions, join(home, ".codex-shadow", "sessions"));

    expect(defaultCodexRoots(home)).toHaveLength(1);
  });
});

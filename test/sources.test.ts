import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexRoots, discover } from "../src/sources";

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

  test("bills a rollout once when a profile home is a copy, not a symlink", () => {
    // ~/.codex is a copy-on-write clone of ~/.codex-primary: same rollout file,
    // two distinct real paths, so realpath dedupe cannot see it. The surviving
    // copy must be credited to the named profile, not the playground.
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const rollout = "rollout-2026-08-18T10-00-00-11111111-2222-3333-4444-555555555555.jsonl";
    const roots = [join(home, ".codex", "sessions"), join(home, ".codex-primary", "sessions")];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, rollout), "");
    }
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));

    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files).toHaveLength(1);
      expect(codex?.files[0]?.path).toBe(join(home, ".codex-primary", "sessions", rollout));
      expect(codex?.files[0]?.account).toBe("primary");
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("labels each profile home so duplicate accounts stay distinguishable", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const roots = [".codex", ".codex-tertiary"].map((p) => join(home, p, "sessions"));
    for (const [index, root] of roots.entries()) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `rollout-2026-08-18T10-00-0${index}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${index}.jsonl`), "");
    }
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));

    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files.map((f) => f.account).sort()).toEqual(["main", "tertiary"]);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });
});

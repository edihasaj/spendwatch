import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sweepStaleSnapshotRoots } from "../src/codex-compressed-rollouts";

// A pid that has certainly exited: a finished child of this test.
function deadPid(): number {
  const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(child.stdout.trim());
}

describe("compressed rollout snapshot sweep", () => {
  test("removes roots of dead runs and old unowned roots, keeps live and recent ones", () => {
    const directory = mkdtempSync("/tmp/spendwatch-sweep-test-");
    try {
      const root = (name: string, owner?: number) => {
        const path = join(directory, `spendwatch-codex-zstd-${name}`);
        mkdirSync(join(path, "rollout-a"), { recursive: true });
        writeFileSync(join(path, "rollout-a", "rollout.jsonl"), "{}\n");
        if (owner !== undefined) writeFileSync(join(path, "owner.pid"), `${owner}\n`);
        return path;
      };
      const dead = root("dead", deadPid());
      const live = root("live", process.pid);
      const recent = root("recent");
      const old = root("old");
      const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      utimesSync(old, hourAgo, hourAgo);
      const other = join(directory, "unrelated-dir");
      mkdirSync(other);

      expect(sweepStaleSnapshotRoots(directory)).toBe(2);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a missing directory sweeps nothing", () => {
    expect(sweepStaleSnapshotRoots("/tmp/spendwatch-sweep-missing-directory")).toBe(0);
  });
});

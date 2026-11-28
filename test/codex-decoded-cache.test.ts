import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DECODED_ENTRY_TTL_MS, codexRolloutSnapshot, decodedCacheRoot, resetCodexRolloutMemo, sweepDecodedCache,
} from "../src/codex-compressed-rollouts";
import { tempDir } from "./tmp";

const ROLLOUT = "rollout-2026-11-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";

function compressed(path: string, text: string): void {
  const result = spawnSync("zstd", ["-q", "-c"], { input: text });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("zstd test fixture failed");
  writeFileSync(path, result.stdout);
}

function lines(count: number, tag = "x"): string {
  let text = "";
  for (let i = 0; i < count; i++) text += `${JSON.stringify({ i, tag })}\n`;
  return text;
}

function archive(text: string, name = ROLLOUT): string {
  const directory = tempDir("spendwatch-decoded-src-");
  const path = join(directory, `${name}.zst`);
  compressed(path, text);
  return path;
}

function withCache<T>(run: (root: string) => T): T {
  const previous = process.env.SPENDWATCH_CODEX_DECODED_CACHE;
  const root = join(tempDir("spendwatch-decoded-cache-"), "cache");
  process.env.SPENDWATCH_CODEX_DECODED_CACHE = root;
  resetCodexRolloutMemo();
  try { return run(root); } finally {
    process.env.SPENDWATCH_CODEX_DECODED_CACHE = previous;
    resetCodexRolloutMemo();
  }
}

describe("persistent decoded Codex archive cache", () => {
  test("a later run reuses the decoded file without writing it again", () => withCache((root) => {
    const source = archive(lines(50));
    const first = codexRolloutSnapshot(source);
    expect(first.startsWith(root)).toBe(true);
    expect(first).toEndWith(ROLLOUT);
    const before = statSync(first);

    resetCodexRolloutMemo(); // a new process
    const second = codexRolloutSnapshot(source);
    const after = statSync(second);
    expect(second).toBe(first);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(readdirSync(root).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    expect(readFileSync(second, "utf8")).toBe(lines(50));
    expect(statSync(root).mode & 0o777).toBe(0o700);
  }));

  test("re-decodes an entry whose decoded file was altered", () => withCache(() => {
    const source = archive(lines(20));
    const first = codexRolloutSnapshot(source);
    chmodSync(first, 0o600);
    writeFileSync(first, "{\"tampered\":true}\n");

    resetCodexRolloutMemo();
    const second = codexRolloutSnapshot(source);
    expect(readFileSync(second, "utf8")).toBe(lines(20));
    expect(statSync(second).mode & 0o222).toBe(0);
  }));

  test("a changed archive gets its own entry", () => withCache(() => {
    const source = archive(lines(5, "old"));
    const first = codexRolloutSnapshot(source);
    compressed(source, lines(5, "new"));
    const second = codexRolloutSnapshot(source);
    expect(dirname(second)).not.toBe(dirname(first));
    expect(readFileSync(second, "utf8")).toBe(lines(5, "new"));
  }));

  test("sweeps entries unused past the TTL and dead staging, keeps recent entries", () => withCache((root) => {
    const keep = codexRolloutSnapshot(archive(lines(3, "keep"), ROLLOUT.replace("aaaa", "1111")));
    const old = codexRolloutSnapshot(archive(lines(3, "old"), ROLLOUT.replace("aaaa", "2222")));
    const now = Date.now();
    const past = new Date(now - DECODED_ENTRY_TTL_MS - 60_000);
    utimesSync(dirname(old), past, past);
    const dead = join(root, ".staging-999999999-abc");
    mkdirSync(dead);

    expect(sweepDecodedCache(root, now)).toBe(2);
    expect(() => statSync(dirname(old))).toThrow();
    expect(() => statSync(dead)).toThrow();
    expect(statSync(keep).isFile()).toBe(true);
  }));

  test("paces cache fills to the configured write rate", () => withCache((root) => {
    const source = archive(lines(120_000));
    // The write budget is process-wide. Start with a fresh clock window.
    const result = spawnSync(process.execPath, ["--eval", `
      import { codexRolloutSnapshot } from ${JSON.stringify(join(import.meta.dir, "../src/codex-compressed-rollouts.ts"))};
      const started = performance.now();
      codexRolloutSnapshot(process.argv[1]);
      console.log(performance.now() - started);
    `, source], {
      encoding: "utf8",
      env: {
        ...process.env,
        SPENDWATCH_CODEX_DECODED_CACHE: root,
        SPENDWATCH_DECODE_WRITE_BYTES_PER_SECOND: String(1024 * 1024),
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(Number(result.stdout.trim())).toBeGreaterThanOrEqual(900);
  }), 15_000);

  test("defaults to a private per-user cache outside the temp directory", () => {
    const previous = process.env.SPENDWATCH_CODEX_DECODED_CACHE;
    delete process.env.SPENDWATCH_CODEX_DECODED_CACHE;
    try { expect(decodedCacheRoot()).toEndWith(join("spendwatch", "codex-decoded")); }
    finally { process.env.SPENDWATCH_CODEX_DECODED_CACHE = previous; }
  });
});

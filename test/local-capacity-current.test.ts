import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import {
  collectLocalCapacity,
  LOCAL_PROVIDERS,
  localQwenTokens,
  type LocalCapacityDeps,
} from "../src/local-capacity-current";
import { normalizeCodexLimits } from "../src/limits";
import { tempDir } from "./tmp";

const NOW = Date.parse("2026-10-27T12:00:00Z");

function report(models: Array<Partial<Report["models"][number]>>, totalCost = 0, totalTokens = 0, source = "x"): Report {
  return {
    source, totalCost, totalTokens,
    models: models.map((m) => ({ model: "x", calls: 1, inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, cost: 0, ...m })),
  } as unknown as Report;
}

function deps(over: Partial<LocalCapacityDeps> = {}): LocalCapacityDeps {
  return {
    now: NOW,
    home: tempDir("local-capacity-home-"),
    reports: () => [],
    run: async () => ({ code: 1, stdout: "" }),
    which: () => null,
    exists: () => false,
    ...over,
  };
}

describe("local capacity collection", () => {
  test("offers only Local Qwen as a local card", () => {
    expect(LOCAL_PROVIDERS).toEqual(["qwen"]);
  });

  test("Local Qwen counts only the self-hosted model, whichever agent routed it", () => {
    const reports = [
      report([
        { model: "qwen3.8-flash-next", inTok: 10, outTok: 5, cacheReadTok: 100 },
        { model: "qwen/qwen3.8-flash-next", inTok: 1, outTok: 1, cacheWriteTok: 2 },
        { model: "codex/qwen3.8-flash-next", inTok: 3 },
        { model: "gpt-6.1-sol", inTok: 999 },
        { model: "qwen3.8-flash-next-other", inTok: 999 },
      ]),
    ];
    expect(localQwenTokens(reports)).toBe(10 + 5 + 100 + 1 + 1 + 2 + 3);
  });

  test("Local Qwen reports measured spend with no money, and notes the observation", async () => {
    const rows = await collectLocalCapacity(["qwen"], deps({
      reports: (days) => [report([{ model: "qwen3.8-flash-next", inTok: days === 1 ? 7 : 70 }])],
    })) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].local.detail).toBe("Self-hosted Qwen usage recorded on this machine.");
    expect(rows[0].spend).toEqual({ recentUsd: 0, recentTokens: 7, recentHours: 24, monthUsd: 0, monthTokens: 70, monthDays: 30 });
  });

  test("Local Qwen is absent on a machine that neither has it configured nor used it", async () => {
    expect(await collectLocalCapacity(["qwen"], deps())).toEqual([]);
  });

  test("Local Qwen configured but unread omits spend rather than inventing zero", async () => {
    const rows = await collectLocalCapacity(["qwen"], deps({
      exists: (path) => path.endsWith("spark-implementer.config.toml"),
      reports: () => { throw new Error("report failed"); },
    })) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBeUndefined();
    expect(rows[0].local.detail).toBe("Self-hosted Qwen usage report unavailable on this machine.");
  });

  test("keeps the 30-day totals for half an hour and rereads them after", async () => {
    const home = tempDir("local-capacity-cache-");
    let stored: unknown;
    const cache = { read: () => stored, write: (value: unknown) => { stored = value; } };
    const run = async (offsetMs: number, monthTokens: number) => {
      const windows: number[] = [];
      const rows = await collectLocalCapacity(["qwen"], deps({
        home, cache, now: NOW + offsetMs,
        reports: (days) => { windows.push(days); return [report([{ model: "qwen3.8-flash-next", inTok: days === 1 ? 10 : monthTokens }])]; },
      })) as any[];
      return { windows, month: rows[0].spend.monthTokens, recent: rows[0].spend.recentTokens };
    };
    expect(await run(0, 900)).toEqual({ windows: [1, 30], month: 900, recent: 10 });
    // Ten minutes later only the day is read; the month still comes from the first read.
    expect(await run(10 * 60_000, 5000)).toEqual({ windows: [1], month: 900, recent: 10 });
    expect(await run(31 * 60_000, 5000)).toEqual({ windows: [1, 30], month: 5000, recent: 10 });
  });

  test("ignores a cached month that is malformed or dated in the future", async () => {
    const home = tempDir("local-capacity-badcache-");
    for (const bad of [{ at: NOW + 60_000, qwenTokens: 1 }, { at: NOW, qwenTokens: "x" }, "junk", null]) {
      const windows: number[] = [];
      await collectLocalCapacity(["qwen"], deps({
        home, cache: { read: () => bad, write: () => {} },
        reports: (days) => { windows.push(days); return []; },
      }));
      expect(windows).toEqual([1, 30]);
    }
  });

});

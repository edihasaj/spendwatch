import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import {
  collectLocalCapacity,
  LOCAL_PROVIDERS,
  localQwenTokens,
  type CommandResult,
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

function ghRunner(users: Record<string, unknown>, calls: string[][] = []) {
  return async (_cmd: string, args: string[], env?: Record<string, string>): Promise<CommandResult> => {
    calls.push(args);
    if (args[0] === "auth" && args[1] === "status") {
      return { code: 0, stdout: JSON.stringify({ hosts: { "github.com": Object.keys(users).map((login) => ({ login })) } }) };
    }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `token-${args[args.length - 1]}\n` };
    if (args[0] === "api") {
      const login = env?.GH_TOKEN?.replace("token-", "") ?? "";
      return login in users ? { code: 0, stdout: JSON.stringify(users[login]) } : { code: 1, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
}

describe("local capacity collection", () => {
  test("no longer offers Copilot as a local card", () => {
    expect(LOCAL_PROVIDERS).toEqual(["grok", "qwen"]);
  });

  test("Grok reports its account with day and month spend from the same reader", async () => {
    const home = tempDir("local-capacity-grok-");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok/auth.json"), JSON.stringify({ scope: { email: "dev@example.com" } }));
    const windows: number[] = [];
    const rows = await collectLocalCapacity(["grok"], deps({
      home,
      reports: (days) => {
        windows.push(days);
        // Another agent's spend in the same build must not reach the Grok card.
        return [report([], 99, 999, "codex"), days === 1 ? report([], 0.5, 100, "grok") : report([], 4, 900, "grok")];
      },
    })) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe("dev@example.com");
    expect(rows[0].spend).toEqual({ recentUsd: 0.5, recentTokens: 100, recentHours: 24, monthUsd: 4, monthTokens: 900, monthDays: 30 });
    expect(windows).toEqual([1, 30]);
  });

  test("Grok without a signed-in account contributes no card", async () => {
    expect(await collectLocalCapacity(["grok"], deps())).toEqual([]);
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

  test("reads each report window once however many providers ask for it", async () => {
    const home = tempDir("local-capacity-memo-");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok/auth.json"), JSON.stringify({ scope: { email: "dev@example.com" } }));
    let reads = 0;
    await collectLocalCapacity(["grok", "qwen", "grok"], deps({
      home,
      exists: () => true,
      reports: () => { reads++; return []; },
    }));
    // One build per window serves Grok, Local Qwen and the repeated Grok alike.
    expect(reads).toBe(2);
  });

  test("keeps the 30-day totals for half an hour and rereads them after", async () => {
    const home = tempDir("local-capacity-cache-");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok/auth.json"), JSON.stringify({ scope: { email: "dev@example.com" } }));
    let stored: unknown;
    const cache = { read: () => stored, write: (value: unknown) => { stored = value; } };
    const run = async (offsetMs: number, monthTokens: number) => {
      const windows: number[] = [];
      const rows = await collectLocalCapacity(["grok"], deps({
        home, cache, now: NOW + offsetMs,
        reports: (days) => { windows.push(days); return [report([], 1, days === 1 ? 10 : monthTokens, "grok")]; },
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
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok/auth.json"), JSON.stringify({ scope: { email: "dev@example.com" } }));
    for (const bad of [{ at: NOW + 60_000, grokUsd: 1, grokTokens: 1, qwenTokens: 1 }, { at: NOW, grokUsd: "x" }, "junk", null]) {
      const windows: number[] = [];
      await collectLocalCapacity(["grok"], deps({
        home, cache: { read: () => bad, write: () => {} },
        reports: (days) => { windows.push(days); return []; },
      }));
      expect(windows).toEqual([1, 30]);
    }
  });

  test("one failing provider never hides the others", async () => {
    const home = tempDir("local-capacity-fail-");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok/auth.json"), JSON.stringify({ scope: { email: "dev@example.com" } }));
    const failures: string[] = [];
    const rows = await collectLocalCapacity(["grok", "qwen"], deps({
      home,
      exists: () => true,
      reports: () => { throw new Error("report failed"); },
    }), (provider, message) => failures.push(`${provider}:${message}`)) as any[];
    expect(failures).toEqual(["grok:report failed"]);
    expect(rows.map((row) => row.provider)).toEqual(["qwen"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, reportsFrom, watchPeriod } from "../src/build";
import { GatewayIndex, type GatewayLedger } from "../src/gateway";
import { readRows } from "../src/gateway-ledger-files";
import { rollingDays } from "../src/periods";
import { apiEvents, claude, copilot, monthKey, NOW, type Row } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// A ledger line the gateway could not have written must not change what a report says: no negative or
// absurd token counts, no time a Date cannot hold, no call without an id.

/**
 * A state directory whose current month file holds these rows as they are. `stateDir` files a row by its time, and a
 * row with no time a Date can hold has no month to be filed under: here it sits in the file the gateway would read.
 */
function stateOf(rows: Row[]): string {
  const dir = tempDir("spendwatch-hostile-");
  mkdirSync(join(dir, "usage"));
  writeFileSync(join(dir, "usage", `usage-${monthKey(NOW)}.jsonl`), rows.map((row) => JSON.stringify({ v: 1, host: "studio", ...row })).join("\n") + "\n");
  return dir;
}
const ledgerOf = (rows: Row[]): GatewayLedger => GatewayIndex.load({ sinceMs: 0, stateDir: stateOf(rows) });
const requestIds = (rows: Row[]): string[] => apiEvents(ledgerOf(rows), "claude").map((event) => event.requestId);
const good = () => claude({ requestId: "ok", responseId: "resp_gl_ok", at: NOW - 60_000, inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 });

describe("a token count the gateway could not have written", () => {
  const hostile: Array<[string, Row]> = [
    ["a negative input", { inputTokens: -5_000_000 }],
    ["a negative output", { outputTokens: -1_000_000 }],
    ["a negative cache read", { cachedTokens: -9_000_000 }],
    ["a negative cache write", { cacheWriteTokens: -9_000_000 }],
    ["a negative reasoning count", { reasoningTokens: -1 }],
    ["a fractional count", { outputTokens: 1.5 }],
    ["a count beyond what a double holds exactly", { outputTokens: 2 ** 53 }],
    ["a huge input", { inputTokens: 1e308 }],
    ["a huge output", { outputTokens: 1e308 }],
    ["counts that together pass what a double holds exactly", { inputTokens: 5e15, outputTokens: 5e15 }],
  ];

  for (const [name, over] of hostile) {
    test(`drops the row with ${name}`, () => {
      expect(requestIds([good(), claude({ requestId: "bad", responseId: "resp_gl_bad", at: NOW - 50_000, cachedTokens: 0, cacheWriteTokens: 0, ...over })])).toEqual(["studio:ok"]);
    });
  }

  test("drops a count that is not finite, which JSON can still spell", () => {
    const dir = tempDir("spendwatch-hostile-");
    const file = join(dir, "usage-2026-10.jsonl");
    const text = (id: string, tokens: string) => `{"v":1,"at":"2026-10-15T10:00:00.000Z","host":"studio","requestId":"${id}","responseId":"resp_gl_${id}","origin":"gateway","providerType":"claude-subscription","provider":"claude","model":"m","inputTokens":${tokens},"outputTokens":1}\n`;
    writeFileSync(file, text("inf", "1e999") + text("fine", "10"));
    expect(readRows(file, {}).rows.map((row) => row.requestId)).toEqual(["fine"]);
  });

  test("reads a missing or wrong-typed field as zero, rather than as the text it holds", () => {
    // "5000" and true are not counts: they must not be coerced into 5000 and 1, nor drop a call that happened.
    const events = apiEvents(ledgerOf([claude({ requestId: "typed", inputTokens: "5000", outputTokens: true, cachedTokens: "400", cacheWriteTokens: null, reasoningTokens: undefined })]), "claude");
    expect(events.map((event) => event.usage)).toEqual([{ input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 }]);
  });

  test("caps the cache counts at the input they are part of", () => {
    const [capped, split] = apiEvents(ledgerOf([
      claude({ requestId: "capped", at: NOW - 60_000, inputTokens: 10, cachedTokens: 9_000_000, cacheWriteTokens: 5_000_000, outputTokens: 1 }),
      claude({ requestId: "split", responseId: "resp_gl_2", at: NOW - 50_000, inputTokens: 10, cachedTokens: 6, cacheWriteTokens: 9, outputTokens: 1 }),
    ]), "claude");
    // Cache reads and writes are part of the gross input, so no row can bill more than its input and output.
    expect(capped!.usage).toEqual({ input: 0, output: 1, cacheRead: 10, cache5m: 0, cache1h: 0 });
    expect(split!.usage).toEqual({ input: 0, output: 1, cacheRead: 6, cache5m: 4, cache1h: 0 });
  });

  test("leaves a negative or absurd credit figure unpriced, with the call still billed", () => {
    const rows = [-1, 1e308].map((nanoAiu, i) => copilot({ requestId: `credit${i}`, responseId: `resp_gl_c${i}`, at: NOW - i * 1000, model: "m", nanoAiu }));
    const events = apiEvents(ledgerOf(rows), "copilot");
    expect(events.map((event) => [event.model, event.costUsd])).toEqual([["m (unpriced)", 0], ["m (unpriced)", 0]]);
  });
});

describe("a time the gateway could not have written", () => {
  test("drops a row whose time a Date cannot hold, as a number or as text", () => {
    expect(requestIds([
      good(),
      claude({ requestId: "far", responseId: "resp_gl_far", at: 1e20 }),
      claude({ requestId: "past", responseId: "resp_gl_past", at: -1e20 }),
      claude({ requestId: "text", responseId: "resp_gl_text", at: "next tuesday" }),
      claude({ requestId: "object", responseId: "resp_gl_object", at: { when: 1 } }),
    ])).toEqual(["studio:ok"]);
  });
});

describe("a row without a request id", () => {
  test("names no call, so it is dropped", () => {
    expect(requestIds([good(), claude({ requestId: "", responseId: "resp_gl_empty", at: NOW - 50_000 }), claude({ requestId: undefined, responseId: "resp_gl_none", at: NOW - 40_000 }), claude({ requestId: 7, responseId: "resp_gl_num", at: NOW - 30_000 })])).toEqual(["studio:ok"]);
  });
});

describe("a run over a ledger with hostile rows", () => {
  const saved = process.env.SPENDWATCH_CONFIG;
  afterEach(() => { if (saved === undefined) delete process.env.SPENDWATCH_CONFIG; else process.env.SPENDWATCH_CONFIG = saved; });

  function hostileWorld() {
    const root = tempDir("spendwatch-hostile-run-");
    const state = stateOf([
      good(),
      claude({ requestId: "negative", responseId: "resp_gl_n", at: NOW - 50_000, inputTokens: 10, cachedTokens: -9_000_000, cacheWriteTokens: -9_000_000, outputTokens: -1_000_000 }),
      claude({ requestId: "huge", responseId: "resp_gl_h", at: NOW - 40_000, inputTokens: 1e308, outputTokens: 1e308 }),
      claude({ requestId: "far", responseId: "resp_gl_f", at: 1e20 }),
    ]);
    writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "claude", path: join(root, "none") }, { agent: "gateway", path: state }]));
    process.env.SPENDWATCH_CONFIG = join(root, "config.json");
  }

  for (const mode of ["watch", "report"] as const) {
    test(`bills only the real call in a ${mode} period, and does not throw on the others`, () => {
      hostileWorld();
      const options = { top: 5, agents: new Set(["claude"]) };
      const built = mode === "watch" ? build(options, [watchPeriod(NOW, 1)], { watching: true }) : build(options, [rollingDays(NOW, 1)]);
      const [claudeReport] = reportsFrom(built, options);
      expect(claudeReport).toMatchObject({ apiCalls: 1, totalTokens: 1100 });
      expect(claudeReport!.totalCost).toBeGreaterThan(0);
      expect(Number.isFinite(claudeReport!.totalCost)).toBe(true);
    });
  }
});

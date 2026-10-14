import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { usageCost } from "../src/pricing";
import type { Event } from "../src/parse";
import { GatewayIndex, type GatewayLedger, type GatewayVendor } from "../src/gateway";

const NOW = Date.now();

type Row = Record<string, unknown>;
type Api = Extract<Event, { t: "api" }>;

// The month a row belongs to, in the gateway's own file naming.
const monthKey = (ts: number): string => {
  const at = new Date(ts);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
};

/** A gateway state directory: each row filed under the month its `at` falls in. */
function stateDir(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spendwatch-gateway-"));
  mkdirSync(join(dir, "usage"), { recursive: true });
  const months = new Map<string, string[]>();
  for (const row of rows) {
    const at = typeof row.at === "number" ? row.at : Date.parse(String(row.at));
    const key = monthKey(at);
    months.set(key, [...(months.get(key) ?? []), JSON.stringify({ v: 1, host: "studio", ...row })]);
  }
  for (const [key, lines] of months) writeFileSync(join(dir, "usage", `usage-${key}.jsonl`), lines.join("\n") + "\n");
  return dir;
}

const load = (rows: Row[]): GatewayLedger => GatewayIndex.load({ sinceMs: 0, stateDir: stateDir(rows) });

// A call the gateway billed on a Copilot subscription.
const copilot = (over: Row = {}): Row => ({
  at: NOW, requestId: "req-1", responseId: "resp_gl_1", origin: "gateway",
  provider: "copilot", providerType: "copilot-subscription", model: "gpt-5.1-codex",
  session: true, inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 100,
  outputTokens: 50, reasoningTokens: 10, nanoAiu: 250_000_000, nanoAiuStatus: "complete", ...over,
});

// The same, on Claude's subscription, where the ledger reports no credit figure.
const claude = (over: Row = {}): Row => ({
  at: NOW, requestId: "req-1", responseId: "resp_gl_1", origin: "gateway",
  provider: "claude", providerType: "claude-subscription", model: "claude-opus-5.5",
  session: true, inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 100,
  outputTokens: 50, reasoningTokens: 0, ...over,
});

function apiEvents(index: GatewayLedger, vendor: GatewayVendor): Api[] {
  const files = index.files(vendor);
  if (!files.length) return [];
  expect(files[0]).toMatchObject({ key: `gateway:${vendor}`, project: "gateway", source: vendor });
  const events = [...files[0]!.events!()];
  expect(events[0]).toMatchObject({ t: "meta", project: "gateway" });
  return events.filter((e): e is Api => e.t === "api");
}

describe("gateway ledger", () => {
  test("bills a Copilot gateway call with its credits and the ledger's cache split", () => {
    const [row] = apiEvents(load([copilot()]), "copilot");
    expect(row).toBeDefined();
    expect(row!.requestId).toBe("studio:req-1");
    expect(row!.ts).toBe(NOW);
    // Gross input is split the way copilot.ts splits it: the cache buckets come out.
    expect(row!.usage).toEqual({ input: 500, output: 50, cacheRead: 400, cache5m: 100, cache1h: 0 });
    expect(row!.model).toBe("gpt-5.1-codex");
    expect(row!.costUsd).toBeCloseTo(250_000_000 / 1e11, 12);
  });

  test("labels a Copilot row whose credits were partial or never arrived", () => {
    const index = load([
      copilot({ requestId: "a", nanoAiu: 100_000_000, nanoAiuStatus: "partial" }),
      copilot({ requestId: "b", responseId: "resp_gl_b", nanoAiu: null, nanoAiuStatus: "unavailable" }),
    ]);
    const rows = apiEvents(index, "copilot");
    expect(rows.map((r) => r.model)).toEqual(["gpt-5.1-codex (partial credits)", "gpt-5.1-codex (unpriced)"]);
    expect(rows.map((r) => r.costUsd)).toEqual([0.001, 0]);
  });

  test("prices Claude gateway rows from their tokens, under the model alias", () => {
    const [row] = apiEvents(load([claude()]), "claude");
    // No credit figure on a Claude row, so the alias is left bare and priced by tokens.
    expect(row!.costUsd).toBeUndefined();
    expect(row!.model).toBe("claude-opus-5.5");
    const agg = new Aggregator();
    agg.stream("gateway:claude", "gateway", "claude")({ ...row!, t: "api" });
    expect(agg.report().totalCost).toBeCloseTo(usageCost("claude-opus-5.5", row!.usage), 8);
    expect(agg.report().totalTokens).toBe(500 + 50 + 400 + 100);
  });

  test("ignores rows for subscriptions it cannot bill", () => {
    const index = load([
      copilot({ requestId: "cx", provider: "openai", providerType: "openai-subscription", model: "gpt-5.6-sol" }),
      claude({ requestId: "qw", provider: "qwen", providerType: undefined, origin: "telemetry", responseId: "", session: false, model: "qwen3.8-flash-next" }),
      copilot({ requestId: "no", origin: "who-knows" }),
    ]);
    expect(apiEvents(index, "copilot")).toEqual([]);
    expect(apiEvents(index, "claude")).toEqual([]);
    // An ignored row cannot absorb a claim either: nothing was billed by it.
    expect(index.claim("gpt-5.6-sol", 1000, 50, NOW)).toBe(false);
  });

  test("counts one call once, from the gateway's own row, when both origins saw it", () => {
    const index = load([
      copilot({ requestId: "dupe", origin: "telemetry", providerType: undefined, responseId: "", session: false }),
      copilot({ requestId: "dupe", nanoAiu: 300_000_000 }),
      copilot({ requestId: "dupe", host: "book", nanoAiu: 400_000_000 }),
    ]);
    const rows = apiEvents(index, "copilot");
    // A call is one row per host, and the gateway's own row wins with its charge.
    expect(rows.map((r) => r.requestId).sort()).toEqual(["book:dupe", "studio:dupe"]);
    expect(rows.find((r) => r.requestId === "studio:dupe")!.costUsd).toBeCloseTo(0.003, 12);
  });

  test("counts a telemetry row once its transcript claims it, and a sessionless one either way", () => {
    const index = load([
      claude({ requestId: "t1", origin: "telemetry", providerType: undefined, responseId: "", session: true }),
      claude({ requestId: "t2", origin: "telemetry", providerType: undefined, responseId: "", session: false }),
    ]);
    // Before any rollout reads it, only the sessionless row is the gateway's to count.
    expect(apiEvents(index, "claude").map((r) => r.requestId)).toEqual(["studio:t2"]);
    // Same usage, but too far from the ledger's clock to be the same call.
    expect(index.claim("claude-opus-5.5", 1000, 50, NOW + 31_000)).toBe(false);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW)).toBe(false); // a different model
    expect(index.claim("claude-opus-5.5", 1000, 55, NOW)).toBe(false); // and different output
    expect(index.claim("claude-opus-5.5", 1000, 50, NOW)).toBe(true);
    expect(index.claim("claude-opus-5.5", 1000, 50, NOW)).toBe(false); // one claim per row
    const rows = apiEvents(index, "claude");
    expect(rows.map((r) => r.requestId)).toEqual(["studio:t1", "studio:t2"]);
    expect(rows.every((r) => r.model === "claude-opus-5.5 (telemetry backfill)")).toBe(true);
    expect(rows.every((r) => r.costUsd === undefined)).toBe(true);
  });

  test("leaves an unmarked gateway row to the transcript that served it", () => {
    const index = load([copilot({ responseId: "resp_9" })]);
    expect(apiEvents(index, "copilot")).toEqual([]);
    // Gateway rows are never claimable: a transcript claim only answers for
    // telemetry, so an unmarked row stays out of the report either way.
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW)).toBe(false);
    expect(apiEvents(index, "copilot")).toEqual([]);
  });

  test("reads the ledger home from SPENDWATCH_GATEWAY_STATE", () => {
    const dir = stateDir([claude()]);
    const previous = process.env.SPENDWATCH_GATEWAY_STATE;
    process.env.SPENDWATCH_GATEWAY_STATE = dir;
    try {
      expect(apiEvents(GatewayIndex.load({ sinceMs: 0 }), "claude")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_GATEWAY_STATE;
      else process.env.SPENDWATCH_GATEWAY_STATE = previous;
    }
  });

  test("reads every month ledger the window touches", () => {
    const earlier = new Date(NOW);
    earlier.setMonth(earlier.getMonth() - 1, 5);
    // Two month files, written newest first: the report still reads them oldest first.
    const index = load([claude({ requestId: "new" }), claude({ requestId: "old", at: earlier.getTime() })]);
    expect(apiEvents(index, "claude").map((r) => r.requestId)).toEqual(["studio:old", "studio:new"]);
  });
});

// Shared ledger fixtures for the gateway tests: rows as the gateway writes them, filed by UTC month.
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../src/parse";
import { GatewayIndex, type GatewayLedger, type GatewayVendor } from "../src/gateway";

export const NOW = Date.now();

export type Row = Record<string, unknown>;
export type Api = Extract<Event, { t: "api" }>;

// The month a row belongs to, in the gateway's own file naming: its UTC month.
export const monthKey = (ts: number): string => {
  const at = new Date(ts);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** A gateway state directory: each row filed under the month its `at` falls in. */
export function stateDir(rows: Row[]): string {
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

export const load = (rows: Row[]): GatewayLedger => GatewayIndex.load({ sinceMs: 0, stateDir: stateDir(rows) });

// A call the gateway billed on a Copilot subscription.
export const copilot = (over: Row = {}): Row => ({
  at: NOW, requestId: "req-1", responseId: "resp_gl_1", origin: "gateway",
  provider: "copilot", providerType: "copilot-subscription", model: "gpt-5.1-codex",
  session: true, inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 100,
  outputTokens: 50, reasoningTokens: 10, nanoAiu: 250_000_000, nanoAiuStatus: "complete", ...over,
});

// The same, on Claude's subscription, where the ledger reports no credit figure.
export const claude = (over: Row = {}): Row => ({
  at: NOW, requestId: "req-1", responseId: "resp_gl_1", origin: "gateway",
  provider: "claude", providerType: "claude-subscription", model: "claude-opus-5.5",
  session: true, inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 100,
  outputTokens: 50, reasoningTokens: 0, ...over,
});

export function apiEvents(index: GatewayLedger, vendor: GatewayVendor): Api[] {
  const files = index.files(vendor);
  if (!files.length) return [];
  expect(files[0]).toMatchObject({ key: `gateway:${vendor}`, project: "gateway", source: vendor });
  const events = [...files[0]!.events!()];
  expect(events[0]).toMatchObject({ t: "meta", project: "gateway" });
  return events.filter((e): e is Api => e.t === "api");
}

/** Runs `body` with these variables set (undefined removes one), then puts every one back. */
export function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return body(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

// An imported telemetry row, as the gateway writes it: no response id, no provider type, credits copied across.
export const telemetry = (over: Row = {}): Row => copilot({
  origin: "telemetry", providerType: undefined, responseId: "", session: false, ...over,
});


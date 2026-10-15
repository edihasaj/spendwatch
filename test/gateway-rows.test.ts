import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayIndex } from "../src/gateway";
import { apiEvents, claude, copilot, load, NOW, stateDir, telemetry, withEnv, type Row } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// Which ledger rows are read, which a rollout may match, and which the ledger bills.

describe("rows the ledger reads", () => {
  test("only names an origin it knows, whatever else the row says", () => {
    const index = load([copilot({ requestId: "odd", origin: "replayed", session: false, responseId: "" })]);
    expect(apiEvents(index, "copilot")).toEqual([]);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(false);
  });

  test("takes a gateway row's subscription from its type alone, never from the provider map", () => {
    const index = load([
      // No type: a gateway row cannot be placed, even under a provider name the map knows.
      claude({ requestId: "untyped", providerType: undefined, provider: "claude" }),
      // A type this ledger does not bill stays out, whatever the provider is called.
      copilot({ requestId: "codex", providerType: "codex-subscription", provider: "copilot" }),
    ]);
    expect([apiEvents(index, "claude"), apiEvents(index, "copilot")]).toEqual([[], []]);
  });

  test("lets an imported telemetry row's type win over its provider name", () => {
    const index = load([
      // The import writes the type of providers still configured; the name is any route id.
      telemetry({ requestId: "typed", provider: "work-claude", providerType: "claude-subscription", model: "claude-opus-5.5" }),
      // Typed as a subscription this ledger does not bill, under a name the map would place.
      telemetry({ requestId: "codex", provider: "claude", providerType: "codex-subscription" }),
    ]);
    expect(apiEvents(index, "claude").map((r) => r.requestId)).toEqual(["studio:typed"]);
    expect(apiEvents(index, "copilot")).toEqual([]);
  });

  test("does not mistake a name every object carries for a subscription", () => {
    const index = load([
      copilot({ requestId: "proto", providerType: "toString" }),
      telemetry({ requestId: "ctor", provider: "constructor" }),
    ]);
    expect([apiEvents(index, "claude"), apiEvents(index, "copilot")]).toEqual([[], []]);
  });

  test("skips a torn last line and keeps every row before it", () => {
    const dir = stateDir([copilot({ requestId: "whole" })]);
    const [file] = readdirSync(join(dir, "usage"));
    appendFileSync(join(dir, "usage", file!), JSON.stringify(copilot({ requestId: "torn" })).slice(0, 60));
    expect(apiEvents(GatewayIndex.load({ sinceMs: 0, stateDir: dir }), "copilot").map((r) => r.requestId)).toEqual(["studio:whole"]);
  });

  test("never prices a negative credit figure: it is no figure at all", () => {
    const [row] = apiEvents(load([copilot({ nanoAiu: -5_000_000 })]), "copilot");
    expect(row).toMatchObject({ model: "gpt-5.1-codex (unpriced)", costUsd: 0 });
  });

  test("bills rows oldest first, whatever order the file holds them in", () => {
    const index = load([
      telemetry({ requestId: "later", at: NOW + 10_000, session: true }),
      telemetry({ requestId: "earlier", at: NOW, session: true }),
    ]);
    // One call between the two: it takes the earlier row, as the transcript order would.
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW + 5_000)).toBe(true);
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:earlier"]);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW + 5_000)).toBe(true);
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:earlier", "studio:later"]);
  });
});

describe("a rollout record's response id", () => {
  test("is covered only by a billed gateway row with exactly that id", () => {
    const index = load([
      copilot({ requestId: "g1", responseId: "resp_gl_g1" }),
      copilot({ requestId: "plain", responseId: "resp_plain" }),
      telemetry({ requestId: "t1", responseId: "resp_gl_t1", session: true }),
    ]);
    expect(index.covers("resp_gl_g1")).toBe(true);
    expect(index.covers("resp_gl_g10")).toBe(false);
    expect(index.covers("resp_plain")).toBe(false); // the gateway did not bill it
    expect(index.covers("resp_gl_t1")).toBe(false); // telemetry rows are matched by claim, never by id
  });

  test("is not covered by a row the rollout already billed on an earlier watch tick", () => {
    const index = load([copilot({ requestId: "g1", responseId: "resp_gl_g1" })]);
    index.adopt([{ model: "anything", input: 0, output: 0, ts: 0, responseId: "resp_gl_g1" }]);
    expect(index.covers("resp_gl_g1")).toBe(false);
    expect(apiEvents(index, "copilot")).toEqual([]);
  });

  test("is not covered when this Mac has no ledger at all", () => {
    const empty = tempDir("spendwatch-no-usage-");
    const index = GatewayIndex.load({ sinceMs: 0, stateDir: empty });
    expect([index.present, index.covers("resp_gl_g1")]).toEqual([false, false]);
    mkdirSync(join(empty, "usage"));
    expect(GatewayIndex.load({ sinceMs: 0, stateDir: empty }).present).toBe(true);
  });
});

describe("a call a rollout billed before its row existed", () => {
  test("never takes a telemetry row: only the ledger's own billed rows stand for a rollout's bill", () => {
    const index = load([telemetry({ requestId: "history", session: true })]);
    index.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW }]);
    // The telemetry row is still there for the rollout that really holds its call.
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW)).toBe(true);
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:history"]);
  });

  test("never takes a row a rollout claimed: that call's rollout copy is gone, so only the row bills it", () => {
    const index = load([copilot({ requestId: "g1" })]);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    index.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW }]);
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:g1"]);
  });

  test("replays a rollout's decisions in order on a freshly loaded ledger", () => {
    const rows = [copilot({ requestId: "g1", responseId: "resp_gl_g1" }), copilot({ requestId: "g2", responseId: "resp_gl_g2", at: NOW + 2_000 })];
    const index = load(rows);
    // The first call claimed a row; the second was billed by the rollout before its row existed, moments later.
    index.replay([
      { kind: "claimed", model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW, gatewayRows: true },
      { kind: "billed", model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW + 100 },
    ]);
    // The nearer row was claimed, so the billed call takes the other: each call billed once, in one place.
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:g1"]);
  });
});

describe("the ledger files a window reads", () => {
  test("include the month before a window that starts on a UTC month boundary, for its last half minute", () => {
    // East of UTC, so a window bounded by local months would end October's file an hour too early.
    withEnv({ TZ: "Europe/Berlin" }, () => {
      expect(new Date(Date.UTC(2026, 10, 1)).getHours()).toBe(1);
      // A call at 23:59:50 on 31 October sits in October's file; its rollout line lands in November.
      const dir = stateDir([telemetry({ requestId: "edge", at: Date.UTC(2026, 9, 31, 23, 59, 50), session: true })]);
      const november = GatewayIndex.load({ sinceMs: Date.UTC(2026, 10, 1), stateDir: dir });
      expect(november.claim("gpt-5.1-codex", 1000, 50, Date.UTC(2026, 10, 1, 0, 0, 5))).toBe(true);
      // A window that starts later than the claim window reaches does not read October at all.
      expect(GatewayIndex.load({ sinceMs: Date.UTC(2026, 10, 1, 0, 1), stateDir: dir }).hasClaimable()).toBe(false);
    });
  });
});

describe("a large ledger", () => {
  // About a month of routed calls on a busy serving Mac, and more: grouping must stay linear.
  function bigLedger(rows: number): string {
    const dir = tempDir("spendwatch-big-ledger-");
    mkdirSync(join(dir, "usage"));
    const base = Date.UTC(2026, 9, 2);
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const isClaude = i % 2 === 0;
      lines.push(JSON.stringify({ v: 1, at: new Date(base + i * 20_000).toISOString(), host: "m5", requestId: `req-${i}`, responseId: `resp_gl_${i}`,
        provider: isClaude ? (i % 4 === 0 ? "claude" : "claude-work") : "copilot", providerType: isClaude ? "claude-subscription" : "copilot-subscription",
        model: isClaude ? "claude-opus-5-5" : "claude-opus-5.5", origin: "gateway", inputTokens: 1000 + i, cachedTokens: 500, cacheWriteTokens: 10, outputTokens: 50 } satisfies Row));
    }
    writeFileSync(join(dir, "usage", "usage-2026-10.jsonl"), lines.join("\n") + "\n");
    return dir;
  }

  test("groups 100,000 rows into account streams well under a second, and answers claims without scanning them", () => {
    const config = join(tempDir("spendwatch-big-config-"), "gateway.json");
    const dir = bigLedger(100_000);
    // A second Claude login, so rows are split across accounts as on a real serving Mac.
    writeFileSync(config, JSON.stringify({ version: 1, stateDirectory: dir, providers: [{ id: "claude-work", type: "claude-subscription", authDirectory: "claude-work" }] }));
    const index = withEnv({ SPENDWATCH_GATEWAY_CONFIG: config }, () => GatewayIndex.load({ sinceMs: Date.UTC(2026, 9, 1) }));
    const grouping = performance.now();
    let events = 0;
    for (const vendor of ["claude", "copilot"] as const) for (const file of index.files(vendor)) for (const _ of file.events!()) events++;
    const grouped = performance.now() - grouping;
    expect(events).toBe(3 + 2 * 100_000); // a meta per stream, then a routed mark and a call per row
    expect(grouped).toBeLessThan(1_000);
    const claiming = performance.now();
    for (let i = 0; i < 5_000; i++) index.claim("gpt-x", 7, 7, Date.UTC(2026, 9, 5) + i * 1_000);
    expect(performance.now() - claiming).toBeLessThan(250);
  }, 30_000);
});

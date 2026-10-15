import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { accountLabel } from "../src/copilot";
import { usageCost } from "../src/pricing";
import { GatewayIndex } from "../src/gateway";
import { claudeAccount } from "../src/sources";
import { apiEvents, claude, copilot, load, monthKey, NOW, stateDir, telemetry, withEnv, type Api, type Row } from "./ledger-fixtures";

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

  test("reads the UTC month file that holds the first hours of a local month east of UTC", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      // 01:00 on 1 October in Berlin is still September in UTC, where the gateway files it.
      const at = Date.UTC(2026, 8, 30, 23, 0, 0);
      const since = new Date(2026, 9, 1).getTime();
      expect(new Date(since).toISOString()).toBe("2026-09-30T22:00:00.000Z");
      const dir = stateDir([copilot({ at, requestId: "edge", responseId: "resp_gl_edge" })]);
      expect(readdirSync(join(dir, "usage"))).toEqual(["usage-2026-09.jsonl"]);
      const rows = apiEvents(GatewayIndex.load({ sinceMs: since, stateDir: dir }), "copilot");
      expect(rows.map((r) => r.requestId)).toEqual(["studio:edge"]);
      // The other side of the boundary: a window that starts after October's first minute — past the claim
      // window a rollout line may stand from its row — needs no September file.
      expect(apiEvents(GatewayIndex.load({ sinceMs: Date.UTC(2026, 9, 1, 0, 1, 0), stateDir: dir }), "copilot")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
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

  test("a token_count may take a billed gateway row once, and the ledger still bills it", () => {
    const index = load([copilot({ requestId: "g1", responseId: "resp_gl_g1" })]);
    // A line with a response id is decided by that id; only a count with nothing to compare asks for billed rows.
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW)).toBe(false);
    expect(index.claim("gpt-5.1-codex", 1000, 55, NOW, { gatewayRows: true })).toBe(false);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW + 31_000, { gatewayRows: true })).toBe(false);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(false); // one claim per row
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:g1"]);
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

describe("telemetry-origin Copilot rows", () => {
  test("keep the credits they carry, and say they came from telemetry", () => {
    const rows = apiEvents(load([
      telemetry({ requestId: "full", nanoAiu: 250_000_000, nanoAiuStatus: "complete" }),
      telemetry({ requestId: "part", nanoAiu: 100_000_000, nanoAiuStatus: "partial" }),
    ]), "copilot");
    expect(rows.map((r) => [r.requestId, r.model, r.costUsd])).toEqual([
      ["studio:full", "gpt-5.1-codex (telemetry backfill)", 0.0025],
      ["studio:part", "gpt-5.1-codex (telemetry backfill, partial credits)", 0.001],
    ]);
  });

  test("stay at $0 and unpriced only when no credits were recorded", () => {
    const [row] = apiEvents(load([telemetry({ nanoAiu: null, nanoAiuStatus: undefined })]), "copilot");
    expect(row!.model).toBe("gpt-5.1-codex (telemetry backfill, unpriced)");
    expect(row!.costUsd).toBe(0);
    // Zero credits is a recorded figure, not a missing one.
    const [free] = apiEvents(load([telemetry({ nanoAiu: 0 })]), "copilot");
    expect(free!.model).toBe("gpt-5.1-codex (telemetry backfill)");
    expect(free!.costUsd).toBe(0);
  });
});

describe("where the ledger lives", () => {
  /** A gateway config directory holding gateway.json, with a ledger at `<dir>/<state>` filled with one Claude row. */
  function installed(config: Record<string, unknown> | undefined, state: string, row: Row = claude()) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-config-")));
    const stateDir = join(dir, state);
    mkdirSync(join(stateDir, "usage"), { recursive: true });
    writeFileSync(join(stateDir, "usage", `usage-${monthKey(row.at as number)}.jsonl`), JSON.stringify({ v: 1, host: "studio", ...row }) + "\n");
    if (config) writeFileSync(join(dir, "gateway.json"), JSON.stringify(config));
    return { dir, file: join(dir, "gateway.json") };
  }
  const read = (file: string) => withEnv({ SPENDWATCH_GATEWAY_CONFIG: file, SPENDWATCH_GATEWAY_STATE: undefined }, () =>
    GatewayIndex.load({ sinceMs: 0 }));

  test("resolves a relative stateDirectory against the config directory, as the gateway does", () => {
    // `gateway init` writes ".state": spendwatch must not look for it in its own working directory.
    const { file } = installed({ version: 1, stateDirectory: ".state", providers: [] }, ".state");
    expect(apiEvents(read(file), "claude")).toHaveLength(1);
    const other = installed({ version: 1, stateDirectory: "ledgers/main", providers: [] }, "ledgers/main");
    expect(apiEvents(read(other.file), "claude")).toHaveLength(1);
  });

  test("defaults a missing stateDirectory key to .state beside the config", () => {
    const { file, dir } = installed({ version: 1, providers: [] }, ".state");
    const ledger = read(file);
    expect(ledger.stateDir).toBe(join(dir, ".state"));
    expect(apiEvents(ledger, "claude")).toHaveLength(1);
  });

  test("reads an absolute stateDirectory as written", () => {
    const elsewhere = stateDir([claude()]);
    const { file } = installed({ version: 1, stateDirectory: elsewhere, providers: [] }, ".state-unused");
    expect(read(file).stateDir).toBe(elsewhere);
  });

  test("falls back to the state directory `gateway setup` leaves only when there is no gateway.json", () => {
    const { file } = installed(undefined, "state");
    expect(apiEvents(read(file), "claude")).toHaveLength(1);
    // With a gateway.json the fallback is not consulted: its own default, .state, is empty here.
    const configured = installed({ version: 1, providers: [] }, "state");
    expect(apiEvents(read(configured.file), "claude")).toEqual([]);
  });

  test("SPENDWATCH_GATEWAY_STATE and an explicit root still win over the config", () => {
    const { file } = installed({ version: 1, stateDirectory: ".state", providers: [] }, ".state");
    const dir = stateDir([claude({ requestId: "other" })]);
    const ledger = withEnv({ SPENDWATCH_GATEWAY_CONFIG: file, SPENDWATCH_GATEWAY_STATE: dir }, () => GatewayIndex.load({ sinceMs: 0 }));
    expect(apiEvents(ledger, "claude").map((r) => r.requestId)).toEqual(["studio:other"]);
  });
});

describe("provider map for telemetry rows", () => {
  const qwen = (over: Row = {}): Row => telemetry({ requestId: "q", provider: "qwen", model: "qwen3.8", ...over });
  const withMap = (map: string | undefined, rows: Row[]) => {
    const dir = stateDir(rows);
    return withEnv({ SPENDWATCH_GATEWAY_PROVIDER_MAP: map }, () => GatewayIndex.load({ sinceMs: 0, stateDir: dir }));
  };

  test("ignores a provider name it was not told about", () => {
    const ledger = withMap(undefined, [qwen()]);
    expect([apiEvents(ledger, "claude"), apiEvents(ledger, "copilot")]).toEqual([[], []]);
  });

  test("retargets a provider name, in the comma form and the JSON form", () => {
    expect(apiEvents(withMap("qwen=claude", [qwen()]), "claude").map((r) => r.requestId)).toEqual(["studio:q"]);
    expect(apiEvents(withMap('{"qwen":"copilot"}', [qwen()]), "copilot").map((r) => r.requestId)).toEqual(["studio:q"]);
  });

  test("a name mapped to nothing is removed from the defaults", () => {
    const rows = [qwen({ provider: "copilot", requestId: "c" }), qwen({ provider: "claude", requestId: "k" })];
    const ledger = withMap("copilot=none", rows);
    expect(apiEvents(ledger, "copilot")).toEqual([]);
    expect(apiEvents(ledger, "claude").map((r) => r.requestId)).toEqual(["studio:k"]);
    // A value that is not JSON or pairs changes nothing.
    expect(apiEvents(withMap("{broken", rows), "copilot")).toHaveLength(1);
  });
});

describe("the account a Claude row is billed to", () => {
  function twoAccounts() {
    const config = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-claude-")));
    mkdirSync(join(config, "claude-work"), { recursive: true });
    writeFileSync(join(config, "claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
    mkdirSync(join(config, "claude-bare"), { recursive: true });
    const state = stateDir([
      claude({ requestId: "main", provider: "claude" }),
      claude({ requestId: "work", provider: "claude-work", responseId: "resp_gl_work" }),
      claude({ requestId: "bare", provider: "claude-bare", responseId: "resp_gl_bare" }),
    ]);
    writeFileSync(join(config, "gateway.json"), JSON.stringify({ version: 1, stateDirectory: state, providers: [
      { id: "claude", type: "claude-subscription" },
      { id: "claude-work", type: "claude-subscription", authDirectory: "claude-work" },
      { id: "claude-bare", type: "claude-subscription", authDirectory: "claude-bare" },
    ] }));
    return withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(config, "gateway.json"), SPENDWATCH_GATEWAY_STATE: undefined }, () => GatewayIndex.load({ sinceMs: 0 }));
  }

  test("follows the provider's own authDirectory instead of the default account", () => {
    const files = twoAccounts().files("claude");
    expect(files.map((f) => f.account).sort()).toEqual([claudeAccount(), "claude-bare", "work@example.com"].sort());
    const byAccount = Object.fromEntries(files.map((f) => [f.account, [...f.events!()].filter((e) => e.t === "api").map((e) => (e as Api).requestId)]));
    expect(byAccount["work@example.com"]).toEqual(["studio:work"]);
    expect(byAccount["claude-bare"]).toEqual(["studio:bare"]);
    expect(byAccount[claudeAccount()]).toEqual(["studio:main"]);
    // One stream per account, and the usual account keeps the plain key.
    expect(new Set(files.map((f) => f.key)).size).toBe(3);
    expect(files.find((f) => f.account === claudeAccount())!.key).toBe("gateway:claude");
  });
});

describe("the account a Copilot row is billed to", () => {
  function twoLogins() {
    const config = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-copilot-")));
    // A COPILOT_HOME the CLI signed in under: its config.json opens with comment lines, which JSON does not allow.
    mkdirSync(join(config, "copilot-work"), { recursive: true });
    writeFileSync(join(config, "copilot-work", "config.json"), "// User settings belong in settings.json.\n// This file is managed automatically.\n"
      + JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octo-work" }, loggedInUsers: [] }, null, 2));
    mkdirSync(join(config, "copilot-bare"), { recursive: true });
    const state = stateDir([
      copilot({ requestId: "main", provider: "copilot" }),
      copilot({ requestId: "work", provider: "copilot-work", responseId: "resp_gl_work" }),
      copilot({ requestId: "bare", provider: "copilot-bare", responseId: "resp_gl_bare" }),
    ]);
    writeFileSync(join(config, "gateway.json"), JSON.stringify({ version: 1, stateDirectory: state, providers: [
      { id: "copilot", type: "copilot-subscription" },
      { id: "copilot-work", type: "copilot-subscription", authDirectory: "copilot-work" },
      { id: "copilot-bare", type: "copilot-subscription", authDirectory: "copilot-bare" },
    ] }));
    return withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(config, "gateway.json"), SPENDWATCH_GATEWAY_STATE: undefined }, () => GatewayIndex.load({ sinceMs: 0 }));
  }

  test("follows the provider's own authDirectory, its COPILOT_HOME, instead of the default account", () => {
    const files = twoLogins().files("copilot");
    expect(files.map((f) => f.account).sort()).toEqual([accountLabel(), "copilot-bare", "octo-work"].sort());
    const byAccount = Object.fromEntries(files.map((f) => [f.account, [...f.events!()].filter((e) => e.t === "api").map((e) => (e as Api).requestId)]));
    expect(byAccount["octo-work"]).toEqual(["studio:work"]);
    // No login recorded: named after the directory, never folded into the default account.
    expect(byAccount["copilot-bare"]).toEqual(["studio:bare"]);
    expect(byAccount[accountLabel()]).toEqual(["studio:main"]);
    expect(files.find((f) => f.account === "octo-work")!.key).toBe("gateway:copilot:octo-work");
    expect(files.find((f) => f.account === accountLabel())!.key).toBe("gateway:copilot");
  });
});

describe("a call a rollout billed before its row existed", () => {
  test("is not billed again by the row that arrives later", () => {
    const index = load([copilot({ requestId: "g1", responseId: "resp_gl_g1" }), copilot({ requestId: "g2", responseId: "resp_gl_g2", at: NOW + 5_000 })]);
    index.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW + 4_000 }]);
    // The nearer row is the one the rollout billed; one row per call.
    expect(apiEvents(index, "copilot").map((r) => r.requestId)).toEqual(["studio:g1"]);
    index.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW }]);
    expect(apiEvents(index, "copilot")).toEqual([]);
    // It cannot be claimed any more either, and a call with no such row is left alone.
    expect(index.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(false);
  });

  test("leaves rows that differ in model, tokens or time", () => {
    const index = load([copilot()]);
    index.adopt([
      { model: "other", input: 1000, output: 50, ts: NOW },
      { model: "gpt-5.1-codex", input: 999, output: 50, ts: NOW },
      { model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW + 31_000 },
    ]);
    expect(apiEvents(index, "copilot")).toHaveLength(1);
  });
});

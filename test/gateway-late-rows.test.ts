import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { watchPeriod } from "../src/build";
import { GatewayIndex } from "../src/gateway";
import { IncrementalReader } from "../src/scan";
import { discover, pollOrder } from "../src/sources";
import { apiEvents, claude, copilot, NOW, stateDir, telemetry, withEnv, type Row } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// The gateway appends a call's ledger row just after the response ends, so a row can land after the ledger was
// read and before (or while) the rollouts are. These are the ways such a row is taken in, or left out.
const marked = (id: string) => `resp_gl_${id}`;
const line = (v: unknown) => JSON.stringify(v) + "\n";
const iso = (ms: number) => new Date(ms).toISOString();
const meta = (at: number, id: string) => line({ timestamp: iso(at), type: "session_meta", payload: { id, model_provider: "subscription_gateway" } }) + line({ timestamp: iso(at), type: "turn_context", payload: { model: "copilot/gpt" } });
const record = (id: string, at: number, input = 100) => line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 } } });
const row = (id: string, at: number, input = 100) => JSON.stringify({ v: 1, at: iso(at), host: "studio", requestId: id, responseId: marked(id), providerType: "copilot-subscription", provider: "copilot", model: "copilot/gpt", status: "completed", origin: "gateway", inputTokens: input, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete" }) + "\n";

const savedConfig = process.env.SPENDWATCH_CONFIG;
afterEach(() => { setSystemTime(); if (savedConfig === undefined) delete process.env.SPENDWATCH_CONFIG; else process.env.SPENDWATCH_CONFIG = savedConfig; });

/** A Mac with a ledger holding one Copilot call (g1) and a Codex rollout that has not recorded anything yet. */
function world() {
  const root = tempDir("spendwatch-late-");
  const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now();
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  writeFileSync(ledger, row("g1", now - 50_000));
  writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "nope.db") }, { agent: "gateway", path: state }]));
  process.env.SPENDWATCH_CONFIG = join(root, "config.json");
  const rollout = join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  writeFileSync(rollout, meta(now - 60_000, "A"));
  return { now, ledger, rollout, sinceMs: now - 86_400_000 };
}

/** Reads the way `build` does: every source's files in poll order, one fold per source. */
function readAll(statuses: ReturnType<typeof discover>, period = watchPeriod(Date.now(), 1)) {
  const sinks = new Map<string, Aggregator>();
  for (const status of pollOrder(statuses)) {
    const sink = new Aggregator(period);
    sinks.set(status.id, sink);
    const reader = new IncrementalReader(sink);
    for (const file of status.files) { reader.poll(file); reader.flush(file); }
  }
  return sinks;
}

describe("a row that lands while the rollouts are read", () => {
  /** Codex's report of a read in which g3's row lands after the ledger was loaded and before the rollout is read. */
  function codexReport(agents: Set<string> | undefined) {
    const w = world();
    appendFileSync(w.rollout, record(marked("g3"), w.now - 1000));
    const statuses = discover({ sinceMs: w.sinceMs, agents });
    appendFileSync(w.ledger, row("g3", w.now - 1000));
    return readAll(statuses, watchPeriod(w.now, 1)).get("codex")!.report();
  }

  test("is the ledger's to bill, whichever agents the run was limited to", () => {
    const full = codexReport(undefined);
    const codexOnly = codexReport(new Set(["codex"]));
    // The row is in the ledger, so Codex drops its copy: no "(gateway-routed, not in this Mac's ledger)" bill.
    expect(full.models).toEqual([]);
    expect(codexOnly.models).toEqual(full.models);
    expect(codexOnly.apiCalls).toBe(full.apiCalls);
    expect(codexOnly.gatewayUnconfirmed ?? []).toEqual(full.gatewayUnconfirmed ?? []);
  });

  test("is found by a read that takes longer than the claim window, though the rollout line was billable meanwhile", () => {
    const w = world();
    const statuses = discover({ sinceMs: w.sinceMs }); // the ledger is loaded here
    // The read goes on for 50 s (other rollouts); meanwhile the call ends at +10 s and the gateway appends its row.
    appendFileSync(w.rollout, record(marked("g3"), w.now + 10_000));
    appendFileSync(w.ledger, row("g3", w.now + 10_000));
    setSystemTime(new Date(w.now + 50_000));
    const sinks = readAll(statuses, watchPeriod(w.now, 1));
    const [codex, copilot] = [sinks.get("codex")!.report(), sinks.get("copilot")!.report()];
    expect(codex.apiCalls + copilot.apiCalls).toBe(2);
    expect(codex.models).toEqual([]);
    expect(copilot.gatewayBilled?.sort()).toEqual(["g1", "g3"]);
  });

  test("still bills a call from the rollout when a slow read finds no row for it", () => {
    const w = world();
    const statuses = discover({ sinceMs: w.sinceMs });
    appendFileSync(w.rollout, record(marked("g3"), w.now + 10_000));
    setSystemTime(new Date(w.now + 50_000));
    const sinks = readAll(statuses, watchPeriod(w.now, 1));
    expect(sinks.get("codex")!.report().models.map((m) => m.model)).toEqual(["copilot/gpt (gateway-routed, not in this Mac's ledger)"]);
    expect(sinks.get("copilot")!.report().gatewayBilled).toEqual(["g1"]);
  });
});

describe("a row that lands for an account the ledger had no stream for", () => {
  // A second Copilot login: its provider names a COPILOT_HOME, and no row of it was in the ledger when it was read.
  function twoLogins(...before: Row[]) {
    const config = realpathSync(tempDir("spendwatch-late-accounts-"));
    mkdirSync(join(config, "copilot-work"), { recursive: true });
    writeFileSync(join(config, "copilot-work", "config.json"), JSON.stringify({ lastLoggedInUser: { login: "octo-work" } }));
    const dir = stateDir([copilot({ requestId: "main", provider: "copilot", at: NOW - 10_000 }), ...before]);
    writeFileSync(join(config, "gateway.json"), JSON.stringify({ version: 1, stateDirectory: dir, providers: [
      { id: "copilot", type: "copilot-subscription" },
      { id: "copilot-work", type: "copilot-subscription", authDirectory: "copilot-work" },
    ] }));
    const ledger = withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(config, "gateway.json"), SPENDWATCH_GATEWAY_STATE: undefined }, () => GatewayIndex.load({ sinceMs: NOW - 86_400_000 }));
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    const land = (...later: Row[]) => {
      appendFileSync(file, later.map((r) => JSON.stringify({ v: 1, host: "studio", ...r }) + "\n").join(""));
      ledger.refresh();
    };
    return { ledger, land };
  }

  test("is neither billed nor covered: no stream would bill it, so its rollout copy must stay", () => {
    const { ledger, land } = twoLogins();
    expect(ledger.files("copilot").map((f) => f.account).length).toBe(1);
    land(copilot({ requestId: "work", provider: "copilot-work", responseId: marked("work"), at: NOW - 5000 }));
    expect(ledger.covers(marked("work"))).toBe(false);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:main"]);
  });

  test("does not replace another account's telemetry echo of the same call: the echo's account does not bill it", () => {
    const { ledger, land } = twoLogins(telemetry({ requestId: "call", provider: "copilot", session: true, at: NOW - 5000 }));
    ledger.files("copilot");
    // The same host and request id, but billed by the work login: the row is not the echo's own, so it takes no place in the main stream.
    land(copilot({ requestId: "call", provider: "copilot-work", responseId: marked("call"), at: NOW - 5000 }));
    expect(ledger.covers(marked("call"))).toBe(false);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:main"]);
  });

  test("is billed and covered when it belongs to an account that has a stream", () => {
    const { ledger, land } = twoLogins();
    ledger.files("copilot");
    land(copilot({ requestId: "main2", provider: "copilot", responseId: marked("main2"), at: NOW - 5000 }));
    expect(ledger.covers(marked("main2"))).toBe(true);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:main", "studio:main2"]);
  });
});

describe("the gateway's own row for a call the ledger holds only as a telemetry echo", () => {
  const open = (...rows: Row[]) => {
    const dir = stateDir(rows);
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    ledger.files("copilot");
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    const land = (...later: Row[]) => { appendFileSync(file, later.map((r) => JSON.stringify({ v: 1, host: "studio", ...r }) + "\n").join("")); ledger.refresh(); };
    return { ledger, land, models: () => apiEvents(ledger, "copilot").map((e) => [e.requestId, e.model, e.gateway?.id]) };
  };
  const echo = () => telemetry({ requestId: "call", session: true, at: NOW - 5000 });
  const own = (over: Row = {}) => copilot({ requestId: "call", responseId: marked("call"), at: NOW - 5000, ...over });

  test("replaces the echo, as a fresh load would, and bills the call once", () => {
    const { ledger, land, models } = open(echo());
    expect(models()).toEqual([]); // a telemetry row with a session counts only once a rollout claims it
    land(own());
    expect(models()).toEqual([["studio:call", "gpt-5.1-codex", "call"]]);
    expect(ledger.covers(marked("call"))).toBe(true);
    // The echo can no longer be claimed: the call is the gateway's row now.
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW - 5000)).toBe(false);
  });

  test("keeps the claim a rollout already made on the echo", () => {
    const { ledger, land, models } = open(echo());
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW - 5000)).toBe(true);
    expect(models()).toEqual([["studio:call", "gpt-5.1-codex (telemetry backfill)", undefined]]);
    land(own());
    // The rollout dropped its copy on the strength of the claim: the gateway's row bills the call, once.
    expect(models()).toEqual([["studio:call", "gpt-5.1-codex", "call"]]);
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW - 5000, { gatewayRows: true })).toBe(false);
  });

  test("leaves a claimed echo alone when the new row is one the gateway does not bill", () => {
    const { ledger, land, models } = open(echo());
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW - 5000)).toBe(true);
    // An unmarked gateway row carries no charge, so the echo the rollout's claim stands on keeps billing the call.
    land(own({ responseId: "resp_plain" }));
    expect(models()).toEqual([["studio:call", "gpt-5.1-codex (telemetry backfill)", undefined]]);
  });

  test("ignores a second row for a call the gateway already billed, and a telemetry echo of it", () => {
    const { land, models } = open(own());
    land(echo(), own({ inputTokens: 5 }));
    expect(models()).toEqual([["studio:call", "gpt-5.1-codex", "call"]]);
  });

  test("does not move a call to another vendor", () => {
    const { land, models } = open(echo());
    land(claude({ requestId: "call", responseId: marked("call"), at: NOW - 5000 }));
    expect(models()).toEqual([]);
  });
});

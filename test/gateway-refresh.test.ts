import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { pollWatched, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { GatewayIndex } from "../src/gateway";
import { IncrementalReader } from "../src/scan";
import { discover, pollOrder } from "../src/sources";
import { apiEvents, copilot, NOW, stateDir } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// One routed call must be billed once in one read, however the gateway's ledger row and the rollout lines interleave:
// the gateway appends a row just after the response ends, so a row can land between the reads of two rollouts.
const marked = (id: string) => `resp_gl_${id}`;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const iso = (ms: number) => new Date(ms).toISOString();
const meta = (at: number, id: string) => line({ timestamp: iso(at), type: "session_meta", payload: { id, model_provider: "subscription_gateway" } })
  + line({ timestamp: iso(at), type: "turn_context", payload: { model: "copilot/gpt" } });
const record = (id: string, at: number, input = 100) => line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 } } });
const count = (at: number, input: number, total: number) => line({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 }, total_token_usage: { input_tokens: total, output_tokens: 10 } } } });
const row = (id: string, at: number, input = 100) => JSON.stringify({ v: 1, at: iso(at), host: "studio", requestId: id, responseId: marked(id), providerType: "copilot-subscription", provider: "copilot", model: "copilot/gpt", status: "completed", origin: "gateway", inputTokens: input, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete" }) + "\n";

const savedConfig = process.env.SPENDWATCH_CONFIG;
afterEach(() => { if (savedConfig === undefined) delete process.env.SPENDWATCH_CONFIG; else process.env.SPENDWATCH_CONFIG = savedConfig; });

/** A Mac with a gateway ledger holding one Copilot call (g1) and room for two rollouts. */
function world() {
  const root = tempDir("spendwatch-refresh-");
  const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now();
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  writeFileSync(ledger, row("g1", now - 50_000));
  writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "nope.db") }, { agent: "gateway", path: state }]));
  process.env.SPENDWATCH_CONFIG = join(root, "config.json");
  const rollout = (letter: "a" | "b", body: string) => writeFileSync(join(sessions, `rollout-2026-10-15T10-00-00-${letter.repeat(8)}-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl`), body);
  return { now, ledger, rollout, options: { top: 5 } as BuildOptions, sinceMs: now - 86_400_000 };
}

/** Reads the way `build` does, except that `between` runs after the first rollout is read and before the second. */
function readWithRowArriving(w: ReturnType<typeof world>, between: () => void): Built {
  const statuses = discover({ sinceMs: w.sinceMs });
  const period = watchPeriod(w.now, 1);
  const readers = new Map(statuses.map((status) => {
    const sink = new Aggregator(period);
    return [status.id, { reader: new IncrementalReader(sink), sink, status }] as const;
  }));
  let codexRead = 0;
  for (const status of pollOrder(statuses)) {
    const { reader } = readers.get(status.id)!;
    const files = status.id === "codex" ? [...status.files].sort((x, y) => x.path.localeCompare(y.path)) : status.files;
    for (const file of files) {
      if (status.id === "codex" && codexRead++ === 1) between();
      reader.poll(file);
      reader.flush(file);
    }
  }
  return { statuses, readers, claims: new IncrementalReader(new Aggregator()), periods: [period] };
}

const reportOf = (built: Built, id: string) => (built.readers.get(id)!.sink as Aggregator).report();
/** Which calls each side billed: the ledger's by gateway id, the rollouts' kept marked calls by the same id. */
const billed = (built: Built) => ({ ledger: [...(reportOf(built, "copilot").gatewayBilled ?? [])].sort(), rollouts: (reportOf(built, "codex").gatewayUnconfirmed ?? []).map((call) => call.id).sort() });

describe("a row that lands between two rollouts of one read", () => {
  test("never bills a marked call the first rollout already billed", () => {
    const w = world();
    // Rollout A ends with g3 and no row for it; rollout B ends later, with a call newer than the ledger read.
    w.rollout("a", meta(w.now - 60_000, "A") + record(marked("g3"), w.now - 1000));
    w.rollout("b", meta(w.now - 60_000, "B") + record(marked("g4"), w.now - 500, 777));
    const built = readWithRowArriving(w, () => appendFileSync(w.ledger, row("g3", w.now - 1000)));
    expect(billed(built)).toEqual({ ledger: ["g1"], rollouts: ["g3", "g4"] });
    expect(reportOf(built, "copilot").apiCalls + reportOf(built, "codex").apiCalls).toBe(3);
  });

  test("never bills a token_count call the first rollout already billed", () => {
    const w = world();
    // Neither rollout records a response id: nothing but model, tokens and time can pair g3 with its row.
    w.rollout("a", meta(w.now - 60_000, "A") + count(w.now - 1000, 100, 100));
    w.rollout("b", meta(w.now - 60_000, "B") + count(w.now - 500, 777, 777));
    const built = readWithRowArriving(w, () => appendFileSync(w.ledger, row("g3", w.now - 1000)));
    expect(reportOf(built, "copilot").gatewayBilled).toEqual(["g1"]);
    expect(reportOf(built, "codex").apiCalls).toBe(2);
  });

  test("still lets the ledger bill a row no rollout of the read billed", () => {
    const w = world();
    w.rollout("a", meta(w.now - 60_000, "A") + record(marked("g2"), w.now - 3000));
    w.rollout("b", meta(w.now - 60_000, "B") + record(marked("g4"), w.now - 500, 777));
    // Rollout A billed g2, whose row never comes. g3's row lands with no rollout that billed it, so the ledger bills it.
    const built = readWithRowArriving(w, () => appendFileSync(w.ledger, row("g3", w.now - 1000, 555)));
    expect(billed(built).ledger).toEqual(["g1", "g3"]);
    expect(billed(built).rollouts).toEqual(["g2", "g4"]);
  });

  test("keeps the call billed once on the watch ticks that follow", () => {
    const w = world();
    w.rollout("a", meta(w.now - 60_000, "A") + record(marked("g3"), w.now - 1000));
    w.rollout("b", meta(w.now - 60_000, "B") + record(marked("g4"), w.now - 500, 777));
    const built = readWithRowArriving(w, () => appendFileSync(w.ledger, row("g3", w.now - 1000)));
    const before = billed(built);
    for (let tick = 0; tick < 3; tick++) pollWatched(built, discover({ sinceMs: w.sinceMs }), w.options);
    expect(billed(built)).toEqual(before);
    expect(reportOf(built, "copilot").apiCalls + reportOf(built, "codex").apiCalls).toBe(3);
  });
});

describe("a ledger that is told what the rollouts billed", () => {
  const request = (id: string, over: Record<string, unknown> = {}) => copilot({ requestId: id, responseId: marked(id), at: NOW - 10_000, ...over });
  // An unrelated call with other tokens, so a call matched by usage cannot take it.
  const other = () => request("g1", { inputTokens: 123 });
  const load = (...rows: Array<Record<string, unknown>>) => {
    const dir = stateDir(rows);
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    ledger.files("copilot");
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    const land = (...later: Array<Record<string, unknown>>) => appendFileSync(file, later.map((r) => JSON.stringify({ v: 1, host: "studio", ...r }) + "\n").join(""));
    return { ledger, land, ids: () => apiEvents(ledger, "copilot").map((e) => e.gateway?.id) };
  };

  test("marks the row of a billed call that lands after it was adopted, by response id", () => {
    const { ledger, land, ids } = load(other());
    ledger.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000, responseId: marked("g3") }]);
    land(request("g3", { at: NOW - 5000 }));
    ledger.refresh();
    expect(ids()).toEqual(["g1"]);
  });

  test("marks the nearest billed row of a call with no response id that lands after it was adopted", () => {
    const { ledger, land, ids } = load(other());
    ledger.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000 }]);
    land(request("g3", { at: NOW - 5000 }));
    ledger.refresh();
    expect(ids()).toEqual(["g1"]);
  });

  test("bills a row that no adopted call matches", () => {
    const { ledger, land, ids } = load(other());
    ledger.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000, responseId: marked("g3") }]);
    land(request("g4", { at: NOW - 4000 }));
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g4"]);
  });

  test("one adopted call marks one row, however often it is offered or the ledger refreshes", () => {
    const { ledger, land, ids } = load(other());
    const call = { model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000 };
    ledger.adopt([call]);
    ledger.adopt([call]);
    land(request("g3", { at: NOW - 5000 }));
    ledger.refresh();
    // A second row for another call with the same usage, a moment later: no rollout billed that one.
    land(request("g5", { at: NOW - 4000 }));
    ledger.refresh();
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g5"]);
  });

  test("offering the same call twice marks one row", () => {
    const { ledger, ids } = load(other(), request("g3", { at: NOW - 5000 }), request("g4", { at: NOW - 4900 }));
    const call = { model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000 };
    ledger.adopt([call]);
    ledger.adopt([call]);
    expect(ids()).toEqual(["g1", "g4"]);
  });

  test("a call that already matched its row marks no later row", () => {
    const { ledger, land, ids } = load(other(), request("g3", { at: NOW - 5000 }));
    ledger.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW - 5000 }]);
    // g3 is nearest to the call: it is taken now, so the rows that land later are the ledger's.
    land(request("g4", { at: NOW - 4900 }));
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g4"]);
  });
});

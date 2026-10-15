import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Aggregator } from "../src/aggregate";
import { build, pollWatched, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import { CLAIM_WINDOW_MS, GatewayIndex } from "../src/gateway";
import { discover } from "../src/sources";
import { copilotRow, iso, routedLine } from "./fuzz-world";
import { apiEvents, copilot, load, NOW, stateDir, telemetry } from "./ledger-fixtures";
import { tempDir } from "./tmp";

afterEach(() => { setSystemTime(); delete process.env.SPENDWATCH_CONFIG; });

describe("which row a claim takes", () => {
  const claim = (ledger: ReturnType<typeof load>, ts: number, options: { gatewayRows?: boolean } = {}) => {
    const keys: string[] = [];
    return { keys, taken: ledger.claim("gpt-5.1-codex", 1000, 50, ts, { ...options, onClaim: (key) => keys.push(key) }) };
  };

  test("the row nearest in time, not the oldest one in the window", () => {
    const ledger = load([
      telemetry({ requestId: "far", at: NOW - 25_000, session: true }),
      telemetry({ requestId: "near", at: NOW + 1_000, session: true }),
    ]);
    expect(claim(ledger, NOW)).toEqual({ taken: true, keys: ["studio:near"] });
  });

  test("a claim moves to another alike row when that gives a later call a row", () => {
    const ledger = load([
      telemetry({ requestId: "far", at: NOW - 25_000, session: true }),
      telemetry({ requestId: "near", at: NOW + 1_000, session: true }),
    ]);
    const first = claim(ledger, NOW);
    // 45 s from the far row, the second call can only stand on the near one, so the first steps over to the far one.
    const second = claim(ledger, NOW + 20_000);
    expect(second).toEqual({ taken: true, keys: ["studio:near"] });
    expect(first.keys).toEqual(["studio:near", "studio:far"]);
    expect(claim(ledger, NOW + 20_000).taken).toBe(false); // two rows, two claims
  });

  test("moves a chain of claims, each only as far as its own window reaches", () => {
    const ledger = load([
      telemetry({ requestId: "a", at: NOW, session: true }),
      telemetry({ requestId: "b", at: NOW + 25_000, session: true }),
      telemetry({ requestId: "c", at: NOW + 50_000, session: true }),
    ]);
    const first = claim(ledger, NOW + 12_000);  // a is 12 s away, b 13 s: a
    const second = claim(ledger, NOW + 26_000); // b is 1 s away: b
    // At -4 s only a and b are in reach, and both are taken. The first claim can step to b if the second steps to c.
    const third = claim(ledger, NOW - 4_000);
    expect(third).toEqual({ taken: true, keys: ["studio:a"] });
    expect(first.keys).toEqual(["studio:a", "studio:b"]);
    expect(second.keys).toEqual(["studio:b", "studio:c"]);
    // Three rows, three claims.
    expect(claim(ledger, NOW + 20_000).taken).toBe(false);
  });

  test("leaves a claim where it is when no row outside its window can take it in", () => {
    const ledger = load([telemetry({ requestId: "only", at: NOW, session: true })]);
    expect(claim(ledger, NOW).taken).toBe(true);
    expect(claim(ledger, NOW + 40_000).taken).toBe(false);
    // The claim that holds the row still holds it.
    expect(claim(ledger, NOW + 1_000).taken).toBe(false);
  });
});

describe("a call billed by its rollout takes a row a claim can leave", () => {
  const rows = () => load([
    copilot({ requestId: "billed", responseId: "resp_gl_billed", at: NOW }),
    telemetry({ requestId: "echo", at: NOW + 5_000, session: true }),
  ]);

  test("the claim steps to the telemetry row, and the stream bills that row instead, under a new version", () => {
    const ledger = rows();
    ledger.files("copilot");
    // A token_count takes the nearest row, the billed one, and the ledger bills it.
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW + 2_000, { gatewayRows: true })).toBe(true);
    const stream = ledger.files("copilot")[0]!;
    const before = stream.version!();
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:billed"]);
    // A call its rollout billed (no row had come) belongs on the billed row; the claim steps over to the echo.
    ledger.adopt([{ model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW }]);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:echo"]);
    // One row bills before and after, but not the same one: the reader has to fold the stream again.
    expect(stream.version!()).not.toBe(before);
  });
});

describe("a call billed under a marked response id", () => {
  const marked = { model: "gpt-5.1-codex", input: 1000, output: 50, ts: NOW, responseId: "resp_gl_x" };

  test("takes its own row from a claim that has another alike row to stand on", () => {
    const ledger = load([copilot({ requestId: "x", responseId: "resp_gl_x", at: NOW }), copilot({ requestId: "y", responseId: "resp_gl_y", at: NOW + 3_000 })]);
    const keys: string[] = [];
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true, onClaim: (key) => keys.push(key) })).toBe(true);
    ledger.adopt([marked]);
    // The token_count was dropped on the strength of a row; it stands on y now, and x is the bill the rollout made.
    expect(keys).toEqual(["studio:x", "studio:y"]);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:y"]);
  });

  test("is the same call as a record already dropped on the strength of that row (a fork copies its parent's): one bill", () => {
    const ledger = load([copilot({ requestId: "x", responseId: "resp_gl_x", at: NOW })]);
    expect(ledger.vouch("resp_gl_x")).toBe(true);
    expect(ledger.vouch("resp_gl_x")).toBe(true);
    // The other copy was billed by its rollout, because it was read before the row landed: that bill is the call's only one.
    ledger.adopt([marked]);
    expect(apiEvents(ledger, "copilot")).toEqual([]);
  });

  test("leaves a row alone that a claim stands on and cannot leave: that claim's call has no other bill", () => {
    const ledger = load([copilot({ requestId: "x", responseId: "resp_gl_x", at: NOW })]);
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    ledger.adopt([marked]);
    expect(apiEvents(ledger, "copilot").map((e) => e.requestId)).toEqual(["studio:x"]);
  });
});

describe("a routed call newer than the ledger read", () => {
  test("asks the ledger for the rows appended since before it claims one: its own row, not a neighbour's", () => {
    const dir = stateDir([copilot({ requestId: "neighbour", responseId: "resp_gl_neighbour", at: NOW - CLAIM_WINDOW_MS })]);
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    // The gateway appends the call's row after the ledger was read, and before the rollout line is.
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    appendFileSync(file, JSON.stringify({ v: 1, host: "studio", ...copilot({ requestId: "own", responseId: "resp_gl_own", at: NOW + 200 }) }) + "\n");
    const ctx = newCodexCtx(ledger);
    const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 };
    const lines = [
      { timestamp: iso(NOW - 5_000), type: "session_meta", payload: { id: "s", model_provider: "subscription_gateway", model: "gpt-5.1-codex" } },
      { timestamp: iso(NOW), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
    ];
    for (const text of lines) [...parseCodexLine(JSON.stringify(text), ctx)];
    // Without the rows appended since, the only row to take is the neighbour's, and its own call would be left without one.
    expect(ctx.decisions).toMatchObject([{ kind: "claimed", key: "studio:own" }]);
  });
});

describe("replaying decisions on a reloaded ledger", () => {
  const decision = (key: string, ts: number) => ({ seq: 0, kind: "claimed" as const, model: "gpt-5.1-codex", input: 1000, output: 50, ts, gatewayRows: false, key });

  test("a claim takes back the row it held, not the one nearest to its time now", () => {
    const ledger = load([telemetry({ requestId: "held", at: NOW, session: true }), telemetry({ requestId: "closer", at: NOW + 9_000, session: true })]);
    ledger.replay([decision("studio:held", NOW + 8_000)]);
    const taken: string[] = [];
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW + 8_000, { onClaim: (key) => taken.push(key) })).toBe(true);
    // The replayed claim held the older row, so the closer one is free for the call that asks now.
    expect(taken).toEqual(["studio:closer"]);
  });

  test("all that were handed over are applied together, in the order they were made, before the next claim", () => {
    const ledger = load([telemetry({ requestId: "first", at: NOW, session: true }), telemetry({ requestId: "second", at: NOW + 1_000, session: true })]);
    // Two rollouts' decisions, handed over in the wrong order, neither with a row to go back to.
    const earlier = { ...decision("", NOW + 300), seq: 5 };
    const later = { ...decision("", NOW + 400), seq: 6 };
    ledger.replay([later]);
    ledger.replay([earlier]);
    expect(ledger.claim("gpt-5.1-codex", 1000, 50, NOW)).toBe(false);
    // Both are nearest to the first row; the earlier decision took it, and the later one took the other.
    expect([earlier.key, later.key]).toEqual(["studio:first", "studio:second"]);
  });
});

/** Two watched rollouts that route through the gateway; calls are bare token_counts, all alike. */
function twoRollouts() {
  const root = tempDir("spendwatch-claim-order-");
  const start = Date.now();
  setSystemTime(new Date(start));
  const sessions = join(root, "codex");
  const state = join(root, "state");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(state, "usage"), { recursive: true });
  const ledger = join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`);
  writeFileSync(ledger, copilotRow("seed", start - 100_000, 7));
  const rollouts = [0, 1].map((k) => join(sessions, `rollout-2026-10-15T10-00-0${k}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${k}.jsonl`));
  rollouts.forEach((path, k) => writeFileSync(path,
    JSON.stringify({ timestamp: iso(start - 90_000), type: "session_meta", payload: { id: `s${k}`, model_provider: "subscription_gateway" } }) + "\n"
    + JSON.stringify({ timestamp: iso(start - 90_000), type: "turn_context", payload: { model: "copilot/gpt" } }) + "\n"));
  writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "none.db") }, { agent: "gateway", path: state }]));
  process.env.SPENDWATCH_CONFIG = join(root, "config.json");
  const options: BuildOptions = { top: 5 };
  let built: Built | undefined;
  const tick = (seconds: number) => {
    setSystemTime(new Date(start + seconds * 1000));
    if (!built) built = build(options, [watchPeriod(start, 1)], { watching: true });
    else pollWatched(built, discover({ sinceMs: start - 86_400_000 }), options);
  };
  const calls = (source: string): number => (built!.readers.get(source)!.sink as Aggregator).report().apiCalls;
  return {
    start, tick, calls, options,
    discover: () => discover({ sinceMs: start - 86_400_000 }),
    get built() { return built!; },
    telemetryRow: (id: string, at: number) => appendFileSync(ledger, JSON.stringify({ ...JSON.parse(copilotRow(id, at, 100)), origin: "telemetry", responseId: "", session: true }) + "\n"),
    row: (id: string, at: number) => appendFileSync(ledger, copilotRow(id, at, 100)),
    write: (rollout: number, at: number, total: number) => appendFileSync(rollouts[rollout]!, routedLine("counts", "n/a", at, 100, total) + "\n"),
  };
}

describe("watch, with a rollout's new call and another rollout's earlier claim", () => {
  // The rollout read first must not take the row the other one's earlier call held: that call's copy is already
  // gone, so the row bills it, and the new call (which has no row here) has to be billed from its rollout.
  for (const [holder, newcomer] of [[1, 0], [0, 1]] as const) {
    test(`rollout ${newcomer} writes a call after rollout ${holder} claimed the only row near it`, () => {
      const w = twoRollouts();
      w.write(holder, w.start - 10_000, 100);
      w.row("held", w.start - 9_800);
      w.tick(0);
      expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
      w.write(newcomer, w.start + 4_500, 100);
      for (let seconds = 5; seconds <= 5 + 2 * CLAIM_WINDOW_MS / 1000; seconds += 5) w.tick(seconds);
      // The held call is billed by its row, the newcomer by its rollout: two calls, two bills (and the older row).
      expect([w.calls("codex"), w.calls("copilot")]).toEqual([1, 2]);
    });
  }
});

describe("a rollout found again", () => {
  test("hands its decisions to a ledger once, however often that discovery is polled", () => {
    const w = twoRollouts();
    w.write(0, w.start - 10_000, 100);
    // The history import left two alike rows near the call; the rollout holds the call of the nearer one.
    w.telemetryRow("held", w.start - 9_800);
    w.telemetryRow("spare", w.start - 5_000);
    w.tick(0);
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
    const found = w.discover();
    pollWatched(w.built, found, w.options);
    pollWatched(w.built, found, w.options);
    // A decision replayed twice would take the spare row too, and bill a call nobody made.
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
  });
});

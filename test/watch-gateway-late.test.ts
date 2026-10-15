import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { build, pollWatched, reportsFrom, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { rollingDays } from "../src/periods";
import { discover } from "../src/sources";
import { copilotRow, iso, routedLine } from "./fuzz-world";
import { tempDir } from "./tmp";

// `watch` is started once and ticks on. What it did not have at the start (a ledger row, a Copilot account with its
// first call, a rollout in the places it looks) must still be billed once, as a report made at the end would.
afterEach(() => { setSystemTime(); delete process.env.SPENDWATCH_CONFIG; });

const TICK = 5_000;
const head = (id: string, at: number) => JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id, model_provider: "subscription_gateway" } }) + "\n"
  + JSON.stringify({ timestamp: iso(at), type: "turn_context", payload: { model: "copilot/gpt" } }) + "\n";
const record = (id: string, at: number) => routedLine("records", id, at, 100, 0) + "\n";
const count = (at: number, total: number) => routedLine("counts", "n/a", at, 100, total) + "\n";
const calls = (reports: Report[]): Record<string, number> => Object.fromEntries(reports.filter((report) => report.apiCalls).map((report) => [report.source, report.apiCalls]));

/** A Mac watched from `start`, with one Codex rollout and a gateway state directory, driven tick by tick. */
function watched(options: { usage?: boolean; archive?: boolean } = {}) {
  const root = tempDir("spendwatch-watch-late-");
  const start = Date.now();
  setSystemTime(new Date(start));
  const sessions = join(root, "codex", "sessions");
  const archived = join(root, "codex", "archived_sessions");
  const state = join(root, "state");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(archived, { recursive: true });
  mkdirSync(options.usage === false ? state : join(state, "usage"), { recursive: true });
  const ledger = join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`);
  if (options.usage !== false) writeFileSync(ledger, "");
  const rollout = join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  writeFileSync(rollout, head("s", start - 90_000));
  // The archive is named by the config only when the test says so, as a user's own config may leave it out.
  writeFileSync(join(root, "config.json"), JSON.stringify([
    { agent: "codex", path: sessions }, ...(options.archive ? [{ agent: "codex", path: archived }] : []),
    { agent: "copilot", path: join(root, "none.db") }, { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = join(root, "config.json");
  const a: BuildOptions = { top: 5 };
  const built: Built = build(a, [watchPeriod(start, 1)], { watching: true });
  let n = 0;
  const tick = (times = 1) => { for (let i = 0; i < times; i++) { setSystemTime(new Date(start + ++n * TICK)); pollWatched(built, discover({ sinceMs: start - 86_400_000 }), a); } };
  return {
    start, tick, built, rollout, ledger, state,
    row: (id: string, at: number) => appendFileSync(ledger, copilotRow(id, at, 100)),
    archive: () => renameSync(rollout, join(archived, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")),
    watching: () => reportsFrom(built, a),
    /** What a report made now would bill from the same files. */
    fresh: () => calls(reportsFrom(build(a, [rollingDays(Date.now(), 1)]), a)),
  };
}

describe("watch started before the ledger held a Copilot row", () => {
  test("bills a routed Copilot call whose first row lands after the start, once", () => {
    const w = watched();
    w.tick();
    w.row("x", w.start + 4_000);
    appendFileSync(w.rollout, record("x", w.start + 3_900));
    w.tick(10);
    expect(calls(w.watching())).toEqual({ copilot: 1 });
    expect(w.fresh()).toEqual({ copilot: 1 });
  });

  test("tags the report as read from a ledger once the ledger exists", () => {
    const w = watched({ usage: false });
    w.tick();
    expect(w.watching().filter((report) => report.apiCalls)).toEqual([]);
    mkdirSync(join(w.state, "usage"));
    w.row("x", w.start + 4_000);
    w.tick(2);
    expect(w.watching().filter((report) => report.apiCalls).map((report) => [report.source, report.ledger])).toEqual([["copilot", true]]);
  });
});

describe("a token_count whose row lands late", () => {
  test("does not leave a history row of the same size billing it a second time", () => {
    const w = watched();
    // The gateway's history import left a row, claimable by a rollout, close to where the call will be.
    appendFileSync(w.ledger, JSON.stringify({ ...JSON.parse(copilotRow("history", w.start - 10_000, 100)), origin: "telemetry", responseId: "", session: true }) + "\n");
    w.row("seed", w.start - 100_000);
    w.tick();
    appendFileSync(w.rollout, count(w.start + 4_000, 100));
    w.tick(3);
    // Its own row lands a minute after the line; the call is the row's, and the history row is nobody's.
    w.row("y", w.start + 4_150);
    w.tick(20);
    expect(calls(w.watching())).toEqual({ copilot: 2 });
    expect(w.fresh()).toEqual({ copilot: 2 });
  });
});

describe("a rollout that leaves the places watch looks in", () => {
  test("keeps what it billed itself, so the row that lands afterwards does not bill the call again", () => {
    const w = watched();
    w.row("seed", w.start - 100_000);
    w.tick();
    appendFileSync(w.rollout, record("x", w.start + 4_000));
    w.tick(9); // past the claim window with no row: billed from the rollout
    expect(calls(w.watching())).toEqual({ codex: 1, copilot: 1 });
    w.archive();
    w.tick(2);
    w.row("x", w.start + 4_150);
    w.tick(5);
    expect(calls(w.watching())).toEqual({ codex: 1, copilot: 1 });
  });

  test("still bills a call that was waiting for its row when it left", () => {
    const w = watched();
    w.row("seed", w.start - 100_000);
    w.tick();
    appendFileSync(w.rollout, record("x", w.start + 4_000));
    w.tick();
    w.archive();
    w.tick(12); // no row ever comes: the call is billed from the rollout, which is no longer found
    expect(calls(w.watching())).toEqual({ codex: 1, copilot: 1 });
  });

  test("is found again, and read on from where it was, when the config names the archive", () => {
    const w = watched({ archive: true });
    w.row("seed", w.start - 100_000);
    w.tick();
    appendFileSync(w.rollout, record("x", w.start + 4_000));
    w.row("x", w.start + 4_150);
    w.tick();
    w.archive();
    w.tick(3);
    expect(calls(w.watching())).toEqual({ copilot: 2 });
  });
});

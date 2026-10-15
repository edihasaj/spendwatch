import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { build, pollWatched, watchPeriod, type BuildOptions } from "../src/build";
import { collectCopilot } from "../src/copilot";
import { IncrementalReader } from "../src/scan";
import { discover } from "../src/sources";
import { tempDir } from "./tmp";

// `watch` finds every Copilot session again on each tick. A tick that finds the native session store as it was must
// fold nothing and draw nothing, the way a gateway ledger that did not change does.
const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** A watched Copilot session store with two sessions, driven the way `watch` drives it. */
function watched() {
  const root = tempDir("spendwatch-watch-copilot-");
  const path = join(root, "session-store.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT);
    CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
      total_nano_aiu INTEGER,token_details_json TEXT,created_at TEXT);`);
  db.prepare("INSERT INTO sessions VALUES (?,?)").run("one", "/workspace/demo");
  db.prepare("INSERT INTO sessions VALUES (?,?)").run("two", "/workspace/other");
  const now = Date.now();
  const add = (id: number, session: string, nano = 1_000_000_000) =>
    db.prepare("INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, session, "claude-sonnet-5", 100, 10, 0, 0, nano, null, new Date(now - 1000 * (10 - id)).toISOString());
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([{ agent: "copilot", path }]));
  process.env.SPENDWATCH_CONFIG = config; delete process.env.SPENDWATCH_GATEWAY_SOURCE;
  const options: BuildOptions = { top: 5, agents: new Set(["copilot"]) };
  let built: ReturnType<typeof build> | undefined;
  const tick = () => {
    if (!built) { built = build(options, [watchPeriod(now, 1)], { watching: true }); return 1; }
    return pollWatched(built, discover({ sinceMs: now - 86_400_000, agents: options.agents }), options);
  };
  const report = () => (built!.readers.get("copilot")!.sink as Aggregator).report();
  return { db, path, add, tick, report };
}

describe("watch mode with a native Copilot session store", () => {
  test("folds nothing on a tick that finds the store as it was", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    w.tick();
    expect(w.report()).toMatchObject({ apiCalls: 2, sessions: 2 });
    expect(w.tick()).toBe(0);
    expect(w.tick()).toBe(0);
    w.db.close();
  });

  test("shows a request added to one session, and only then", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    w.tick();
    w.add(3, "one");
    expect(w.tick()).toBeGreaterThan(0);
    expect(w.report().apiCalls).toBe(3);
    expect(w.tick()).toBe(0);
    w.db.close();
  });

  test("shows a charge the CLI finalizes on a request it already wrote, though no row was added", () => {
    const w = watched();
    w.add(1, "one", 0); w.add(2, "two");
    w.tick();
    expect(w.report().totalCost).toBeCloseTo(0.01, 9);
    w.db.exec("UPDATE assistant_usage_events SET total_nano_aiu=3000000000 WHERE id=1");
    expect(w.tick()).toBeGreaterThan(0);
    expect(w.report()).toMatchObject({ apiCalls: 2 });
    expect(w.report().totalCost).toBeCloseTo(0.04, 9);
    expect(w.tick()).toBe(0);
    w.db.close();
  });
});

describe("reading a native Copilot session store", () => {
  /** How many times the usage rows were read: the table has no index on the session, so each read scans all of it. */
  const usageReads = (reads: { mock: { calls: unknown[][] } }): number => reads.mock.calls.filter(([sql]) => String(sql).includes("FROM assistant_usage_events WHERE session_id")).length;

  test("reads the rows once per tick, for the version and the events together", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    const reads = spyOn(Database.prototype, "query");
    try {
      w.tick();
      expect(usageReads(reads)).toBe(1);
      w.add(3, "one");
      reads.mockClear();
      expect(w.tick()).toBeGreaterThan(0);
      expect(usageReads(reads)).toBe(1);
      reads.mockClear();
      expect(w.tick()).toBe(0);
      expect(usageReads(reads)).toBe(1);
    } finally { reads.mockRestore(); }
    w.db.close();
  });

  test("reads a store of many sessions in a few scans, not one per session", () => {
    const w = watched();
    for (let i = 0; i < 120; i++) { w.db.prepare("INSERT INTO sessions VALUES (?,?)").run(`many-${i}`, "/workspace/many"); w.add(100 + i, `many-${i}`); }
    const reads = spyOn(Database.prototype, "query");
    try {
      w.tick();
      // 122 sessions, 50 to a scan.
      expect(usageReads(reads)).toBe(3);
      expect(w.report()).toMatchObject({ apiCalls: 120, sessions: 120 });
      reads.mockClear();
      expect(w.tick()).toBe(0);
      expect(usageReads(reads)).toBe(3);
    } finally { reads.mockRestore(); }
    w.db.close();
  });

  test("skips a store it cannot read at the poll, folds nothing, and reads it again at the next one", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    const files = collectCopilot(w.path, 0, "dev");
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    renameSync(w.path, `${w.path}.away`);
    for (const file of files) expect(reader.poll(file)).toBe(0);
    expect(agg.report()).toMatchObject({ apiCalls: 0, sessions: 0 });
    renameSync(`${w.path}.away`, w.path);
    for (const file of files) expect(reader.poll(file)).toBeGreaterThan(0);
    expect(agg.report()).toMatchObject({ apiCalls: 2, sessions: 2 });
    w.db.close();
  });
});

describe("a Copilot session store that has not been written to for a while", () => {
  /**
   * Makes the store look as if it was last written a minute ago or more, which is what lets a tick trust that it is as it
   * was. Each call names a different time, as writes at different moments would: the same size and time twice is not a change.
   */
  let age = 60_000;
  const settle = (path: string): void => {
    age += 1_000;
    const old = new Date(Date.now() - age);
    utimesSync(path, old, old);
  };
  const reads = (spy: { mock: { calls: unknown[][] } }, what: string): number => spy.mock.calls.filter(([sql]) => String(sql).includes(what)).length;
  const withSpy = <T,>(body: (spy: ReturnType<typeof spyOn>) => T): T => {
    const spy = spyOn(Database.prototype, "query");
    try { return body(spy as ReturnType<typeof spyOn>); } finally { spy.mockRestore(); }
  };

  test("is not read at all by a tick that finds it as it was: not its sessions, not their rows", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    settle(w.path);
    withSpy((spy) => {
      w.tick();
      expect(reads(spy, "FROM sessions")).toBe(1);
      expect(reads(spy, "FROM assistant_usage_events WHERE session_id")).toBe(1);
      spy.mockClear();
      expect(w.tick()).toBe(0);
      expect(w.tick()).toBe(0);
      expect(spy.mock.calls.length).toBe(0);
      expect(w.report()).toMatchObject({ apiCalls: 2, sessions: 2 });
    });
    w.db.close();
  });

  test("is read again when a request is added, and a charge finalized in place shows too", () => {
    const w = watched();
    w.add(1, "one", 0); w.add(2, "two");
    settle(w.path);
    w.tick();
    w.add(3, "one");
    expect(w.tick()).toBeGreaterThan(0);
    expect(w.report().apiCalls).toBe(3);
    settle(w.path);
    expect(w.tick()).toBe(0);
    w.db.exec("UPDATE assistant_usage_events SET total_nano_aiu=3000000000 WHERE id=1");
    expect(w.tick()).toBeGreaterThan(0);
    expect(w.report().totalCost).toBeCloseTo(0.05, 9);
    w.db.close();
  });

  test("lists a session added since, though the store was settled when it was last read", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    settle(w.path);
    w.tick();
    w.db.prepare("INSERT INTO sessions VALUES (?,?)").run("three", "/workspace/three");
    w.add(3, "three");
    expect(w.tick()).toBeGreaterThan(0);
    expect(w.report()).toMatchObject({ apiCalls: 3, sessions: 3 });
    w.db.close();
  });

  test("is read again by a session file polled after the store was written, without a new discovery", () => {
    const w = watched();
    w.add(1, "one", 0);
    settle(w.path);
    const files = collectCopilot(w.path, 0, "dev");
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    for (const file of files) reader.poll(file);
    expect(agg.report().totalCost).toBe(0);
    w.db.exec("UPDATE assistant_usage_events SET total_nano_aiu=3000000000 WHERE id=1");
    for (const file of files) expect(reader.poll(file)).toBeGreaterThan(0);
    expect(agg.report().totalCost).toBeCloseTo(0.03, 9);
    w.db.close();
  });

  test("gives its events to a reader that has not folded them yet, though the version is known", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    settle(w.path);
    const files = collectCopilot(w.path, 0, "dev");
    const first = new Aggregator();
    const readerOne = new IncrementalReader(first);
    for (const file of files) readerOne.poll(file);
    const second = new Aggregator();
    const readerTwo = new IncrementalReader(second);
    for (const file of files) expect(readerTwo.poll(file)).toBeGreaterThan(0);
    expect(second.report()).toMatchObject({ apiCalls: 2, sessions: 2 });
    w.db.close();
  });

  test("is read by a tick that finds only its write-ahead log changed", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    const wal = `${w.path}-wal`;
    writeFileSync(wal, "frames");
    settle(w.path); settle(wal);
    w.tick();
    withSpy((spy) => {
      expect(w.tick()).toBe(0);
      expect(spy.mock.calls.length).toBe(0);
      appendFileSync(wal, "more frames");
      w.tick();
      expect(reads(spy, "FROM assistant_usage_events WHERE session_id")).toBe(1);
    });
    w.db.close();
  });

  test("is read by a tick that finds a write in progress, as a rollback journal shows", () => {
    const w = watched();
    w.add(1, "one"); w.add(2, "two");
    settle(w.path);
    w.tick();
    writeFileSync(`${w.path}-journal`, "");
    withSpy((spy) => {
      w.tick();
      expect(reads(spy, "FROM assistant_usage_events WHERE session_id")).toBe(1);
    });
    w.db.close();
  });

  test("lists the sessions that fall in the period asked for, not those of another period it was last read for", () => {
    const w = watched();
    w.db.prepare("INSERT INTO sessions VALUES (?,?)").run("older", "/workspace/old");
    w.db.prepare("INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(50, "older", "claude-sonnet-5", 100, 10, 0, 0, 1, null, "2020-01-01T00:00:00.000Z");
    w.add(1, "one");
    settle(w.path);
    expect(collectCopilot(w.path, Date.parse("2019-01-01"), "dev")).toHaveLength(2);
    expect(collectCopilot(w.path, Date.parse("2026-01-01"), "dev")).toHaveLength(1);
    w.db.close();
  });

  test("after a failed read, the next session tries the batch again instead of scanning the table for itself", () => {
    const w = watched();
    w.db.prepare("INSERT INTO sessions VALUES (?,?)").run("three", "/workspace/three");
    w.add(1, "one"); w.add(2, "two"); w.add(3, "three");
    const files = collectCopilot(w.path, 0, "dev");
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    renameSync(w.path, `${w.path}.away`);
    expect(reader.poll(files[0]!)).toBe(0);
    renameSync(`${w.path}.away`, w.path);
    withSpy((spy) => {
      expect(reader.poll(files[1]!)).toBeGreaterThan(0);
      expect(reader.poll(files[2]!)).toBeGreaterThan(0);
      // One scan read the rest of the batch for both.
      expect(reads(spy, "FROM assistant_usage_events WHERE session_id")).toBe(1);
    });
    w.db.close();
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSync, writeFileSync } from "node:fs";
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

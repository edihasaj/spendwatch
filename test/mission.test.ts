import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectMission, defaultMissionRoots, readMission } from '../src/mission';
import { MonthlyAggregator } from '../src/monthly';
import { monthPeriod } from '../src/periods';
import { Aggregator } from '../src/aggregate';
import { IncrementalReader } from '../src/scan';
import type { Event } from '../src/parse';
import { ATTEMPT, usageRecord } from './agent-usage-fixture';
import { tempDir } from './tmp';

const RUN = 'run_5d2f0c6e-1111-4222-8333-444455556666';
const AT = '2026-10-10T08:59:12.115Z';

function fixture(runs = true, createdAt: string | null = AT): { path: string; db: Database } {
  const path = join(tempDir('spendwatch-mission-'), 'authority.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE mission_run_outputs(run_id TEXT, output_key TEXT, output_json TEXT, updated_at TEXT, PRIMARY KEY(run_id, output_key));');
  if (runs) {
    db.exec('CREATE TABLE mission_runs(run_id TEXT PRIMARY KEY, spec_json TEXT, created_at TEXT);');
    db.prepare('INSERT INTO mission_runs VALUES (?,?,?)').run(RUN, JSON.stringify({ executor: { repository_key: 'edihasaj/mission-runtime' } }), createdAt);
  }
  return { path, db };
}

function put(db: Database, key: string, json: unknown, at = AT, run = RUN): void {
  db.prepare('INSERT OR REPLACE INTO mission_run_outputs VALUES (?,?,?,?)').run(run, key, typeof json === 'string' ? json : JSON.stringify(json), at);
}

const apis = (events: Iterable<Event>) => [...events].filter((e): e is Extract<Event, { t: 'api' }> => e.t === 'api');

describe('Mission Runtime usage rows', () => {
  test('reads one file per attempt and model, split by usage kind, account and cost', () => {
    const { path, db } = fixture();
    put(db, `usage:${ATTEMPT}`, usageRecord());
    const files = collectMission(path, 0);
    expect(files.map((f) => f.key)).toEqual([
      `mission:${RUN}:${ATTEMPT}:azure-openai-responses:mission-runtime-terra`,
      `mission:${RUN}:${ATTEMPT}:claude:claude-sonnet-5`,
    ]);
    expect(files.map((f) => [f.source, f.account, f.project])).toEqual([
      ['mission', 'azure-openai', 'mission-runtime'], ['mission', 'anthropic:main', 'mission-runtime'],
    ]);
    const [terra, claude] = files.map((f) => apis(f.snapshot!()!.events)[0]!);
    expect(terra!.usage).toEqual({ input: 256239 - 204189 - 47170, output: 6107, cacheRead: 204189, cache5m: 47170, cache1h: 0 });
    expect(terra!.costUsd).toBeUndefined();
    expect(claude!.usage).toEqual({ input: 875032 - 272569 - 602355, output: 43347, cacheRead: 272569, cache5m: 602355, cache1h: 0 });
    expect(claude!.costUsd).toBeCloseTo(2.897613, 9);
    expect(terra!.ts).toBe(Date.parse(AT));
    expect(terra!.requestId).toBe(`${ATTEMPT}:azure-openai-responses:mission-runtime-terra`);
    db.close();
  });

  test('an explicit account names every entry, and a missing runs table leaves the project unknown', () => {
    const { path, db } = fixture(false);
    put(db, `usage:${ATTEMPT}`, usageRecord());
    const files = collectMission(path, 0, 'team');
    expect(files.map((f) => [f.account, f.project])).toEqual([['team', '?'], ['team', '?']]);
    db.close();
  });

  test('keeps rows updated since the window opened, and only usage rows', () => {
    const { path, db } = fixture();
    put(db, `usage:${ATTEMPT}`, usageRecord());
    put(db, 'usage:attempt_old', usageRecord({ attempt_id: 'attempt_old' }), '2026-09-01T00:00:00.000Z');
    put(db, 'summary', usageRecord({ attempt_id: 'attempt_summary' }));
    put(db, 'result', { text: 'not usage' });
    expect(collectMission(path, Date.parse('2026-10-01T00:00:00Z')).map((f) => f.key?.split(':')[2])).toEqual([ATTEMPT, ATTEMPT]);
    expect(collectMission(path, 0)).toHaveLength(4);
    db.close();
  });

  test('never throws on bad rows, tables or files', () => {
    const { path, db } = fixture();
    put(db, 'usage:a', '{not json');
    put(db, 'usage:b', 'null');
    put(db, 'usage:c', { usage_version: 'agent-usage.v2', attempt_id: 'x', entries: [] });
    put(db, 'usage:d', usageRecord({ attempt_id: 'd', entries: [null, 7, { input_tokens: 'many', output_tokens: -4 }] }));
    expect(collectMission(path, 0)).toEqual([]);
    db.close();
    const empty = join(tempDir('spendwatch-mission-'), 'empty.sqlite');
    new Database(empty).close();
    expect(collectMission(empty, 0)).toEqual([]);
    expect(collectMission(join(tempDir('spendwatch-mission-'), 'missing.sqlite'), 0)).toEqual([]);
    const wrong = join(tempDir('spendwatch-mission-'), 'wrong.sqlite');
    const other = new Database(wrong); other.exec('CREATE TABLE mission_run_outputs(run_id TEXT)'); other.close();
    expect(collectMission(wrong, 0)).toEqual([]);
  });

  test('sanitizes non-finite and negative numbers and skips an all-zero entry', () => {
    const { path, db } = fixture();
    const record = usageRecord({}, 1) as any;
    record.entries[0].input_tokens = -5; record.entries[0].cached_input_tokens = 'x'; record.entries[0].cache_write_input_tokens = null;
    record.entries[0].output_tokens = 0;
    record.entries[1].cost_usd_micros = -1;
    put(db, `usage:${ATTEMPT}`, record);
    const files = collectMission(path, 0);
    expect(files).toHaveLength(1);
    expect(apis(files[0]!.snapshot()!.events)[0]!.costUsd).toBeUndefined();
    db.close();
  });

  test('a rewritten, larger row is the attempt cumulatively, under a new version', () => {
    const { path, db } = fixture();
    put(db, `usage:${ATTEMPT}`, usageRecord());
    const agg = new Aggregator(); const reader = new IncrementalReader(agg);
    const files = collectMission(path, 0);
    for (const file of files) { reader.poll(file); reader.poll(file); }
    expect(agg.report(10).apiCalls).toBe(2);
    const before = agg.report(10).totalTokens;
    const first = files[0]!.snapshot()!.version;
    put(db, `usage:${ATTEMPT}`, usageRecord({}, 2), '2026-10-10T09:30:00.000Z');
    expect(files[0]!.snapshot()!.version).not.toBe(first);
    for (const file of files) reader.poll(file);
    const report = agg.report(10);
    expect(report.apiCalls).toBe(2);
    expect(report.sessions).toBe(1);
    expect(report.totalTokens).toBe(before * 2);
    db.close();
  });

  test('an unreadable store gives no snapshot, and the default path follows MISSION_RUNTIME_DB_PATH', () => {
    const { path, db } = fixture();
    put(db, `usage:${ATTEMPT}`, usageRecord());
    const files = collectMission(path, 0);
    db.close();
    rmSync(path);
    expect(files[0]!.snapshot!()).toBeUndefined();
    const previous = process.env.MISSION_RUNTIME_DB_PATH;
    process.env.MISSION_RUNTIME_DB_PATH = '/tmp/elsewhere/authority.sqlite';
    try { expect(defaultMissionRoots()).toEqual(['/tmp/elsewhere/authority.sqlite']); }
    finally { if (previous === undefined) delete process.env.MISSION_RUNTIME_DB_PATH; else process.env.MISSION_RUNTIME_DB_PATH = previous; }
  });
  test('reads a store whose -wal and -shm are gone, as after a clean close, and leaves nothing behind', () => {
    const { path, db } = fixture();
    db.exec('PRAGMA journal_mode=WAL');
    put(db, `usage:${ATTEMPT}`, usageRecord());
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    // The plain read-only open fails on such a store; the immutable one reads it.
    expect(() => new Database(path, { readonly: true, create: false }).query('SELECT 1 FROM mission_run_outputs').get()).toThrow();
    const before = readdirSync(join(path, '..')).sort();
    const read = readMission(path, 0);
    expect([read.files.length, read.unreadable]).toEqual([2, false]);
    expect(apis(read.files[1]!.snapshot!()!.events)[0]!.costUsd).toBeCloseTo(2.897613, 9);
    expect(readdirSync(join(path, '..')).sort()).toEqual(before);
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || existsSync(`${path}-journal`)).toBe(false);
  });

  test('says so when a store with a -wal cannot be read, rather than reporting nothing quietly', () => {
    const path = join(tempDir('spendwatch-mission-'), 'authority.sqlite');
    writeFileSync(path, 'this is not a database, '.repeat(200));
    writeFileSync(`${path}-wal`, 'x');
    expect(readMission(path, 0)).toEqual({ files: [], unreadable: true });
    expect(readMission(join(tempDir('spendwatch-mission-'), 'missing.sqlite'), 0)).toEqual({ files: [], unreadable: false });
  });

  test('dates an attempt at its run start, so it stays in one month when it runs past the 1st', () => {
    const { path, db } = fixture(true, '2026-09-28T10:00:00.000Z');
    put(db, `usage:${ATTEMPT}`, usageRecord(), '2026-09-30T23:00:00.000Z');
    const agg = new MonthlyAggregator([monthPeriod('2026-09'), monthPeriod('2026-10')]);
    const reader = new IncrementalReader(agg);
    const file = collectMission(path, 0)[0]!;
    reader.poll(file);
    const september = agg.reports(10).get('2026-09')!.apiCalls;
    put(db, `usage:${ATTEMPT}`, usageRecord({}, 2), '2026-10-02T09:00:00.000Z');
    reader.poll(file);
    const reports = agg.reports(10);
    expect([september, reports.get('2026-09')!.apiCalls, reports.get('2026-10')!.apiCalls]).toEqual([1, 1, 0]);
    expect(reports.get('2026-09')!.totalTokens).toBe((256239 + 6107) * 2);
    // The window still follows the last update.
    expect(collectMission(path, Date.parse('2026-10-03T00:00:00Z'))).toEqual([]);
    expect(collectMission(path, Date.parse('2026-10-01T00:00:00Z'))).toHaveLength(2);
    db.close();
  });

  test('falls back to the last update without a start, and survives a spec that is not JSON', () => {
    const { path, db } = fixture(true, null);
    db.prepare('UPDATE mission_runs SET spec_json=?').run('{broken');
    put(db, `usage:${ATTEMPT}`, usageRecord());
    const files = collectMission(path, 0);
    expect(files.map((f) => f.project)).toEqual(['?', '?']);
    expect(apis(files[0]!.snapshot!()!.events)[0]!.ts).toBe(Date.parse(AT));
    db.close();
  });

  test('keeps only the projects that match the filter, ignoring case', () => {
    const { path, db } = fixture();
    put(db, `usage:${ATTEMPT}`, usageRecord());
    expect(collectMission(path, 0, undefined, 'MISSION')).toHaveLength(2);
    expect(collectMission(path, 0, undefined, 'spendwatch')).toEqual([]);
  });
});

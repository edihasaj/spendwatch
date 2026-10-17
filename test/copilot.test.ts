import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { collectCopilot } from '../src/copilot';
import { Aggregator } from '../src/aggregate';
import { MonthlyAggregator } from '../src/monthly';
import { IncrementalReader } from '../src/scan';
import { monthPeriod } from '../src/periods';
import { tempDir } from './tmp';

function fixture(): { path: string; db: Database } {
  const path = join(tempDir('spendwatch-copilot-'), 'session-store.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT);
    CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
      total_nano_aiu INTEGER,token_details_json TEXT,created_at TEXT);`);
  db.prepare('INSERT INTO sessions VALUES (?,?)').run('one', '/workspace/demo');
  db.prepare('INSERT INTO sessions VALUES (?,?)').run('two', '/workspace/other');
  return { path, db };
}

function add(db: Database, id: number, session: string, at: string, nano = 6_602_500_000): void {
  const details = JSON.stringify([
    { tokenType: 'input', tokenCount: 80 }, { tokenType: 'output', tokenCount: 11 },
    { tokenType: 'cache_write', tokenCount: 26302 }, { tokenType: 'cache_read', tokenCount: 0 },
  ]);
  db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, session, 'claude-sonnet-5', 26382, 11, 0, 26302, nano, details, at);
}

describe('Copilot usage ledger', () => {
  test('keeps reported billing, cache tokens and individual sessions without replaying calls', () => {
    const { path, db } = fixture();
    add(db, 1, 'one', '2026-10-10T08:59:12.115Z');
    add(db, 2, 'two', '2026-10-11T08:59:12.115Z', 1_000_000_000);
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const files = collectCopilot(path, Date.parse('2026-10-01T00:00:00Z'), 'dev');
    for (const file of files) { reader.poll(file); reader.poll(file); }
    const report = agg.report(10);
    expect(report.apiCalls).toBe(2);
    expect(report.sessions).toBe(2);
    expect(report.totalCost).toBeCloseTo(0.076025, 9);
    expect(report.totalTokens).toBe(26393 * 2);
    expect(report.models[0]?.inTok).toBe(160);
    expect(report.models[0]?.cacheWriteTok).toBe(52604);
    expect(report.accounts[0]?.account).toBe('dev');
    db.close();
  });

  test('a copied session store does not double-count the same requests', () => {
    const first = fixture(), second = fixture();
    add(first.db, 1, 'one', '2026-10-10T08:59:12.115Z');
    add(second.db, 1, 'one', '2026-10-10T08:59:12.115Z');
    const agg = new Aggregator(); const reader = new IncrementalReader(agg);
    for (const file of [...collectCopilot(first.path, 0), ...collectCopilot(second.path, 0)]) reader.poll(file);
    expect(agg.report(10).apiCalls).toBe(1);
    expect(agg.report(10).totalCost).toBeCloseTo(0.066025, 9);
    first.db.close(); second.db.close();
  });

  test('routes a resumed session to the month of each request', () => {
    const { path, db } = fixture();
    add(db, 1, 'one', '2026-09-30T18:59:12.115Z');
    add(db, 2, 'one', '2026-10-01T08:59:12.115Z', 1_000_000_000);
    const agg = new MonthlyAggregator([monthPeriod('2026-09'), monthPeriod('2026-10')]);
    const reader = new IncrementalReader(agg);
    for (const file of collectCopilot(path, Date.parse('2026-09-01T00:00:00Z'))) reader.poll(file);
    expect(agg.reports(10).get('2026-09')?.totalCost).toBeCloseTo(0.066025, 9);
    expect(agg.reports(10).get('2026-10')?.totalCost).toBeCloseTo(0.01, 9);
    db.close();
  });

  test('updates a finalized charge for an existing request without billing it twice', () => {
    const { path, db } = fixture();
    add(db, 1, 'one', '2026-10-10T08:59:12.115Z', 0);
    const agg = new Aggregator(); const reader = new IncrementalReader(agg);
    const file = collectCopilot(path, 0)[0]!;
    reader.poll(file);
    db.exec('UPDATE assistant_usage_events SET total_nano_aiu=6602500000 WHERE id=1');
    reader.poll(file);
    expect(agg.report(10).apiCalls).toBe(1);
    expect(agg.report(10).totalCost).toBeCloseTo(0.066025, 9);
    db.close();
  });
});

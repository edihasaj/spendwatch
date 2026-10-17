import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAutoreview } from '../src/autoreview';
import { Aggregator } from '../src/aggregate';
import { IncrementalReader } from '../src/scan';
import { usageRecord } from './agent-usage-fixture';
import { tempDir } from './tmp';

const ledger = (lines: unknown[]): string => {
  const path = join(tempDir('spendwatch-autoreview-'), 'jobs.jsonl');
  writeFileSync(path, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  return path;
};
const rec = (attempt: string, at: string, scale = 1, project: unknown = 'edihasaj/spendwatch') =>
  usageRecord({ attempt_id: attempt, updated_at: at, project }, scale);

describe('AutoReview job ledger', () => {
  test('one file per attempt and model, in the repository project and the provider account', () => {
    const files = collectAutoreview(ledger([rec('attempt_a', '2026-10-10T10:00:00Z')]), 0);
    expect(files.map((f) => [f.key, f.source, f.account, f.project])).toEqual([
      ['autoreview:attempt_a:azure-openai-responses:mission-runtime-terra', 'autoreview', 'azure-openai', 'spendwatch'],
      ['autoreview:attempt_a:claude:claude-sonnet-5', 'autoreview', 'anthropic:main', 'spendwatch'],
    ]);
    expect(collectAutoreview(ledger([rec('attempt_a', '2026-10-10T10:00:00Z')]), 0, 'ci').map((f) => f.account)).toEqual(['ci', 'ci']);
  });

  test('the last line of an attempt replaces the earlier ones', () => {
    const path = ledger([rec('attempt_a', '2026-10-10T10:00:00Z', 1), rec('attempt_b', '2026-10-10T10:00:00Z', 1), rec('attempt_a', '2026-10-10T11:00:00Z', 3)]);
    const agg = new Aggregator(); const reader = new IncrementalReader(agg);
    const files = collectAutoreview(path, 0);
    expect(files).toHaveLength(4);
    for (const file of files) reader.poll(file);
    // attempt_a counts once, at its latest totals (x3), and attempt_b at x1: four records' worth of tokens in all.
    expect(agg.report(10).totalTokens).toBe((256239 + 6107 + 875032 + 43347) * 4);
    expect(agg.report(10).apiCalls).toBe(4);
    expect(agg.report(10).sessions).toBe(2);
  });

  test('keeps records updated since the window opened', () => {
    const path = ledger([rec('attempt_old', '2026-09-01T00:00:00Z'), rec('attempt_new', '2026-10-10T00:00:00Z')]);
    expect(collectAutoreview(path, Date.parse('2026-10-01T00:00:00Z')).map((f) => f.key?.split(':')[1])).toEqual(['attempt_new', 'attempt_new']);
  });

  test('skips bad lines and records without an attempt or a time, and a missing file is nothing', () => {
    const path = ledger([
      '{broken', '', 'null', '[1]',
      { ...rec('x', '2026-10-10T00:00:00Z'), attempt_id: undefined },
      { ...rec('y', '2026-10-10T00:00:00Z'), updated_at: undefined },
      { ...rec('z', 'not a date') },
      { ...rec('w', '2026-10-10T00:00:00Z'), usage_version: 'other' },
      rec('ok', '2026-10-10T00:00:00Z', 1, null),
    ]);
    const files = collectAutoreview(path, 0);
    expect(files.map((f) => [f.key?.split(':')[1], f.project])).toEqual([['ok', '?'], ['ok', '?']]);
    expect(collectAutoreview(join(tempDir('spendwatch-autoreview-'), 'none.jsonl'), 0)).toEqual([]);
  });

  test('reading a file again replaces its events, and an unchanged record folds nothing', () => {
    const path = ledger([rec('attempt_a', '2026-10-10T10:00:00Z')]);
    const agg = new Aggregator(); const reader = new IncrementalReader(agg);
    for (const file of collectAutoreview(path, 0)) reader.poll(file);
    const once = agg.report(10).totalTokens;
    let folded = 0;
    for (const file of collectAutoreview(path, 0)) folded += reader.poll(file);
    expect(folded).toBe(0);
    writeFileSync(path, JSON.stringify(rec('attempt_a', '2026-10-10T12:00:00Z', 2)) + '\n');
    for (const file of collectAutoreview(path, 0)) reader.poll(file);
    expect(agg.report(10).totalTokens).toBe(once * 2);
    expect(agg.report(10).apiCalls).toBe(2);
  });
  test('keeps only the projects that match the filter, ignoring case', () => {
    const path = ledger([rec('attempt_a', '2026-10-10T10:00:00Z')]);
    expect(collectAutoreview(path, 0, undefined, 'SPEND')).toHaveLength(2);
    expect(collectAutoreview(path, 0, undefined, 'mission')).toEqual([]);
  });
});

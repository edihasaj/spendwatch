import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Aggregator } from '../src/aggregate';
import { sourceLabel } from '../src/reports';
import { IncrementalReader } from '../src/scan';
import { discover } from '../src/sources';
import { ATTEMPT, usageRecord } from './agent-usage-fixture';
import { tempDir } from './tmp';

const ROOT = join(import.meta.dir, '..');
const RUN = 'run_5d2f0c6e-1111-4222-8333-444455556666';
const NEW = new Set(['mission', 'autoreview']);
const RECORD_TOKENS = 256239 + 6107 + 875032 + 43347;

/** A Mission Runtime store with one attempt and an AutoReview ledger with another, both updated an hour ago. */
function world(): { config: string } {
  const dir = tempDir('spendwatch-agent-usage-');
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const db = new Database(join(dir, 'authority.sqlite'));
  db.exec('CREATE TABLE mission_run_outputs(run_id TEXT, output_key TEXT, output_json TEXT, updated_at TEXT);');
  db.prepare('INSERT INTO mission_run_outputs VALUES (?,?,?,?)').run(RUN, `usage:${ATTEMPT}`, JSON.stringify(usageRecord()), at);
  db.close();
  writeFileSync(join(dir, 'jobs.jsonl'), JSON.stringify(usageRecord({ attempt_id: 'attempt_auto', updated_at: at, project: 'example-owner/autoreview' })) + '\n');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify([
    { agent: 'mission', path: join(dir, 'authority.sqlite') },
    { agent: 'autoreview', path: join(dir, 'jobs.jsonl') },
  ]));
  return { config };
}

function withConfig<T>(config: string, run: () => T): T {
  const previous = process.env.SPENDWATCH_CONFIG;
  process.env.SPENDWATCH_CONFIG = config;
  try { return run(); } finally { if (previous === undefined) delete process.env.SPENDWATCH_CONFIG; else process.env.SPENDWATCH_CONFIG = previous; }
}

describe('Mission Runtime and AutoReview sources', () => {
  test('are discovered from config roots alone, and count each entry once however often they are read', () => {
    const { config } = world();
    withConfig(config, () => {
      const statuses = discover({ sinceMs: 0 }).filter((s) => NEW.has(s.id));
      expect(statuses.map((s) => [s.id, s.present, s.files.length])).toEqual([['mission', true, 2], ['autoreview', true, 2]]);
      for (const status of statuses) {
        const agg = new Aggregator(); const reader = new IncrementalReader(agg);
        for (let round = 0; round < 3; round++) {
          for (const file of discover({ sinceMs: 0 }).find((s) => s.id === status.id)!.files) { reader.poll(file); reader.flush(file); }
        }
        const report = agg.report(10);
        expect([report.apiCalls, report.sessions, report.totalTokens]).toEqual([2, 1, RECORD_TOKENS]);
      }
    });
  });

  test('autoreview needs a config root, and a missing mission store is "not installed"', () => {
    const none = join(tempDir('spendwatch-agent-usage-'), 'config.json');
    writeFileSync(none, JSON.stringify([{ agent: 'mission', path: join(tempDir('spendwatch-agent-usage-'), 'missing.sqlite') }]));
    withConfig(none, () => {
      expect(discover({ sinceMs: 0 }).filter((s) => NEW.has(s.id)).map((s) => [s.id, s.present, s.note])).toEqual([['mission', false, 'not installed']]);
      // Left out of a default report; asked for by name, it says what it needs.
      expect(discover({ sinceMs: 0 }).some((s) => s.id === 'autoreview')).toBe(false);
      expect(discover({ sinceMs: 0, agents: new Set(['autoreview']) })).toEqual([
        { id: 'autoreview', present: false, parseable: false, note: 'needs an autoreview root in the config', files: [] },
      ]);
    });
  });

  test('says when a Mission Runtime store exists but cannot be read, and applies --project', () => {
    const dir = tempDir('spendwatch-agent-usage-');
    const bad = join(dir, 'bad.sqlite');
    writeFileSync(bad, 'not a database '.repeat(300)); writeFileSync(`${bad}-wal`, 'x');
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify([{ agent: 'mission', path: bad }]));
    withConfig(config, () => {
      expect(discover({ sinceMs: 0 }).filter((s) => NEW.has(s.id)).map((s) => [s.id, s.present, s.note])).toEqual([['mission', true, 'store could not be read']]);
    });
    const { config: both } = world();
    withConfig(both, () => {
      const found = discover({ sinceMs: 0, project: 'autoreview' }).filter((s) => NEW.has(s.id));
      expect(found.map((s) => [s.id, s.files.length])).toEqual([['mission', 0], ['autoreview', 2]]);
    });
  });

  test('report --json lists each as its own source with the entries as its totals', () => {
    const { config } = world();
    const out = Bun.spawnSync(['bun', join(ROOT, 'src', 'cli.ts'), 'report', '--days', '7', '--json'], {
      cwd: ROOT, env: { ...process.env, SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_CONFIG: process.env.SPENDWATCH_GATEWAY_CONFIG },
    });
    expect(out.exitCode).toBe(0);
    const rows = JSON.parse(out.stdout.toString()) as Array<{ source: string; apiCalls: number; sessions: number; totalTokens: number; projects: Array<{ project: string }> }>;
    const ours = rows.filter((r) => NEW.has(r.source));
    expect(ours.map((r) => [r.source, r.apiCalls, r.sessions, r.totalTokens])).toEqual([
      ['mission', 2, 1, RECORD_TOKENS], ['autoreview', 2, 1, RECORD_TOKENS],
    ]);
    expect(ours.map((r) => r.projects.map((p) => p.project))).toEqual([['?'], ['autoreview']]);
  });

  test('are labelled for people', () => {
    expect(sourceLabel('studio:mission')).toBe('studio · Mission Runtime');
    expect(sourceLabel('autoreview')).toBe('AutoReview');
  });
});

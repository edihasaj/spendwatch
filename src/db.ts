// Persists a report snapshot into a SQLite database (one row per run, so you
// build spend history over time and can query with plain SQL). Uses bun:sqlite,
// which is bundled into the compiled binary.
import { Database, isManagedDatabase } from "./database";
import type { Report } from "./aggregate";
import { encodeSampleDetail } from "./managed/codecs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, generated_at TEXT, day_span INTEGER, total_cost REAL
);
CREATE TABLE IF NOT EXISTS agent_account (run_id INTEGER, agent TEXT, account TEXT, cost REAL, calls INTEGER, sessions INTEGER);
CREATE TABLE IF NOT EXISTS tools (run_id INTEGER, agent TEXT, tool TEXT, calls INTEGER, arg_tok INTEGER, result_tok INTEGER, ctx_cost REAL);
CREATE TABLE IF NOT EXISTS commands (run_id INTEGER, agent TEXT, command TEXT, is_deep INTEGER, calls INTEGER, arg_tok INTEGER, result_tok INTEGER, ctx_cost REAL);
CREATE TABLE IF NOT EXISTS prompts (run_id INTEGER, agent TEXT, project TEXT, cost REAL, tool_calls INTEGER, out_tok INTEGER, text TEXT);
CREATE TABLE IF NOT EXISTS models (run_id INTEGER, agent TEXT, model TEXT, calls INTEGER, in_tok INTEGER, out_tok INTEGER, cache_rd INTEGER, cache_wr INTEGER, cost REAL);
CREATE TABLE IF NOT EXISTS projects (run_id INTEGER, agent TEXT, project TEXT, cost REAL);
CREATE TABLE IF NOT EXISTS targets (run_id INTEGER, agent TEXT, command TEXT, calls INTEGER, ctx_cost REAL, err_pct REAL, reason TEXT, score REAL);
CREATE TABLE IF NOT EXISTS samples (run_id INTEGER, agent TEXT, scope TEXT, key TEXT, detail TEXT, count INTEGER, result_tok INTEGER);
CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
CREATE INDEX IF NOT EXISTS idx_aa_run ON agent_account(run_id);
`;

export function writeSnapshot(path: string, reports: Report[], opts: {
  generatedAt: number; days: number; idempotencyKey?: string;
}): { runId: number; rows: number } {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const snapshotKey = isManagedDatabase(path)
    ? opts.idempotencyKey ?? process.env.SPENDWATCH_SNAPSHOT_ID : undefined;
  if (snapshotKey) {
    if (!/^[a-f0-9]{64}$/.test(snapshotKey)) throw new Error("Invalid managed snapshot identity");
    db.exec(`CREATE TABLE IF NOT EXISTS _spendwatch_snapshot_receipts(
      id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,row_count INTEGER NOT NULL)`);
  }

  const live = reports.filter((r) => r.apiCalls > 0);
  const total = live.reduce((s, r) => s + r.totalCost, 0);
  let rows = 0;

  const insertRun = db.prepare("INSERT INTO runs(ts, generated_at, day_span, total_cost) VALUES (?, ?, ?, ?)");
  const flushes: Array<() => void> = [];
  type Binding = string | number | bigint | Uint8Array | boolean | null | undefined;
  const prepareLeaf = (sql: string) => {
    if (!isManagedDatabase(path)) return db.prepare(sql);
    const marker = sql.indexOf(" VALUES ");
    if (marker < 0) throw new Error("Snapshot insert requires an explicit column list");
    const prefix = sql.slice(0, marker);
    let pending: Binding[][] = [], bytes = 0;
    const flush = () => {
      if (!pending.length) return;
      const values = pending.map((row) => "(" + row.map(() => "?").join(",") + ")").join(",");
      const result = db.prepare(prefix + " VALUES " + values).run(...pending.flat());
      if (Number(result.changes) !== pending.length) throw new Error("Snapshot row count differs");
      pending = []; bytes = 0;
    };
    flushes.push(flush);
    return { run(...values: Binding[]) {
      if (sql.startsWith("INSERT INTO samples(")) values[4] = encodeSampleDetail(values[4]);
      pending.push(values);
      bytes += values.reduce((size, value) => size + (typeof value === "string"
        ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0);
      if (pending.length >= 200 || bytes >= 1024 * 1024) flush();
    } };
  };
  const stmt = {
    aa: prepareLeaf("INSERT INTO agent_account(run_id, agent, account, cost, calls, sessions) VALUES (?,?,?,?,?,?)"),
    tools: prepareLeaf("INSERT INTO tools(run_id, agent, tool, calls, arg_tok, result_tok, ctx_cost) VALUES (?,?,?,?,?,?,?)"),
    commands: prepareLeaf("INSERT INTO commands(run_id, agent, command, is_deep, calls, arg_tok, result_tok, ctx_cost) VALUES (?,?,?,?,?,?,?,?)"),
    prompts: prepareLeaf("INSERT INTO prompts(run_id, agent, project, cost, tool_calls, out_tok, text) VALUES (?,?,?,?,?,?,?)"),
    models: prepareLeaf("INSERT INTO models(run_id, agent, model, calls, in_tok, out_tok, cache_rd, cache_wr, cost) VALUES (?,?,?,?,?,?,?,?,?)"),
    projects: prepareLeaf("INSERT INTO projects(run_id, agent, project, cost) VALUES (?,?,?,?)"),
    targets: prepareLeaf("INSERT INTO targets(run_id, agent, command, calls, ctx_cost, err_pct, reason, score) VALUES (?,?,?,?,?,?,?,?)"),
    samples: prepareLeaf("INSERT INTO samples(run_id, agent, scope, key, detail, count, result_tok) VALUES (?,?,?,?,?,?,?)"),
  };

  const tx = db.transaction(() => {
    if (snapshotKey) {
      const prior = db.query<{ run_id: number; row_count: number }, [string]>(
        "SELECT run_id,row_count FROM _spendwatch_snapshot_receipts WHERE id=?").get(snapshotKey);
      if (prior) { rows = prior.row_count; return prior.run_id; }
    }
    const info = insertRun.run(opts.generatedAt, new Date(opts.generatedAt).toISOString(), opts.days, total);
    const runId = Number(info.lastInsertRowid);
    for (const r of live) {
      const a = r.source;
      for (const x of r.accounts) (stmt.aa.run(runId, a, x.account, x.cost, x.calls, x.sessions), rows++);
      for (const t of r.tools) {
        stmt.tools.run(runId, a, t.name, t.calls, t.argTok, t.resultTok, t.ctxCost);
        rows++;
        for (const s of t.samples ?? []) (stmt.samples.run(runId, a, "tool", t.name, s.detail, s.count, s.resultTok), rows++);
      }
      for (const c of r.bash) (stmt.commands.run(runId, a, c.name, 0, c.calls, c.argTok, c.resultTok, c.ctxCost), rows++);
      for (const c of r.deep) {
        stmt.commands.run(runId, a, c.name, 1, c.calls, c.argTok, c.resultTok, c.ctxCost);
        rows++;
        for (const s of c.samples ?? []) (stmt.samples.run(runId, a, "deep", c.name, s.detail, s.count, s.resultTok), rows++);
      }
      for (const p of r.prompts) (stmt.prompts.run(runId, a, p.project, p.cost, p.toolCalls, p.outTok, p.text.replace(/\s+/g, " ").trim().slice(0, 400)), rows++);
      for (const m of r.models) (stmt.models.run(runId, a, m.model, m.calls, m.inTok, m.outTok, m.cacheReadTok, m.cacheWriteTok, m.cost), rows++);
      for (const pr of r.projects) (stmt.projects.run(runId, a, pr.project, pr.cost), rows++);
      for (const t of r.targets) (stmt.targets.run(runId, a, t.command, t.calls, t.ctxCost, t.errPct, t.reason, t.score), rows++);
    }
    for (const flush of flushes) flush();
    if (snapshotKey) db.prepare("INSERT INTO _spendwatch_snapshot_receipts VALUES(?,?,?)")
      .run(snapshotKey, runId, rows);
    return runId;
  });

  const runId = tx() as number;
  db.close();
  return { runId, rows };
}

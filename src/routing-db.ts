import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RoutePlan } from "./routing";
import type { ExecutionResult } from "./model-executors";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, policy_version TEXT, task TEXT, repo TEXT,
  planned_model TEXT, planned_effort TEXT, actual_model TEXT, provider TEXT, shadow INTEGER,
  status TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER, attempts INTEGER,
  estimated_cost REAL, plan_json TEXT, verification_json TEXT, output TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS routing_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, attempt INTEGER, provider TEXT, model TEXT,
  effort TEXT, started_at TEXT, duration_ms INTEGER, exit_code INTEGER, passed INTEGER,
  estimated_cost REAL, verification_json TEXT, usage_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_runs_task ON routing_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_routing_attempts_run ON routing_attempts(run_id);
`;

export interface AttemptRecord {
  attempt: number;
  model: string;
  effort: string;
  startedAt: string;
  durationMs: number;
  result: ExecutionResult;
  verification: Array<{ command: string; ok: boolean; exitCode: number; output: string }>;
}

export class RoutingStore {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.ensureColumn("routing_runs", "estimated_cost", "REAL");
    this.ensureColumn("routing_runs", "plan_json", "TEXT");
    this.ensureColumn("routing_attempts", "estimated_cost", "REAL");
  }
  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  start(plan: RoutePlan, shadow: boolean): number {
    const result = this.db.prepare(`INSERT INTO routing_runs
      (task_id,policy_version,task,repo,planned_model,planned_effort,shadow,status,started_at,plan_json)
      VALUES (?,?,?,?,?,?,?,'running',?,?)`).run(
        plan.taskId, plan.policyVersion, plan.task, plan.repo, plan.decision.model,
        plan.decision.effort, shadow ? 1 : 0, new Date().toISOString(), JSON.stringify(plan),
      );
    return Number(result.lastInsertRowid);
  }
  attempt(runId: number, record: AttemptRecord): void {
    this.db.prepare(`INSERT INTO routing_attempts
      (run_id,attempt,provider,model,effort,started_at,duration_ms,exit_code,passed,estimated_cost,verification_json,usage_json,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        runId, record.attempt, record.result.provider, record.model, record.effort, record.startedAt,
        record.durationMs, record.result.exitCode, record.result.ok && record.verification.every((x) => x.ok) ? 1 : 0,
        record.result.estimatedCost ?? null, JSON.stringify(record.verification), JSON.stringify(record.result.usage ?? null), record.result.error ?? null,
      );
  }
  finish(runId: number, status: "succeeded" | "failed", records: AttemptRecord[], output: string, error?: string): void {
    const last = records.at(-1);
    const duration = records.reduce((sum, record) => sum + record.durationMs, 0);
    const estimatedCost = records.reduce((sum, record) => sum + (record.result.estimatedCost ?? 0), 0);
    this.db.prepare(`UPDATE routing_runs SET actual_model=?,provider=?,status=?,finished_at=?,duration_ms=?,attempts=?,estimated_cost=?,verification_json=?,output=?,error=? WHERE id=?`).run(
      last?.model ?? null, last?.result.provider ?? null, status, new Date().toISOString(), duration, records.length,
      estimatedCost, JSON.stringify(last?.verification ?? []), output.slice(0, 20_000), error ?? null, runId,
    );
  }
  close(): void { this.db.close(); }
}

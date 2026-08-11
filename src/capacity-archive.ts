import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openCapacityDatabase } from "./capacity-db";

const DAY_MS = 86_400_000;
const WINDOW_COLUMNS = [
  "sample_key", "provider", "account", "window_kind", "sampled_at_ms", "observed_at",
  "used_percent", "resets_at_ms", "window_minutes", "source", "devices",
  "prediction_delta", "prediction_expected", "prediction_will_last", "prediction_runs_out_at_ms",
] as const;
const ACCOUNT_COLUMNS = [
  "sample_key", "provider", "account", "sampled_at_ms", "observed_at", "plan", "organization", "devices",
  "copilot_chat_unlimited", "copilot_completions_unlimited", "copilot_premium_unlimited",
  "copilot_premium_credits_used", "copilot_overage_permitted", "copilot_token_based_billing",
  "copilot_resets_at_ms", "copilot_seat_assigned_at_ms", "api_balance_available", "api_balances_json",
] as const;

export interface CapacityArchiveOptions {
  database: string;
  archiveDir?: string;
  keepDays?: number;
  before?: number;
  force?: boolean;
  vacuum?: boolean;
  now?: number;
}

export interface CapacityArchiveResult {
  dryRun: boolean;
  cutoff: string;
  eligible: { windows: number; accounts: number };
  archive?: string;
  deleted: { windows: number; accounts: number };
  bytes: { before: number; after: number };
}

interface ArchiveMetadata {
  schema_version: number;
  cutoff_ms: number;
  window_rows: number;
  account_rows: number;
}

function countBefore(db: Database, table: string, cutoff: number): number {
  return Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE sampled_at_ms < ?`).get(cutoff) as { count: number }).count);
}

function safeArchiveDir(database: string, input?: string): string {
  const path = resolve(input ?? join(dirname(database), "archives"));
  if (path === resolve(database)) throw new Error("archive directory cannot be the database file");
  return path;
}

function archiveMetadata(path: string): ArchiveMetadata {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (integrity?.integrity_check !== "ok") throw new Error(`archive integrity check failed: ${integrity?.integrity_check ?? "missing"}`);
    const metadata = db.query("SELECT schema_version, cutoff_ms, window_rows, account_rows FROM archive_metadata").get() as ArchiveMetadata | null;
    if (!metadata || metadata.schema_version !== 1) throw new Error("unsupported or missing capacity archive metadata");
    const windows = Number((db.query("SELECT COUNT(*) AS count FROM capacity_history").get() as { count: number }).count);
    const accounts = Number((db.query("SELECT COUNT(*) AS count FROM capacity_account_history").get() as { count: number }).count);
    if (windows !== metadata.window_rows || accounts !== metadata.account_rows) throw new Error("capacity archive row-count verification failed");
    return metadata;
  } finally { db.close(); }
}

async function gzip(source: string, destination: string): Promise<void> {
  const child = Bun.spawn(["gzip", "-9", "-c", source], { stdout: Bun.file(destination), stderr: "pipe" });
  const [error, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`gzip failed: ${error.trim() || `exit ${exitCode}`}`);
  const check = Bun.spawnSync(["gzip", "-t", destination], { stdout: "ignore", stderr: "pipe" });
  if (check.exitCode !== 0) throw new Error(`archive compression verification failed: ${new TextDecoder().decode(check.stderr).trim()}`);
}

async function gunzip(source: string, destination: string): Promise<void> {
  const child = Bun.spawn(["gzip", "-dc", source], { stdout: Bun.file(destination), stderr: "pipe" });
  const [error, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`archive decompression failed: ${error.trim() || `exit ${exitCode}`}`);
}

function createArchive(database: string, destination: string, cutoff: number, createdAt: string): ArchiveMetadata {
  const db = openCapacityDatabase(database);
  try {
    db.prepare("ATTACH DATABASE ? AS archive").run(destination);
    const tx = db.transaction(() => {
      db.exec("CREATE TABLE archive.archive_metadata(schema_version INTEGER, created_at TEXT, cutoff_ms INTEGER, window_rows INTEGER, account_rows INTEGER)");
      db.exec(`CREATE TABLE archive.capacity_history AS SELECT ${WINDOW_COLUMNS.join(",")} FROM main.capacity_history WHERE sampled_at_ms < ${Math.round(cutoff)}`);
      db.exec(`CREATE TABLE archive.capacity_account_history AS SELECT ${ACCOUNT_COLUMNS.join(",")} FROM main.capacity_account_history WHERE sampled_at_ms < ${Math.round(cutoff)}`);
      const windowRows = Number((db.query("SELECT COUNT(*) AS count FROM archive.capacity_history").get() as { count: number }).count);
      const accountRows = Number((db.query("SELECT COUNT(*) AS count FROM archive.capacity_account_history").get() as { count: number }).count);
      db.prepare("INSERT INTO archive.archive_metadata VALUES (1,?,?,?,?)").run(createdAt, cutoff, windowRows, accountRows);
    });
    tx();
    db.exec("DETACH DATABASE archive");
  } finally { db.close(); }
  return archiveMetadata(destination);
}

function deleteArchived(database: string, restoredArchive: string, metadata: ArchiveMetadata): { windows: number; accounts: number } {
  const db = openCapacityDatabase(database);
  try {
    db.prepare("ATTACH DATABASE ? AS archive").run(restoredArchive);
    const deleted = db.transaction(() => {
      const windows = db.prepare("DELETE FROM main.capacity_history WHERE sample_key IN (SELECT sample_key FROM archive.capacity_history)").run().changes;
      const accounts = db.prepare("DELETE FROM main.capacity_account_history WHERE sample_key IN (SELECT sample_key FROM archive.capacity_account_history)").run().changes;
      if (windows !== metadata.window_rows || accounts !== metadata.account_rows) throw new Error("live rows changed during archival; cleanup rolled back safely");
      if (countBefore(db, "capacity_history", metadata.cutoff_ms) || countBefore(db, "capacity_account_history", metadata.cutoff_ms)) {
        throw new Error("new old-history rows appeared during archival; cleanup rolled back safely");
      }
      db.prepare(`
        INSERT INTO main.capacity_retention(id, history_floor_ms, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          history_floor_ms = MAX(history_floor_ms, excluded.history_floor_ms),
          updated_at = excluded.updated_at
      `).run(metadata.cutoff_ms, new Date().toISOString());
      return { windows, accounts };
    })();
    db.exec("DETACH DATABASE archive");
    return { windows: Number(deleted.windows), accounts: Number(deleted.accounts) };
  } finally { db.close(); }
}

export async function archiveCapacityHistory(options: CapacityArchiveOptions): Promise<CapacityArchiveResult> {
  const database = resolve(options.database);
  if (!existsSync(database) || !statSync(database).isFile()) throw new Error(`SQLite database not found: ${database}`);
  const now = options.now ?? Date.now();
  const keepDays = options.keepDays ?? 365;
  if (!Number.isInteger(keepDays) || keepDays < 30) throw new Error("keep-days must be an integer of at least 30");
  const cutoff = options.before ?? now - keepDays * DAY_MS;
  if (!Number.isFinite(cutoff) || cutoff >= now) throw new Error("archive cutoff must be in the past");
  const sizeBefore = statSync(database).size;
  const db = openCapacityDatabase(database);
  const eligible = { windows: countBefore(db, "capacity_history", cutoff), accounts: countBefore(db, "capacity_account_history", cutoff) };
  db.close();
  const base: CapacityArchiveResult = {
    dryRun: !options.force, cutoff: new Date(cutoff).toISOString(), eligible,
    deleted: { windows: 0, accounts: 0 }, bytes: { before: sizeBefore, after: sizeBefore },
  };
  if (!options.force || eligible.windows + eligible.accounts === 0) return base;

  const archiveDir = safeArchiveDir(database, options.archiveDir);
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  const createdAt = new Date(now).toISOString();
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  const finalPath = join(archiveDir, `capacity-before-${cutoffDate}-${stamp}.db.gz`);
  if (existsSync(finalPath)) throw new Error(`archive already exists: ${finalPath}`);
  const scratch = mkdtempSync(join(tmpdir(), "spendwatch-capacity-archive-"));
  const raw = join(scratch, "capacity.db");
  const restored = join(scratch, "restored.db");
  let pruned = false;
  try {
    const metadata = createArchive(database, raw, cutoff, createdAt);
    await gzip(raw, finalPath);
    chmodSync(finalPath, 0o600);
    await gunzip(finalPath, restored);
    const restoredMetadata = archiveMetadata(restored);
    if (JSON.stringify(metadata) !== JSON.stringify(restoredMetadata)) throw new Error("archive restore-drill metadata mismatch");
    const deleted = deleteArchived(database, restored, metadata);
    pruned = true;
    if (options.vacuum !== false) {
      const compact = openCapacityDatabase(database);
      try { compact.exec("VACUUM"); } finally { compact.close(); }
    }
    return { ...base, dryRun: false, archive: finalPath, deleted, bytes: { before: sizeBefore, after: statSync(database).size } };
  } catch (error) {
    if (!pruned && existsSync(finalPath)) rmSync(finalPath);
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function restoreCapacityArchive(databaseInput: string, archiveInput: string): Promise<{ archive: string; windows: number; accounts: number }> {
  const database = resolve(databaseInput);
  const archive = resolve(archiveInput);
  if (!existsSync(archive) || !statSync(archive).isFile()) throw new Error(`capacity archive not found: ${archive}`);
  mkdirSync(dirname(database), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "spendwatch-capacity-restore-"));
  const restored = join(scratch, basename(archive, ".gz"));
  try {
    await gunzip(archive, restored);
    archiveMetadata(restored);
    const db = openCapacityDatabase(database);
    try {
      db.prepare("ATTACH DATABASE ? AS archive").run(restored);
      const inserted = db.transaction(() => ({
        windows: Number(db.prepare(`INSERT OR IGNORE INTO main.capacity_history(${WINDOW_COLUMNS.join(",")}) SELECT ${WINDOW_COLUMNS.join(",")} FROM archive.capacity_history`).run().changes),
        accounts: Number(db.prepare(`INSERT OR IGNORE INTO main.capacity_account_history(${ACCOUNT_COLUMNS.join(",")}) SELECT ${ACCOUNT_COLUMNS.join(",")} FROM archive.capacity_account_history`).run().changes),
      }))();
      db.exec("DETACH DATABASE archive");
      return { archive, ...inserted };
    } finally { db.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

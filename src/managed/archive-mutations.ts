import { Database as LocalDatabase } from "bun:sqlite";
import { Database } from "../database";
import { rowDigest, fingerprint, archiveFingerprints, type ArchiveMetadata } from "./archive-snapshot";
import { quoteIdentifier } from "./sql-tokens";

function batches<T>(values: Iterable<T>, size = 400): Iterable<T[]> {
  return {
    *[Symbol.iterator]() {
      let batch: T[] = [];
      for (const value of values) {
        batch.push(value);
        if (batch.length === size) { yield batch; batch = []; }
      }
      if (batch.length) yield batch;
    },
  };
}

export function deleteManagedArchived(
  database: string, restored: string, metadata: ArchiveMetadata,
): { windows: number; accounts: number } {
  const proofs = archiveFingerprints(restored);
  const archive = new LocalDatabase(restored, { readonly: true, safeIntegers: true });
  const db = new Database(database, { safeIntegers: true });
  try {
    return db.transaction(() => {
      const counts = new Map<string, number>();
      for (const [table, proof] of proofs) {
        const hashes: Buffer[] = [];
        let deleted = 0;
        const names = proof.columns.map(quoteIdentifier).join(",");
        const keys = archive.query<{ sample_key: string }, []>(
          "SELECT sample_key FROM " + quoteIdentifier(table)).iterate();
        for (const batch of batches(keys)) {
          const values = batch.map((row) => row.sample_key), placeholders = values.map(() => "?").join(",");
          const rows = db.query<Record<string, unknown>, []>("SELECT " + names +
            " FROM " + quoteIdentifier(table) + " WHERE sample_key IN (" + placeholders + ")").all(...values as []);
          if (rows.length !== values.length) throw new Error("Live archive rows changed; pruning was rolled back");
          for (const row of rows) hashes.push(rowDigest(proof.columns.map((column) => row[column])));
          deleted += Number(db.prepare("DELETE FROM " + quoteIdentifier(table) +
            " WHERE sample_key IN (" + placeholders + ")").run(...values).changes);
        }
        const actual = fingerprint(hashes);
        if (actual.rowCount !== proof.rowCount || actual.sha256 !== proof.sha256 || deleted !== proof.rowCount) {
          throw new Error("Live archive values changed; pruning was rolled back");
        }
        const remaining = db.query<{ n: bigint }, [number]>("SELECT COUNT(*) AS n FROM " +
          quoteIdentifier(table) + " WHERE sampled_at_ms < ?").get(metadata.cutoff_ms);
        if (remaining?.n !== 0n) throw new Error("New old-history rows appeared; pruning was rolled back");
        counts.set(table, deleted);
      }
      db.prepare(`INSERT INTO capacity_retention(id,history_floor_ms,updated_at) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET history_floor_ms=MAX(history_floor_ms,excluded.history_floor_ms),
        updated_at=excluded.updated_at`).run(metadata.cutoff_ms, new Date().toISOString());
      return { windows: counts.get("capacity_history")!, accounts: counts.get("capacity_account_history")! };
    })();
  } finally { archive.close(); db.close(); }
}

export function restoreManagedArchive(
  database: string, restored: string, windowColumns: readonly string[], accountColumns: readonly string[],
): { windows: number; accounts: number } {
  const archive = new LocalDatabase(restored, { readonly: true, safeIntegers: true });
  const db = new Database(database, { safeIntegers: true });
  try {
    return db.transaction(() => {
      const counts = new Map<string, number>();
      for (const [table, columns] of [
        ["capacity_history", windowColumns], ["capacity_account_history", accountColumns],
      ] as const) {
        const names = columns.map(quoteIdentifier).join(",");
        const statement = db.prepare("INSERT OR IGNORE INTO " + quoteIdentifier(table) +
          "(" + names + ") VALUES(" + columns.map(() => "?").join(",") + ")");
        let count = 0;
        for (const row of archive.query<Record<string, unknown>, []>(
            "SELECT " + names + " FROM " + quoteIdentifier(table)).iterate()) {
          const values = columns.map((column) => row[column]);
          count += Number(statement.run(...values as (string | number | bigint | Uint8Array | null)[]).changes);
        }
        counts.set(table, count);
      }
      return { windows: counts.get("capacity_history")!, accounts: counts.get("capacity_account_history")! };
    })();
  } finally { archive.close(); db.close(); }
}

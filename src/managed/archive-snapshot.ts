import { Database as LocalDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Database } from "../database";
import { quoteIdentifier } from "./sql-tokens";

export interface ArchiveMetadata {
  schema_version: number;
  cutoff_ms: number;
  window_rows: number;
  account_rows: number;
}
export interface TableFingerprint {
  columns: string[];
  rowCount: number;
  sha256: string;
}
export function rowDigest(values: unknown[]): Buffer {
  const encoded = values.map((value) => {
    if (value === null) return ["null"];
    if (typeof value === "bigint") return ["integer", value.toString()];
    if (typeof value === "number") {
      const buffer = Buffer.alloc(8); buffer.writeDoubleBE(value);
      return ["real", buffer.toString("hex")];
    }
    if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
    if (typeof value === "string") return ["text", value];
    throw new Error("Unsupported archive value");
  });
  return createHash("sha256").update(JSON.stringify(encoded)).digest();
}
export function fingerprint(hashes: Buffer[]): { rowCount: number; sha256: string } {
  hashes.sort(Buffer.compare);
  const digest = createHash("sha256");
  for (const value of hashes) digest.update(value);
  return { rowCount: hashes.length, sha256: digest.digest("hex") };
}

export function createManagedArchive(
  database: string, destination: string, cutoff: number, createdAt: string,
  windowColumns: readonly string[], accountColumns: readonly string[],
): ArchiveMetadata {
  const source = new Database(database, { readonly: true, safeIntegers: true });
  const archive = new LocalDatabase(destination, { safeIntegers: true });
  const proofs = new Map<string, TableFingerprint>();
  const pending = new Map<string, { columns: string[]; hashes: Buffer[] }>();
  try {
    source.exec("BEGIN");
    archive.exec("BEGIN");
    for (const [table, selected] of [
      ["capacity_history", windowColumns], ["capacity_account_history", accountColumns],
    ] as const) {
      const catalog = source.query<{ name: string; type: string }, []>(
        "PRAGMA table_info(" + table + ")").all();
      const types = new Map(catalog.map((column) => [column.name, column.type]));
      for (const column of selected) {
        if (!["INTEGER", "REAL", "TEXT", "BLOB"].includes(types.get(column) ?? "")) {
          throw new Error("Archive schema requires explicit admission");
        }
      }
      archive.exec("CREATE TABLE " + quoteIdentifier(table) + "(" + selected.map(
        (column) => quoteIdentifier(column) + " " + types.get(column)).join(",") + ")");
      const names = selected.map(quoteIdentifier).join(",");
      const insert = archive.prepare("INSERT INTO " + quoteIdentifier(table) +
        "(" + names + ") VALUES(" + selected.map(() => "?").join(",") + ")");
      const hashes: Buffer[] = [];
      let lastTime: bigint | undefined, lastKey: string | undefined;
      for (;;) {
        const after = lastTime === undefined ? "" :
          " AND (sampled_at_ms > ? OR (sampled_at_ms = ? AND sample_key > ?))";
        const values = lastTime === undefined ? [Math.round(cutoff)] :
          [Math.round(cutoff), lastTime, lastTime, lastKey!];
        const batch = source.query<Record<string, unknown>, []>("SELECT " + names +
          " FROM " + quoteIdentifier(table) + " WHERE sampled_at_ms < ?" + after +
          " ORDER BY sampled_at_ms,sample_key LIMIT 1000").all(...values as []);
        if (!batch.length) break;
        for (const row of batch) {
          const fields = selected.map((column) => row[column]);
          insert.run(...fields as (string | number | bigint | Uint8Array | null)[]);
          hashes.push(rowDigest(fields));
        }
        const final = batch.at(-1)!;
        lastTime = BigInt(final.sampled_at_ms as bigint);
        lastKey = String(final.sample_key);
      }
      pending.set(table, { columns: [...selected], hashes });
    }
    source.exec("COMMIT");
    for (const [table, value] of pending) {
      proofs.set(table, { columns: value.columns, ...fingerprint(value.hashes) });
    }
    archive.exec("CREATE TABLE archive_metadata(schema_version INTEGER,created_at TEXT," +
      "cutoff_ms INTEGER,window_rows INTEGER,account_rows INTEGER)");
    archive.exec("CREATE TABLE archive_row_fingerprints(table_name TEXT PRIMARY KEY," +
      "columns_json TEXT NOT NULL,sha256 TEXT NOT NULL,row_count INTEGER NOT NULL)");
    for (const [table, proof] of proofs) {
      archive.run("INSERT INTO archive_row_fingerprints VALUES(?,?,?,?)",
        table, JSON.stringify(proof.columns), proof.sha256, proof.rowCount);
    }
    const windows = proofs.get("capacity_history")!.rowCount;
    const accounts = proofs.get("capacity_account_history")!.rowCount;
    archive.run("INSERT INTO archive_metadata VALUES(1,?,?,?,?)", createdAt, cutoff, windows, accounts);
    archive.exec("COMMIT");
    return { schema_version: 1, cutoff_ms: cutoff, window_rows: windows, account_rows: accounts };
  } catch (error) {
    try { source.exec("ROLLBACK"); } catch {}
    try { archive.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { source.close(); archive.close(); }
}

export function archiveFingerprints(path: string): Map<string, TableFingerprint> {
  const archive = new LocalDatabase(path, { readonly: true, safeIntegers: true });
  const results = new Map<string, TableFingerprint>();
  try {
    const exists = archive.query("SELECT 1 FROM sqlite_master WHERE name='archive_row_fingerprints'").get();
    if (!exists) throw new Error("Managed pruning requires verified row fingerprints");
    const records = archive.query<{ table_name: string; columns_json: string; sha256: string; row_count: bigint }, []>(
      "SELECT * FROM archive_row_fingerprints").all();
    if (records.length !== 2) throw new Error("Incomplete archive fingerprints");
    for (const record of records) {
      if (!["capacity_history", "capacity_account_history"].includes(record.table_name)) {
        throw new Error("Unadmitted archive table");
      }
      const columns = JSON.parse(record.columns_json) as unknown;
      if (!Array.isArray(columns) || !columns.length ||
          !columns.every((value) => typeof value === "string" && /^[a-z_]+$/.test(value))) {
        throw new Error("Invalid archive column metadata");
      }
      const hashes = [];
      for (const row of archive.query<Record<string, unknown>, []>("SELECT " +
          columns.map(quoteIdentifier).join(",") + " FROM " + quoteIdentifier(record.table_name)).iterate()) {
        hashes.push(rowDigest(columns.map((name) => row[name])));
      }
      const actual = fingerprint(hashes);
      if (actual.rowCount !== Number(record.row_count) || actual.sha256 !== record.sha256) {
        throw new Error("Independent archive row fingerprint mismatch");
      }
      results.set(record.table_name, { columns, ...actual });
    }
    return results;
  } finally { archive.close(); }
}

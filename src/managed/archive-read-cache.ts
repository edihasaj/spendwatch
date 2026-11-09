// Disposable report reads: PostgreSQL remains the authority on every access.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type { PgResult } from "./libpq";
import { sqlTokens } from "./sql-tokens";

const normalize = (sql: string) => sqlTokens(sql).map(token =>
  token.kind === "word" ? token.text.toUpperCase() : token.text).join(" ");

// Only these deterministic archive readers qualify. Other SQL always reaches PG.
const READS = new Set([
  `SELECT m.month, m.source, m.tokens, m.cost, m.calls, m.sessions, m.first_ts AS firstTs, m.updated_at AS updatedAt,
    r.report_json AS reportJson FROM spend_month m LEFT JOIN spend_report r
    ON r.month=m.month AND r.source=m.source ORDER BY m.month DESC, m.tokens DESC`,
  `SELECT month, source, report_json FROM spend_report
    WHERE report_json LIKE '%"gatewayBilled"%' OR report_json LIKE '%"gatewayUnconfirmed"%' ORDER BY month, source`,
  `SELECT m.month,m.source,m.tokens,m.updated_at,r.report_json FROM spend_month m
    LEFT JOIN spend_report r ON r.month=m.month AND r.source=m.source ORDER BY m.month,m.source`,
  `SELECT r.month,r.source,r.report_json,m.tokens AS storedTokens FROM spend_report r
    LEFT JOIN spend_month m ON m.month=r.month AND m.source=r.source ORDER BY r.month,r.source`,
].map(normalize));

export function archiveVersionQuery(sql: string): string | undefined {
  const normalized = normalize(sql);
  if (!READS.has(normalized)) return undefined;
  const tables = normalized.includes("SPEND_MONTH") ? ["spend_report", "spend_month"] : ["spend_report"];
  const versions = tables.map(table => `COALESCE((SELECT string_agg(v, ',' ORDER BY v) FROM
    (SELECT json_build_array(tableoid::text,month,source,xmin::text,ctid::text)::text AS v FROM ${table}) rows), '')`);
  // OID and boot time fence database recreation/recovery; epoch fences XID wrap.
  return `SELECT encode(sha256(convert_to(concat_ws('|', pg_postmaster_start_time()::text,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()),
    (txid_snapshot_xmax(txid_current_snapshot()) / 4294967296)::text,
    ${versions.join(",")}), 'UTF8')), 'hex') AS version`;
}

const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

export function cachedArchiveRead(
  root: string, identity: string, sql: string, version: string, read: () => PgResult,
): PgResult {
  const directory = join(root, ".report-read-cache");
  const path = join(directory, digest(identity + "\n" + normalize(sql)) + ".bin");
  try {
    const folder = lstatSync(directory);
    const file = lstatSync(path);
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) ||
        !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw Error("Unsafe cache path");
    const stored = readFileSync(path), body = stored.subarray(130);
    if (stored.subarray(0, 65).toString() === digest(version) + "\n" &&
        stored.subarray(65, 130).toString() === digest(body) + "\n") {
      const result = deserialize(body) as PgResult;
      if (!Array.isArray(result.rows) || !Array.isArray(result.columns) || typeof result.changes !== "number") {
        throw Error("Invalid cached result");
      }
      return result;
    }
  } catch { /* Missing or corrupt local data is a cache miss, never a stale fallback. */ }
  const result = read();
  let temporary: string | undefined;
  let descriptor: number | undefined;
  try {
    // Archive queries return scalar text/numbers, never binary-origin values.
    if (result.columns.some(column => column.type === 17)) return result;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077)) return result;
    const body = serialize(result);
    temporary = path + "." + randomUUID();
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, digest(version) + "\n" + digest(body) + "\n");
    writeFileSync(descriptor, body);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } catch { /* Optional cache storage must not prevent a verified database read. */ }
  finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporary) try { unlinkSync(temporary); } catch { /* Already renamed. */ }
  }
  return result;
}

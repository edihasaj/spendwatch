import { expect, test } from "bun:test";
import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveVersionQuery, cachedArchiveRead } from "../src/managed/archive-read-cache";
import type { PgResult } from "../src/managed/libpq";
import { tempDir } from "./tmp";

const sql = `SELECT month, source, report_json FROM spend_report
  WHERE report_json LIKE '%"gatewayBilled"%' OR report_json LIKE '%"gatewayUnconfirmed"%' ORDER BY month, source`;
const result = (text: string): PgResult => ({ rows: [{ body: text, tokens: 9007199254740993n, empty: null }], changes: 0,
  columns: [{ name: "body", type: 25, table: 1, column: 1 }, { name: "tokens", type: 20, table: 1, column: 2 },
    { name: "empty", type: 20, table: 1, column: 3 }] });

test("only exact deterministic report readers are cached", () => {
  expect(archiveVersionQuery(sql)).toContain("spend_report");
  expect(archiveVersionQuery(sql.replace("ORDER BY month, source", "ORDER BY random()"))).toBeUndefined();
  expect(archiveVersionQuery("SELECT report_json, clock_timestamp() FROM spend_report")).toBeUndefined();
  expect(archiveVersionQuery("DELETE FROM spend_report RETURNING report_json")).toBeUndefined();
});

test("reuses bytes across processes, preserves int64/nulls and invalidates changes and deletion", () => {
  const root = tempDir("archive-read-cache-");
  let reads = 0;
  const read = () => { reads++; return result("first"); };
  expect(cachedArchiveRead(root, "db", sql, "v1", read)).toEqual(result("first"));
  expect(cachedArchiveRead(root, "db", sql, "v1", read)).toEqual(result("first"));
  expect(reads).toBe(1);
  expect(cachedArchiveRead(root, "db", sql, "v2", () => result("changed"))).toEqual(result("changed"));
  const empty = { rows: [], changes: 0, columns: [] };
  expect(cachedArchiveRead(root, "db", sql, "deleted", () => empty)).toEqual(empty);
  expect(readdirSync(join(root, ".report-read-cache"))).toHaveLength(1);
});

test("separates database identities and repairs corrupt cache without stale fallback", () => {
  const root = tempDir("archive-read-cache-");
  cachedArchiveRead(root, "one", sql, "v1", () => result("one"));
  expect(cachedArchiveRead(root, "two", sql, "v1", () => result("two"))).toEqual(result("two"));
  for (const file of readdirSync(join(root, ".report-read-cache"))) {
    writeFileSync(join(root, ".report-read-cache", file), "corrupt");
  }
  expect(() => cachedArchiveRead(root, "one", sql, "v1", () => { throw Error("database failed"); }))
    .toThrow("database failed");
  expect(cachedArchiveRead(root, "one", sql, "v1", () => result("repaired"))).toEqual(result("repaired"));
});

test("a nonprivate cache directory never serves saved private results", () => {
  const root = tempDir("archive-read-cache-");
  cachedArchiveRead(root, "one", sql, "v1", () => result("old"));
  chmodSync(join(root, ".report-read-cache"), 0o755);
  expect(cachedArchiveRead(root, "one", sql, "v1", () => result("fresh"))).toEqual(result("fresh"));
});

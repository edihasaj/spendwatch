import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ManagedPostgresDatabase } from "../src/managed/postgres-db";
import { PgConnection } from "../src/managed/libpq";
import { tempDir } from "./tmp";

const fixture = process.env.SPENDWATCH_TEST_PG_CONFIG;
const suite = fixture ? describe : describe.skip;
const sql = `SELECT month, source, report_json FROM spend_report
  WHERE report_json LIKE '%"gatewayBilled"%' OR report_json LIKE '%"gatewayUnconfirmed"%' ORDER BY month, source`;

suite("managed archive cache with real PostgreSQL", () => {
  test("fresh versions preserve snapshot isolation, changes, deletion and permission revocation", () => {
    const options = JSON.parse(readFileSync(fixture!, "utf8")) as Record<string, string>;
    if (options.host !== "127.0.0.1" || options.port !== "15487" || options.dbname !== "postgres") {
      throw Error("Isolated loopback fixture required");
    }
    const name = "spendwatch_test_" + randomUUID().replaceAll("-", "");
    const role = "cache_test_" + randomUUID().replaceAll("-", "");
    const admin = new PgConnection(options);
    admin.query(`CREATE DATABASE "${name}"`);
    admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-cache-test'`);
    const writer = new PgConnection({ ...options, dbname: name });
    let reader: ManagedPostgresDatabase | undefined;
    const previous = process.env.SPENDWATCH_SERVER_ROOT;
    process.env.SPENDWATCH_SERVER_ROOT = tempDir("archive-pg-cache-");
    try {
      writer.query("CREATE TABLE spend_report(month text,source text,report_json text)");
      writer.query(`INSERT INTO spend_report VALUES('2026-11','fixture',$1)`, ['{"gatewayBilled":["old"]}']);
      writer.query(`GRANT SELECT ON spend_report TO "${role}"`);
      const connection = { ...options, dbname: name, user: role, password: "isolated-cache-test" };
      reader = new ManagedPostgresDatabase(connection, { readonly: true });
      expect(reader.query(sql).all()).toEqual([{ month: "2026-11", source: "fixture", report_json: '{"gatewayBilled":["old"]}' }]);
      reader.close();
      reader = new ManagedPostgresDatabase(connection, { readonly: true });
      expect(reader.query(sql).all()).toHaveLength(1);
      reader.begin();
      reader.query(sql).all();
      writer.query("UPDATE spend_report SET report_json=$1", ['{"gatewayBilled":["new"]}']);
      expect(reader.query<{ report_json: string }>(sql).all()[0]!.report_json).toContain("old");
      reader.commit();
      expect(reader.query<{ report_json: string }>(sql).all()[0]!.report_json).toContain("new");
      writer.query(`REVOKE SELECT ON spend_report FROM "${role}"`);
      writer.query(`GRANT SELECT(month,source) ON spend_report TO "${role}"`);
      expect(() => reader!.query(sql).all()).toThrow();
      writer.query(`GRANT SELECT ON spend_report TO "${role}"`);
      writer.query("DELETE FROM spend_report");
      expect(reader.query(sql).all()).toEqual([]);
    } finally {
      reader?.close(); writer.close();
      admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      admin.query(`DROP ROLE "${role}"`); admin.close();
      if (previous === undefined) delete process.env.SPENDWATCH_SERVER_ROOT;
      else process.env.SPENDWATCH_SERVER_ROOT = previous;
    }
  });
});

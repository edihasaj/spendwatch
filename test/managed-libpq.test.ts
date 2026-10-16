import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ManagedDatabaseError, PgConnection } from "../src/managed/libpq";

const path = process.env.SPENDWATCH_TEST_PG_CONFIG;
const suite = path ? describe : describe.skip;
function connection(timeout?: number): PgConnection {
  const options = JSON.parse(readFileSync(path!, "utf8")) as Record<string, string>;
  if (options.host !== "127.0.0.1" || options.port !== "15487") {
    throw new Error("Transport regression tests require the isolated loopback fixture");
  }
  return new PgConnection(options, timeout);
}
suite("native PostgreSQL transport", () => {
  test("preserves signed 64-bit values, blobs, empty blobs and Unicode", () => {
    const db = connection();
    try {
      const values = [-(2n ** 63n), 2n ** 63n - 1n];
      for (const value of values) {
        const row = db.query("SELECT $1::bigint AS n,$2::bytea AS b,$3::text AS t",
          [value, Buffer.from([0, 255, 7]), "Shëndetësi"]).rows[0]!;
        expect(row.n).toBe(value);
        expect(row.b).toEqual(Buffer.from([0, 255, 7]));
        expect(row.t).toBe("Shëndetësi");
      }
      expect(db.query("SELECT $1::bytea AS b", [Buffer.alloc(0)]).rows[0]!.b).toEqual(Buffer.alloc(0));
      expect(db.query("SELECT $1::text AS n", [null]).rows[0]!.n).toBeNull();
    } finally { db.close(); }
  });
  test("binds SQL-looking input as data and rolls back constraints atomically", () => {
    const db = connection();
    try {
      db.query("CREATE TEMP TABLE fidelity(id bigint PRIMARY KEY,value text)");
      const input = "'); DROP TABLE fidelity; --";
      db.query("INSERT INTO fidelity VALUES($1,$2)", [1, input]);
      expect(db.query("SELECT value FROM fidelity").rows[0]!.value).toBe(input);
      db.query("BEGIN");
      db.query("INSERT INTO fidelity VALUES($1,$2)", [2, "transaction"]);
      try {
        db.query("INSERT INTO fidelity VALUES($1,$2)", [1, "conflict"]);
        throw new Error("A duplicate primary key was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedDatabaseError);
        expect((error as ManagedDatabaseError).code).toBe("23505");
      }
      db.query("ROLLBACK");
      expect(db.query("SELECT count(*) AS n FROM fidelity").rows[0]!.n).toBe(1n);
    } finally { db.close(); }
  });
  test("socket waits have a deadline and a closed connection cannot replay a query", () => {
    const db = connection(50), started = performance.now();
    try {
      expect(() => db.query("SELECT pg_sleep(1)")).toThrow(ManagedDatabaseError);
      expect(performance.now() - started).toBeLessThan(500);
      expect(() => db.query("SELECT 1")).toThrow(ManagedDatabaseError);
    } finally { db.close(); }
  });
});

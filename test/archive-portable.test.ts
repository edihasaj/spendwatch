// The archive SQL that must run unchanged on Bun's SQLite and through the managed PostgreSQL layer:
// no pragma_table_info(), no rowid, and no SQLite JSON functions, with the same behaviour either way.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Report } from "../src/aggregate";
import { archivedCoverage } from "../src/gateway-settle";
import { addArchiveColumns, archiveSource, initReportArchive, storedArchiveSource } from "../src/spend-report-archive";

const columns = (db: Database, table: string) =>
  db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);

describe("addArchiveColumns without pragma_table_info()", () => {
  test("adds the three columns once, and a second call changes nothing", () => {
    const db = new Database(":memory:");
    // The month table as an archive from before the columns had it.
    db.exec(`CREATE TABLE spend_month (month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL,
      PRIMARY KEY (month, source))`);
    addArchiveColumns(db, "spend_month");
    expect(columns(db, "spend_month")).toEqual(["month", "source", "calls", "observed_calls", "ledger", "routed_calls"]);
    addArchiveColumns(db, "spend_month");
    expect(columns(db, "spend_month")).toEqual(["month", "source", "calls", "observed_calls", "ledger", "routed_calls"]);
    db.close();
  });

  test("the report table the init already brought up is left as it is", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    const before = columns(db, "spend_report");
    expect(before).toContain("observed_calls");
    addArchiveColumns(db, "spend_report");
    expect(columns(db, "spend_report")).toEqual(before);
    db.close();
  });

  test("throws for a table outside the fixed set, as the name is interpolated into SQL", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    expect(() => addArchiveColumns(db, "spend_token_day")).toThrow("not an archive table");
    expect(() => addArchiveColumns(db, "sqlite_master")).toThrow("not an archive table");
    expect(() => addArchiveColumns(db, "spend_report; DROP TABLE spend_installation")).toThrow("not an archive table");
    expect(columns(db, "spend_installation")).toContain("archive_source");
    db.close();
  });
});

describe("the installation queries without rowid", () => {
  test("the plain installation is first when the rowids are not", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    // The same set an ordered archive holds, filed so that rowid order would start elsewhere.
    const insert = db.prepare("INSERT INTO spend_installation VALUES (?,?,?)");
    insert.run("macbook:codex", "i2", "macbook:codex (installation 2)");
    insert.run("macbook:codex", "i10", "macbook:codex (installation 10)");
    insert.run("macbook:codex", "i1", "macbook:codex");
    expect(storedArchiveSource(db, "macbook:codex")).toBe("macbook:codex");
    expect(storedArchiveSource(db, "macbook:codex", "i10")).toBe("macbook:codex (installation 10)");
    expect(archiveSource(db, { source: "macbook:codex" } as Report)).toBe("macbook:codex");
    db.close();
  });

  test("installations made through archiveSource still return the first one's archive source", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    const report = (installationId?: string) => ({ source: "x", ...(installationId ? { installationId } : {}) }) as Report;
    expect(archiveSource(db, report("a"))).toBe("x");
    for (let i = 2; i <= 10; i++) expect(archiveSource(db, report(`id${i}`))).toBe(`x (installation ${i})`);
    expect(storedArchiveSource(db, "x", "id10")).toBe("x (installation 10)");
    expect(storedArchiveSource(db, "x")).toBe("x");
    expect(archiveSource(db, report())).toBe("x");
    db.close();
  });
});

describe("archivedCoverage without the SQLite JSON functions", () => {
  const call = (id: string) => ({
    id, ts: 1, model: "gpt-5.5", account: "me@example.com", project: "app",
    tokens: 100, inTok: 90, outTok: 10, cacheReadTok: 0, cacheWriteTok: 0, cost: 0.01,
  });
  const reportJson = (fields: Record<string, unknown>) => JSON.stringify({ month: "x", ...fields });
  const insert = (db: Database, month: string, source: string, report_json: string) =>
    db.prepare("INSERT INTO spend_report (month, source, calls, report_json, updated_at) VALUES (?,?,0,?,1)").run(month, source, report_json);

  test("billed ids settle other rows' unconfirmed calls; junk is skipped the way json_each and json_valid skipped it", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    // This row's billed ids settle the calls of the rows below it, and it keeps an uncovered call of its own.
    insert(db, "2026-09", "a:codex", reportJson({ gatewayBilled: ["id1", "id2"], gatewayUnconfirmed: [call("other")] }));
    insert(db, "2026-09", "b:codex", reportJson({ gatewayUnconfirmed: [call("id1"), call("unstuck")] }));
    insert(db, "2026-09", "g:codex", reportJson({ gatewayUnconfirmed: [call("id2"), call("id1")] }));
    // Numbers, strings and objects-as-data among the entries: the wrong types are ignored, as before.
    insert(db, "2026-10", "c:codex", reportJson({ gatewayBilled: [123, { id: "x" }, "id3"], gatewayUnconfirmed: ["nope", call("id3"), 42] }));
    // Unparsable JSON that still names the field: skipped without throwing, and it settles nothing.
    insert(db, "2026-11", "d:codex", `{"gatewayBilled": ["id4"`);
    insert(db, "2026-11", "e:codex", reportJson({ gatewayUnconfirmed: [call("id4")] }));
    const coverage = archivedCoverage(db);
    expect([...coverage.keys()]).toEqual([
      JSON.stringify(["2026-09", "b:codex"]),
      JSON.stringify(["2026-09", "g:codex"]),
      JSON.stringify(["2026-10", "c:codex"]),
    ]);
    expect(coverage.get(JSON.stringify(["2026-09", "b:codex"]))).toEqual([call("id1")]);
    // Both billed calls of the first row, in the array's own order.
    expect(coverage.get(JSON.stringify(["2026-09", "g:codex"]))!.map((item) => item.id)).toEqual(["id2", "id1"]);
    expect(coverage.get(JSON.stringify(["2026-10", "c:codex"]))).toEqual([call("id3")]);
    db.close();
  });

  test("an archive with nothing billed settles nothing, and rows naming neither field are not read", () => {
    const db = new Database(":memory:");
    initReportArchive(db);
    insert(db, "2026-09", "a:codex", reportJson({ gatewayUnconfirmed: [call("id1")] }));
    insert(db, "2026-09", "b:codex", reportJson({ models: [], note: "gatewayBilled is only prose here" }));
    expect(archivedCoverage(db).size).toBe(0);
    db.close();
  });

  test("an archive without the report table stays empty", () => {
    const db = new Database(":memory:");
    expect(archivedCoverage(db).size).toBe(0);
    db.close();
  });
});

describe("addArchiveColumns with a concurrent writer", () => {
  /** A database whose first column list predates the columns, as another writer adds them just before this ALTER runs. */
  const racing = (afterwards: string[]) => {
    let reads = 0;
    const altered: string[] = [];
    const db = {
      query: () => ({ all: () => (reads++ === 0 ? [] : afterwards).map((name) => ({ name })) }),
      exec: (sql: string) => { altered.push(sql); throw new Error("duplicate column name"); },
    } as unknown as Database;
    return { db, altered };
  };

  test("a column another writer added in the meantime is not an error", () => {
    const { db, altered } = racing(["observed_calls", "ledger", "routed_calls"]);
    expect(() => addArchiveColumns(db, "spend_month")).not.toThrow();
    expect(altered.length).toBe(3);
  });

  test("a column that is still missing after a failed ALTER is", () => {
    const { db } = racing(["observed_calls"]);
    expect(() => addArchiveColumns(db, "spend_month")).toThrow("duplicate column name");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "../src/database";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { writeMonthlySpend, loadMonthlySpend } from "../src/spend-history";
import { addArchiveColumns, loadArchivedReports } from "../src/spend-report-archive";
import { archivedCoverage } from "../src/gateway-settle";
import { monthPeriod } from "../src/periods";
import type { Report, UnconfirmedCall } from "../src/aggregate";

const configPath = process.env.SPENDWATCH_TEST_PG_CONFIG;
const suite = configPath ? describe : describe.skip;

function fixture<T>(run: (path: string) => T): { sqlite: T; postgres: T } {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-pg-parity-"));
  const prior = process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
  delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
  try {
    const sqlite = run(join(root, "sqlite.db"));
    const connection = JSON.parse(readFileSync(configPath!, "utf8")) as Record<string, string>;
    if (connection.host !== "127.0.0.1" || connection.port !== "15487" || connection.dbname !== "postgres") {
      throw new Error("Business tests require the owned loopback fixture");
    }
    const name = "spendwatch_test_" + randomBytes(8).toString("hex");
    const admin = new PgConnection(connection);
    try { admin.query("CREATE DATABASE " + quoteIdentifier(name)); }
    finally { admin.close(); }
    const path = join(root, "remote.db"), configuration = join(root, "managed.json");
    writeFileSync(configuration, JSON.stringify({
      path, connection: { ...connection, dbname: name }, localFixture: true,
    }), { mode: 0o600 });
    process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = configuration;
    return { sqlite, postgres: run(path) };
  } finally {
    if (prior === undefined) delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
    else process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = prior;
  }
}

/** One month's read of one Mac's agent, in the shape the token parity test builds. */
function read(source: string, calls: number, extra: Partial<Report> = {}): Report {
  const now = Date.parse("2026-10-13T20:00:00Z");
  const model = source.slice(source.lastIndexOf(":") + 1) + "-model";
  return {
    source, period: monthPeriod("2026-10"), sinceTs: now,
    totalTokens: calls * 100, totalCost: calls / 100, apiCalls: calls, sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], projects: [], accounts: [],
    models: [{ model, calls, inTok: calls * 100, outTok: 0,
      cacheReadTok: 0, cacheWriteTok: 0, cost: calls / 100 }],
    tokenDays: { timeZone: "Europe/Belgrade", measuredAt: now,
      rows: [{ day: "2026-10-13", model, tokens: calls * 100 }] },
    ...extra,
  };
}

/** A ledger column as both engines store it: SQLite 1/0, PostgreSQL BIGINT read back as a number. */
const stored = (value: unknown): number => Number(typeof value === "bigint" ? Number(value) : value);

/**
 * The archive as an earlier version created it: spend_month and spend_report without observed_calls, ledger and
 * routed_calls, holding one September row of 20 Codex calls.
 */
function createOldArchive(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spend_month (
        month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL,
        calls INTEGER NOT NULL, sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (month, source)
      );
      CREATE TABLE IF NOT EXISTS spend_report (
        month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL,
        report_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (month, source)
      );
    `);
    db.prepare("INSERT INTO spend_month(month, source, tokens, cost, calls, sessions, first_ts, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("2026-09", "fixture:codex", 2000, 0.2, 20, 1, null, 1);
  } finally { db.close(); }
}

const LEDGER_ROWS = `month, source, calls, observed_calls AS observedCalls,
  ledger, routed_calls AS routedCalls`;

suite("managed gateway archive behavior", () => {
  test("the gateway ledger takes over a month in Codex, Claude and Copilot together, on both engines", () => {
    const result = fixture((path) => {
      const now = Date.parse("2026-10-13T20:00:00Z");
      // Archived without the ledger: every source billed all the calls it observed.
      writeMonthlySpend(path, [
        read("fixture:codex", 10), read("fixture:claude", 5), read("fixture:copilot", 2),
      ], { generatedAt: now });
      // The same month read with this Mac's gateway ledger: 3 routed calls leave Codex, 1 lands on Claude and 4 on
      // Copilot, so all three sources move together.
      writeMonthlySpend(path, [
        read("fixture:codex", 7, { observedCalls: 10, ledger: true, routedCalls: 3 }),
        read("fixture:claude", 4, { observedCalls: 5, ledger: true, routedCalls: 1 }),
        read("fixture:copilot", 6, { observedCalls: 6, ledger: true, routedCalls: 4, gatewayBilled: ["aa", "bb"] }),
      ], { generatedAt: now + 1 });
      // A thinner Claude re-read with the ledger saw fewer calls: it must be refused, the month keeps Claude's 4.
      writeMonthlySpend(path, [
        read("fixture:claude", 2, { observedCalls: 3, ledger: true, routedCalls: 1 }),
      ], { generatedAt: now + 2 });
      // A later Codex-only ledger read that observed more is accepted: `ledger` must read back as the number 1 on
      // both engines for the stored take-over to be recognised.
      writeMonthlySpend(path, [
        read("fixture:codex", 8, { observedCalls: 11, ledger: true, routedCalls: 3 }),
      ], { generatedAt: now + 3 });
      const db = new Database(path, { readonly: true });
      try {
        return {
          months: loadMonthlySpend(path),
          reports: loadArchivedReports(path),
          spendRows: db.query<{ month: string; source: string; calls: number; observedCalls: number;
            ledger: number | null; routedCalls: number | null }, []>(
            `SELECT ${LEDGER_ROWS} FROM spend_month ORDER BY month, source`).all(),
          reportRows: db.query<{ month: string; source: string; calls: number; observedCalls: number;
            ledger: number | null; routedCalls: number | null }, []>(
            `SELECT ${LEDGER_ROWS} FROM spend_report ORDER BY month, source`).all(),
        };
      } finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    const month = (source: string) => result.sqlite.spendRows.find((row) => row.source === source)!;
    // The takeover wrote each source's ledger read wholesale: what it observed is stored beside what it billed.
    const observed = new Map([["fixture:codex", 11], ["fixture:claude", 5], ["fixture:copilot", 6]]);
    expect(month("fixture:codex").calls).toBe(8);
    expect(month("fixture:claude").calls).toBe(4);
    expect(month("fixture:copilot").calls).toBe(6);
    for (const [source, routed] of [["fixture:codex", 3], ["fixture:claude", 1], ["fixture:copilot", 4]] as const) {
      expect(stored(month(source).ledger)).toBe(1);
      expect(stored(month(source).routedCalls)).toBe(routed);
      expect(stored(month(source).observedCalls)).toBe(observed.get(source));
      const archived = result.sqlite.reportRows.find((row) => row.source === source)!;
      expect(stored(archived.ledger)).toBe(1);
      expect(stored(archived.routedCalls)).toBe(routed);
      expect(stored(archived.observedCalls)).toBe(observed.get(source));
    }
    // The month card carries the same billed calls the ledger moved.
    for (const [source, calls] of [["fixture:codex", 8], ["fixture:claude", 4], ["fixture:copilot", 6]] as const) {
      expect(result.sqlite.months[0]!.sources.find((row) => row.source === source)!.calls).toBe(calls);
    }
    expect(result.sqlite.reports.map((report) => [report.source, report.apiCalls]))
      .toEqual([["fixture:claude", 4], ["fixture:codex", 8], ["fixture:copilot", 6]]);
  });

  test("a ledger take-over that one source would shrink is refused for all three, on both engines", () => {
    const result = fixture((path) => {
      const now = Date.parse("2026-10-13T20:00:00Z");
      writeMonthlySpend(path, [
        read("fixture:codex", 10), read("fixture:claude", 5), read("fixture:copilot", 2),
      ], { generatedAt: now });
      // Codex and Copilot are fuller with the ledger, but Claude observed fewer calls: none of them may change.
      writeMonthlySpend(path, [
        read("fixture:codex", 7, { observedCalls: 10, ledger: true, routedCalls: 3 }),
        read("fixture:claude", 3, { observedCalls: 4, ledger: true, routedCalls: 1 }),
        read("fixture:copilot", 6, { observedCalls: 6, ledger: true, routedCalls: 4 }),
      ], { generatedAt: now + 1 });
      const db = new Database(path, { readonly: true });
      try {
        return {
          spendRows: db.query<{ month: string; source: string; calls: number; observedCalls: number | null;
            ledger: number | null; routedCalls: number | null }, []>(
            `SELECT ${LEDGER_ROWS} FROM spend_month ORDER BY month, source`).all(),
          reportRows: db.query<{ month: string; source: string; calls: number; observedCalls: number | null;
            ledger: number | null; routedCalls: number | null }, []>(
            `SELECT ${LEDGER_ROWS} FROM spend_report ORDER BY month, source`).all(),
        };
      } finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    for (const rows of [result.sqlite.spendRows, result.sqlite.reportRows]) {
      expect(rows.map((row) => row.source)).toEqual(["fixture:claude", "fixture:codex", "fixture:copilot"]);
      for (const [source, calls] of [["fixture:codex", 10], ["fixture:claude", 5], ["fixture:copilot", 2]] as const) {
        const row = rows.find((candidate) => candidate.source === source)!;
        expect(row.calls).toBe(calls);
        expect(row.ledger === null ? 0 : stored(row.ledger)).toBe(0);
        expect(row.routedCalls === null ? 0 : stored(row.routedCalls)).toBe(0);
      }
    }
  });

  test("an archive created before the ledger columns takes the ledger month and keeps its old rows, on both engines", () => {
    const result = fixture((path) => {
      const now = Date.parse("2026-10-13T20:00:00Z");
      createOldArchive(path);
      writeMonthlySpend(path, [
        read("fixture:codex", 7, { observedCalls: 10, ledger: true, routedCalls: 3 }),
      ], { generatedAt: now });
      const db = new Database(path, { readonly: true });
      try {
        return {
          spendRows: db.query<{ month: string; source: string; calls: number; observedCalls: number | null;
            ledger: number | null; routedCalls: number | null }, []>(
            `SELECT ${LEDGER_ROWS} FROM spend_month ORDER BY month, source`).all(),
        };
      } finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    expect(result.sqlite.spendRows.map((row) => [row.month, row.source, row.calls]))
      .toEqual([["2026-09", "fixture:codex", 20], ["2026-10", "fixture:codex", 7]]);
    const september = result.sqlite.spendRows[0]!, october = result.sqlite.spendRows[1]!;
    expect(september.ledger).toBeNull();
    expect(september.routedCalls).toBeNull();
    expect(stored(october.ledger)).toBe(1);
    expect(stored(october.routedCalls)).toBe(3);
    expect(stored(october.observedCalls)).toBe(10);
  });

  test("a connection that cached the old columns still adds them after another connection did, on both engines", () => {
    const result = fixture((path) => {
      createOldArchive(path);
      const a = new Database(path), b = new Database(path);
      try {
        const names = (db: Database) => db.query<{ name: string }, []>("PRAGMA table_info(spend_month)").all()
          .map((row) => row.name);
        // B caches the old column list, then A adds the columns, so B's own ALTERs fail as duplicates.
        const before = names(b);
        addArchiveColumns(a, "spend_month");
        addArchiveColumns(b, "spend_month");
        return { before, after: names(b) };
      } finally { a.close(); b.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    for (const column of ["observed_calls", "ledger", "routed_calls"]) {
      expect(result.sqlite.before).not.toContain(column);
      expect(result.sqlite.after).toContain(column);
    }
  });

  test("a client's unconfirmed Messages call leaves its report where a serving Mac's report billed it, on both engines", () => {
    const call: UnconfirmedCall = {
      id: "abc", ts: Date.parse("2026-10-13T15:00:00Z"), model: "claude-model",
      account: "client@example.com", project: "spendwatch", tokens: 150,
      inTok: 100, outTok: 50, cacheReadTok: 0, cacheWriteTok: 0, cost: 0.5,
    };
    const result = fixture((path) => {
      const now = Date.parse("2026-10-13T20:00:00Z");
      // The client's report billed this gateway call itself (no ledger row here); the serving Mac's Copilot
      // report billed the same call from its ledger, so the call must move out of the client once.
      const client: Report = {
        ...read("client:claude", 2), totalTokens: 500, totalCost: 1, gatewayUnconfirmed: [call],
        models: [{ model: "claude-model", calls: 2, inTok: 400, outTok: 100, cacheReadTok: 0, cacheWriteTok: 0, cost: 1 }],
        tokenDays: { timeZone: "Europe/Belgrade", measuredAt: now,
          rows: [{ day: "2026-10-13", model: "claude-model", tokens: 500 }] },
      };
      const serving = read("studio:copilot", 1, { gatewayBilled: ["abc"] });
      writeMonthlySpend(path, [client, serving], { generatedAt: now });
      const db = new Database(path, { readonly: true });
      try {
        return { months: loadMonthlySpend(path), coverage: [...archivedCoverage(db).entries()] };
      } finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    expect(result.sqlite.coverage.length).toBe(1);
    expect(result.sqlite.coverage[0]![0]).toBe(JSON.stringify(["2026-10", "client:claude"]));
    expect(result.sqlite.coverage[0]![1]).toEqual([call]);
    const clientMonth = result.sqlite.months[0]!.sources.find((row) => row.source === "client:claude")!;
    expect(clientMonth.calls).toBe(2 - 1); // one call fewer than the client report
    expect(clientMonth.tokens).toBe(500 - 150); // and 150 fewer tokens
    const servingMonth = result.sqlite.months[0]!.sources.find((row) => row.source === "studio:copilot")!;
    expect(servingMonth.calls).toBe(1);
    expect(servingMonth.tokens).toBe(100);
  });
});

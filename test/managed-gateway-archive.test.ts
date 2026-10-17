import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "../src/database";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { writeMonthlySpend, loadMonthlySpend } from "../src/spend-history";
import { loadArchivedReports } from "../src/spend-report-archive";
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
    tokenDays: { timeZone: "Europe/Berlin", measuredAt: now,
      rows: [{ day: "2026-10-13", model, tokens: calls * 100 }] },
    ...extra,
  };
}

/** A ledger column as both engines store it: SQLite 1/0, PostgreSQL BIGINT read back as a number. */
const stored = (value: unknown): number => Number(typeof value === "bigint" ? Number(value) : value);

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
    const observed = new Map([["fixture:codex", 10], ["fixture:claude", 5], ["fixture:copilot", 6]]);
    expect(month("fixture:codex").calls).toBe(7);
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
    for (const [source, calls] of [["fixture:codex", 7], ["fixture:claude", 4], ["fixture:copilot", 6]] as const) {
      expect(result.sqlite.months[0]!.sources.find((row) => row.source === source)!.calls).toBe(calls);
    }
    expect(result.sqlite.reports.map((report) => [report.source, report.apiCalls]))
      .toEqual([["fixture:claude", 4], ["fixture:codex", 7], ["fixture:copilot", 6]]);
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
        tokenDays: { timeZone: "Europe/Berlin", measuredAt: now,
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

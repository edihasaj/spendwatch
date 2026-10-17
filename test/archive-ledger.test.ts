import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { monthPeriod } from "../src/periods";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { loadArchivedReports } from "../src/spend-report-archive";
import { tempDir } from "./tmp";

// The archive keeps each source's fullest read. A read with this Mac's gateway ledger moves routed turns from the
// Codex report into the Claude or Copilot report of the same month, so those sources must agree on where the
// routed turns are: this file is about every way they could come to disagree.

const dbPath = () => join(tempDir("spendwatch-ledger-archive-"), "spendwatch.db");

function read(source: string, calls: number, extra: Partial<Report> = {}, month = "2026-10"): Report {
  return {
    period: monthPeriod(month),
    totalTokens: calls * 100,
    totalCost: calls / 100,
    apiCalls: calls,
    observedCalls: calls,
    sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], projects: [], accounts: [],
    source,
    sinceTs: monthPeriod(month).from,
    ...extra,
  };
}

/** Billed calls per source, as the month card and the archived reports each hold them. */
function stored(path: string): { month: Record<string, number>; reports: Record<string, number> } {
  const [month] = loadMonthlySpend(path);
  return {
    month: Object.fromEntries((month?.sources ?? []).map((row) => [row.source, row.calls])),
    reports: Object.fromEntries(loadArchivedReports(path).map((report) => [report.source, report.apiCalls])),
  };
}

const both = (calls: Record<string, number>) => ({ month: calls, reports: calls });

describe("the month the gateway ledger takes over", () => {
  // Archived without the ledger: Codex billed all 100 calls it observed, 10 of them routed to Claude.
  const before = () => [read("studio:codex", 100), read("studio:claude", 50)];

  test("does not lose routed turns when Claude's transcripts have rotated and its read is refused", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    // With the ledger: Codex drops the 10 routed calls (still observing 100); Claude has 30 native calls left plus
    // the 10 ledger rows, fewer than the 50 stored, so its read is refused. Codex must not move without it.
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
      read("studio:claude", 40, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 100, "studio:claude": 50 }));
  });

  test("does not count routed turns twice when Codex's read is refused and Claude's is fuller", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    // A rollout was deleted, so Codex observes fewer calls; Claude grew and gained the 10 ledger rows.
    writeMonthlySpend(path, [
      read("studio:codex", 70, { observedCalls: 80, ledger: true, routedCalls: 10 }),
      read("studio:claude", 62, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 100, "studio:claude": 50 }));
  });

  test("moves the routed turns when every source offers a fuller read", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
      read("studio:claude", 62, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 90, "studio:claude": 62 }));
  });

  test("waits for a source the run did not read, since nothing says whether routed turns reach it", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    // `report --agents codex --sqlite`: the routed turns Codex drops may be Claude's, and its read is not here.
    writeMonthlySpend(path, [read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 })], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 100, "studio:claude": 50 }));
  });

  test("lets a source that routed nothing keep its own rule, and a new source join", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    // The routed turns were Copilot's. Claude routed nothing and its transcripts rotated: it keeps its stored
    // read on its own, while Codex and the new Copilot read take the routed turns over together.
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
      read("studio:claude", 30, { ledger: true }),
      read("studio:copilot", 10, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 90, "studio:claude": 50, "studio:copilot": 10 }));
  });

  test("refuses a read that routes fewer calls than Codex stored, though it observes as many, and moves nothing", () => {
    const path = dbPath();
    writeMonthlySpend(path, [read("studio:codex", 100), read("studio:copilot", 50)], { generatedAt: 1 });
    // Codex takes the ledger over alone: it routed 10 of its 100 calls. Copilot routed none and keeps its own read,
    // taken without the ledger.
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
      read("studio:copilot", 50),
    ], { generatedAt: 2 });
    const settled = both({ "studio:codex": 90, "studio:copilot": 50 });
    expect(stored(path)).toEqual(settled);
    // A later read sees as many calls but routes 8 (a pruned ledger month): thinner in the one way that matters, so
    // Codex refuses it, and Copilot, which would take the 8 on top of its read without the ledger, must wait with it.
    writeMonthlySpend(path, [
      read("studio:codex", 92, { observedCalls: 100, ledger: true, routedCalls: 8 }),
      read("studio:copilot", 58, { ledger: true, routedCalls: 8 }),
    ], { generatedAt: 3 });
    expect(stored(path)).toEqual(settled);
  });

  test("takes over a month whose every Codex call was routed, together with Copilot", () => {
    const path = dbPath();
    writeMonthlySpend(path, [read("studio:codex", 50), read("studio:copilot", 5)], { generatedAt: 1 });
    // With the ledger, all 50 Codex turns are Copilot's: Codex bills none of them, though it observed every one.
    writeMonthlySpend(path, [
      read("studio:codex", 0, { observedCalls: 50, ledger: true, routedCalls: 50 }),
      read("studio:copilot", 55, { ledger: true, routedCalls: 50 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 0, "studio:copilot": 55 }));
  });

  test("lets the fullest offer alone speak for one installation's month offered twice in a run", () => {
    const path = dbPath();
    writeMonthlySpend(path, before(), { generatedAt: 1 });
    // The same export passed twice (`--input a.json,a.json`), while Claude's read is refused: neither copy may move Codex.
    const codex = () => read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 });
    writeMonthlySpend(path, [codex(), codex(), read("studio:claude", 40, { ledger: true, routedCalls: 10 })], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 100, "studio:claude": 50 }));
  });

  test("keeps the sources together in an archive that never recorded an installation", () => {
    const path = dbPath();
    const db = new Database(path);
    db.exec(`CREATE TABLE spend_month (month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL,
      sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));
      CREATE TABLE spend_report (month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL, report_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));`);
    for (const report of before()) {
      db.prepare("INSERT INTO spend_month VALUES (?,?,?,?,?,?,?,?)").run("2026-10", report.source, report.totalTokens, report.totalCost, report.apiCalls, 1, null, 1);
      db.prepare("INSERT INTO spend_report VALUES (?,?,?,?,?)").run("2026-10", report.source, report.apiCalls, JSON.stringify(report), 1);
    }
    db.close();
    // Claude's read is refused, so Codex must keep the routed turns too, although no installation names its rows.
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
      read("studio:claude", 40, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 100, "studio:claude": 50 }));
  });

  test("keeps another installation's month out of the decision", () => {
    const path = dbPath();
    writeMonthlySpend(path, [{ ...read("studio:codex", 100), installationId: "a" }, { ...read("studio:claude", 50), installationId: "a" }], { generatedAt: 1 });
    // A fresh installation on the same Mac has nothing stored: its reads are archived beside the old ones.
    writeMonthlySpend(path, [
      { ...read("studio:codex", 9, { observedCalls: 10, ledger: true, routedCalls: 1 }), installationId: "b" },
      { ...read("studio:claude", 3, { ledger: true, routedCalls: 1 }), installationId: "b" },
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 109, "studio:claude": 53 }));
  });

  test("leaves a refused month's days alone, in every source", () => {
    const path = dbPath();
    const days = (tokens: number) => ({ timeZone: "UTC", measuredAt: monthPeriod("2026-10").from + 3_600_000, rows: [{ day: "2026-10-05", model: "m", tokens }] });
    writeMonthlySpend(path, [read("studio:codex", 100, { tokenDays: days(10_000) }), read("studio:claude", 50, { tokenDays: days(5_000) })], { generatedAt: 1 });
    writeMonthlySpend(path, [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10, tokenDays: days(9_000) }),
      read("studio:claude", 40, { ledger: true, routedCalls: 10, tokenDays: days(4_000) }),
      // A Copilot read that is fuller on its own still waits for the month to move.
      read("studio:copilot", 7, { ledger: true, routedCalls: 2, tokenDays: days(700) }),
    ], { generatedAt: 2 });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT source, tokens FROM spend_token_day ORDER BY source").all()).toEqual([
        { source: "studio:claude", tokens: 5_000 },
        { source: "studio:codex", tokens: 10_000 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("a month the ledger already took over", () => {
  const taken = () => [
    read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }),
    read("studio:claude", 60, { ledger: true, routedCalls: 10 }),
  ];

  test("keeps updating source by source, as every month does", () => {
    const path = dbPath();
    writeMonthlySpend(path, taken(), { generatedAt: 1 });
    // Claude's oldest transcripts rotated; Codex saw two more calls. Both reads place the routed turns alike.
    writeMonthlySpend(path, [
      read("studio:codex", 92, { observedCalls: 102, ledger: true, routedCalls: 10 }),
      read("studio:claude", 55, { ledger: true, routedCalls: 10 }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 92, "studio:claude": 60 }));
  });

  test("is never replaced by a read that billed fewer routed calls through the ledger", () => {
    const path = dbPath();
    writeMonthlySpend(path, taken(), { generatedAt: 1 });
    // The ledger's month was pruned, or the gateway source switched off: the routed turns are back in Codex, with
    // the same observed calls, while Claude no longer has its ledger rows.
    writeMonthlySpend(path, [
      read("studio:codex", 100, { observedCalls: 100, ledger: true }),
      read("studio:claude", 50, { ledger: true }),
    ], { generatedAt: 2 });
    expect(stored(path)).toEqual(both({ "studio:codex": 90, "studio:claude": 60 }));
  });
});

describe("archives written before these columns", () => {
  function legacy(): string {
    const path = dbPath();
    const db = new Database(path);
    db.exec(`CREATE TABLE spend_month (month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL,
      sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));
      CREATE TABLE spend_report (month TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL, report_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source));`);
    // A Codex month recorded by an older Spendwatch, which billed every repeated token_count: 900 calls.
    const old = read("studio:codex", 900, { observedCalls: undefined, totalTokens: 90_000 });
    db.prepare("INSERT INTO spend_month VALUES (?,?,?,?,?,?,?,?)").run("2026-08", "studio:codex", 90_000, 9, 900, 1, null, 1);
    db.prepare("INSERT INTO spend_report VALUES (?,?,?,?,?)").run("2026-08", "studio:codex", 900, JSON.stringify({ ...old, period: monthPeriod("2026-08") }), 1);
    db.close();
    return path;
  }

  test("take a deduped read that observed as many calls as the old row billed", () => {
    const path = legacy();
    // The same rollouts read today: 800 calls billed once the repeats are dropped, 900 observed.
    writeMonthlySpend(path, [read("studio:codex", 800, { observedCalls: 900, totalTokens: 80_000 }, "2026-08")], { generatedAt: 2 });
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(80_000);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(80_000);
  });

  test("still refuse a thinner read", () => {
    const path = legacy();
    writeMonthlySpend(path, [read("studio:codex", 20, { totalTokens: 2_000 }, "2026-08")], { generatedAt: 2 });
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(90_000);
    expect(loadArchivedReports(path)[0]!.totalTokens).toBe(90_000);
  });
});

describe("daily token rows of an accepted read", () => {
  test("are replaced only inside the read's own month", () => {
    const path = dbPath();
    const days = (month: string, day: string, tokens: number) => ({ timeZone: "UTC", measuredAt: monthPeriod(month).from + 3_600_000, rows: [{ day, model: "m", tokens }] });
    writeMonthlySpend(path, [
      read("studio:codex", 10, { totalTokens: 1_000, tokenDays: days("2026-08", "2026-08-05", 1_000) }, "2026-08"),
      read("studio:codex", 10, { totalTokens: 2_000, tokenDays: days("2026-09", "2026-09-05", 2_000) }, "2026-09"),
    ], { generatedAt: 1 });
    // September is read again and accepted: August's days are another month's, and stay.
    writeMonthlySpend(path, [read("studio:codex", 11, { totalTokens: 2_100, tokenDays: days("2026-09", "2026-09-06", 2_100) }, "2026-09")], { generatedAt: 2 });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT day, tokens FROM spend_token_day ORDER BY day").all()).toEqual([
        { day: "2026-08-05", tokens: 1_000 },
        { day: "2026-09-06", tokens: 2_100 },
      ]);
    } finally {
      db.close();
    }
  });
});

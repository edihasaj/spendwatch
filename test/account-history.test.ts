import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Report, UnconfirmedCall } from "../src/aggregate";
import { withoutCalls } from "../src/gateway-settle";
import { renderHistoryHtml } from "../src/history";
import { monthPeriod } from "../src/periods";
import { mergeReports } from "../src/reports";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { TokenDayAccumulator } from "../src/token-days";
import { tempDir } from "./tmp";

const at = Date.UTC(2026, 9, 15, 12);

function report(
  tokens: number,
  source = "macbook:codex",
  installationId?: string,
  accountRows: Array<{ day: string; model: string; account: string; tokens: number }> = [],
): Report {
  return {
    period: monthPeriod("2026-10"),
    totalTokens: tokens,
    totalCost: 0,
    apiCalls: tokens ? 1 : 0,
    sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [], accounts: [],
    projects: [],
    source,
    sinceTs: at,
    ...(installationId ? { installationId } : {}),
    tokenDays: {
      timeZone: "UTC",
      measuredAt: at,
      rows: [{ day: "2026-10-15", model: "gpt-5.5", tokens }],
      ...(accountRows.length ? { accountRows } : {}),
    },
  };
}

describe("account-attributed history", () => {
  test("keeps exact account day evidence alongside the global token rows", () => {
    const days = new TokenDayAccumulator("UTC");
    days.add(at, "gpt-5.5", 80, "alex.work@example.com");
    days.add(at, "gpt-5.5", 20);
    expect(days.snapshot(at).accountRows).toEqual([
      { day: "2026-10-15", model: "gpt-5.5", account: "alex.work@example.com", tokens: 80 },
      { day: "2026-10-15", model: "gpt-5.5", account: "Unknown account", tokens: 20 },
    ]);
  });

  test("folds installations under their original source while retaining proven account totals and days", () => {
    const path = join(tempDir("spendwatch-account-history-"), "spendwatch.db");
    writeMonthlySpend(path, [
      report(300, "macbook:codex", "before", [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex.work@example.com", tokens: 100 },
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 200 },
      ]),
      report(100, "macbook:codex", "after", [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 100 },
      ]),
    ], { generatedAt: at });

    const [month] = loadMonthlySpend(path);
    expect(month!.sources).toMatchObject([{ source: "macbook:codex", tokens: 400 }]);
    expect(month!.accounts).toEqual([
      { source: "macbook:codex", account: "alex.work@example.com", tokens: 100 },
      { source: "macbook:codex", account: "alex@example.com", tokens: 300 },
    ]);
    expect(month!.accountDays).toEqual([
      { day: "2026-10-15", source: "macbook:codex", account: "alex.work@example.com", tokens: 100 },
      { day: "2026-10-15", source: "macbook:codex", account: "alex@example.com", tokens: 300 },
    ]);
  });

  test("marks unverified or historical account detail Unknown without making up a split", () => {
    const path = join(tempDir("spendwatch-account-history-"), "spendwatch.db");
    writeMonthlySpend(path, [report(100, "macbook:codex", "one", [
      { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 90 },
    ])], { generatedAt: at });

    const [month] = loadMonthlySpend(path);
    expect(month!.accounts).toEqual([{ source: "macbook:codex", account: "Unknown account", tokens: 100 }]);
    expect(month!.accountDays).toEqual([
      { day: "2026-10-15", source: "macbook:codex", account: "Unknown account", tokens: 100 },
    ]);
  });

  test("reads a pre-report archive without requiring an account history migration", () => {
    const path = join(tempDir("spendwatch-account-history-"), "spendwatch.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE spend_month (
        month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL,
        calls INTEGER NOT NULL, sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (month, source)
      );
      CREATE TABLE spend_month_project (
        month TEXT NOT NULL, source TEXT NOT NULL, project TEXT NOT NULL, tokens INTEGER NOT NULL,
        cost REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (month, source, project)
      );
    `);
    db.prepare("INSERT INTO spend_month VALUES (?,?,?,?,?,?,?,?)")
      .run("2026-10", "macbook:codex", 100, 0, 1, 1, at, at);
    db.close();

    expect(loadMonthlySpend(path)).toMatchObject([{
      tokens: 100,
      accounts: [{ source: "macbook:codex", account: "Unknown account", tokens: 100 }],
    }]);
  });

  test("does not attribute a fuller legacy monthly row from a later partial report JSON", () => {
    const path = join(tempDir("spendwatch-account-history-"), "spendwatch.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE spend_month (
        month TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL,
        calls INTEGER NOT NULL, sessions INTEGER NOT NULL, first_ts INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (month, source)
      );
    `);
    db.prepare("INSERT INTO spend_month VALUES (?,?,?,?,?,?,?,?)")
      .run("2026-10", "macbook:codex", 100, 0, 10, 1, at, at);
    db.close();

    writeMonthlySpend(path, [{
      ...report(50, "macbook:codex", undefined, [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 50 },
      ]),
      apiCalls: 5,
      observedCalls: 5,
    }], { generatedAt: at + 1 });

    const [month] = loadMonthlySpend(path);
    expect(month).toMatchObject({
      tokens: 100,
      accounts: [{ source: "macbook:codex", account: "Unknown account", tokens: 100 }],
    });
    expect(month!.accountDays).toBeUndefined();
  });

  test("settling a gateway call subtracts its matching account day row too", () => {
    const call: UnconfirmedCall = {
      id: "gateway-call", ts: at, model: "gpt-5.5", account: "alex@example.com", project: "app",
      tokens: 40, inTok: 30, outTok: 10, cacheReadTok: 0, cacheWriteTok: 0, cost: 0,
    };
    const settled = withoutCalls({
      ...report(100, "macbook:codex", undefined, [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 100 },
      ]),
      models: [{ model: "gpt-5.5", calls: 1, inTok: 90, outTok: 10, cacheReadTok: 0, cacheWriteTok: 0, cost: 0 }],
      accounts: [{ account: "alex@example.com", tokens: 100, cost: 0, calls: 1, sessions: 1 }],
      projects: [{ project: "app", tokens: 100, cost: 0 }],
      gatewayUnconfirmed: [call],
    }, [call]);

    expect(settled.totalTokens).toBe(60);
    expect(settled.tokenDays!.rows).toEqual([{ day: "2026-10-15", model: "gpt-5.5", tokens: 60 }]);
    expect(settled.tokenDays!.accountRows).toEqual([
      { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 60 },
    ]);
  });

  test("preserves reconciled account day rows when reports merge", () => {
    const merged = mergeReports([
      report(100, "macbook:codex", undefined, [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 100 },
      ]),
      report(50, "studio:codex", undefined, [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex.work@example.com", tokens: 50 },
      ]),
    ], "all", "service", true);

    expect(merged.totalTokens).toBe(150);
    expect(merged.tokenDays).toMatchObject({
      rows: [{ day: "2026-10-15", model: "gpt-5.5", tokens: 150 }],
      accountRows: [
        { day: "2026-10-15", model: "gpt-5.5", account: "alex.work@example.com", tokens: 50 },
        { day: "2026-10-15", model: "gpt-5.5", account: "alex@example.com", tokens: 100 },
      ],
    });
  });

  test("renders compact account/source totals and leaves daily account detail collapsed", () => {
    const html = renderHistoryHtml({ generatedAt: at, sampleCount: 0, series: [] }, {
      months: [{
        month: "2026-10", label: "October 2026", tokens: 100, cost: 0, calls: 1, sessions: 1, updatedAt: at,
        sources: [{ source: "macbook:codex", tokens: 100, cost: 0, calls: 1, sessions: 1 }],
        projects: [],
        accounts: [{ source: "macbook:codex", account: "alex@example.com", tokens: 100 }],
        accountDays: [{ day: "2026-10-15", source: "macbook:codex", account: "alex@example.com", tokens: 100 }],
      }],
    });

    expect(html).toContain("By account");
    expect(html).toContain("alex@example.com");
    expect(html).toContain("Daily account detail");
    expect(html).toContain('<details class="account-days"><summary>');
  });
});

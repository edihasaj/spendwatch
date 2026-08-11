import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCapacityHistory, loadCapacityHistory, writeCapacitySnapshot } from "../src/capacity-db";
import { renderHistoryHtml } from "../src/history";
import { renderLimitsHtml, type CodexLimitAccount } from "../src/limits";
import { attachSessionEquivalentForecasts } from "../src/session-equivalents";

describe("capacity history", () => {
  test("stores live and imported samples idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-capacity-"));
    const db = join(dir, "history.db");
    const input = join(dir, "history.jsonl");
    const account: CodexLimitAccount = {
      provider: "codex",
      email: "work@example.com",
      plan: "Pro",
      devices: ["studio", "macbook"],
      updatedAt: "2026-08-09T20:00:00Z",
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: "2026-08-09T23:00:00Z" },
      weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: "2026-08-15T20:00:00Z" },
    };
    expect(writeCapacitySnapshot(db, [account], { collectedAt: Date.parse(account.updatedAt!) }).rows).toBe(3);
    expect(writeCapacitySnapshot(db, [account], { collectedAt: Date.parse(account.updatedAt!) }).rows).toBe(0);
    writeFileSync(input, [
      JSON.stringify({
        provider: "codex", account: "work@example.com", device: "studio",
        source: "codex-session-log", sampledAt: "2026-06-12T10:00:00Z", plan: "pro",
        windows: [
          { kind: "session", usedPercent: 10, windowMinutes: 300, resetsAt: "2026-06-12T13:00:00Z" },
          { kind: "weekly", usedPercent: 15, windowMinutes: 10080, resetsAt: "2026-06-18T10:00:00Z" },
        ],
      }),
      "not-json",
    ].join("\n"));
    const firstImport = importCapacityHistory(db, [input]);
    expect(firstImport).toEqual({ inserted: 2, accepted: 1 });
    expect(importCapacityHistory(db, [input]).inserted).toBe(0);

    const history = loadCapacityHistory(db, Date.parse("2026-08-10T00:00:00Z"));
    expect(history.sampleCount).toBe(5);
    expect(history.firstSampleAt).toBe(Date.parse("2026-06-12T10:00:00Z"));
    expect(history.series.map((series) => series.kind).sort()).toEqual(["session", "weekly"]);
    expect(history.series.every((series) => series.sampleCount === 2)).toBe(true);
    const html = renderHistoryHtml(history, { capacityHref: "capacity.html" });
    expect(html).toContain("Past month");
    expect(html).toContain("Raw history remains append-only in SQLite");
    expect(html).toContain("work@example.com");
    expect(html).toContain('href="capacity.html">Capacity</a>');
  });

  test("stores Copilot credit history", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-copilot-"));
    const db = join(dir, "history.db");
    writeCapacitySnapshot(db, [{
      provider: "copilot",
      email: "developer (Business)",
      plan: "Business",
      devices: ["studio"],
      updatedAt: "2026-08-09T20:00:00Z",
      copilot: {
        chatUnlimited: true,
        completionsUnlimited: true,
        premiumUnlimited: false,
        premiumCreditsUsed: 1234,
        overagePermitted: true,
        tokenBasedBilling: true,
        resetsAt: "2026-09-01T00:00:00Z",
        seatAssignedAt: "2026-05-13T12:12:57Z",
      },
    }], { collectedAt: Date.parse("2026-08-09T20:00:00Z") });
    const history = loadCapacityHistory(db, Date.parse("2026-08-10T00:00:00Z"));
    expect(history.series[0]?.kind).toBe("credits");
    expect(history.series[0]?.points[0]?.value).toBe(1234);
    const sqlite = new Database(db, { readonly: true });
    const billing = sqlite.query<{
      overage: number;
      tokenBased: number;
      resetsAt: number;
      assignedAt: number;
    }, []>(`
      SELECT copilot_overage_permitted AS overage,
             copilot_token_based_billing AS tokenBased,
             copilot_resets_at_ms AS resetsAt,
             copilot_seat_assigned_at_ms AS assignedAt
      FROM capacity_account_history
    `).get();
    sqlite.close();
    expect(billing?.overage).toBe(1);
    expect(billing?.tokenBased).toBe(1);
    expect(billing?.resetsAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(billing?.assignedAt).toBe(Date.parse("2026-05-13T12:12:57Z"));
  });

  test("stores API balances in account history", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-balance-"));
    const dbPath = join(dir, "history.db");
    writeCapacitySnapshot(dbPath, [{
      provider: "lokai",
      email: "DeepSeek V4 Flash",
      plan: "DeepSeek API",
      devices: ["studio"],
      updatedAt: "2026-08-09T20:00:00Z",
      route: {
        ready: true,
        detail: "LiteLLM · 1M context",
        available: true,
        balances: [{ currency: "USD", total: 4.6, granted: 0, toppedUp: 4.6 }],
      },
    }], { collectedAt: Date.parse("2026-08-09T20:00:00Z") });
    const db = new Database(dbPath, { readonly: true });
    const row = db.query<{ available: number; balances: string }, []>(`
      SELECT api_balance_available AS available, api_balances_json AS balances
      FROM capacity_account_history
    `).get();
    db.close();
    expect(row?.available).toBe(1);
    expect(JSON.parse(row?.balances ?? "[]")).toEqual([
      { currency: "USD", total: 4.6, granted: 0, toppedUp: 4.6 },
    ]);
  });

  test("learns weekly burn per completed five-hour session", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-equivalent-"));
    const db = join(dir, "history.db");
    const weeklyReset = "2026-08-16T00:00:00Z";
    for (let index = 0; index < 4; index++) {
      const sampledAt = new Date(Date.parse("2026-08-10T00:00:00Z") + index * 5 * 60 * 60_000).toISOString();
      writeCapacitySnapshot(db, [{
        provider: "codex",
        email: "learned@example.com",
        plan: "Pro",
        devices: ["studio"],
        updatedAt: sampledAt,
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: new Date(Date.parse(sampledAt) + 5 * 60 * 60_000).toISOString() },
        weekly: { usedPercent: 10 + index * 10, windowMinutes: 10080, resetsAt: weeklyReset },
      }], { collectedAt: Date.parse(sampledAt) });
    }
    const current: CodexLimitAccount = {
      provider: "codex",
      email: "learned@example.com",
      plan: "Pro",
      devices: ["studio"],
      weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: weeklyReset },
    };
    attachSessionEquivalentForecasts(db, [current], Date.parse("2026-08-10T15:00:00Z"));
    expect(current.sessionEquivalent?.sampleCount).toBe(3);
    expect(current.sessionEquivalent?.medianWeeklyBurn).toBe(10);
    expect(current.sessionEquivalent?.estimatedQuotasLeft).toBe(6);
    expect(renderLimitsHtml([current], { generatedAt: Date.parse("2026-08-10T15:00:00Z") })).toContain("Est. 6 session quotas left");
  });
});

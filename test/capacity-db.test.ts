import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { importCapacityHistory, loadCapacityHistory, writeCapacitySnapshot } from "../src/capacity-db";
import { renderHistoryHtml } from "../src/history";
import { renderLimitsHtml, type CodexLimitAccount } from "../src/limits";
import { attachSessionEquivalentForecasts } from "../src/session-equivalents";
import { tempDir } from "./tmp";

describe("capacity history", () => {
  test("stores live and imported samples idempotently", () => {
    const dir = tempDir("spendwatch-capacity-");
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
    expect(html).toContain("Older verified archives remain restorable");
    expect(html).toContain("work@example.com");
    expect(html).toContain('href="capacity.html">Capacity</a>');
  });

  test("imports bounded batches in source order and retains distinct same-time windows", () => {
    const dir = tempDir("spendwatch-capacity-batch-");
    const db = join(dir, "history.db");
    const input = join(dir, "history.jsonl");
    const sampledAt = "2026-08-09T20:00:00Z";
    const reset = "2026-08-10T01:00:00Z";
    const records = [
      {
        provider: "codex", account: "work@example.com", device: "first", source: "first",
        sampledAt, plan: "Pro", windows: [
          { kind: "session", usedPercent: 17, windowMinutes: 300, resetsAt: reset },
          { kind: "weekly", usedPercent: 42, windowMinutes: 10080, resetsAt: "2026-08-16T20:00:00Z" },
        ],
      },
      {
        provider: "codex", account: "work@example.com", device: "later", source: "later",
        sampledAt, plan: "Pro", windows: [
          { kind: "session", usedPercent: 17, windowMinutes: 300, resetsAt: reset },
        ],
      },
      ...Array.from({ length: 300 }, (_, index) => ({
        provider: "codex", account: "work@example.com", device: "batch", source: "batch",
        sampledAt: new Date(Date.parse(sampledAt) + (index + 1) * 1_000).toISOString(), plan: "Pro",
        windows: [{ kind: "session", usedPercent: index % 101, windowMinutes: 300, resetsAt: reset }],
      })),
    ];
    writeFileSync(input, records.map((record) => JSON.stringify(record)).join("\n"));

    expect(importCapacityHistory(db, [input])).toEqual({ inserted: 302, accepted: 302 });
    expect(importCapacityHistory(db, [input])).toEqual({ inserted: 0, accepted: 302 });

    const native = new Database(db, { readonly: true });
    try {
      expect(native.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM capacity_history").get()?.count).toBe(302);
      expect(native.query<{ kind: string; source: string; devices: string }, [number]>(`
        SELECT window_kind AS kind, source, devices FROM capacity_history
        WHERE sampled_at_ms=? ORDER BY window_kind
      `).all(Date.parse(sampledAt))).toEqual([
        { kind: "session", source: "first", devices: JSON.stringify(["first"]) },
        { kind: "weekly", source: "first", devices: JSON.stringify(["first"]) },
      ]);
    } finally {
      native.close();
    }
  });

  test("rolls back batches already inserted from a rejected later history row", () => {
    const dir = tempDir("spendwatch-capacity-batch-rollback-");
    const db = join(dir, "history.db");
    const input = join(dir, "history.jsonl");
    importCapacityHistory(db, []);
    const native = new Database(db);
    try {
      native.exec(`
        CREATE TRIGGER reject_late_capacity BEFORE INSERT ON capacity_history
        WHEN NEW.source = 'reject'
        BEGIN SELECT RAISE(ABORT, 'late history row rejected'); END;
      `);
    } finally {
      native.close();
    }
    const sampledAt = Date.parse("2026-08-09T20:00:00Z");
    const records = [
      ...Array.from({ length: 250 }, (_, index) => ({
        provider: "codex", account: "work@example.com", device: "batch", source: "batch",
        sampledAt: new Date(sampledAt + index * 1_000).toISOString(), plan: "Pro",
        windows: [{ kind: "session", usedPercent: index % 101, windowMinutes: 300 }],
      })),
      {
        provider: "codex", account: "work@example.com", device: "batch", source: "reject",
        sampledAt: new Date(sampledAt + 251_000).toISOString(), plan: "Pro",
        windows: [{ kind: "session", usedPercent: 100, windowMinutes: 300 }],
      },
    ];
    writeFileSync(input, records.map((record) => JSON.stringify(record)).join("\n"));

    expect(() => importCapacityHistory(db, [input])).toThrow("late history row rejected");
    const check = new Database(db, { readonly: true });
    try {
      expect(check.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM capacity_history").get()?.count).toBe(0);
    } finally {
      check.close();
    }
  });

  test("stores Copilot credit history", () => {
    const dir = tempDir("spendwatch-copilot-");
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
    const dir = tempDir("spendwatch-balance-");
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
    const dir = tempDir("spendwatch-equivalent-");
    const db = join(dir, "history.db");
    const weeklyReset = "2026-08-16T00:00:00Z";
    for (let index = 0; index < 4; index++) {
      const sampledAt = new Date(Date.parse("2026-08-10T00:00:00Z") + index * 5 * 60 * 60_000).toISOString();
      writeCapacitySnapshot(db, [{
        provider: "codex",
        email: "LEARNED@EXAMPLE.COM",
        plan: "Pro",
        devices: ["studio"],
        updatedAt: sampledAt,
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: new Date(Date.parse(sampledAt) + 5 * 60 * 60_000).toISOString() },
        weekly: { usedPercent: 10 + index * 10, windowMinutes: 10080, resetsAt: weeklyReset },
      }], { collectedAt: Date.parse(sampledAt) });
      // Multiple sources can report different values at the same timestamp.
      // Forecast loading must aggregate them before pairing the two windows.
      writeCapacitySnapshot(db, [{
        provider: "codex",
        email: "LEARNED@EXAMPLE.COM",
        plan: "Pro",
        devices: ["macbook"],
        updatedAt: sampledAt,
        session: { usedPercent: 1, windowMinutes: 300, resetsAt: new Date(Date.parse(sampledAt) + 5 * 60 * 60_000).toISOString() },
        weekly: { usedPercent: 11 + index * 10, windowMinutes: 10080, resetsAt: weeklyReset },
      }], { collectedAt: Date.parse(sampledAt) });
    }
    const current: CodexLimitAccount = {
      provider: "codex",
      email: "learned@example.com",
      plan: "Pro",
      devices: ["studio"],
      updatedAt: "2026-08-10T14:59:00Z",
      weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: weeklyReset },
    };
    attachSessionEquivalentForecasts(db, [current], Date.parse("2026-08-10T15:00:00Z"));
    expect(current.sessionEquivalent?.sampleCount).toBe(3);
    expect(current.sessionEquivalent?.medianWeeklyBurn).toBe(10);
    expect(current.sessionEquivalent?.estimatedQuotasLeft).toBe(6);
    expect(renderLimitsHtml([current], { generatedAt: Date.parse("2026-08-10T15:00:00Z") })).toContain("Est. 6 session quotas left");
  });
});

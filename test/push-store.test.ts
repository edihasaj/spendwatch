import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexLimitAccount } from "../src/limits";
import { PushStore } from "../src/push-store";

describe("background push state", () => {
  test("queues each sparse threshold once per account and reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-push-"));
    const store = new PushStore(join(dir, "push.db"));
    store.upsertSubscription({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "public-key", auth: "auth-secret" },
    }, "test browser", 1);
    expect(store.subscriptionStatus("https://push.example.test/subscription")).toEqual({ enabled: true, verified: false });
    const account: CodexLimitAccount = {
      provider: "codex",
      email: "work@example.com",
      plan: "Pro",
      devices: ["studio"],
      weekly: { usedPercent: 69, windowMinutes: 10080, resetsAt: "2026-08-17T00:00:00Z" },
    };

    expect(store.observe([account], 2)).toBe(0);
    account.weekly!.usedPercent = 72;
    expect(store.observe([account], 3)).toBe(1);
    expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([30]);
    const first = store.pendingDeliveries()[0]!;
    store.markSent(first.eventId, first.endpoint, 4);
    expect(store.subscriptionStatus(first.endpoint)).toEqual({ enabled: true, verified: true });
    expect(store.observe([account], 5)).toBe(0);

    account.weekly!.usedPercent = 91;
    expect(store.observe([account], 6)).toBe(1);
    expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([10]);
    const second = store.pendingDeliveries()[0]!;
    store.markSent(second.eventId, second.endpoint, 7);

    account.weekly = { usedPercent: 0, windowMinutes: 10080, resetsAt: "2026-08-24T00:00:00Z" };
    expect(store.observe([account], 8)).toBe(0);
    account.weekly.usedPercent = 86;
    expect(store.observe([account], 9)).toBe(1);
    expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([15]);
    store.close();
  });

  test("alerts once when Copilot passes its manual monthly budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-push-copilot-"));
    const store = new PushStore(join(dir, "push.db"));
    store.upsertSubscription({
      endpoint: "https://push.example.test/copilot",
      keys: { p256dh: "public-key", auth: "auth-secret" },
    }, "test browser", 1);
    const nowMs = Date.parse("2026-08-17T12:00:00Z");
    const account: CodexLimitAccount = {
      provider: "copilot",
      email: "org (Business)",
      plan: "Business",
      devices: ["studio"],
      copilot: {
        chatUnlimited: false,
        completionsUnlimited: false,
        premiumUnlimited: false,
        premiumCreditsUsed: 20_000,
        overagePermitted: true,
        tokenBasedBilling: true,
        resetsAt: "2026-09-01T00:00:00Z",
      },
    };

    expect(store.observe([account], nowMs)).toBe(0);
    account.copilot!.premiumCreditsUsed = 39_000;
    expect(store.observe([account], nowMs + 1)).toBe(1);
    expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([5]);
    const warning = store.pendingDeliveries()[0]!;
    store.markSent(warning.eventId, warning.endpoint, nowMs + 2);

    account.copilot!.premiumCreditsUsed = 52_500;
    expect(store.observe([account], nowMs + 3)).toBe(1);
    const spent = store.pendingDeliveries()[0]!;
    expect(spent.threshold).toBe(0);
    expect(spent.provider).toBe("copilot");
    store.markSent(spent.eventId, spent.endpoint, nowMs + 4);

    account.copilot!.premiumCreditsUsed = 80_000;
    expect(store.observe([account], nowMs + 5)).toBe(0);
    expect(store.pendingDeliveries()).toEqual([]);
    store.close();
  });

  test("adds delivery verification state to an existing subscription table", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-push-migration-"));
    const path = join(dir, "push.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        user_agent TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
    `);
    legacy.close();

    const store = new PushStore(path);
    const columns = store.db.query<{ name: string }, []>("PRAGMA table_info(push_subscriptions)").all();
    expect(columns.map((column) => column.name)).toContain("verified_at_ms");
    store.close();
  });
});

import { describe, expect, test } from "bun:test";
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
});

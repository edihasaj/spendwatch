import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { CodexLimitAccount } from "../src/limits";
import { ManagedDatabaseError } from "../src/managed/libpq";
import { isDeadConnectionError, PushStore, ReconnectingPushStore } from "../src/push-store";
import { tempDir } from "./tmp";

describe("background push state", () => {
  test("queues each sparse threshold once per account and reset", () => {
    const dir = tempDir("spendwatch-push-");
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

  test("adds delivery verification state to an existing subscription table", () => {
    const dir = tempDir("spendwatch-push-migration-");
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

describe("reconnecting push store", () => {
  const path = () => join(tempDir("push-reconnect-"), "push.db");

  test("only a dead managed connection counts as a reason to reconnect", () => {
    expect(isDeadConnectionError(new ManagedDatabaseError("08006", true))).toBe(true);
    expect(isDeadConnectionError(new ManagedDatabaseError("08003", true))).toBe(true);
    expect(isDeadConnectionError(new ManagedDatabaseError("23505"))).toBe(false);
    expect(isDeadConnectionError(new Error("database is locked"))).toBe(false);
    expect(isDeadConnectionError(undefined)).toBe(false);
  });

  test("replaces the store after a dead connection and never replays the failed call", () => {
    const opened: PushStore[] = [];
    let attempts = 0;
    const source = new ReconnectingPushStore(path(), (file) => {
      const store = new PushStore(file);
      if (opened.length === 0) {
        store.setConfig = () => { attempts++; throw new ManagedDatabaseError("08006", true); };
      }
      opened.push(store);
      return store;
    });
    try {
      expect(() => source.use((store) => store.setConfig("k", "v"))).toThrow("08006");
      expect(attempts).toBe(1);
      source.use((store) => store.setConfig("k", "v"));
      expect(source.use((store) => store.config("k"))).toBe("v");
      expect(opened).toHaveLength(2);
      expect(attempts).toBe(1);
    } finally { source.close(); }
  });

  test("ordinary failures keep the connection so setup statements do not rerun", () => {
    let opens = 0;
    const source = new ReconnectingPushStore(path(), (file) => { opens++; return new PushStore(file); });
    try {
      for (const error of [new Error("bad input"), new ManagedDatabaseError("23505")]) {
        expect(() => source.use(() => { throw error; })).toThrow();
      }
      source.use((store) => store.setConfig("k", "v"));
      expect(source.use((store) => store.config("k"))).toBe("v");
      expect(opens).toBe(1);
    } finally { source.close(); }
  });

  test("opening failures are retried on the next call", () => {
    let opens = 0;
    const source = new ReconnectingPushStore(path(), (file) => {
      if (++opens === 1) throw new ManagedDatabaseError("08001", true);
      return new PushStore(file);
    });
    try {
      expect(() => source.use((store) => store.config("k"))).toThrow("08001");
      expect(source.use((store) => store.config("k"))).toBeUndefined();
      expect(opens).toBe(2);
    } finally { source.close(); }
  });
});

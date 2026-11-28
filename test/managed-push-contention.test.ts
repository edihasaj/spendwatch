import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CodexLimitAccount } from "../src/limits";
import { ManagedDatabaseError, ManagedWriterDeferredError, PgConnection } from "../src/managed/libpq";
import { ManagedPostgresDatabase } from "../src/managed/postgres-db";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { PushStore } from "../src/push-store";
import { tempDir } from "./tmp";

const configPath = process.env.SPENDWATCH_TEST_PG_CONFIG;
const suite = configPath ? describe : describe.skip;

// The same global key every managed writer takes before BEGIN.
const ADVISORY_KEY = "hashtextextended(current_database(),193764)";
const TRY_LOCK = "SELECT pg_try_advisory_lock(" + ADVISORY_KEY + ") AS acquired";
const UNLOCK = "SELECT pg_advisory_unlock(" + ADVISORY_KEY + ") AS released";

function account(usedPercent: number): CodexLimitAccount {
  return {
    provider: "codex", email: "work@example.com", plan: "Pro",
    devices: ["studio"],
    weekly: { usedPercent, windowMinutes: 10080, resetsAt: "2026-08-17T00:00:00Z" },
  };
}

/** One disposable database per test on the owned loopback fixture. */
function fixture<T>(run: (store: PushStore, database: Record<string, string>) => T): T {
  const root = tempDir("spendwatch-push-contention-");
  const prior = process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
  const connection = JSON.parse(readFileSync(configPath!, "utf8")) as Record<string, string>;
  if (connection.host !== "127.0.0.1" || connection.port !== "15487") {
    throw new Error("Push contention tests require the owned loopback fixture");
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
  try { return run(new PushStore(path), { ...connection, dbname: name }); }
  finally {
    const cleanup = new PgConnection(connection);
    try { cleanup.query("DROP DATABASE " + quoteIdentifier(name) + " WITH (FORCE)"); }
    finally { cleanup.close(); }
    if (prior === undefined) delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
    else process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = prior;
  }
}

function managedDb(store: PushStore): ManagedPostgresDatabase {
  if (!(store.db instanceof ManagedPostgresDatabase)) {
    throw new Error("The managed push store must own a managed database");
  }
  return store.db;
}

/** Deliveries are only fanned out to enabled subscriptions, so seed one. */
function subscribe(store: PushStore): void {
  store.upsertSubscription({
    endpoint: "https://push.example.test/subscription",
    keys: { p256dh: "public-key", auth: "auth-secret" },
  }, "contention test", 1);
}

suite("managed push writer contention", () => {
  test("observe commits and returns the created count when no writer contends", () => {
    fixture((store) => {
      const db = managedDb(store);
      subscribe(store);
      try {
        const first = account(69);
        // A successful nonblocking transaction must be reported as success,
        // never as a spurious contention (undefined callback result ≠ defer).
        expect(store.observe([first], 1)).toBe(0);
        expect(store.observe([first], 2)).toBe(0);
        first.weekly!.usedPercent = 72;
        expect(store.observe([first], 3)).toBe(1);
        expect(db.query("SELECT count(*) AS n FROM push_threshold_events").get()!.n).toBe(1);
        expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([30]);
      } finally { store.close(); }
    });
  });

  test("observe defers promptly while a competing writer holds the lock and advances after release", () => {
    fixture((store, database) => {
      const db = managedDb(store);
      subscribe(store);
      const competing = new PgConnection(database);
      try {
        expect(competing.query(TRY_LOCK).rows[0]!.acquired).toBe(true);
        const first = account(69);
        const started = performance.now();
        let deferred: unknown;
        try { store.observe([first], 1); } catch (error) { deferred = error; }
        const elapsed = performance.now() - started;
        expect(deferred).toBeInstanceOf(ManagedWriterDeferredError);
        expect((deferred as ManagedDatabaseError).code).toBe("55P03");
        expect((deferred as ManagedDatabaseError).transport).toBe(false);
        // The session lock_timeout is 10s; a deferred tick must be prompt.
        expect(elapsed).toBeLessThan(2_500);
        // A second deferral behaves identically: no self-queuing, no replay.
        expect(() => store.observe([first], 2)).toThrow(ManagedDatabaseError);
        expect(db.inTransaction).toBe(false);
        // The failure path must not hold the advisory lock across the failure:
        // only the competing writer's single lock exists in this database.
        const holders = competing.query(
          "SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory'" +
          " AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        ).rows[0]!;
        expect(Number(holders.n)).toBe(1);
        // The deferral is not a transport failure: the connection survives.
        expect(db.query("SELECT 1 AS ok").get()!.ok).toBe(1);
        expect(competing.query(UNLOCK).rows[0]!.released).toBe(true);
        // After the writer exits, the next tick advances and persists.
        expect(store.observe([first], 3)).toBe(0); // first sight seeds the state row
        expect(db.query("SELECT count(*) AS n FROM push_account_state").get()!.n).toBe(1);
        first.weekly!.usedPercent = 72;
        expect(store.observe([first], 4)).toBe(1); // 31% -> 28% left crosses 30
        expect(db.query("SELECT count(*) AS n FROM push_threshold_events").get()!.n).toBe(1);
        expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([30]);
      } finally { competing.close(); store.close(); }
    });
  });

  test("a PostgreSQL statement lock timeout stays distinct from writer deferral", () => {
    fixture((store, database) => {
      const db = managedDb(store);
      const competing = new PgConnection(database);
      try {
        db.exec("PRAGMA busy_timeout=200");
        competing.query("BEGIN");
        competing.query("LOCK TABLE push_account_state IN ACCESS EXCLUSIVE MODE");
        let failure: unknown;
        try { store.observe([account(69)], 1); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ManagedDatabaseError);
        expect(failure).not.toBeInstanceOf(ManagedWriterDeferredError);
        expect((failure as ManagedDatabaseError).code).toBe("55P03");
        expect(db.inTransaction).toBe(false);
        expect(competing.query(TRY_LOCK).rows[0]!.acquired).toBe(true);
        competing.query(UNLOCK);
        competing.query("ROLLBACK");
        expect(store.observe([account(69)], 2)).toBe(0);
      } finally { competing.close(); store.close(); }
    });
  });

  test("a failing nonblocking transaction rolls back and releases the writer lock", () => {
    fixture((store, database) => {
      const db = managedDb(store);
      try {
        expect(() => db.tryTransactionNonblocking(() => {
          db.run(`
            INSERT INTO push_account_state(provider, account_key, account_label, reset_key, last_left, updated_at_ms)
            VALUES(?, ?, ?, ?, ?, ?)
          `, "codex", "rollback@example.com", "Rollback", "reset", 50, 1);
          throw new Error("boom");
        })).toThrow("boom");
        expect(db.inTransaction).toBe(false);
        expect(db.query("SELECT count(*) AS n FROM push_account_state").get()!.n).toBe(0);
        const probe = new PgConnection(database);
        try {
          // The lock is free: the store never retained it after the failure.
          expect(probe.query(TRY_LOCK).rows[0]!.acquired).toBe(true);
          expect(probe.query(UNLOCK).rows[0]!.released).toBe(true);
        } finally { probe.close(); }
        expect(store.observe([account(69)], 1)).toBe(0);
      } finally { store.close(); }
    });
  });

  test("a nested nonblocking call keeps the savepoint path while the outer lock is held", () => {
    fixture((store) => {
      const db = managedDb(store);
      try {
        db.begin();
        expect(db.inTransaction).toBe(true);
        try {
          // Already holding the lock: the nested call must not defer itself.
          expect(db.tryTransactionNonblocking(() => {
            db.run("INSERT INTO push_config(key, value) VALUES(?, ?)", "nested", "ok");
          })).toBe(true);
          expect(db.inTransaction).toBe(true); // still inside the outer transaction
        } finally { db.commit(); }
        expect(db.inTransaction).toBe(false);
        expect(db.query("SELECT value FROM push_config WHERE key='nested'").get()!.value).toBe("ok");
      } finally { store.close(); }
    });
  });
});

describe("native push writer", () => {
  test("keeps the blocking transaction path unchanged", () => {
    const prior = process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
    delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
    try {
      const store = new PushStore(join(tempDir("spendwatch-push-native-"), "push.db"));
      subscribe(store);
      const first = account(69);
      expect(store.observe([first], 1)).toBe(0);
      first.weekly!.usedPercent = 72;
      expect(store.observe([first], 2)).toBe(1);
      expect(store.pendingDeliveries().map((delivery) => delivery.threshold)).toEqual([30]);
      store.close();
    } finally {
      if (prior === undefined) delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
      else process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = prior;
    }
  });
});

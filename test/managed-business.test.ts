import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "../src/database";
import { writeCapacitySnapshot, loadCapacityHistory } from "../src/capacity-db";
import { loadSessionEquivalentForecasts } from "../src/session-equivalents";
import { CapacityPollStore, POLL_INTERVAL_MS } from "../src/capacity-poll";
import { PushStore } from "../src/push-store";
import type { CodexLimitAccount } from "../src/limits";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { writeMonthlySpend, loadMonthlySpend } from "../src/spend-history";
import { tokenSummary } from "../src/token-summary";
import { monthPeriod } from "../src/periods";
import type { Report } from "../src/aggregate";
import { loadBurnForecasts } from "../src/capacity-burn";
import { writeSnapshot } from "../src/db";

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

suite("managed business behavior", () => {
  test("keeps quota history, duplicates, paired forecast selection and aliases identical", () => {
    const result = fixture((path) => {
      const reset = "2026-08-16T00:00:00Z";
      const writes = [];
      for (let index = 0; index < 4; index++) {
        const at = Date.parse("2026-08-10T00:00:00Z") + index * 18_000_000;
        const account: CodexLimitAccount = {
          provider: "codex", email: "WORK@EXAMPLE.COM", plan: "Pro", devices: ["fixture"],
          updatedAt: new Date(at).toISOString(),
          session: { usedPercent: index, windowMinutes: 300, resetsAt: new Date(at + 18_000_000).toISOString() },
          weekly: { usedPercent: 10 + index * 10, windowMinutes: 10080, resetsAt: reset },
        };
        writes.push(writeCapacitySnapshot(path, [account], { collectedAt: at }));
        writes.push(writeCapacitySnapshot(path, [account], { collectedAt: at }));
      }
      const now = Date.parse("2026-08-10T15:00:00Z");
      const forecasts = [...loadSessionEquivalentForecasts(path, [{
        provider: "codex", email: "work@example.com", plan: "Pro", devices: ["fixture"],
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: reset },
      }], now)];
      const burn = [...loadBurnForecasts(path, [{
        provider: "codex", email: "work@example.com", plan: "Pro", devices: ["fixture"],
        updatedAt: new Date(now - 60_000).toISOString(),
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: reset },
      }], now)];
      return { writes, history: loadCapacityHistory(path, now), forecasts, burn };
    });
    expect(result.postgres).toEqual(result.sqlite);
  });

  test("preserves shared reservations, stale completions and cooldowns after reconnect", () => {
    const result = fixture((path) => {
      const stores = [new CapacityPollStore(path), new CapacityPollStore(path)];
      try {
        const first = stores[0]!.claim("codex", "WORK@example.com", 0);
        const blocked = stores[1]!.claim("codex", "work@example.com", 1);
        const next = stores[1]!.claim("codex", "work@example.com", POLL_INTERVAL_MS);
        const stale = stores[0]!.complete("codex", "work@example.com", first.lease!,
          { status: 429, retryAfterMs: 300_000 }, POLL_INTERVAL_MS + 1);
        const accepted = stores[1]!.complete("codex", "work@example.com", next.lease!,
          { status: 429, retryAfterMs: 300_000 }, POLL_INTERVAL_MS + 2);
        const again = new CapacityPollStore(path);
        try {
          const final = again.claim("codex", "work@example.com", POLL_INTERVAL_MS + 3);
          return { firstGranted: Boolean(first.lease), blocked: !blocked.lease,
            nextGranted: Boolean(next.lease), stale, accepted, finalGranted: Boolean(final.lease),
            nextAt: final.nextAt };
        } finally { again.close(); }
      } finally { stores.forEach((store) => store.close()); }
    });
    expect(result.postgres).toEqual(result.sqlite);
  });

  test("retains VAPID state and deduplicates threshold events without sending notifications", () => {
    const result = fixture((path) => {
      const store = new PushStore(path);
      try {
        store.setConfig("vapid_private_key", "fixture-key");
        store.upsertSubscription({ endpoint: "https://push.example.test/fixture",
          keys: { p256dh: "fixture", auth: "fixture" } }, "fixture", 1);
        const account: CodexLimitAccount = {
          provider: "codex", email: "work@example.com", plan: "Pro", devices: ["fixture"],
          weekly: { usedPercent: 69, windowMinutes: 10080, resetsAt: "2026-08-17T00:00:00Z" },
        };
        const initial = store.observe([account], 2);
        account.weekly!.usedPercent = 72;
        const crossed = store.observe([account], 3);
        const repeated = store.observe([account], 4);
        const pending = store.pendingDeliveries();
        store.markSent(pending[0]!.eventId, pending[0]!.endpoint, 5);
        return { initial, crossed, repeated, thresholds: pending.map((delivery) => delivery.threshold),
          remaining: store.pendingDeliveries().length, key: store.config("vapid_private_key") };
      } finally { store.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
  });

  test("keeps lexical values, nested rollback and SQL-looking data unchanged", () => {
    const result = fixture((path) => {
      const db = new Database(path);
      try {
        db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,n INTEGER)");
        const input = "What? '; DROP TABLE sample; --";
        db.query("INSERT INTO sample(name,n) VALUES(?,?)").run(input, 1);
        db.transaction(() => {
          db.query("INSERT INTO sample(name,n) VALUES(?,?)").run("outer", 2);
          try { db.transaction(() => {
            db.query("INSERT INTO sample(name,n) VALUES(?,?)").run("inner", 3);
            throw new Error("rollback fixture");
          })(); } catch {}
        })();
        return db.query("SELECT name,n AS numberValue,MAX(n,NULL) AS nullValue FROM sample ORDER BY id").all();
      } finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
  });

  test("keeps monthly and daily token high-water marks across resets and thinner rereads", () => {
    const result = fixture((path) => {
      const now = Date.parse("2026-10-13T20:00:00Z");
      const report = (tokens: number, installationId: string): Report => ({
        source: "fixture:codex", installationId, period: monthPeriod("2026-10"),
        totalTokens: tokens, totalCost: 0, apiCalls: 1, sessions: 1, tools: [], bash: [],
        deep: [], targets: [], prompts: [], projects: [], accounts: [], sinceTs: now,
        models: [{ model: "gpt-6.1-sol", calls: 1, inTok: tokens, outTok: 0,
          cacheReadTok: 0, cacheWriteTok: 0, cost: 0 }],
        tokenDays: { timeZone: "Europe/Berlin", measuredAt: now,
          rows: [{ day: "2026-10-13", model: "gpt-6.1-sol", tokens }] },
      });
      writeMonthlySpend(path, [report(100, "one"), report(30, "two")], { generatedAt: now });
      writeMonthlySpend(path, [report(10, "one")], { generatedAt: now + 1 });
      return { months: loadMonthlySpend(path), tokens: tokenSummary(path,
        { now, timeZone: "Europe/Berlin" }) };
    });
    expect(result.postgres).toEqual(result.sqlite);
  });

  test("a managed import retry cannot append a second normalized snapshot", () => {
    const result = fixture((path) => {
      const opts = { generatedAt: 1000, days: 30, idempotencyKey: "a".repeat(64) };
      const first = writeSnapshot(path, [], opts);
      const second = writeSnapshot(path, [], { ...opts, generatedAt: 2000 });
      const db = new Database(path);
      try { return { first, second, count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n }; }
      finally { db.close(); }
    });
    expect(result.postgres.count).toBe(1);
    expect(result.postgres.second).toEqual(result.postgres.first);
    expect(result.sqlite.count).toBe(2); // The ordinary local CLI retains its append-only contract.
  });

  test("batched normalized inserts retain every model and the final partial batch", () => {
    const result = fixture((path) => {
      const models: Report["models"] = Array.from({ length: 350 }, (_, index) => ({
        model: "fixture-" + index, calls: 1, inTok: index, outTok: 1,
        cacheReadTok: 0, cacheWriteTok: 0, cost: 0,
      }));
      const report: Report = {
        source: "fixture:codex", totalTokens: 100, totalCost: 0, apiCalls: 350, sessions: 1,
        tools: [], bash: [], deep: [], targets: [], prompts: [], projects: [], accounts: [], models,
      };
      const written = writeSnapshot(path, [report], { generatedAt: 1000, days: 30 });
      const db = new Database(path);
      try { return { written, models: db.query("SELECT model,in_tok AS inputTokens FROM models ORDER BY model").all() }; }
      finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    expect(result.postgres.written.rows).toBe(350);
  });

  test("sample text containing NUL survives normalized storage and an aliased read", () => {
    const result = fixture((path) => {
      const detail = "before\0after — Shëndetësi";
      const report: Report = {
        source: "fixture:codex", totalTokens: 100, totalCost: 0, apiCalls: 1, sessions: 1,
        tools: [{ name: "read", calls: 1, argTok: 1, resultTok: 1, ctxCost: 0,
          samples: [{ detail, count: 1, resultTok: 1 }] }],
        bash: [], deep: [], targets: [], prompts: [], projects: [], accounts: [], models: [],
      };
      writeSnapshot(path, [report], { generatedAt: 1000, days: 30 });
      const db = new Database(path);
      try { return db.query("SELECT detail AS body FROM samples").get(); }
      finally { db.close(); }
    });
    expect(result.postgres).toEqual(result.sqlite);
    expect((result.postgres as { body: string }).body).toContain("\0");
  });
});

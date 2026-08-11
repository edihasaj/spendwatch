import { Database } from "bun:sqlite";
import { crossedWeeklyThreshold, type WeeklyAlertThreshold } from "./capacity-alerts";
import type { CodexLimitAccount } from "./limits";

const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_account_state (
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_label TEXT NOT NULL,
  reset_key TEXT NOT NULL,
  last_left INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, account_key, reset_key)
);
CREATE TABLE IF NOT EXISTS push_threshold_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_label TEXT NOT NULL,
  reset_key TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  remaining_percent INTEGER NOT NULL,
  triggered_at_ms INTEGER NOT NULL,
  UNIQUE(provider, account_key, reset_key, threshold)
);
CREATE TABLE IF NOT EXISTS push_deliveries (
  event_id INTEGER NOT NULL REFERENCES push_threshold_events(id),
  endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms INTEGER,
  last_error TEXT,
  sent_at_ms INTEGER,
  PRIMARY KEY(event_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_delivery_pending ON push_deliveries(status, event_id);
`;

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PendingPushDelivery extends StoredPushSubscription {
  eventId: number;
  provider: string;
  account: string;
  resetKey: string;
  threshold: WeeklyAlertThreshold;
  remainingPercent: number;
}

interface AccountStateRow { lastLeft: number }
interface EventRow { id: number }

export class PushStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(PUSH_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  config(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM push_config WHERE key = ?").get(key)?.value;
  }

  setConfig(key: string, value: string): void {
    this.db.query("INSERT INTO push_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  upsertSubscription(subscription: StoredPushSubscription, userAgent: string | undefined, nowMs: number): void {
    this.db.query(`
      INSERT INTO push_subscriptions(endpoint, p256dh, auth, user_agent, enabled, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth,
        user_agent=excluded.user_agent, enabled=1, updated_at_ms=excluded.updated_at_ms
    `).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent ?? null, nowMs, nowMs);
  }

  disableSubscription(endpoint: string, nowMs: number): void {
    this.db.query("UPDATE push_subscriptions SET enabled=0, updated_at_ms=? WHERE endpoint=?").run(nowMs, endpoint);
  }

  enabledSubscriptions(): StoredPushSubscription[] {
    return this.db.query<{ endpoint: string; p256dh: string; auth: string }, []>(`
      SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE enabled=1 ORDER BY created_at_ms
    `).all().map((row) => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }));
  }

  observe(accounts: CodexLimitAccount[], nowMs: number): number {
    let created = 0;
    const transaction = this.db.transaction(() => {
      for (const account of accounts) {
        if (!account.weekly) continue;
        const accountKey = account.email.toLowerCase();
        const resetKey = account.weekly.resetsAt ?? `window-${account.weekly.windowMinutes}`;
        const remaining = Math.max(0, Math.min(100, Math.round(100 - account.weekly.usedPercent)));
        const state = this.db.query<AccountStateRow, [string, string, string]>(`
          SELECT last_left AS lastLeft FROM push_account_state
          WHERE provider=? AND account_key=? AND reset_key=?
        `).get(account.provider, accountKey, resetKey);
        if (!state) {
          this.db.query(`
            INSERT INTO push_account_state(provider, account_key, account_label, reset_key, last_left, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(account.provider, accountKey, account.email, resetKey, remaining, nowMs);
          continue;
        }
        const threshold = crossedWeeklyThreshold(state.lastLeft, remaining);
        if (threshold !== undefined) {
          const result = this.db.query(`
            INSERT OR IGNORE INTO push_threshold_events(
              provider, account_key, account_label, reset_key, threshold, remaining_percent, triggered_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(account.provider, accountKey, account.email, resetKey, threshold, remaining, nowMs);
          if (result.changes > 0) {
            const event = this.db.query<EventRow, [string, string, string, number]>(`
              SELECT id FROM push_threshold_events
              WHERE provider=? AND account_key=? AND reset_key=? AND threshold=?
            `).get(account.provider, accountKey, resetKey, threshold)!;
            this.db.query(`
              INSERT OR IGNORE INTO push_deliveries(event_id, endpoint)
              SELECT ?, endpoint FROM push_subscriptions WHERE enabled=1
            `).run(event.id);
            created++;
          }
        }
        this.db.query(`
          UPDATE push_account_state SET account_label=?, last_left=?, updated_at_ms=?
          WHERE provider=? AND account_key=? AND reset_key=?
        `).run(account.email, remaining, nowMs, account.provider, accountKey, resetKey);
      }
    });
    transaction();
    return created;
  }

  pendingDeliveries(): PendingPushDelivery[] {
    return this.db.query<{
      eventId: number; endpoint: string; p256dh: string; auth: string; provider: string;
      account: string; resetKey: string; threshold: WeeklyAlertThreshold; remainingPercent: number;
    }, []>(`
      SELECT d.event_id AS eventId, d.endpoint, s.p256dh, s.auth,
        e.provider, e.account_label AS account, e.reset_key AS resetKey,
        e.threshold, e.remaining_percent AS remainingPercent
      FROM push_deliveries d
      JOIN push_subscriptions s ON s.endpoint=d.endpoint AND s.enabled=1
      JOIN push_threshold_events e ON e.id=d.event_id
      WHERE d.status='pending'
      ORDER BY e.triggered_at_ms, d.endpoint
    `).all().map((row) => ({
      ...row,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }));
  }

  markSent(eventId: number, endpoint: string, nowMs: number): void {
    this.db.query(`
      UPDATE push_deliveries SET status='sent', attempts=attempts+1,
        last_attempt_at_ms=?, last_error=NULL, sent_at_ms=? WHERE event_id=? AND endpoint=?
    `).run(nowMs, nowMs, eventId, endpoint);
  }

  markFailed(eventId: number, endpoint: string, error: string, gone: boolean, nowMs: number): void {
    this.db.query(`
      UPDATE push_deliveries SET status=?, attempts=attempts+1,
        last_attempt_at_ms=?, last_error=? WHERE event_id=? AND endpoint=?
    `).run(gone ? "gone" : "pending", nowMs, error.slice(0, 300), eventId, endpoint);
    if (gone) this.disableSubscription(endpoint, nowMs);
  }
}

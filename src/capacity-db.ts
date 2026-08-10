import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { CapacityProvider, CodexLimitAccount, LimitWindow } from "./limits";

const CAPACITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS capacity_history (
  sample_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  sampled_at_ms INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  used_percent REAL NOT NULL,
  resets_at_ms INTEGER,
  window_minutes INTEGER NOT NULL,
  source TEXT NOT NULL,
  devices TEXT NOT NULL,
  prediction_delta REAL,
  prediction_expected REAL,
  prediction_will_last INTEGER,
  prediction_runs_out_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_capacity_history_time
  ON capacity_history(sampled_at_ms);
CREATE INDEX IF NOT EXISTS idx_capacity_history_account
  ON capacity_history(provider, account, window_kind, sampled_at_ms);

CREATE TABLE IF NOT EXISTS capacity_account_history (
  sample_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  sampled_at_ms INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  plan TEXT NOT NULL,
  organization TEXT,
  devices TEXT NOT NULL,
  copilot_chat_unlimited INTEGER,
  copilot_completions_unlimited INTEGER,
  copilot_premium_unlimited INTEGER,
  copilot_premium_credits_used REAL,
  copilot_overage_permitted INTEGER,
  copilot_token_based_billing INTEGER,
  copilot_resets_at_ms INTEGER,
  copilot_seat_assigned_at_ms INTEGER,
  api_balance_available INTEGER,
  api_balances_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_capacity_account_history_time
  ON capacity_account_history(sampled_at_ms);
CREATE INDEX IF NOT EXISTS idx_capacity_account_history_account
  ON capacity_account_history(provider, account, sampled_at_ms);
`;

interface HistoricalWindowInput {
  kind?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowMinutes?: unknown;
}

interface HistoricalRecordInput {
  provider?: unknown;
  account?: unknown;
  device?: unknown;
  source?: unknown;
  sampledAt?: unknown;
  plan?: unknown;
  windows?: unknown;
}

export interface CapacityHistoryPoint {
  at: number;
  value: number;
  resetsAt?: number;
}

export interface CapacityHistorySeries {
  provider: CapacityProvider;
  account: string;
  kind: "session" | "weekly" | "credits";
  points: CapacityHistoryPoint[];
  sampleCount: number;
}

export interface CapacityHistoryDataset {
  generatedAt: number;
  firstSampleAt?: number;
  lastSampleAt?: number;
  sampleCount: number;
  series: CapacityHistorySeries[];
}

function parsedTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanPart(value: string): string {
  return value.replace(/[|\n\r]/g, "-").trim();
}

function windowSampleKey(
  provider: string,
  account: string,
  kind: string,
  sampledAt: number,
  usedPercent: number,
  resetsAt?: number,
): string {
  return [provider, cleanPart(account.toLowerCase()), kind, Math.round(sampledAt), usedPercent, resetsAt ?? ""].join("|");
}

function openCapacityDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 10000;");
  db.exec(CAPACITY_SCHEMA);
  const accountColumns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(capacity_account_history)",
  ).all().map((column) => column.name));
  if (!accountColumns.has("api_balance_available")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN api_balance_available INTEGER");
  }
  if (!accountColumns.has("api_balances_json")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN api_balances_json TEXT");
  }
  if (!accountColumns.has("copilot_overage_permitted")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN copilot_overage_permitted INTEGER");
  }
  if (!accountColumns.has("copilot_token_based_billing")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN copilot_token_based_billing INTEGER");
  }
  if (!accountColumns.has("copilot_resets_at_ms")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN copilot_resets_at_ms INTEGER");
  }
  if (!accountColumns.has("copilot_seat_assigned_at_ms")) {
    db.exec("ALTER TABLE capacity_account_history ADD COLUMN copilot_seat_assigned_at_ms INTEGER");
  }
  return db;
}

function insertWindow(
  statement: ReturnType<Database["prepare"]>,
  account: { provider: string; account: string; devices: string[] },
  kind: "session" | "weekly",
  window: LimitWindow,
  sampledAt: number,
  observedAt: string,
  source: string,
): boolean {
  const resetsAt = parsedTime(window.resetsAt);
  const prediction = window.prediction;
  const result = statement.run(
    windowSampleKey(account.provider, account.account, kind, sampledAt, window.usedPercent, resetsAt),
    account.provider,
    account.account,
    kind,
    sampledAt,
    observedAt,
    window.usedPercent,
    resetsAt ?? null,
    window.windowMinutes,
    source,
    JSON.stringify(account.devices),
    prediction?.deltaPercent ?? null,
    prediction?.expectedUsedPercent ?? null,
    prediction ? Number(prediction.willLastToReset) : null,
    prediction?.runsOutAt ? parsedTime(prediction.runsOutAt) ?? null : null,
  );
  return result.changes > 0;
}

export function writeCapacitySnapshot(
  path: string,
  accounts: CodexLimitAccount[],
  opts: { collectedAt: number },
): { rows: number } {
  const db = openCapacityDatabase(path);
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO capacity_account_history(
      sample_key, provider, account, sampled_at_ms, observed_at, plan,
      organization, devices, copilot_chat_unlimited,
      copilot_completions_unlimited, copilot_premium_unlimited,
      copilot_premium_credits_used, copilot_overage_permitted,
      copilot_token_based_billing, copilot_resets_at_ms,
      copilot_seat_assigned_at_ms, api_balance_available, api_balances_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO capacity_history(
      sample_key, provider, account, window_kind, sampled_at_ms, observed_at,
      used_percent, resets_at_ms, window_minutes, source, devices,
      prediction_delta, prediction_expected, prediction_will_last,
      prediction_runs_out_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let rows = 0;
  const tx = db.transaction(() => {
    for (const account of accounts) {
      const sampledAt = parsedTime(account.updatedAt) ?? opts.collectedAt;
      const observedAt = account.updatedAt ?? new Date(sampledAt).toISOString();
      const accountKey = [account.provider, cleanPart(account.email.toLowerCase()), sampledAt].join("|");
      const result = insertAccount.run(
        accountKey,
        account.provider,
        account.email,
        sampledAt,
        observedAt,
        account.plan,
        account.organization ?? null,
        JSON.stringify(account.devices),
        account.copilot ? Number(account.copilot.chatUnlimited) : null,
        account.copilot ? Number(account.copilot.completionsUnlimited) : null,
        account.copilot ? Number(account.copilot.premiumUnlimited) : null,
        account.copilot?.premiumCreditsUsed ?? null,
        account.copilot ? Number(account.copilot.overagePermitted) : null,
        account.copilot ? Number(account.copilot.tokenBasedBilling) : null,
        account.copilot?.resetsAt ? parsedTime(account.copilot.resetsAt) ?? null : null,
        account.copilot?.seatAssignedAt ? parsedTime(account.copilot.seatAssignedAt) ?? null : null,
        account.route?.available === undefined ? null : Number(account.route.available),
        account.route ? JSON.stringify(account.route.balances) : null,
      );
      rows += result.changes;
      if (account.session) rows += Number(insertWindow(insertHistory, { provider: account.provider, account: account.email, devices: account.devices }, "session", account.session, sampledAt, observedAt, "live"));
      if (account.weekly) rows += Number(insertWindow(insertHistory, { provider: account.provider, account: account.email, devices: account.devices }, "weekly", account.weekly, sampledAt, observedAt, "live"));
    }
  });
  tx();
  db.close();
  return { rows };
}

function normalizeHistoricalRecord(value: unknown): {
  provider: CapacityProvider;
  account: string;
  device: string;
  source: string;
  sampledAt: number;
  plan: string;
  windows: Array<{ kind: "session" | "weekly"; window: LimitWindow }>;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as HistoricalRecordInput;
  if (record.provider !== "codex" && record.provider !== "claude" && record.provider !== "copilot" && record.provider !== "lokai") return undefined;
  if (typeof record.account !== "string" || !record.account.trim()) return undefined;
  const sampledAt = parsedTime(record.sampledAt);
  if (sampledAt === undefined || !Array.isArray(record.windows)) return undefined;
  const windows = record.windows.flatMap((raw): Array<{ kind: "session" | "weekly"; window: LimitWindow }> => {
    if (!raw || typeof raw !== "object") return [];
    const input = raw as HistoricalWindowInput;
    const usedPercent = finiteNumber(input.usedPercent);
    const windowMinutes = finiteNumber(input.windowMinutes);
    if ((input.kind !== "session" && input.kind !== "weekly") || usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) return [];
    return [{
      kind: input.kind,
      window: {
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        windowMinutes,
        resetsAt: typeof input.resetsAt === "string" ? input.resetsAt : undefined,
      },
    }];
  });
  if (!windows.length) return undefined;
  return {
    provider: record.provider,
    account: record.account.trim(),
    device: typeof record.device === "string" ? record.device.trim().toLowerCase() : "historical",
    source: typeof record.source === "string" ? record.source.trim() : "historical",
    sampledAt,
    plan: typeof record.plan === "string" ? record.plan : "unknown",
    windows,
  };
}

export function importCapacityHistory(path: string, inputs: string[]): { inserted: number; accepted: number } {
  const db = openCapacityDatabase(path);
  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO capacity_history(
      sample_key, provider, account, window_kind, sampled_at_ms, observed_at,
      used_percent, resets_at_ms, window_minutes, source, devices,
      prediction_delta, prediction_expected, prediction_will_last,
      prediction_runs_out_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0;
  let accepted = 0;
  const tx = db.transaction((records: ReturnType<typeof normalizeHistoricalRecord>[]) => {
    for (const record of records) {
      if (!record) continue;
      accepted++;
      const observedAt = new Date(record.sampledAt).toISOString();
      for (const item of record.windows) {
        inserted += Number(insertWindow(
          insertHistory,
          { provider: record.provider, account: record.account, devices: [record.device] },
          item.kind,
          item.window,
          record.sampledAt,
          observedAt,
          record.source,
        ));
      }
    }
  });
  for (const input of inputs) {
    const raw = readFileSync(input);
    const text = input.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    const records = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeHistoricalRecord(JSON.parse(line));
        } catch {
          return undefined;
        }
      });
    tx(records);
  }
  db.close();
  return { inserted, accepted };
}

interface HistoryRow {
  provider: CapacityProvider;
  account: string;
  kind: "session" | "weekly";
  sampledAt: number;
  value: number;
  resetsAt: number | null;
  sampleCount: number;
}

interface CreditRow {
  provider: CapacityProvider;
  account: string;
  sampledAt: number;
  value: number;
  sampleCount: number;
}

export function loadCapacityHistory(path: string, nowMs = Date.now()): CapacityHistoryDataset {
  const db = openCapacityDatabase(path);
  const historyMeta = db.query<{ count: number; firstAt: number | null; lastAt: number | null }, []>(`
    SELECT COUNT(*) AS count, MIN(sampled_at_ms) AS firstAt, MAX(sampled_at_ms) AS lastAt
    FROM capacity_history
  `).get();
  const accountMeta = db.query<{ count: number; firstAt: number | null; lastAt: number | null }, []>(`
    SELECT COUNT(*) AS count, MIN(sampled_at_ms) AS firstAt, MAX(sampled_at_ms) AS lastAt
    FROM capacity_account_history
  `).get();
  const bucketExpression = `CASE
    WHEN sampled_at_ms >= ${Math.round(nowMs - 2 * 86400_000)} THEN 300000
    WHEN sampled_at_ms >= ${Math.round(nowMs - 30 * 86400_000)} THEN 1800000
    WHEN sampled_at_ms >= ${Math.round(nowMs - 180 * 86400_000)} THEN 21600000
    ELSE 86400000 END`;
  const rows = db.query<HistoryRow, []>(`
    WITH ranked AS (
      SELECT provider, account, window_kind AS kind, sampled_at_ms AS sampledAt,
             used_percent AS value, resets_at_ms AS resetsAt,
             COUNT(*) OVER (PARTITION BY provider, account, window_kind) AS sampleCount,
             ROW_NUMBER() OVER (
               PARTITION BY provider, account, window_kind,
                 CAST(sampled_at_ms / (${bucketExpression}) AS INTEGER)
               ORDER BY sampled_at_ms DESC
             ) AS rank
      FROM capacity_history
    )
    SELECT provider, account, kind, sampledAt, value, resetsAt, sampleCount
    FROM ranked WHERE rank = 1
    ORDER BY provider, account, kind, sampledAt
  `).all();
  const creditRows = db.query<CreditRow, []>(`
    WITH ranked AS (
      SELECT provider, account, sampled_at_ms AS sampledAt,
             copilot_premium_credits_used AS value,
             COUNT(*) OVER (PARTITION BY provider, account) AS sampleCount,
             ROW_NUMBER() OVER (
               PARTITION BY provider, account,
                 CAST(sampled_at_ms / (${bucketExpression}) AS INTEGER)
               ORDER BY sampled_at_ms DESC
             ) AS rank
      FROM capacity_account_history
      WHERE copilot_premium_credits_used IS NOT NULL
    )
    SELECT provider, account, sampledAt, value, sampleCount
    FROM ranked WHERE rank = 1
    ORDER BY provider, account, sampledAt
  `).all();
  const series = new Map<string, CapacityHistorySeries>();
  for (const row of rows) {
    const key = `${row.provider}:${row.account}:${row.kind}`;
    const item = series.get(key) ?? {
      provider: row.provider,
      account: row.account,
      kind: row.kind,
      points: [],
      sampleCount: row.sampleCount,
    };
    item.points.push({ at: row.sampledAt, value: row.value, resetsAt: row.resetsAt ?? undefined });
    series.set(key, item);
  }
  for (const row of creditRows) {
    const key = `${row.provider}:${row.account}:credits`;
    const item = series.get(key) ?? {
      provider: row.provider,
      account: row.account,
      kind: "credits" as const,
      points: [],
      sampleCount: row.sampleCount,
    };
    item.points.push({ at: row.sampledAt, value: row.value });
    series.set(key, item);
  }
  db.close();
  const firstValues = [historyMeta?.firstAt, accountMeta?.firstAt].filter((value): value is number => typeof value === "number");
  const lastValues = [historyMeta?.lastAt, accountMeta?.lastAt].filter((value): value is number => typeof value === "number");
  return {
    generatedAt: nowMs,
    firstSampleAt: firstValues.length ? Math.min(...firstValues) : undefined,
    lastSampleAt: lastValues.length ? Math.max(...lastValues) : undefined,
    sampleCount: (historyMeta?.count ?? 0) + (accountMeta?.count ?? 0),
    series: [...series.values()],
  };
}

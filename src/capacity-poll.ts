import { Database } from "./database";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapacityCloudCredits, CapacityExtraUsage, CapacityResult, CapacityWindow } from "./capacity-current";
import type { ClaudeCapacityResult } from "./claude-capacity";
import {
  CapacityCoordinatorUnavailableError,
  coordinatorAccessHeaders,
} from "./capacity-coordinator-client";

export type PollProvider = "claude" | "codex";
export type PollSnapshot = CapacityResult | ClaudeCapacityResult;
// Keep the established Claude failure-backoff floor and exported timing base.
export const POLL_INTERVAL_MS = 5 * 60_000;
export const CODEX_POLL_INTERVAL_MS = 60_000;
export const CLAUDE_POLL_INTERVAL_MS = 2 * 60_000;
export const MAX_FUTURE_SNAPSHOT_SKEW_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;

interface PollRow {
  next_at: number;
  lease: string;
  failures: number;
  snapshot: string | null;
}

export interface PollClaim {
  lease?: string;
  nextAt: number;
  snapshot?: PollSnapshot;
}

export function pollIntervalMs(provider: PollProvider): number {
  return provider === "codex" ? CODEX_POLL_INTERVAL_MS : CLAUDE_POLL_INTERVAL_MS;
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export function pollKey(provider: unknown, account: unknown): string {
  if ((provider !== "claude" && provider !== "codex") || typeof account !== "string" ||
      account.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(account.trim())) {
    throw new Error("invalid capacity account");
  }
  return `${provider}:${account.trim().toLowerCase()}`;
}

function money(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Allowlist the projection before persisting anything supplied by a collector.
// Tokens, provider responses and exception messages must never enter this table.
export function sanitizePollSnapshot(value: unknown, key: string, now = Date.now()): PollSnapshot {
  const input = value as PollSnapshot | undefined;
  const updatedAtMs = input?.usage ? Date.parse(input.usage.updatedAt) : Number.NaN;
  if (!input || pollKey(input.provider, input.account) !== key ||
      !input.usage || !Number.isFinite(updatedAtMs) ||
      updatedAtMs > now + MAX_FUTURE_SNAPSHOT_SKEW_MS) {
    throw new Error("invalid capacity snapshot");
  }
  const window = (raw: CapacityWindow | null): CapacityWindow | null => {
    if (raw == null) return null;
    if (!Number.isFinite(raw.usedPercent) || raw.usedPercent < 0 || raw.usedPercent > 100 ||
        !Number.isFinite(raw.windowMinutes) || raw.windowMinutes <= 0 ||
        (raw.resetsAt !== undefined && !Number.isFinite(Date.parse(raw.resetsAt)))) {
      throw new Error("invalid capacity window");
    }
    return { usedPercent: raw.usedPercent, windowMinutes: raw.windowMinutes, resetsAt: raw.resetsAt };
  };
  const usage: CapacityResult["usage"] & {
    accountOrganization?: string;
    cloudCredits?: CapacityCloudCredits;
    extraUsage?: CapacityExtraUsage;
  } = {
    accountEmail: input.account,
    loginMethod: typeof input.usage.loginMethod === "string" ? input.usage.loginMethod.slice(0, 100) : undefined,
    primary: window(input.usage.primary),
    secondary: window(input.usage.secondary),
    tertiary: window(input.usage.tertiary),
    updatedAt: input.usage.updatedAt,
  };
  if (!usage.primary && !usage.secondary && !usage.tertiary) throw new Error("missing capacity windows");
  if (input.provider === "claude") {
    const claudeUsage = input.usage;
    usage.accountOrganization = typeof claudeUsage.accountOrganization === "string"
      ? claudeUsage.accountOrganization.slice(0, 320) : undefined;
    // Malformed credit blocks are advisory next to the quota windows: drop them
    // rather than rejecting a snapshot whose windows are valid.
    const cloud = claudeUsage.cloudCredits;
    if (cloud && typeof cloud === "object") {
      const limit = cloud.limitUsd;
      const remaining = cloud.remainingUsd;
      const expiresAt = typeof cloud.expiresAt === "string" && Number.isFinite(Date.parse(cloud.expiresAt))
        ? cloud.expiresAt
        : undefined;
      if (money(limit) && limit > 0 && money(remaining) && remaining <= limit) {
        usage.cloudCredits = {
          limitUsd: limit,
          remainingUsd: remaining,
          ...(expiresAt ? { expiresAt } : {}),
          ...(cloud.locked === true ? { locked: true } : {}),
        };
      }
    }
    const extra = claudeUsage.extraUsage;
    if (extra && typeof extra === "object") {
      const used = extra.usedAmount;
      const limit = extra.limitAmount;
      if (money(used) && money(limit) && typeof extra.currency === "string" && /^[A-Z]{3}$/.test(extra.currency)) {
        usage.extraUsage = { usedAmount: used, limitAmount: limit, currency: extra.currency };
      }
    }
  } else if (input.usage.credits) {
    const { balance, unlimited } = input.usage.credits;
    if (typeof balance !== "string" || !/^\d+(?:\.\d+)?$/.test(balance) || balance.length > 100 ||
        typeof unlimited !== "boolean") throw new Error("invalid capacity credits");
    usage.credits = { balance, unlimited };
  }
  if (input.provider === "codex" && input.usage.quotaPool !== undefined) {
    if (typeof input.usage.quotaPool !== "string" ||
        !/^(?:legacy|codex(?:_[a-z0-9-]+)?)$/u.test(input.usage.quotaPool)) {
      throw new Error("invalid capacity quota pool");
    }
    usage.quotaPool = input.usage.quotaPool;
  }
  return { provider: input.provider, account: input.account, usage, pace: null } as PollSnapshot;
}

export class CapacityPollStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS capacity_poll (
        account_key TEXT PRIMARY KEY, next_at INTEGER NOT NULL,
        lease TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, snapshot TEXT
      );`);
  }

  claim(provider: PollProvider, account: string, now = Date.now()): PollClaim {
    const key = pollKey(provider, account);
    return this.db.transaction(() => {
      const row = this.db.query<PollRow, [string]>("SELECT * FROM capacity_poll WHERE account_key=?").get(key);
      const snapshot = row?.snapshot ? JSON.parse(row.snapshot) as PollSnapshot : undefined;
      if (row && row.next_at > now) return { nextAt: row.next_at, snapshot };
      const lease = crypto.randomUUID();
      const nextAt = now + pollIntervalMs(provider);
      this.db.query(`INSERT INTO capacity_poll(account_key,next_at,lease) VALUES(?,?,?)
        ON CONFLICT(account_key) DO UPDATE SET next_at=excluded.next_at,lease=excluded.lease`)
        .run(key, nextAt, lease);
      return { lease, nextAt, snapshot };
    }).immediate();
  }

  cached(provider: PollProvider, account: string): PollSnapshot | undefined {
    const key = pollKey(provider, account);
    const row = this.db.query<PollRow, [string]>("SELECT * FROM capacity_poll WHERE account_key=?").get(key);
    if (!row?.snapshot) return undefined;
    try { return JSON.parse(row.snapshot) as PollSnapshot; }
    catch { return undefined; }
  }

  // The remote coordinator owns leases and cooldowns. This cache changes only
  // the validated fallback value, so it cannot steal or extend local state.
  cacheSnapshot(provider: PollProvider, account: string, value: unknown): void {
    const key = pollKey(provider, account);
    const snapshot = sanitizePollSnapshot(value, key);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO capacity_poll(account_key,next_at,lease,failures,snapshot) VALUES(?,?, '',0,?)
        ON CONFLICT(account_key) DO UPDATE SET snapshot=excluded.snapshot`)
        .run(key, 0, JSON.stringify(snapshot));
    }).immediate();
  }

  complete(provider: PollProvider, account: string, lease: string,
    result: { snapshot?: unknown; status?: number; retryAfterMs?: number }, now = Date.now()): boolean {
    const key = pollKey(provider, account);
    const snapshot = result.snapshot === undefined ? undefined : sanitizePollSnapshot(result.snapshot, key);
    return this.db.transaction(() => {
      const row = this.db.query<PollRow, [string]>("SELECT * FROM capacity_poll WHERE account_key=?").get(key);
      if (!row || row.lease !== lease) return false;
      const failures = snapshot ? 0 : Math.min(row.failures + 1, 8);
      const backoff = snapshot ? 0 : result.status === 429
        ? RATE_LIMIT_COOLDOWN_MS * 2 ** Math.min(failures - 1, 2)
        : (provider === "claude" ? POLL_INTERVAL_MS : CODEX_POLL_INTERVAL_MS) * 2 ** Math.min(failures - 1, 3);
      const retry = Number.isFinite(result.retryAfterMs) && result.retryAfterMs! > 0 ? result.retryAfterMs! : 0;
      this.db.query("UPDATE capacity_poll SET next_at=?,lease='',failures=?,snapshot=? WHERE account_key=?")
        .run(Math.max(row.next_at, now + backoff, now + retry), failures,
          snapshot ? JSON.stringify(snapshot) : row.snapshot, key);
      return true;
    }).immediate();
  }

  close(): void { this.db.close(); }
}

export function pollingCoordinator(): string | undefined {
  if (process.env.SPENDWATCH_CAPACITY_COORDINATOR) return process.env.SPENDWATCH_CAPACITY_COORDINATOR;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".config/spendwatch/polling.json"), "utf8"));
    return typeof config.coordinator === "string" ? config.coordinator : undefined;
  } catch { return undefined; }
}

export async function coordinatorRequest(
  base: string,
  action: string,
  body: unknown,
  options: { accessConfigPath?: string; fetch?: typeof fetch } = {},
): Promise<unknown> {
  const headers = coordinatorAccessHeaders(base, options.accessConfigPath);
  const response = await (options.fetch ?? fetch)(new URL(`/api/capacity/poll/${action}`, base), {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`capacity coordinator HTTP ${response.status}`);
  return response.json();
}

function coordinatorClaim(value: unknown): PollClaim {
  if (!value || typeof value !== "object") throw new Error("invalid capacity coordinator response");
  const claim = value as Partial<PollClaim>;
  if (!Number.isFinite(claim.nextAt) || claim.nextAt! < 0 ||
      (claim.lease !== undefined && (typeof claim.lease !== "string" || claim.lease.length > 100))) {
    throw new Error("invalid capacity coordinator response");
  }
  return claim as PollClaim;
}

export async function coordinatedCapacity<T extends PollSnapshot>(
  provider: PollProvider, account: string, read: () => Promise<T | undefined>,
  options: {
    coordinator?: string;
    store?: CapacityPollStore;
    now?: () => number;
    accessConfigPath?: string;
    fetch?: typeof fetch;
  } = {},
): Promise<T | undefined> {
  const key = pollKey(provider, account);
  const coordinator = options.coordinator ?? pollingCoordinator();
  const now = options.now ?? Date.now;
  const nowMs = now();
  const local = options.store ?? new CapacityPollStore(
    process.env.SPENDWATCH_CAPACITY_CACHE ?? join(homedir(), ".local/share/spendwatch/capacity-poll.db"));
  try {
    // The configured coordinator is authoritative. If it is unreachable, use
    // only the local cache; independent fallback reads would multiply traffic.
    let claim: PollClaim;
    if (coordinator) {
      try {
        claim = coordinatorClaim(await coordinatorRequest(
          coordinator, "claim", { provider, account }, options,
        ));
      } catch {
        const cached = local.cached(provider, account);
        if (cached) {
          sanitizePollSnapshot(cached, key);
          return cached as T;
        }
        throw new CapacityCoordinatorUnavailableError();
      }
    } else claim = local.claim(provider, account, nowMs);
    if (claim.snapshot) {
      sanitizePollSnapshot(claim.snapshot, key);
      if (coordinator) local.cacheSnapshot(provider, account, claim.snapshot);
    }
    if (!claim.lease) return claim.snapshot as T | undefined;
    let snapshot: T | undefined;
    let failure: unknown;
    try {
      snapshot = await read();
      if (snapshot) sanitizePollSnapshot(snapshot, key);
    } catch (error) { failure = error; }
    const error = failure as { status?: number; retryAfterMs?: number; message?: string } | undefined;
    const result = {
      snapshot,
      status: error?.status ?? (/\b429\b|rate.?limit/iu.test(error?.message ?? "") ? 429 : undefined),
      retryAfterMs: error?.retryAfterMs,
    };
    if (coordinator) {
      try {
        await coordinatorRequest(
          coordinator, "complete", { provider, account, lease: claim.lease, ...result },
          options,
        );
      }
      catch { /* The reserved attempt still prevents retries when completion is lost. */ }
      if (snapshot) local.cacheSnapshot(provider, account, snapshot);
    } else local.complete(provider, account, claim.lease, result, nowMs);
    if (failure) throw failure;
    return snapshot ?? claim.snapshot as T | undefined;
  } finally { if (!options.store) local.close(); }
}

export async function handleCapacityPoll(request: Request, store: CapacityPollStore): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) return Response.json({ error: "request too large" }, { status: 413 });
  const text = await request.text();
  if (text.length > 16_384) return Response.json({ error: "request too large" }, { status: 413 });
  try {
    const body = JSON.parse(text);
    pollKey(body.provider, body.account);
    if (new URL(request.url).pathname.endsWith("/claim")) return Response.json(store.claim(body.provider, body.account));
    if (typeof body.lease !== "string" || body.lease.length > 100) throw new Error("invalid lease");
    const ok = store.complete(body.provider, body.account, body.lease, body);
    return Response.json({ ok }, { status: ok ? 200 : 409 });
  } catch { return Response.json({ error: "invalid capacity poll" }, { status: 400 }); }
}

import { Database } from "./database";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapacityResult, CapacityWindow } from "./capacity-current";
import type { ClaudeCapacityResult } from "./claude-capacity";

export type PollProvider = "claude" | "codex";
export type PollSnapshot = CapacityResult | ClaudeCapacityResult;
export const POLL_INTERVAL_MS = 5 * 60_000;
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

// Allowlist the projection before persisting anything supplied by a collector.
// Tokens, provider responses and exception messages must never enter this table.
export function sanitizePollSnapshot(value: unknown, key: string): PollSnapshot {
  const input = value as PollSnapshot | undefined;
  if (!input || pollKey(input.provider, input.account) !== key ||
      !input.usage || !Number.isFinite(Date.parse(input.usage.updatedAt))) {
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
  const usage: CapacityResult["usage"] & { accountOrganization?: string } = {
    accountEmail: input.account,
    loginMethod: typeof input.usage.loginMethod === "string" ? input.usage.loginMethod.slice(0, 100) : undefined,
    primary: window(input.usage.primary),
    secondary: window(input.usage.secondary),
    tertiary: window(input.usage.tertiary),
    updatedAt: input.usage.updatedAt,
  };
  if (!usage.primary && !usage.secondary && !usage.tertiary) throw new Error("missing capacity windows");
  if (input.provider === "claude") {
    usage.accountOrganization = typeof input.usage.accountOrganization === "string"
      ? input.usage.accountOrganization.slice(0, 320) : undefined;
  } else if (input.usage.credits) {
    const { balance, unlimited } = input.usage.credits;
    if (typeof balance !== "string" || !/^\d+(?:\.\d+)?$/.test(balance) || balance.length > 100 ||
        typeof unlimited !== "boolean") throw new Error("invalid capacity credits");
    usage.credits = { balance, unlimited };
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
      const nextAt = now + POLL_INTERVAL_MS;
      this.db.query(`INSERT INTO capacity_poll(account_key,next_at,lease) VALUES(?,?,?)
        ON CONFLICT(account_key) DO UPDATE SET next_at=excluded.next_at,lease=excluded.lease`)
        .run(key, nextAt, lease);
      return { lease, nextAt, snapshot };
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
        : POLL_INTERVAL_MS * 2 ** Math.min(failures - 1, 3);
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

async function coordinatorRequest(base: string, action: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(`/api/capacity/poll/${action}`, base), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`capacity coordinator HTTP ${response.status}`);
  return response.json();
}

export async function coordinatedCapacity<T extends PollSnapshot>(
  provider: PollProvider, account: string, read: () => Promise<T | undefined>,
  options: { coordinator?: string; store?: CapacityPollStore; now?: () => number } = {},
): Promise<T | undefined> {
  const key = pollKey(provider, account);
  const coordinator = options.coordinator ?? pollingCoordinator();
  const now = options.now ?? Date.now;
  const local = options.store ?? new CapacityPollStore(
    process.env.SPENDWATCH_CAPACITY_CACHE ?? join(homedir(), ".local/share/spendwatch/capacity-poll.db"));
  try {
    // The configured coordinator is authoritative. If it is unreachable, use
    // only the local cache; independent fallback reads would multiply traffic.
    let claim: PollClaim;
    if (coordinator) {
      try {
        claim = await coordinatorRequest(coordinator, "claim", { provider, account }) as PollClaim;
      } catch {
        return local.claim(provider, account, now()).snapshot as T | undefined;
      }
    } else claim = local.claim(provider, account, now());
    if (claim.snapshot) sanitizePollSnapshot(claim.snapshot, key);
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
      try { await coordinatorRequest(coordinator, "complete", { provider, account, lease: claim.lease, ...result }); }
      catch { /* The reserved attempt still prevents retries when completion is lost. */ }
      if (snapshot) {
        const cached = local.claim(provider, account, now());
        if (cached.lease) local.complete(provider, account, cached.lease, { snapshot }, now());
      }
    } else local.complete(provider, account, claim.lease, result, now());
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

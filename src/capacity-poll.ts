import { Database } from "./database";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapacityCloudCredits, CapacityExtraUsage, CapacityLastKnownCredits, CapacityResult, CapacityWindow } from "./capacity-current";
import type { ClaudeCapacityResult } from "./claude-capacity";
import type { GeminiCapacityResult } from "./gemini-capacity";
import { normalizeGeminiRows } from "./gemini-quota";
import {
  CapacityCoordinatorUnavailableError,
  coordinatorAccessHeaders,
} from "./capacity-coordinator-client";

export type PollProvider = "claude" | "codex" | "gemini";
export type PollSnapshot = CapacityResult | ClaudeCapacityResult | GeminiCapacityResult;
// Keep the established Claude failure-backoff floor and exported timing base.
export const POLL_INTERVAL_MS = 5 * 60_000;
export const CODEX_POLL_INTERVAL_MS = 60_000;
export const CLAUDE_POLL_INTERVAL_MS = 2 * 60_000;
// Google meters this quota per account rather than per request, and the CLI
// itself only re-reads it every 30 seconds while a session is open. Five
// minutes keeps a shared collector well clear of the rate limit.
export const GEMINI_POLL_INTERVAL_MS = 5 * 60_000;
export const MAX_FUTURE_SNAPSHOT_SKEW_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
// A shared snapshot older than this, with no lease to refresh it, means the
// account's lease holder keeps failing (for example a revoked login on another
// Mac). Each machine may then read the account itself, at most once per window.
export const STALE_SNAPSHOT_MS = 15 * 60_000;

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
  if (provider === "codex") return CODEX_POLL_INTERVAL_MS;
  if (provider === "gemini") return GEMINI_POLL_INTERVAL_MS;
  return CLAUDE_POLL_INTERVAL_MS;
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export function pollKey(provider: unknown, account: unknown): string {
  if ((provider !== "claude" && provider !== "codex" && provider !== "gemini") || typeof account !== "string" ||
      account.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(account.trim())) {
    throw new Error("invalid capacity account");
  }
  return `${provider}:${account.trim().toLowerCase()}`;
}

function money(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Credit blocks are advisory next to the quota windows, so a malformed one is dropped rather than rejected.
function sanitizeCloudCredits(cloud: unknown): CapacityCloudCredits | undefined {
  if (!cloud || typeof cloud !== "object") return undefined;
  const { limitUsd: limit, remainingUsd: remaining, expiresAt: expiry, locked } = cloud as CapacityCloudCredits;
  const expiresAt = typeof expiry === "string" && Number.isFinite(Date.parse(expiry)) ? expiry : undefined;
  if (!money(limit) || limit <= 0 || !money(remaining) || remaining > limit) return undefined;
  return { limitUsd: limit, remainingUsd: remaining, ...(expiresAt ? { expiresAt } : {}), ...(locked === true ? { locked: true } : {}) };
}

function sanitizeExtraUsage(extra: unknown): CapacityExtraUsage | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const { usedAmount: used, limitAmount: limit, currency } = extra as CapacityExtraUsage;
  if (!money(used) || !money(limit) || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { usedAmount: used, limitAmount: limit, currency };
}

function sanitizeLastKnown(value: unknown, now: number): CapacityLastKnownCredits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as CapacityLastKnownCredits;
  const observed = typeof raw.observedAt === "string" ? Date.parse(raw.observedAt) : Number.NaN;
  if (!Number.isFinite(observed) || observed > now + MAX_FUTURE_SNAPSHOT_SKEW_MS) return undefined;
  const cloudCredits = sanitizeCloudCredits(raw.cloudCredits);
  const extraUsage = sanitizeExtraUsage(raw.extraUsage);
  if (!cloudCredits && !extraUsage) return undefined;
  return { observedAt: raw.observedAt, ...(cloudCredits ? { cloudCredits } : {}), ...(extraUsage ? { extraUsage } : {}) };
}

/**
 * Keeps the last credit figures a provider reported once it stops reporting them. A new Claude reading that
 * carries live credit figures replaces what was kept; one that carries none inherits the previous reading's
 * live figures, or the figures it was already holding, together with the time they were last seen. The
 * snapshot store keeps one row per account and overwrites it on every poll, so without this the figures of
 * an exhausted allowance would vanish with the first reading that omits them.
 */
export function carryLastKnownCredits<T extends PollSnapshot>(previous: PollSnapshot | undefined, next: T): T {
  if (next.provider !== "claude" || previous?.provider !== "claude") return next;
  const usage = next.usage;
  if (usage.cloudCredits || usage.extraUsage) {
    if (!usage.lastKnownCredits) return next;
    const { lastKnownCredits: _dropped, ...rest } = usage;
    return { ...next, usage: rest } as T;
  }
  const prior = previous.usage;
  const kept: CapacityLastKnownCredits | undefined = prior.cloudCredits || prior.extraUsage
    ? { observedAt: prior.updatedAt, ...(prior.cloudCredits ? { cloudCredits: prior.cloudCredits } : {}), ...(prior.extraUsage ? { extraUsage: prior.extraUsage } : {}) }
    : prior.lastKnownCredits;
  if (!kept || usage.lastKnownCredits) return next;
  return { ...next, usage: { ...usage, lastKnownCredits: kept } } as T;
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
    profile?: string;
    cloudCredits?: CapacityCloudCredits;
    extraUsage?: CapacityExtraUsage;
    creditsExhausted?: true;
    lastKnownCredits?: CapacityLastKnownCredits;
    buckets?: ReturnType<typeof normalizeGeminiRows>;
  } = {
    accountEmail: input.account,
    loginMethod: typeof input.usage.loginMethod === "string" ? input.usage.loginMethod.slice(0, 100) : undefined,
    primary: window(input.usage.primary),
    secondary: window(input.usage.secondary),
    tertiary: window(input.usage.tertiary),
    updatedAt: input.usage.updatedAt,
  };
  if (!usage.primary && !usage.secondary && !usage.tertiary) throw new Error("missing capacity windows");
  if (input.provider === "claude" || input.provider === "codex") {
    // The profile name orders and labels the account; anything but a plain directory suffix is dropped.
    const profile = (input.usage as { profile?: unknown }).profile;
    if (typeof profile === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(profile)) usage.profile = profile;
  }
  if (input.provider === "claude") {
    const claudeUsage = input.usage;
    usage.accountOrganization = typeof claudeUsage.accountOrganization === "string"
      ? claudeUsage.accountOrganization.slice(0, 320) : undefined;
    const cloudCredits = sanitizeCloudCredits(claudeUsage.cloudCredits);
    if (cloudCredits) usage.cloudCredits = cloudCredits;
    const extraUsage = sanitizeExtraUsage(claudeUsage.extraUsage);
    if (extraUsage) usage.extraUsage = extraUsage;
    if (claudeUsage.creditsExhausted === true) usage.creditsExhausted = true;
    const lastKnown = sanitizeLastKnown(claudeUsage.lastKnownCredits, now);
    // Figures are kept only while nothing live replaces them.
    if (lastKnown && !usage.cloudCredits && !usage.extraUsage) usage.lastKnownCredits = lastKnown;
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
  if (input.provider === "gemini") {
    // A Gemini reading is per model, so the rows are the reading. They are
    // re-validated rather than copied: a cached snapshot arrives from another
    // machine's collector, and only these whitelisted fields may reach the
    // dashboard. A bad row is dropped; a snapshot with no usable row is rejected
    // outright, because rendering an empty quota card would be a false reading.
    const rows = normalizeGeminiRows((input.usage as { buckets?: unknown }).buckets);
    if (!rows) throw new Error("invalid capacity buckets");
    usage.buckets = rows;
  }
  return { provider: input.provider, account: input.account, usage, pace: null } as PollSnapshot;
}

function parseSnapshot(text: string | null | undefined): PollSnapshot | undefined {
  if (!text) return undefined;
  try { return JSON.parse(text) as PollSnapshot; } catch { return undefined; }
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
    const fresh = sanitizePollSnapshot(value, key);
    this.db.transaction(() => {
      const row = this.db.query<PollRow, [string]>("SELECT * FROM capacity_poll WHERE account_key=?").get(key);
      const previous = parseSnapshot(row?.snapshot);
      // A stale shared snapshot must not replace a newer reading this machine made itself.
      if (previous && snapshotTime(previous) > snapshotTime(fresh)) return;
      const snapshot = carryLastKnownCredits(previous, fresh);
      this.db.query(`INSERT INTO capacity_poll(account_key,next_at,lease,failures,snapshot) VALUES(?,?, '',0,?)
        ON CONFLICT(account_key) DO UPDATE SET snapshot=excluded.snapshot`)
        .run(key, 0, JSON.stringify(snapshot));
    }).immediate();
  }

  complete(provider: PollProvider, account: string, lease: string,
    result: { snapshot?: unknown; status?: number; retryAfterMs?: number }, now = Date.now()): boolean {
    const key = pollKey(provider, account);
    const fresh = result.snapshot === undefined ? undefined : sanitizePollSnapshot(result.snapshot, key);
    return this.db.transaction(() => {
      const row = this.db.query<PollRow, [string]>("SELECT * FROM capacity_poll WHERE account_key=?").get(key);
      if (!row || row.lease !== lease) return false;
      const snapshot = fresh ? carryLastKnownCredits(parseSnapshot(row.snapshot), fresh) : undefined;
      const failures = snapshot ? 0 : Math.min(row.failures + 1, 8);
      const backoff = snapshot ? 0 : result.status === 429
        ? RATE_LIMIT_COOLDOWN_MS * 2 ** Math.min(failures - 1, 2)
        : (provider === "gemini" ? GEMINI_POLL_INTERVAL_MS
          : provider === "claude" ? POLL_INTERVAL_MS : CODEX_POLL_INTERVAL_MS) * 2 ** Math.min(failures - 1, 3);
      const retry = Number.isFinite(result.retryAfterMs) && result.retryAfterMs! > 0 ? result.retryAfterMs! : 0;
      this.db.query("UPDATE capacity_poll SET next_at=?,lease='',failures=?,snapshot=? WHERE account_key=?")
        .run(Math.max(row.next_at, now + backoff, now + retry), failures,
          snapshot ? JSON.stringify(snapshot) : row.snapshot, key);
      return true;
    }).immediate();
  }

  // Created on first use, never in the constructor: only a collector reads
  // directly, and the shared server store must not need a schema change.
  private directTable = false;
  private ensureDirectTable(): void {
    if (this.directTable) return;
    this.db.exec("CREATE TABLE IF NOT EXISTS capacity_direct (account_key TEXT PRIMARY KEY, next_at INTEGER NOT NULL)");
    this.directTable = true;
  }

  /**
   * Reserves this machine's direct read of an account whose shared snapshot is
   * stale. Local only: it never touches the shared lease or cooldown.
   */
  claimDirect(provider: PollProvider, account: string, now = Date.now()): boolean {
    const key = pollKey(provider, account);
    this.ensureDirectTable();
    return this.db.transaction(() => {
      const row = this.db.query<{ next_at: number }, [string]>(
        "SELECT next_at FROM capacity_direct WHERE account_key=?").get(key);
      if (row && row.next_at > now) return false;
      this.db.query(`INSERT INTO capacity_direct(account_key,next_at) VALUES(?,?)
        ON CONFLICT(account_key) DO UPDATE SET next_at=excluded.next_at`).run(key, now + STALE_SNAPSHOT_MS);
      return true;
    }).immediate();
  }

  /** Pushes this machine's next direct read out after a rate limit. */
  deferDirect(provider: PollProvider, account: string, until: number): void {
    const key = pollKey(provider, account);
    this.ensureDirectTable();
    this.db.query(`INSERT INTO capacity_direct(account_key,next_at) VALUES(?,?)
      ON CONFLICT(account_key) DO UPDATE SET next_at=MAX(next_at,excluded.next_at)`).run(key, until);
  }

  close(): void { this.db.close(); }
}

function snapshotTime(snapshot: PollSnapshot | undefined): number {
  const time = snapshot?.usage ? Date.parse(snapshot.usage.updatedAt) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function isRateLimited(error: { status?: number; message?: string } | undefined): boolean {
  return error?.status === 429 || /\b429\b|rate.?limit/iu.test(error?.message ?? "");
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
    if (!claim.lease) {
      if (!coordinator) return claim.snapshot as T | undefined;
      // The coordinator keeps backing off while its lease holder fails, so its
      // snapshot can freeze for hours. Past the stale window, read directly,
      // cache locally and leave the shared lease and cooldown untouched.
      const cached = local.cached(provider, account);
      const newest = snapshotTime(cached) > snapshotTime(claim.snapshot) ? cached : claim.snapshot;
      if (newest && nowMs - snapshotTime(newest) <= STALE_SNAPSHOT_MS) return newest as T;
      if (!local.claimDirect(provider, account, nowMs)) return newest as T | undefined;
      try {
        const direct = await read();
        if (!direct) return newest as T | undefined;
        const kept = carryLastKnownCredits(newest, direct);
        sanitizePollSnapshot(kept, key);
        local.cacheSnapshot(provider, account, kept);
        return kept;
      } catch (error) {
        const failure = error as { status?: number; retryAfterMs?: number; message?: string };
        if (isRateLimited(failure)) {
          local.deferDirect(provider, account, nowMs + Math.max(RATE_LIMIT_COOLDOWN_MS, failure.retryAfterMs ?? 0));
        }
        // The shared snapshot stays the answer; the card reads as not current.
        return newest as T | undefined;
      }
    }
    let snapshot: T | undefined;
    let failure: unknown;
    try {
      snapshot = await read();
      if (snapshot) {
        // The local cache holds the figures kept so far; a shared snapshot from a server without them must not erase them.
        snapshot = carryLastKnownCredits(local.cached(provider, account) ?? claim.snapshot, snapshot);
        sanitizePollSnapshot(snapshot, key);
      }
    } catch (error) { failure = error; }
    const error = failure as { status?: number; retryAfterMs?: number; message?: string } | undefined;
    const result = {
      snapshot,
      status: error?.status ?? (isRateLimited(error) ? 429 : undefined),
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

/**
 * Holds the shared poll store for a long-running server and replaces it after
 * any failure. A managed PostgreSQL connection closes itself on a transport
 * error and never reopens, so one timeout or dropped socket would otherwise
 * make every later poll request fail until the process restarts. The failed
 * statement is never replayed; the next request opens a fresh connection.
 */
export class ReconnectingPollStore {
  private current?: CapacityPollStore;

  constructor(
    private readonly path: string,
    private readonly open: (path: string) => CapacityPollStore = (value) => new CapacityPollStore(value),
  ) {}

  use<T>(run: (store: CapacityPollStore) => T): T {
    try {
      this.current ??= this.open(this.path);
      return run(this.current);
    } catch (error) {
      if (!isCapacityValidationError(error)) this.close();
      throw error;
    }
  }

  close(): void {
    const store = this.current;
    this.current = undefined;
    try { store?.close(); } catch { /* The connection is already gone. */ }
  }
}

function isCapacityValidationError(error: unknown): boolean {
  return error instanceof SyntaxError ||
    (error instanceof Error && error.constructor === Error &&
      /^(?:invalid|missing) (?:capacity|lease)\b/u.test(error.message));
}

export async function handleCapacityPoll(
  request: Request,
  source: CapacityPollStore | ReconnectingPollStore,
): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) return Response.json({ error: "request too large" }, { status: 413 });
  const text = await request.text();
  if (text.length > 16_384) return Response.json({ error: "request too large" }, { status: 413 });
  try {
    const body = JSON.parse(text);
    pollKey(body.provider, body.account);
    const run = <T>(action: (store: CapacityPollStore) => T): T =>
      source instanceof ReconnectingPollStore ? source.use(action) : action(source);
    if (new URL(request.url).pathname.endsWith("/claim")) {
      return Response.json(run((store) => store.claim(body.provider, body.account)));
    }
    if (typeof body.lease !== "string" || body.lease.length > 100) throw new Error("invalid lease");
    const ok = run((store) => store.complete(body.provider, body.account, body.lease, body));
    return Response.json({ ok }, { status: ok ? 200 : 409 });
  } catch (error) {
    // Only a malformed request is the caller's fault. A database failure must
    // surface as a server error so the collector and error reporting see it.
    if (!isCapacityValidationError(error)) throw error;
    return Response.json({ error: "invalid capacity poll" }, { status: 400 });
  }
}

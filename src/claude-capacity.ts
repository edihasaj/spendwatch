// Current Claude capacity from the account's own OAuth usage endpoint.
//
// Claude Code has no local quota command, and the previous path depended on a
// third-party menu-bar app: when that binary disappeared, Claude capacity went
// silently stale instead of failing. This reads the same authenticated endpoint
// the Claude Code /usage view uses, with the credentials Claude Code already
// stores locally, so the dashboard has a first-party source.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { paceFor, type CapacityCloudCredits, type CapacityExtraUsage, type CapacityPaceWindow, type CapacityWindow } from "./capacity-current";
import { coordinatedCapacity, retryAfterMs } from "./capacity-poll";
import {
  freshestClaudeKeychainCredential,
  hasClaudeKeychainRefreshToken,
  keychainLocatorsFrom,
  persistClaudeKeychainCredentials,
  readClaudeKeychainCredential,
  type ClaudeKeychainCredential,
} from "./claude-keychain";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The access token lives eight hours. Nothing else on a collector host runs
// Claude Code, so without refreshing here the card dies within a working day
// and only a human re-login brings it back.
export const CLAUDE_TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// A default runtime user agent is refused by the edge with Cloudflare 1010
// before the request ever reaches the OAuth server.
const CLAUDE_USER_AGENT = "claude-cli/2.1.228 (external, cli)";
/** Refresh this far before expiry so a slow collect cannot race the deadline. */
const REFRESH_SKEW_MS = 5 * 60_000;
const SESSION_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export interface ClaudeCapacityResult {
  provider: "claude";
  account: string;
  usage: {
    accountEmail: string;
    accountOrganization?: string;
    loginMethod?: string;
    primary: CapacityWindow | null;
    secondary: CapacityWindow | null;
    tertiary: CapacityWindow | null;
    /** Promotional cloud credits reported in dollars, when present. */
    cloudCredits?: CapacityCloudCredits;
    /** Paid extra usage beyond the plan, converted from cents. */
    extraUsage?: CapacityExtraUsage;
    updatedAt: string;
  };
  pace: {
    primary: CapacityPaceWindow | null;
    secondary: CapacityPaceWindow | null;
    tertiary: CapacityPaceWindow | null;
  } | null;
}

export interface ClaudeIdentity {
  email: string;
  organization?: string;
  plan?: string;
}

interface RawUsageWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawClaudeUsage {
  five_hour?: RawUsageWindow | null;
  seven_day?: RawUsageWindow | null;
  seven_day_opus?: RawUsageWindow | null;
  iguana_necktie?: RawCloudCredits | null;
  extra_usage?: RawExtraUsage | null;
}

interface RawCloudCredits {
  limit_dollars?: unknown;
  used_dollars?: unknown;
  remaining_dollars?: unknown;
  resets_at?: unknown;
  locked_reason?: unknown;
}

interface RawExtraUsage {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  currency?: unknown;
}

// The endpoint recomputes reset times per call, so the sub-second part drifts
// between reads. Rounding to the minute keeps one cycle identifiable across
// samples, which cycle-aware history and burn analysis depend on.
function isoFrom(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(Math.round(parsed / 60_000) * 60_000).toISOString();
}

function windowFrom(value: RawUsageWindow | null | undefined, windowMinutes: number): CapacityWindow | null {
  const utilization = Number(value?.utilization);
  if (!Number.isFinite(utilization)) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, utilization)),
    windowMinutes,
    resetsAt: isoFrom(value?.resets_at),
  };
}

// The promotional cloud-credit block reports dollars. A malformed block is
// dropped instead of failing the read: the quota windows are still accurate.
function cloudCreditsFrom(value: RawCloudCredits | null | undefined): CapacityCloudCredits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const number = (amount: unknown): amount is number => typeof amount === "number" && Number.isFinite(amount);
  const limit = value.limit_dollars;
  if (!number(limit) || limit <= 0) return undefined;
  const used = value.used_dollars === undefined ? undefined : value.used_dollars;
  const remaining = value.remaining_dollars === undefined ? undefined : value.remaining_dollars;
  if (used === undefined && remaining === undefined) return undefined;
  if (used !== undefined && (!number(used) || used < 0 || used > limit)) return undefined;
  if (remaining !== undefined && (!number(remaining) || remaining < 0 || remaining > limit)) return undefined;
  const credits: CapacityCloudCredits = { limitUsd: limit, remainingUsd: remaining ?? limit - used };
  const expiresAt = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) credits.expiresAt = new Date(expiresAt).toISOString();
  if (typeof value.locked_reason === "string" && value.locked_reason.trim()) credits.locked = true;
  return credits;
}

// Extra usage is reported in integer cents, unlike the dollar cloud-credit
// block; dividing here keeps every downstream figure in one currency unit.
function extraUsageFrom(value: RawExtraUsage | null | undefined): CapacityExtraUsage | undefined {
  if (!value || typeof value !== "object" || value.is_enabled !== true) return undefined;
  const monthlyLimit = value.monthly_limit;
  const usedCredits = value.used_credits;
  if (typeof monthlyLimit !== "number" || !Number.isFinite(monthlyLimit) || monthlyLimit < 0 ||
      typeof usedCredits !== "number" || !Number.isFinite(usedCredits) || usedCredits < 0) return undefined;
  const trimmed = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  return {
    usedAmount: usedCredits / 100,
    limitAmount: monthlyLimit / 100,
    currency: /^[A-Z]{3}$/.test(trimmed) ? trimmed : "USD",
  };
}

export function claudeCapacityFromUsage(
  usageValue: unknown,
  identity: ClaudeIdentity,
  now = Date.now(),
): ClaudeCapacityResult | undefined {
  if (!usageValue || typeof usageValue !== "object") return undefined;
  if (!identity.email.includes("@")) return undefined;
  const raw = usageValue as RawClaudeUsage;
  const primary = windowFrom(raw.five_hour, SESSION_WINDOW_MINUTES);
  const secondary = windowFrom(raw.seven_day, WEEKLY_WINDOW_MINUTES);
  const tertiary = windowFrom(raw.seven_day_opus, WEEKLY_WINDOW_MINUTES);
  if (!primary && !secondary) return undefined;
  const cloudCredits = cloudCreditsFrom(raw.iguana_necktie);
  const extraUsage = extraUsageFrom(raw.extra_usage);
  return {
    provider: "claude",
    account: identity.email,
    usage: {
      accountEmail: identity.email,
      accountOrganization: identity.organization,
      loginMethod: identity.plan,
      primary,
      secondary,
      tertiary,
      ...(cloudCredits ? { cloudCredits } : {}),
      ...(extraUsage ? { extraUsage } : {}),
      updatedAt: new Date(now).toISOString(),
    },
    pace: {
      primary: paceFor(primary, now),
      secondary: paceFor(secondary, now),
      tertiary: paceFor(tertiary, now),
    },
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export interface ClaudeProfile {
  home: string;
  token: string;
  identity: ClaudeIdentity;
  refreshToken?: string;
  expiresAt?: number;
  /** Present for file-backed credentials. */
  credentialsPath?: string;
  /** Present only when this exact Keychain item was selected from its attributes. */
  keychainCredential?: ClaudeKeychainCredential;
}

export interface RefreshedCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

/**
 * True once the stored token is expired, close enough that a read would race
 * it, or carries no deadline at all. A credentials file written without
 * expiresAt is the shape that went stale unnoticed: treating unknown as due
 * refreshes it once, after which the written deadline governs.
 */
export function needsRefresh(expiresAt: number | undefined, nowMs: number): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return expiresAt - REFRESH_SKEW_MS <= nowMs;
}

export function refreshedCredentialsFrom(payload: unknown, nowMs: number): RefreshedCredentials | undefined {
  const body = payload as Record<string, unknown> | undefined;
  const accessToken = stringField(body, "access_token");
  const refreshToken = stringField(body, "refresh_token");
  const expiresIn = Number(body?.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) return undefined;
  const refreshExpiresIn = Number(body?.refresh_token_expires_in);
  const scope = stringField(body, "scope");
  return {
    accessToken,
    refreshToken,
    expiresAt: nowMs + expiresIn * 1000,
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresIn) ? nowMs + refreshExpiresIn * 1000 : undefined,
    scopes: scope ? scope.split(" ").filter(Boolean) : undefined,
  };
}

/**
 * Persist through a temporary file and rename. The server rotates the refresh
 * token, so a half-written file loses the only credential that can recover the
 * session without a human.
 */
export function persistClaudeCredentials(path: string, next: RefreshedCredentials): void {
  const current = readJson(path) ?? {};
  const oauth = { ...(current.claudeAiOauth as Record<string, unknown> | undefined ?? {}) };
  oauth.accessToken = next.accessToken;
  oauth.refreshToken = next.refreshToken;
  oauth.expiresAt = next.expiresAt;
  if (next.refreshTokenExpiresAt !== undefined) oauth.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
  if (next.scopes) oauth.scopes = next.scopes;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...current, claudeAiOauth: oauth }), { mode: 0o600 });
  renameSync(temporary, path);
}

async function requestRefresh(refreshToken: string, nowMs: number): Promise<RefreshedCredentials | undefined> {
  for (const url of CLAUDE_TOKEN_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": CLAUDE_USER_AGENT,
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) continue;
      const refreshed = refreshedCredentialsFrom(await response.json(), nowMs);
      if (refreshed) return refreshed;
    } catch {
      // Try the next endpoint; the token exchange host has moved before.
    }
  }
  return undefined;
}

/**
 * Refresh in place and return the new access token, or undefined if it cannot.
 *
 * Kept public for the trusted Mac GUI collector's deliberate renewal check.
 * Call it without a timestamp so the stored deadline is always anchored to the
 * actual local clock, never a capacity sample's reported time.
 */
export async function refreshProfile(profile: ClaudeProfile, nowMs = Date.now()): Promise<string | undefined> {
  if (!profile.refreshToken || (!profile.credentialsPath && !profile.keychainCredential)) return undefined;
  // Do not spend a one-time refresh grant when Claude Code has already
  // completed a newer login in the selected item. We do the guarded write
  // after the exchange too; this preflight prevents a stale profile from
  // rotating a grant it can no longer persist.
  if (profile.keychainCredential
    && !hasClaudeKeychainRefreshToken(profile.keychainCredential, profile.refreshToken)) return undefined;
  const refreshed = await requestRefresh(profile.refreshToken, nowMs);
  if (!refreshed) return undefined;
  if (profile.credentialsPath) {
    persistClaudeCredentials(profile.credentialsPath, refreshed);
  } else if (profile.keychainCredential) {
    const written = persistClaudeKeychainCredentials(profile.keychainCredential, profile.refreshToken, refreshed);
    if (!written) return undefined;
    profile.keychainCredential = written;
  } else {
    return undefined;
  }
  profile.token = refreshed.accessToken;
  profile.refreshToken = refreshed.refreshToken;
  profile.expiresAt = refreshed.expiresAt;
  return refreshed.accessToken;
}

function stringField(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Claude Code scopes every non-default `CLAUDE_CONFIG_DIR` to a distinct
 * Keychain service. The service is deliberately derived from the absolute
 * directory, so one named profile can never borrow the default login.
 */
export function claudeKeychainService(configDir?: string): string {
  if (configDir === undefined) return CLAUDE_KEYCHAIN_SERVICE;
  const absoluteConfigDir = resolve(configDir);
  if (absoluteConfigDir === resolve(homedir(), ".claude")) return CLAUDE_KEYCHAIN_SERVICE;
  const hash = createHash("sha256").update(absoluteConfigDir).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Every account name holding credentials for `service`, read from the
 * attribute-only Keychain dump. Claude Code leaves the previous item behind
 * when it re-creates one under a different account name, so the service alone
 * can match more than one item.
 */
export function keychainAccountsFrom(dump: string, service: string): string[] {
  const accounts: string[] = [];
  for (const record of dump.split(/^keychain: /m)) {
    if (!record.includes(`"svce"<blob>="${service}"`)) continue;
    const account = /^\s*"acct"<blob>="([^"]*)"/m.exec(record)?.[1];
    if (account !== undefined && !accounts.includes(account)) accounts.push(account);
  }
  return accounts;
}

/**
 * The credential a login would produce, out of everything the Keychain holds
 * for the service. `security find-generic-password` returns whichever item it
 * matches first, which is not the newest: an orphan left by an earlier login
 * shadowed the live credential for a week and every read came back HTTP 401.
 * Prefer a token that has not expired, then the furthest deadline.
 */
export function freshestCredentials(candidates: unknown[], nowMs: number): unknown {
  const ranked = candidates
    .filter((candidate) => stringField(candidate, "accessToken"))
    .map((candidate) => {
      const expiresAt = Number((candidate as Record<string, unknown>).expiresAt);
      const deadline = Number.isFinite(expiresAt) ? expiresAt : Number.NEGATIVE_INFINITY;
      return { candidate, deadline, usable: deadline > nowMs };
    })
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.deadline - a.deadline);
  return ranked[0]?.candidate;
}

function keychainSecret(args: string[]): unknown {
  const result = spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    return (JSON.parse(result.stdout) as Record<string, unknown>).claudeAiOauth;
  } catch {
    return undefined;
  }
}

export interface KeychainCredentials {
  oauth: unknown;
  credential?: ClaudeKeychainCredential;
}

type KeychainReader = (service: string, nowMs?: number, allowPlainLookup?: boolean) => KeychainCredentials | undefined;

// Claude Code keeps the default profile's credentials in the login Keychain on
// macOS. It can also leave the on-disk file behind as a husk with blank tokens
// after that migration, so presence of the file says nothing about usability.
function keychainCredentials(
  service: string,
  nowMs = Date.now(),
  allowPlainLookup = false,
): KeychainCredentials | undefined {
  if (platform() !== "darwin") return undefined;
  const dump = spawnSync("/usr/bin/security", ["dump-keychain"], { encoding: "utf8", timeout: 10_000 });
  const locators = dump.status === 0 && dump.stdout
    ? keychainLocatorsFrom(dump.stdout, service)
    : [];
  const credential = freshestClaudeKeychainCredential(
    locators.flatMap((locator) => {
      const found = readClaudeKeychainCredential(locator);
      return found ? [found] : [];
    }),
    nowMs,
  );
  if (credential) return { oauth: credential.oauth, credential };
  // The dump is attribute-only and needs no unlock, but a locked or unreadable
  // default-profile Keychain still has to fall back to the plain lookup rather
  // than go blind. A named profile must only use its exact hashed service:
  // falling back would silently attribute the default account to that profile.
  if (!allowPlainLookup) return undefined;
  const oauth = keychainSecret(["find-generic-password", "-s", service, "-w"]);
  return oauth === undefined ? undefined : { oauth };
}

/**
 * Prefer whichever source actually carries a token. Falling back only on a
 * missing file lets a husk left by the Keychain migration — present, but with
 * blank tokens — shadow the credentials that still work.
 */
export function preferUsableCredentials(fileCredentials: unknown, fromKeychain: () => unknown): unknown {
  if (stringField(fileCredentials, "accessToken")) return fileCredentials;
  return fromKeychain() ?? fileCredentials;
}

export function claudeProfileFrom(
  home: string,
  metadataPath: string,
  keychainService?: string,
  readKeychain: KeychainReader = keychainCredentials,
): ClaudeProfile | undefined {
  const oauthAccount = readJson(metadataPath)?.oauthAccount;
  const email = stringField(oauthAccount, "emailAddress");
  if (!email) return undefined;
  const fileCredentials = readJson(join(home, ".credentials.json"))?.claudeAiOauth;
  let fromKeychain: KeychainCredentials | undefined;
  let triedKeychain = false;
  const credentials = preferUsableCredentials(
    fileCredentials,
    () => {
      if (!triedKeychain) {
        triedKeychain = true;
        fromKeychain = keychainService
          ? readKeychain(keychainService, undefined, keychainService === CLAUDE_KEYCHAIN_SERVICE)
          : undefined;
      }
      return fromKeychain?.oauth;
    },
  );
  const token = stringField(credentials, "accessToken");
  if (!token) return undefined;
  const organizationType = stringField(oauthAccount, "organizationType");
  const expiresAtValue = Number((credentials as Record<string, unknown> | undefined)?.expiresAt);
  return {
    home,
    token,
    refreshToken: stringField(credentials, "refreshToken"),
    expiresAt: Number.isFinite(expiresAtValue) ? expiresAtValue : undefined,
    credentialsPath: credentials === fileCredentials ? join(home, ".credentials.json") : undefined,
    keychainCredential: credentials === fromKeychain?.oauth ? fromKeychain.credential : undefined,
    identity: {
      email,
      organization: stringField(oauthAccount, "organizationName") ?? "Personal",
      plan: stringField(credentials, "subscriptionType")
        ?? organizationType?.replace(/^claude_/, "")
        ?? "unknown",
    },
  };
}

/** Default profile plus every `~/.claude-<name>` profile, as Claude Code lays them out. */
export function discoverClaudeProfiles(base = homedir(), readKeychain: KeychainReader = keychainCredentials): ClaudeProfile[] {
  const useKeychain = base === homedir() || readKeychain !== keychainCredentials;
  const homes: { home: string; metadata: string; keychainService?: string }[] = [
    {
      home: join(base, ".claude"),
      metadata: join(base, ".claude.json"),
      keychainService: useKeychain ? CLAUDE_KEYCHAIN_SERVICE : undefined,
    },
  ];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {}
  for (const entry of entries.sort()) {
    if (!/^\.claude-[A-Za-z0-9][A-Za-z0-9-]*$/.test(entry)) continue;
    const home = join(base, entry);
    const sibling = `${home}.json`;
    homes.push({
      home,
      metadata: existsSync(sibling) ? sibling : join(home, ".claude.json"),
      keychainService: useKeychain ? claudeKeychainService(home) : undefined,
    });
  }
  return homes.flatMap((entry) => {
    const profile = claudeProfileFrom(entry.home, entry.metadata, entry.keychainService, readKeychain);
    return profile ? [profile] : [];
  });
}

/** A read that failed, with enough detail to tell "sign in again" from "slow down". */
export interface ClaudeReadFailure {
  email?: string;
  status?: number;
  reason: "unauthenticated" | "rate-limited" | "unavailable";
  message: string;
}

class ClaudeReadError extends Error {
  constructor(readonly status: number, readonly email?: string, readonly retryAfterMs?: number) {
    super(`Claude usage read failed with HTTP ${status}`);
  }
}

/**
 * A 401 needs a human to re-authenticate, a 429 needs patience, and anything
 * else is a transient fault. Collapsing all three into "no data" is what let an
 * expired token look identical to a rate limit for nine hours.
 */
export function classifyReadFailure(status: number): ClaudeReadFailure["reason"] {
  if (status === 401 || status === 403) return "unauthenticated";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

function readUsage(token: string): Promise<Response> {
  return fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
}

async function profileCapacity(profile: ClaudeProfile, now: number): Promise<ClaudeCapacityResult | undefined> {
  // Refresh ahead of expiry rather than spending a guaranteed 401 to discover
  // it. Repeated rejected reads are also what draws the endpoint's 429.
  if (needsRefresh(profile.expiresAt, now)) await refreshProfile(profile, now);
  let response = await readUsage(profile.token);
  if (response.status === 401) {
    const token = await refreshProfile(profile, now);
    if (token) response = await readUsage(token);
  }
  if (!response.ok) throw new ClaudeReadError(response.status, profile.identity.email, retryAfterMs(response.headers.get("retry-after")));
  return claudeCapacityFromUsage(await response.json(), profile.identity, now);
}

export async function currentClaudeCapacity(
  now = Date.now(),
  onFailure?: (failure: ClaudeReadFailure) => void,
): Promise<ClaudeCapacityResult[]> {
  const profiles = new Map<string, ClaudeProfile>();
  for (const profile of discoverClaudeProfiles()) {
    const key = profile.identity.email.toLowerCase();
    const previous = profiles.get(key);
    if (!previous || (profile.expiresAt ?? 0) > (previous.expiresAt ?? 0)) profiles.set(key, profile);
  }
  const settled = await Promise.allSettled(
    [...profiles.values()].map((profile) => coordinatedCapacity("claude", profile.identity.email, () => profileCapacity(profile, now))),
  );
  const byAccount = new Map<string, ClaudeCapacityResult>();
  for (const item of settled) {
    if (item.status === "fulfilled" && item.value) {
      byAccount.set(item.value.account.toLowerCase(), item.value);
      continue;
    }
    // Dropping the rejection silently is what made an expired token
    // indistinguishable from having no Claude account at all.
    if (item.status !== "rejected" || !onFailure) continue;
    const error = item.reason;
    const status = error instanceof ClaudeReadError ? error.status : undefined;
    onFailure({
      email: error instanceof ClaudeReadError ? error.email : undefined,
      status,
      reason: status === undefined ? "unavailable" : classifyReadFailure(status),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

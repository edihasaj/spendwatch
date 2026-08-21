// Current Claude capacity from the account's own OAuth usage endpoint.
//
// Claude Code has no local quota command, and the previous path depended on a
// third-party menu-bar app: when that binary disappeared, Claude capacity went
// silently stale instead of failing. This reads the same authenticated endpoint
// the Claude Code /usage view uses, with the credentials Claude Code already
// stores locally, so the dashboard has a first-party source.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { paceFor, type CapacityPaceWindow, type CapacityWindow } from "./capacity-current";

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
  /** Absent for Keychain-held credentials, which we can read but not rewrite. */
  credentialsPath?: string;
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

/** Refresh in place and return the new access token, or undefined if it cannot. */
async function refreshProfile(profile: ClaudeProfile, nowMs: number): Promise<string | undefined> {
  if (!profile.refreshToken || !profile.credentialsPath) return undefined;
  const refreshed = await requestRefresh(profile.refreshToken, nowMs);
  if (!refreshed) return undefined;
  persistClaudeCredentials(profile.credentialsPath, refreshed);
  profile.token = refreshed.accessToken;
  profile.refreshToken = refreshed.refreshToken;
  profile.expiresAt = refreshed.expiresAt;
  return refreshed.accessToken;
}

function stringField(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Claude Code keeps the default profile's credentials in the login Keychain on
// macOS. It can also leave the on-disk file behind as a husk with blank tokens
// after that migration, so presence of the file says nothing about usability.
function keychainCredentials(): unknown {
  if (platform() !== "darwin") return undefined;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    return (JSON.parse(result.stdout) as Record<string, unknown>).claudeAiOauth;
  } catch {
    return undefined;
  }
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

export function claudeProfileFrom(home: string, metadataPath: string, allowKeychain = false): ClaudeProfile | undefined {
  const fileCredentials = readJson(join(home, ".credentials.json"))?.claudeAiOauth;
  const credentials = preferUsableCredentials(
    fileCredentials,
    () => (allowKeychain ? keychainCredentials() : undefined),
  );
  const token = stringField(credentials, "accessToken");
  if (!token) return undefined;
  const oauthAccount = readJson(metadataPath)?.oauthAccount;
  const email = stringField(oauthAccount, "emailAddress");
  if (!email) return undefined;
  const organizationType = stringField(oauthAccount, "organizationType");
  const expiresAtValue = Number((credentials as Record<string, unknown> | undefined)?.expiresAt);
  return {
    home,
    token,
    refreshToken: stringField(credentials, "refreshToken"),
    expiresAt: Number.isFinite(expiresAtValue) ? expiresAtValue : undefined,
    // Only a file-backed profile can be rewritten; a Keychain one cannot.
    credentialsPath: credentials === fileCredentials ? join(home, ".credentials.json") : undefined,
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
export function discoverClaudeProfiles(base = homedir()): ClaudeProfile[] {
  const homes: { home: string; metadata: string; keychain: boolean }[] = [
    { home: join(base, ".claude"), metadata: join(base, ".claude.json"), keychain: base === homedir() },
  ];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {}
  for (const entry of entries.sort()) {
    if (!/^\.claude-[A-Za-z0-9][A-Za-z0-9-]*$/.test(entry)) continue;
    const home = join(base, entry);
    const sibling = `${home}.json`;
    homes.push({ home, metadata: existsSync(sibling) ? sibling : join(home, ".claude.json"), keychain: false });
  }
  return homes.flatMap((entry) => {
    const profile = claudeProfileFrom(entry.home, entry.metadata, entry.keychain);
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
  constructor(readonly status: number, readonly email?: string) {
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
  if (!response.ok) throw new ClaudeReadError(response.status, profile.identity.email);
  return claudeCapacityFromUsage(await response.json(), profile.identity, now);
}

export async function currentClaudeCapacity(
  now = Date.now(),
  onFailure?: (failure: ClaudeReadFailure) => void,
): Promise<ClaudeCapacityResult[]> {
  const settled = await Promise.allSettled(
    discoverClaudeProfiles().map((profile) => profileCapacity(profile, now)),
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

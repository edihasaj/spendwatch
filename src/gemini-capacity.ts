// Current Gemini capacity from the account's own Code Assist quota API.
//
// The official Gemini CLI has no quota command; it reads its allowance from the
// Code Assist API and keeps the sign-in in a home directory. This collector is
// the same read, done out-of-process against the credentials GateFox already
// stores for its `gemini-subscription` provider, so the dashboard gets a
// first-party source instead of an estimate.
//
// Collection is opt-in by presence: no signed-in credential file means no card
// and no request. A refreshed token lives in this call's memory only — the
// credential file belongs to the gateway, which owns writing it back under its
// own lock — and no token, response body, or file path is ever returned or
// logged.
import { paceFor, type CapacityPaceWindow, type CapacityWindow } from "./capacity-current";
import { coordinatedCapacity, retryAfterMs } from "./capacity-poll";
import {
  geminiCredentialHomes,
  geminiNeedsRefresh,
  scanGeminiHomes,
  type GeminiAccount,
} from "./gemini-credential";
import { geminiQuotaFromBuckets, type GeminiQuotaRow } from "./gemini-quota";
import { installedGeminiOAuthClient, type GeminiOAuthClient } from "./gemini-oauth-client";
import { GeminiReadError } from "./gemini-read-error";
import { readAntigravityQuota, type AntigravityReadOptions } from "./antigravity-capacity";
import type { GeminiQuota, GeminiWeek } from "./gemini-quota";

/** Mirror of the CLI's own endpoint constants (chunk-37D3S3FZ.js:333387-333388). */
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const GEMINI_API_VERSION = "v1internal";
/** The CLI's OAuth client refreshes against this endpoint (chunk-37D3S3FZ.js:12564). */
export const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Google's installed-app OAuth client is the one the official CLI signs in with. It is public by distribution,
 * but Spendwatch keeps no copy in its source: `installedGeminiOAuthClient` reads it from the installed CLI
 * bundle (chunk-37D3S3FZ.js:291234-291235 in 0.70.0). It is only ever sent to Google's own token endpoint.
 */

// The CLI sends `GeminiCLI/<version>/<model> (<platform>; <arch>; <surface>)`
// (chunk-37D3S3FZ.js:335084-335086) and the auth transport appends
// `google-api-nodejs-client/<version>` to whatever User-Agent it is handed
// (chunk-37D3S3FZ.js:126737,126792). Spendwatch is not the CLI, so it keeps the
// shape and identifies itself honestly rather than claiming a CLI version it is
// not, which is also what an edge expects from a non-browser client.
const GEMINI_TRANSPORT_SUFFIX = "google-api-nodejs-client";
export function geminiUserAgent(platform = process.platform, arch = process.arch): string {
  return `GeminiCLI/spendwatch/gemini (${platform}; ${arch}; cli) ${GEMINI_TRANSPORT_SUFFIX}`;
}

const REQUEST_TIMEOUT_MS = 12_000;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;

export interface GeminiCapacityResult {
  provider: "gemini";
  account: string;
  usage: {
    accountEmail: string;
    /** The Code Assist tier name, e.g. `Google AI Ultra`. */
    loginMethod?: string;
    primary: CapacityWindow | null;
    secondary: CapacityWindow | null;
    tertiary: CapacityWindow | null;
    /** One row per collapsed model allowance, most useful order first. */
    buckets: GeminiQuotaRow[];
    /** The seven-day window ledger the poll store carries forward (Antigravity sign-ins). */
    week?: GeminiWeek;
    updatedAt: string;
  };
  pace: {
    primary: CapacityPaceWindow | null;
    secondary: CapacityPaceWindow | null;
    tertiary: CapacityPaceWindow | null;
  } | null;
}

/** Same fixed failure vocabulary as the Claude collector, so callers treat them alike. */
export interface GeminiReadFailure {
  email?: string;
  status?: number;
  reason: "unauthenticated" | "rate-limited" | "unavailable";
  message: string;
}

/**
 * The only sentence used for a fault this collector cannot name.
 *
 * An exception from SQLite, the coordinator client or a fetch transport can
 * carry a file path, a URL, or a fragment of a request in its `message`, and a
 * caller prints that message on a terminal. Such text is never forwarded: an
 * unknown fault is reported as an unknown fault, and nothing else.
 */
export const GEMINI_UNKNOWN_MESSAGE = "Gemini quota read failed";

/**
 * The one line a Gemini failure is allowed to produce, on a writer the caller
 * controls so it can be tested rather than assumed. Every part of it is either
 * one of the fixed classes above or an account label that `scanGeminiHomes`
 * already held to an address shape.
 */
export function reportGeminiFailure(
  failure: GeminiReadFailure,
  write: (chunk: string) => void = (chunk) => process.stderr.write(chunk),
): void {
  const who = failure.email ? ` for ${failure.email}` : "";
  write(`gemini capacity ${failure.reason}${who}: ${failure.message}\n`);
}


/**
 * A 401 needs a human to sign in again, a 429 needs patience, and anything
 * else is a transient fault. These are the same three fixed classes the Claude
 * collector publishes.
 */
export function classifyGeminiFailure(status: number): GeminiReadFailure["reason"] {
  if (status === 401 || status === 403) return "unauthenticated";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

export interface GeminiReadOptions extends AntigravityReadOptions {
  /** Test-only seam for the Code Assist base URL; never read from the environment. */
  codeAssistBaseUrl?: string;
  /** Test-only seam for the OAuth token endpoint; never read from the environment. */
  tokenUrl?: string;
  /** Test-only override for the credential homes to consider. */
  homes?: string[];
  /**
   * Test-only override for the poll coordinator. Pass `""` to exercise a read
   * against the local lease store; omit it in production so the configured
   * coordinator stays authoritative.
   */
  coordinator?: string;
  fetch?: typeof fetch;
  /** Test-only OAuth client; production reads the installed CLI's own. */
  oauthClient?: GeminiOAuthClient;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface TokenResponse {
  accessToken: string;
  expiresAt: number;
}

/**
 * Exchange the refresh grant for a live access token, in memory only.
 *
 * The request body and header are the CLI's own (chunk-37D3S3FZ.js:127180-127195):
 * a form-encoded `refresh_token`, `client_id`, `client_secret` and
 * `grant_type=refresh_token` posted to Google's token endpoint. The result is
 * returned to the caller and never persisted: the gateway owns this file.
 *
 * Google answers a revoked or rotated grant with HTTP 400 `invalid_grant`. That
 * is a sign-in problem, not a retry, so it surfaces as the same 401 the quota
 * read uses and lands in the dashboard's Authentication required state.
 */
async function refreshInMemory(
  refreshToken: string,
  nowMs: number,
  options: GeminiReadOptions,
): Promise<TokenResponse> {
  const request = options.fetch ?? fetch;
  // Without an installed CLI there is no client to refresh with: a fixed transient class, no request.
  const client = options.oauthClient ?? installedGeminiOAuthClient();
  if (!client) throw new GeminiReadError(503);
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: client.id,
    client_secret: client.secret,
    grant_type: "refresh_token",
  }).toString();
  const response = await request(options.tokenUrl ?? GEMINI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!response) throw new GeminiReadError(0);
  if (!response.ok) {
    // Only the fixed `error` code is read out of the body. An `error_description`
    // can quote the very grant that was just rejected, so it is never carried
    // into an error, a snapshot, or stderr.
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    const code = response.status === 400 ? stringField(payload, "error") : undefined;
    throw new GeminiReadError(code === "invalid_grant" ? 401 : response.status);
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const accessToken = stringField(payload, "access_token");
  const expiresIn = Number(payload?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new GeminiReadError(502);
  return { accessToken, expiresAt: nowMs + expiresIn * 1000 };
}

async function postCodeAssist(
  method: "loadCodeAssist" | "retrieveUserQuota",
  body: Record<string, unknown>,
  token: string,
  options: GeminiReadOptions,
): Promise<{ status: number; ok: boolean; json?: unknown; retryAfterMs?: number }> {
  const base = (options.codeAssistBaseUrl ?? GEMINI_CODE_ASSIST_ENDPOINT).replace(/\/+$/, "");
  // `getMethodUrl` joins the version with a colon, not a slash (chunk-37D3S3FZ.js:333748).
  const url = `${base}/${GEMINI_API_VERSION}:${method}`;
  const request = options.fetch ?? fetch;
  const response = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": geminiUserAgent(),
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!response) return { status: 0, ok: false };
  if (!response.ok) {
    return { status: response.status, ok: false, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
  }
  return { status: response.status, ok: true, json: await response.json().catch(() => undefined) };
}

/**
 * The live token for one account read.
 *
 * One collect spends at most one refresh grant. Google can rotate a refresh
 * grant when it hands out a new access token, and this collector may never
 * write the rotated grant back — the gateway owns that file and its lock — so a
 * second exchange in the same read could strand the stored login. Both Code
 * Assist calls therefore share the single token this session obtains.
 */
interface TokenSession {
  token: string;
  refreshed?: Promise<string>;
}

async function sessionToken(session: TokenSession, account: GeminiAccount, now: number, options: GeminiReadOptions): Promise<string> {
  if (!session.refreshed) {
    if (!account.credential.refreshToken) throw new GeminiReadError(401, account.email);
    session.refreshed = refreshInMemory(account.credential.refreshToken, now, options).then((result) => result.accessToken);
  }
  session.token = await session.refreshed;
  return session.token;
}

/** One Code Assist call, retried once after the session's single in-memory refresh on a 401. */
async function authorizedPost(
  method: "loadCodeAssist" | "retrieveUserQuota",
  body: Record<string, unknown>,
  account: GeminiAccount,
  session: TokenSession,
  now: number,
  options: GeminiReadOptions,
): Promise<unknown> {
  const first = await postCodeAssist(method, body, session.token, options);
  if (first.ok) return first.json;
  if (first.status === 401) {
    const token = await sessionToken(session, account, now, options);
    const second = await postCodeAssist(method, body, token, options);
    if (second.ok) return second.json;
    throw new GeminiReadError(second.status, account.email, second.retryAfterMs);
  }
  throw new GeminiReadError(first.status, account.email, first.retryAfterMs);
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: unknown;
  currentTier?: { name?: unknown } | null;
  paidTier?: { name?: unknown } | null;
}

/**
 * The account's Code Assist project id and tier name.
 *
 * The body mirrors the CLI exactly (chunk-37D3S3FZ.js:333926-333934):
 * `cloudaicompanionProject` plus a `metadata` block carrying `duetProject`, both
 * set to the project id the caller already knows. With no known project the CLI
 * sends them as `undefined`, which JSON.stringify drops, leaving the same
 * `{metadata:{ideType,platform,pluginType}}` body this sends. The CLI seeds the
 * known project from `GOOGLE_CLOUD_PROJECT` (chunk-37D3S3FZ.js:333890); this
 * collector deliberately does not read that variable — an environment value has
 * no place in a quota request Spendwatch did not ask for, and the project id
 * comes back in the response either way.
 */
async function loadAccount(
  account: GeminiAccount,
  session: TokenSession,
  now: number,
  options: GeminiReadOptions,
): Promise<{ project: string; tier?: string }> {
  const response = await authorizedPost("loadCodeAssist", {
    metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  }, account, session, now, options) as LoadCodeAssistResponse | undefined;
  const project = typeof response?.cloudaicompanionProject === "string" ? response.cloudaicompanionProject : undefined;
  if (!project || !PROJECT_PATTERN.test(project)) throw new GeminiReadError(502, account.email);
  const tier = stringField(response.paidTier as Record<string, unknown> | undefined, "name")
    ?? stringField(response.currentTier as Record<string, unknown> | undefined, "name");
  return { project, tier };
}

export function geminiCapacityFromQuota(
  quotaValue: unknown,
  identity: { email: string; tier?: string },
  now = Date.now(),
): GeminiCapacityResult | undefined {
  const quota = quotaValue && typeof quotaValue === "object"
    ? geminiQuotaFromBuckets((quotaValue as { buckets?: unknown }).buckets, now)
    : undefined;
  return geminiCapacityResult(quota, identity, now);
}

/** The dashboard row for one account's quota, whichever sign-in read it. */
export function geminiCapacityResult(
  quota: GeminiQuota | undefined,
  identity: { email: string; tier?: string },
  now = Date.now(),
): GeminiCapacityResult | undefined {
  if (!identity.email.includes("@") || !quota) return undefined;
  return {
    provider: "gemini",
    account: identity.email,
    usage: {
      accountEmail: identity.email,
      ...(identity.tier ? { loginMethod: identity.tier } : {}),
      primary: quota.primary,
      secondary: quota.secondary,
      tertiary: quota.tertiary,
      buckets: quota.rows,
      updatedAt: new Date(now).toISOString(),
    },
    pace: {
      primary: paceFor(quota.primary, now),
      secondary: paceFor(quota.secondary, now),
      tertiary: paceFor(quota.tertiary, now),
    },
  };
}

async function accountCapacity(
  account: GeminiAccount,
  now: number,
  options: GeminiReadOptions,
): Promise<GeminiCapacityResult | undefined> {
  if (account.signIn === "antigravity") {
    const { quota, tier } = await readAntigravityQuota(account, now, options);
    return geminiCapacityResult(quota, { email: account.email, tier }, now);
  }
  // Refresh ahead of expiry rather than spending a guaranteed 401 to discover
  // it; the token lives only in this session object.
  const session: TokenSession = { token: account.credential.accessToken };
  if (geminiNeedsRefresh(account.credential.expiresAt, now) && account.credential.refreshToken) {
    session.token = await sessionToken(session, account, now, options);
  }
  const { project, tier } = await loadAccount(account, session, now, options);
  const quota = await authorizedPost("retrieveUserQuota", { project }, account, session, now, options);
  return geminiCapacityFromQuota(quota, { email: account.email, tier }, now);
}

/**
 * One quota read per signed-in Gemini account.
 *
 * A home with no credential file is simply not collected — that is the opt-in.
 * Everything else that went wrong is reported, because an empty array cannot
 * tell "sign in again" from "no Gemini account here".
 */
export async function currentGeminiCapacity(
  now = Date.now(),
  onFailure?: (failure: GeminiReadFailure) => void,
  options: GeminiReadOptions = {},
): Promise<GeminiCapacityResult[]> {
  const homes = options.homes ?? geminiCredentialHomes();
  const { accounts, refusals } = scanGeminiHomes(homes);
  for (const refusal of refusals) {
    // Refusals are reported by class, never by path: the home a credential was
    // refused in is itself information a stranger cannot be handed.
    onFailure?.({
      reason: "unavailable",
      message: refusal.reason === "unnamed-account"
        ? "Gemini sign-in names no usable account"
        : `Gemini credential file was refused: ${refusal.reason}`,
    });
  }
  const settled = await Promise.allSettled(accounts.map(async (account) =>
    coordinatedCapacity("gemini", account.email, () => accountCapacity(account, now, options), {
      ...(options.coordinator !== undefined ? { coordinator: options.coordinator } : {}),
    })));
  const byAccount = new Map<string, GeminiCapacityResult>();
  for (const [index, item] of settled.entries()) {
    if (item.status === "fulfilled" && item.value) {
      byAccount.set(item.value.account.toLowerCase(), item.value);
      continue;
    }
    if (item.status === "rejected") {
      const error = item.reason;
      const status = error instanceof GeminiReadError ? error.status : undefined;
      // A failed token exchange throws before any account is named, so the
      // account the read was started for is the only label this failure can
      // carry; without it a lost sign-in would be reported as anonymous and
      // the dashboard could not point at the account that needs signing in.
      const email = (error instanceof GeminiReadError ? error.email : undefined) ?? accounts[index]?.email;
      onFailure?.({
        email,
        status,
        reason: status === undefined || status === 0 ? "unavailable" : classifyGeminiFailure(status),
        // Only this file's own fixed sentences are quoted. Anything else that
        // threw — a database open failure, a coordinator transport fault — is
        // reported as the unknown fault it is.
        message: error instanceof GeminiReadError ? error.message : GEMINI_UNKNOWN_MESSAGE,
      });
      continue;
    }
    // A read that answered with nothing usable is a reporting gap worth naming.
    onFailure?.({ email: accounts[index]?.email, reason: "unavailable", message: "Gemini quota reported no usable buckets" });
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

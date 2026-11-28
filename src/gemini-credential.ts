// The Gemini sign-in on disk: where it lives, whether it may be read, and what
// it says about the account.
//
// The official Gemini CLI keeps its OAuth grant in `<home>/.gemini/oauth_creds.json`
// and the signed-in label in `<home>/.gemini/google_accounts.json`. GateFox
// stores its `gemini-subscription` login in the same shape, so Spendwatch can
// read a card without asking anybody to sign in twice.
//
// This file never writes. The credential belongs to the gateway, which owns it
// under its own lock; a collector that saved a rotated grant could strand the
// stored login. Nothing here returns or logs a token, and a refusal is always a
// fixed reason, never a path.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readGatewayConfig, resolveStateDirectory, type GatewayConfigView } from "./gateway-config";

/** Refresh this far before the deadline so a slow collect cannot race it. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface GeminiCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Which sign-in a home holds. Google moved Google AI Pro and Ultra subscriptions to Antigravity CLI (`agy`) on
 * 18 June 2026, and GateFox's `gemini-subscription` provider now signs in through it, so `antigravity` is the
 * current login and `gemini-cli` the older one.
 */
export type GeminiSignIn = "antigravity" | "gemini-cli";

export interface GeminiAccount {
  home: string;
  email: string;
  credential: GeminiCredential;
  signIn: GeminiSignIn;
}

/** Why a credential file was refused. Fixed reasons only: never a path. */
export type GeminiCredentialRejection = "symlink" | "not-owned" | "not-private" | "not-a-file";

export function credentialPath(home: string): string {
  return join(home, ".gemini", "oauth_creds.json");
}

/** Where `agy` keeps its sign-in inside a home (harness-gateway src/providers/antigravity-home.ts). */
export function antigravityDirectory(home: string): string {
  return join(home, ".gemini", "antigravity-cli");
}

export function antigravityCredentialPath(home: string): string {
  return join(antigravityDirectory(home), "antigravity-oauth-token");
}

/**
 * Reject a credential file this process should not be reading.
 *
 * These files hold a refresh grant for a Google account. A link can be swapped
 * for another account's login between the check and the read, a file owned by
 * somebody else was not written by this user, and any group or world bit means
 * a stranger could have copied the grant. Missing is not a rejection: presence
 * is the opt-in.
 */
export interface GeminiCredentialStats {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  uid: number;
  mode: number;
}

/** The rule, separated from the stat call so the ownership branch is testable. */
export function inspectGeminiCredentialStats(
  stats: GeminiCredentialStats,
  uid = process.getuid?.(),
): GeminiCredentialRejection | undefined {
  if (stats.isSymbolicLink()) return "symlink";
  if (!stats.isFile()) return "not-a-file";
  if (uid !== undefined && stats.uid !== uid) return "not-owned";
  // Any group or world bit means a stranger could have copied the grant.
  if ((stats.mode & 0o077) !== 0) return "not-private";
  return undefined;
}

export function inspectGeminiCredentialFile(path: string): GeminiCredentialRejection | undefined {
  const read = readPrivateFile(path);
  return read && "rejection" in read ? read.rejection : undefined;
}

/**
 * Open, judge and read one descriptor, so the check and the read cannot be
 * aimed at two different files.
 *
 * A `lstat` followed by a separate read-by-path leaves a window: a link can be
 * planted, or the file swapped for another account's grant, between the two
 * calls. `O_NOFOLLOW` refuses a link at open, and the checks run on the `fstat`
 * of the very descriptor whose bytes are then read, so nothing is re-resolved by
 * path once it has been judged.
 *
 * Absent is not a refusal: presence of the file is the opt-in. `policy` differs
 * per file on purpose. The grant file is written 0600 by the CLI
 * (chunk-37D3S3FZ.js:291866) and holds a refresh token, so owner and mode are
 * enforced. The account label is written with no mode at all
 * (chunk-37D3S3FZ.js:284911, so whatever umask the sign-in ran under) and holds
 * nothing secret, so demanding 0600 there would lose the label — and the card
 * with it — on a correct install. Both still refuse a link.
 */
type TrustedRead = { text: string } | { rejection: GeminiCredentialRejection };

function readTrusted(path: string, policy: "secret" | "label"): TrustedRead | undefined {
  let fd;
  try {
    // `O_NONBLOCK` matters: `lstat` refused a FIFO outright, and opening one for
    // reading without it blocks until somebody writes, which would hang the
    // collect. With it the open returns at once and the `fstat` below refuses it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(fd);
    const rejection: GeminiCredentialRejection | undefined = policy === "secret"
      ? inspectGeminiCredentialStats(stats)
      : stats.isFile() ? undefined : "not-a-file";
    if (rejection) return { rejection };
    return { text: readFileSync(fd, "utf8") };
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    if (code === "ELOOP") return { rejection: "symlink" };
    if (code === "EACCES" || code === "EPERM") {
      return { rejection: policy === "secret" ? "not-private" : "not-a-file" };
    }
    return { rejection: "not-a-file" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateFile(path: string): TrustedRead | undefined {
  return readTrusted(path, "secret");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// The label is read from a file and then keys history, a poll reservation and a
// reported failure, so it is held to the shape those all require rather than to
// "contains an @". `pollKey` enforces the same pattern and would reject the
// account later with no useful message at all.
const ACCOUNT_PATTERN = /^[^\s@]+@[^\s@]+$/;

/** The signed-in account label, exactly where the CLI keeps it. */
export function geminiAccountEmail(home: string): string | undefined {
  const accounts = parseJsonObject(readTrusted(join(home, ".gemini", "google_accounts.json"), "label")?.text ?? "");
  const active = stringField(accounts, "active");
  return active && active.length <= 320 && ACCOUNT_PATTERN.test(active) ? active : undefined;
}

/**
 * The credential homes to consider, gateway-managed login first.
 *
 * GateFox resolves a `gemini-subscription` provider's `geminiHome` itself
 * (harness-gateway src/config.ts:368), defaulting it to `<stateDirectory>/gemini-home`.
 * Both are read here through the gateway-config helpers Spendwatch already uses,
 * so a relative `geminiHome` lands beside the gateway's own files and one
 * resolution rule exists in this repo. The personal `~/.gemini` login follows as
 * a second account. Nothing from the config is logged, and none of it is written.
 */
export function geminiCredentialHomes(
  config: GatewayConfigView = readGatewayConfig(),
  base = homedir(),
): string[] {
  const homes: string[] = [];
  if (config.found) {
    for (const home of config.geminiHomes?.values() ?? []) homes.push(home);
    // The gateway's own default for a provider that does not name a home. It is
    // probed even when no Gemini provider is configured: presence of a
    // credential file is the opt-in, so a home with no file costs one stat.
    const stateDirectory = resolveStateDirectory(config);
    if (stateDirectory) homes.push(join(stateDirectory, "gemini-home"));
  }
  homes.push(base);
  return [...new Set(homes.map((home) => resolve(home)))];
}

function readGeminiCredential(path: string): { credential?: GeminiCredential; rejection?: GeminiCredentialRejection } {
  const read = readPrivateFile(path);
  if (!read) return {};
  if ("rejection" in read) return { rejection: read.rejection };
  const stored = parseJsonObject(read.text);
  const accessToken = stringField(stored, "access_token");
  if (!accessToken) return {};
  const expiry = Number(stored?.expiry_date);
  return {
    credential: {
      accessToken,
      refreshToken: stringField(stored, "refresh_token"),
      expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry : undefined,
    },
  };
}

/**
 * The Antigravity sign-in: `{token:{access_token, refresh_token, expiry}, id_token_email}`. Unlike the Gemini CLI,
 * the account label lives in the same file, so one trusted read names the account too.
 */
function readAntigravityCredential(path: string): { credential?: GeminiCredential; email?: string; rejection?: GeminiCredentialRejection } {
  const read = readPrivateFile(path);
  if (!read) return {};
  if ("rejection" in read) return { rejection: read.rejection };
  const stored = parseJsonObject(read.text);
  const token = stored?.token && typeof stored.token === "object" && !Array.isArray(stored.token)
    ? stored.token as Record<string, unknown> : undefined;
  const accessToken = stringField(token, "access_token");
  if (!accessToken) return {};
  const expiry = Date.parse(stringField(token, "expiry") ?? "");
  const email = stringField(stored, "id_token_email");
  return {
    credential: {
      accessToken,
      refreshToken: stringField(token, "refresh_token"),
      expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry : undefined,
    },
    email: email && email.length <= 320 && ACCOUNT_PATTERN.test(email) ? email : undefined,
  };
}

/**
 * Every usable signed-in account, de-duplicated by email so one login reads once.
 *
 * Nothing is dropped silently: a home that holds a credential file but yields no
 * account is listed in `refusals` with a fixed reason, so the caller can report
 * the gap rather than let an empty list read as "no Gemini here".
 */
export type GeminiHomeRefusal = GeminiCredentialRejection | "unnamed-account";

export interface GeminiHomeScan {
  accounts: GeminiAccount[];
  /** Every home holding a credential file that produced no account, in home order. */
  refusals: Array<{ home: string; reason: GeminiHomeRefusal }>;
}

export function scanGeminiHomes(homes: string[]): GeminiHomeScan {
  const accounts: GeminiAccount[] = [];
  const refusals: Array<{ home: string; reason: GeminiHomeRefusal }> = [];
  const seen = new Set<string>();
  const add = (home: string, email: string, credential: GeminiCredential, signIn: GeminiSignIn) => {
    if (seen.has(email.toLowerCase())) return;
    seen.add(email.toLowerCase());
    accounts.push({ home, email, credential, signIn });
  };
  for (const home of homes) {
    // The Antigravity sign-in is read first: it is the one a current subscription uses, and an older Gemini CLI
    // login for the same address in the same home would only report a quota Google no longer serves there.
    const antigravity = readAntigravityCredential(antigravityCredentialPath(home));
    if (antigravity.rejection) refusals.push({ home, reason: antigravity.rejection });
    else if (antigravity.credential && !antigravity.email) refusals.push({ home, reason: "unnamed-account" });
    else if (antigravity.credential && antigravity.email) add(home, antigravity.email, antigravity.credential, "antigravity");
    const path = credentialPath(home);
    const read = readGeminiCredential(path);
    if (read.rejection) {
      refusals.push({ home, reason: read.rejection });
      continue;
    }
    const credential = read.credential;
    if (!credential) continue;
    const email = geminiAccountEmail(home);
    // No label means no way to key the account across machines, so it is not a
    // card, and a label that is not an address keys nothing either.
    if (!email) {
      refusals.push({ home, reason: "unnamed-account" });
      continue;
    }
    add(home, email, credential, "gemini-cli");
  }
  return { accounts, refusals };
}

/** True when the stored token is expired, about to be, or carries no deadline. */
export function geminiNeedsRefresh(expiresAt: number | undefined, nowMs: number): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return expiresAt - REFRESH_SKEW_MS <= nowMs;
}

/**
 * The Antigravity sign-in's bytes, for a disposable copy only. The same descriptor-checked read as the parse, so a
 * file swapped or relinked after the scan is refused here too.
 */
export function readAntigravitySignIn(home: string): string | undefined {
  const read = readPrivateFile(antigravityCredentialPath(home));
  return read && "text" in read ? read.text : undefined;
}

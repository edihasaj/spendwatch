import { spawnSync } from "node:child_process";

export interface ClaudeKeychainLocator {
  service: string;
  account: string;
  path: string;
}

export interface ClaudeKeychainCredential {
  locator: ClaudeKeychainLocator;
  /** The complete Keychain JSON value, not only `claudeAiOauth`. */
  wrapper: Record<string, unknown>;
  oauth: Record<string, unknown>;
}

export interface RefreshedClaudeKeychainCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

interface SecurityResult {
  status: number | null;
  stdout: string;
}

type SecurityRunner = (args: string[], input?: string) => SecurityResult;

function security(args: string[], input?: string): SecurityResult {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    input,
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function stringField(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oauthFrom(wrapper: Record<string, unknown>): Record<string, unknown> | undefined {
  const oauth = wrapper.claudeAiOauth;
  return oauth && typeof oauth === "object" && !Array.isArray(oauth)
    ? oauth as Record<string, unknown>
    : undefined;
}

function readWrapper(locator: ClaudeKeychainLocator, runner: SecurityRunner): Record<string, unknown> | undefined {
  const result = runner([
    "find-generic-password",
    "-s", locator.service,
    "-a", locator.account,
    "-w",
    locator.path,
  ]);
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const value = JSON.parse(result.stdout);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read only the record attributes from `security dump-keychain`. The resulting
 * locator keeps the source keychain path, so a later refresh cannot update a
 * different item with the same service/account pair in the default search list.
 */
export function keychainLocatorsFrom(dump: string, service: string): ClaudeKeychainLocator[] {
  const locators: ClaudeKeychainLocator[] = [];
  for (const record of dump.split(/^keychain: /m)) {
    const path = /^"([^"]+)"/.exec(record)?.[1];
    if (!path || !record.includes(`"svce"<blob>="${service}"`)) continue;
    const account = /^\s*"acct"<blob>="([^"]*)"/m.exec(record)?.[1];
    if (account === undefined) continue;
    const duplicate = locators.some((locator) =>
      locator.service === service && locator.account === account && locator.path === path);
    if (!duplicate) locators.push({ service, account, path });
  }
  return locators;
}

export function readClaudeKeychainCredential(
  locator: ClaudeKeychainLocator,
  runner: SecurityRunner = security,
): ClaudeKeychainCredential | undefined {
  const wrapper = readWrapper(locator, runner);
  const oauth = wrapper && oauthFrom(wrapper);
  return oauth && stringField(oauth, "accessToken") ? { locator, wrapper, oauth } : undefined;
}

/** Check whether the selected item is still the login that supplied this profile. */
export function hasClaudeKeychainRefreshToken(
  credential: ClaudeKeychainCredential,
  expectedRefreshToken: string,
  runner: SecurityRunner = security,
): boolean {
  const wrapper = readWrapper(credential.locator, runner);
  const oauth = wrapper && oauthFrom(wrapper);
  return stringField(oauth, "refreshToken") === expectedRefreshToken;
}

export function freshestClaudeKeychainCredential(
  candidates: ClaudeKeychainCredential[],
  nowMs: number,
): ClaudeKeychainCredential | undefined {
  return candidates
    .map((candidate, index) => {
      const expiresAt = Number(candidate.oauth.expiresAt);
      const deadline = Number.isFinite(expiresAt) ? expiresAt : Number.NEGATIVE_INFINITY;
      return { candidate, deadline, usable: deadline > nowMs, index };
    })
    // Preserve the later attribute record when dates tie: old logins are left
    // behind by Claude Code and the most recently listed record is the useful
    // deterministic fallback when their metadata is otherwise identical.
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.deadline - a.deadline || b.index - a.index)[0]
    ?.candidate;
}

function quoteSecurityInteractive(value: string): string {
  // `security -i` has its own command-line parser, so keep every externally
  // sourced field in one quoted token. Newlines are rejected rather than
  // becoming a second interactive command.
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid Keychain locator");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hexUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function nextWrapper(
  current: Record<string, unknown>,
  next: RefreshedClaudeKeychainCredentials,
): Record<string, unknown> | undefined {
  const oauth = oauthFrom(current);
  if (!oauth) return undefined;
  const updated: Record<string, unknown> = {
    ...oauth,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
  };
  if (next.refreshTokenExpiresAt !== undefined) updated.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
  if (next.scopes) updated.scopes = next.scopes;
  return { ...current, claudeAiOauth: updated };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]));
}

/**
 * Rotate the exact pre-existing Keychain item selected from an attribute dump.
 *
 * `security add-generic-password -U` has no compare-and-swap form. We first
 * read the specific item and verify the old refresh token, then read it back
 * after the write and require the entire wrapper to match. A concurrent Claude
 * login that changed its refresh token therefore wins safely. The CLI cannot
 * make that preflight atomic with `-U`, so a concurrent deletion remains an
 * OS-level race; callers treat any failed verification as no renewal.
 */
export function persistClaudeKeychainCredentials(
  credential: ClaudeKeychainCredential,
  expectedRefreshToken: string,
  next: RefreshedClaudeKeychainCredentials,
  runner: SecurityRunner = security,
): ClaudeKeychainCredential | undefined {
  const current = readWrapper(credential.locator, runner);
  const currentOauth = current && oauthFrom(current);
  if (!current || !currentOauth || stringField(currentOauth, "refreshToken") !== expectedRefreshToken) return undefined;

  const expected = nextWrapper(current, next);
  if (!expected) return undefined;

  let command: string;
  try {
    // Keep the complete serialized credential out of argv and shell history.
    // `-X` accepts UTF-8 bytes as hex, and `security -i` reads this from stdin.
    command = [
      "add-generic-password -U",
      `-s ${quoteSecurityInteractive(credential.locator.service)}`,
      `-a ${quoteSecurityInteractive(credential.locator.account)}`,
      `-X ${hexUtf8(JSON.stringify(expected))}`,
      quoteSecurityInteractive(credential.locator.path),
    ].join(" ") + "\n";
  } catch {
    return undefined;
  }
  runner(["-i"], command);

  // `security -i` can exit zero after an internal command failure. The exact
  // readback is the result: it verifies both token rotation and all unrelated
  // Claude Code-owned wrapper fields before the in-memory profile is changed.
  const written = readWrapper(credential.locator, runner);
  const writtenOauth = written && oauthFrom(written);
  if (!written || !writtenOauth || !jsonEqual(written, expected)) return undefined;
  return { locator: credential.locator, wrapper: written, oauth: writtenOauth };
}

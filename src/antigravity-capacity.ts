// The Gemini quota of an Antigravity sign-in.
//
// Google moved Google AI Pro and Ultra subscriptions from the Gemini CLI to Antigravity CLI (`agy`) on 18 June 2026,
// and GateFox's `gemini-subscription` provider signs in through it. Antigravity reads its allowance from the same
// Code Assist service as the CLI did, but through `fetchAvailableModels`, which answers each model's
// `quotaInfo.remainingFraction` and `resetTime`; `retrieveUserQuota` refuses an Antigravity login.
//
// Refreshing the access token. `agy` ships its OAuth client without a secret that Spendwatch could use, so the
// token is refreshed the way GateFox itself refreshes it: `agy` runs in a disposable home holding a copy of the
// sign-in, here with `agy models`, which only lists models and starts no conversation. The refreshed access token
// is read from that copy into memory and the copy is deleted. Google keeps the same refresh grant across this
// refresh (checked on 28 November 2026), so discarding the copy never strands GateFox's stored login, and
// Spendwatch still never writes the gateway's file.
import { spawn } from "node:child_process";
import { accessSync, constants, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { retryAfterMs } from "./capacity-poll";
import {
  antigravityDirectory,
  geminiNeedsRefresh,
  readAntigravitySignIn,
  type GeminiAccount,
} from "./gemini-credential";
import { geminiQuotaFromAntigravityModels, type GeminiQuota } from "./gemini-quota";
import { GeminiReadError } from "./gemini-read-error";

export const ANTIGRAVITY_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const REQUEST_TIMEOUT_MS = 12_000;
const REFRESH_TIMEOUT_MS = 60_000;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;

/**
 * Code Assist serves an Antigravity login only to an Antigravity client, so the User-Agent keeps that product name
 * and then names Spendwatch, the way the Gemini CLI collector names itself.
 */
export function antigravityUserAgent(platform = process.platform, arch = process.arch): string {
  return `antigravity/spendwatch (${platform}; ${arch})`;
}

export interface AntigravityReadOptions {
  /** Test-only seam for the Code Assist base URL; never read from the environment. */
  codeAssistBaseUrl?: string;
  fetch?: typeof fetch;
  /** Test-only path to the `agy` executable; production looks on PATH and in the usual install folders. */
  antigravityCommand?: string;
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** PATH first, then Homebrew and the official installer's folder, which a launchd PATH usually lacks. */
export function findAntigravityCommand(path = process.env.PATH ?? "", home = homedir()): string | undefined {
  for (const directory of path.split(delimiter)) if (directory && executable(join(directory, "agy"))) return join(directory, "agy");
  for (const fallback of ["/opt/homebrew/bin/agy", join(home, ".local/bin/agy")]) if (executable(fallback)) return fallback;
  return undefined;
}

function tokenFrom(text: string | undefined, now: number): { accessToken: string; expiresAt: number } | undefined {
  try {
    const token = (JSON.parse(text ?? "") as { token?: Record<string, unknown> }).token;
    const accessToken = typeof token?.access_token === "string" ? token.access_token : "";
    const expiresAt = Date.parse(typeof token?.expiry === "string" ? token.expiry : "");
    return accessToken && Number.isFinite(expiresAt) && expiresAt > now ? { accessToken, expiresAt } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A live access token, obtained by letting `agy` refresh a disposable copy of the sign-in.
 *
 * The copy lives in a fresh 0700 folder under /tmp, the process gets only that folder as its home and no other
 * environment beyond what locates programs, and the folder is removed whatever happens. A copy that came back
 * without a newer token means the grant itself no longer works: that is a sign-in problem (401), not a retry.
 */
export async function refreshAntigravityToken(account: GeminiAccount, now: number, options: AntigravityReadOptions = {}): Promise<string> {
  const command = options.antigravityCommand ?? findAntigravityCommand();
  if (!command) throw new GeminiReadError(503, account.email);
  const signIn = readAntigravitySignIn(account.home);
  if (!signIn) throw new GeminiReadError(401, account.email);
  const scratch = mkdtempSync("/tmp/spendwatch-agy-");
  try {
    chmodSync(scratch, 0o700);
    const directory = antigravityDirectory(scratch);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(scratch, "tmp"), { mode: 0o700 });
    writeFileSync(join(directory, "antigravity-oauth-token"), signIn, { mode: 0o600, flag: "wx" });
    writeFileSync(join(directory, "settings.json"), `${JSON.stringify({ enableTelemetry: false, useG1Credits: false })}\n`, { mode: 0o600, flag: "wx" });
    try {
      // The installation id is not secret; carrying it keeps this from looking like a new install on every read.
      writeFileSync(join(directory, "installation_id"), readFileSync(join(antigravityDirectory(account.home), "installation_id")), { mode: 0o600, flag: "wx" });
    } catch { /* absent is fine */ }
    const env: NodeJS.ProcessEnv = { HOME: scratch, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: join(scratch, "tmp") };
    for (const name of ["USER", "LOGNAME", "LANG", "LC_ALL"]) if (process.env[name]) env[name] = process.env[name];
    const exited = await new Promise<boolean>((resolve) => {
      const child = spawn(command, ["models"], { cwd: scratch, env, stdio: "ignore" });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, REFRESH_TIMEOUT_MS);
      child.once("error", () => { clearTimeout(timer); resolve(false); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    let refreshed: string | undefined;
    try { refreshed = readFileSync(join(directory, "antigravity-oauth-token"), "utf8"); } catch { refreshed = undefined; }
    const token = tokenFrom(refreshed, now);
    if (token && token.accessToken !== account.credential.accessToken) return token.accessToken;
    throw new GeminiReadError(exited ? 401 : 503, account.email);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function post(
  method: "loadCodeAssist" | "fetchAvailableModels",
  body: Record<string, unknown>,
  token: string,
  options: AntigravityReadOptions,
): Promise<{ status: number; ok: boolean; json?: unknown; retryAfterMs?: number }> {
  const base = (options.codeAssistBaseUrl ?? ANTIGRAVITY_CODE_ASSIST_ENDPOINT).replace(/\/+$/, "");
  const response = await (options.fetch ?? fetch)(`${base}/v1internal:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": antigravityUserAgent() },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!response) return { status: 0, ok: false };
  if (!response.ok) return { status: response.status, ok: false, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
  return { status: response.status, ok: true, json: await response.json().catch(() => undefined) };
}

function nameOf(tier: unknown): string | undefined {
  const name = (tier as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name.trim() && name.length <= 80 ? name.trim() : undefined;
}

/**
 * One account's quota: the project and tier from `loadCodeAssist`, then the per-model quota. One read spends at
 * most one `agy` refresh, ahead of expiry or after a 401, and both calls share the token it obtained.
 */
export async function readAntigravityQuota(
  account: GeminiAccount,
  now: number,
  options: AntigravityReadOptions = {},
): Promise<{ quota?: GeminiQuota; tier?: string }> {
  let token = account.credential.accessToken;
  let refreshed = false;
  const refresh = async () => { refreshed = true; token = await refreshAntigravityToken(account, now, options); };
  if (geminiNeedsRefresh(account.credential.expiresAt, now)) await refresh();
  const call = async (method: "loadCodeAssist" | "fetchAvailableModels", body: Record<string, unknown>) => {
    let result = await post(method, body, token, options);
    if (!result.ok && result.status === 401 && !refreshed) {
      await refresh();
      result = await post(method, body, token, options);
    }
    if (!result.ok) throw new GeminiReadError(result.status, account.email, result.retryAfterMs);
    return result.json as Record<string, unknown> | undefined;
  };
  const loaded = await call("loadCodeAssist", {
    metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  });
  const project = typeof loaded?.cloudaicompanionProject === "string" ? loaded.cloudaicompanionProject : undefined;
  if (!project || !PROJECT_PATTERN.test(project)) throw new GeminiReadError(502, account.email);
  const tier = nameOf(loaded?.paidTier) ?? nameOf(loaded?.currentTier);
  const models = await call("fetchAvailableModels", { project });
  return { quota: geminiQuotaFromAntigravityModels(models?.models, now), tier };
}

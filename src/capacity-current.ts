// Current Codex capacity from the official Codex app-server protocol.
//
// `account/rateLimits/read` performs a live, authenticated quota read for the
// selected CODEX_HOME. Rollout events remain useful for history, but are not a
// current-capacity source: an idle profile may have no recent rollout at all, and
// a profile that never ran a task may have no rollout directory of any kind. A
// signed-in home is therefore discovered by its own credential, not by its history.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexClaims, defaultCodexRoots } from "./sources";
import { codexCapacityProfileHomes } from "./codex-capacity-profiles";
import { coordinatedCapacity } from "./capacity-poll";
import { CapacityCoordinatorUnavailableError } from "./capacity-coordinator-client";

export interface CapacityWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
}

export interface CapacityPaceWindow {
  deltaPercent: number;
  expectedUsedPercent: number;
  etaSeconds?: number;
  willLastToReset: boolean;
}

export interface CapacityCredits {
  /** Decimal string as returned by the API; kept verbatim to avoid float drift. */
  balance: string;
  unlimited: boolean;
}

/** Promotional cloud-credit allowance, reported in whole dollars. */
export interface CapacityCloudCredits {
  limitUsd: number;
  remainingUsd: number;
  expiresAt?: string;
  /** The provider has frozen the allowance, usually pending verification. */
  locked?: true;
}

/** Metered pay-as-you-go usage beyond the plan, reported in the provider currency. */
export interface CapacityExtraUsage {
  usedAmount: number;
  limitAmount: number;
  currency: string;
}

export interface CapacityResult {
  provider: "codex";
  account: string;
  usage: {
    accountEmail: string;
    loginMethod?: string;
    primary: CapacityWindow | null;
    secondary: CapacityWindow | null;
    tertiary: CapacityWindow | null;
    credits?: CapacityCredits | null;
    /** The one official quota pool that supplied these windows. */
    quotaPool?: string;
    updatedAt: string;
  };
  pace: {
    primary: CapacityPaceWindow | null;
    secondary: CapacityPaceWindow | null;
    tertiary: CapacityPaceWindow | null;
  } | null;
}

export interface CodexCapacityReadFailure {
  email?: string;
  reason: "unavailable";
  message: string;
}

interface AppServerAccount {
  type?: unknown;
  email?: unknown;
  planType?: unknown;
}

interface AppServerWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface AppServerCredits {
  hasCredits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface AppServerRateLimits {
  primary?: AppServerWindow | null;
  secondary?: AppServerWindow | null;
  tertiary?: AppServerWindow | null;
  credits?: AppServerCredits | null;
}

interface AppServerRateLimitResponse {
  rateLimits?: AppServerRateLimits;
  rateLimitsByLimitId?: Record<string, AppServerRateLimits | null> | null;
}

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

function isoFromEpoch(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function windowFrom(value: AppServerWindow | null | undefined): CapacityWindow | null {
  const usedPercent = Number(value?.usedPercent);
  const windowMinutes = Number(value?.windowDurationMins);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: isoFromEpoch(value?.resetsAt),
  };
}

// Purchased credits cover usage beyond the plan's included window. The API
// reports the balance as a decimal string; keep it verbatim so a large balance
// never loses precision to a float. `hasCredits` false with a "0" balance means
// the account simply has none, which is not worth rendering.
function creditsFrom(value: AppServerCredits | null | undefined): CapacityCredits | null {
  if (!value) return null;
  const unlimited = value.unlimited === true;
  const balance = typeof value.balance === "string" ? value.balance : Number.isFinite(Number(value.balance)) ? String(value.balance) : undefined;
  if (unlimited) return { balance: balance ?? "0", unlimited: true };
  if (balance === undefined) return null;
  if (value.hasCredits !== true && Number(balance) <= 0) return null;
  return { balance, unlimited: false };
}

function windowsFrom(limits: AppServerRateLimits | null | undefined): CapacityWindow[] {
  return [limits?.primary, limits?.secondary, limits?.tertiary]
    .map(windowFrom)
    .filter((window): window is CapacityWindow => Boolean(window));
}

interface CodexPool {
  id: string;
  limits: AppServerRateLimits;
  windows: CapacityWindow[];
}

// An app-server response can describe independently metered Codex model pools.
// A dashboard card needs one coherent account reading, never percentages
// stitched together from different pools.
function codexPool(response: AppServerRateLimitResponse | undefined): CodexPool | undefined {
  const generic = response?.rateLimitsByLimitId?.codex;
  const genericWindows = windowsFrom(generic);
  if (generic && genericWindows.length) return { id: "codex", limits: generic, windows: genericWindows };

  const legacy = response?.rateLimits;
  const legacyWindows = windowsFrom(legacy);
  if (legacy && legacyWindows.length) return { id: "legacy", limits: legacy, windows: legacyWindows };

  // Object order is not an API contract. Select one viable model pool
  // deterministically, then retain all of its windows together.
  for (const id of Object.keys(response?.rateLimitsByLimitId ?? {}).filter((key) => key.startsWith("codex_")).sort()) {
    const limits = response?.rateLimitsByLimitId?.[id];
    const windows = windowsFrom(limits);
    if (limits && windows.length) return { id, limits, windows };
  }
  return undefined;
}

export function paceFor(window: CapacityWindow | null, now = Date.now()): CapacityPaceWindow | null {
  if (!window || !window.resetsAt) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) return null;
  const windowMs = window.windowMinutes * 60_000;
  const remainingMs = resetsAtMs - now;
  if (remainingMs <= 0 || remainingMs > windowMs) return null;
  const elapsed = (windowMs - remainingMs) / windowMs;
  const expectedUsedPercent = elapsed * 100;
  const deltaPercent = window.usedPercent - expectedUsedPercent;
  const burnPerMs = elapsed > 0 ? window.usedPercent / (windowMs * elapsed) : 0;
  const remainingPercent = 100 - window.usedPercent;
  const etaSeconds = burnPerMs > 0 ? Math.max(0, Math.round((remainingPercent / burnPerMs) / 1000)) : undefined;
  return {
    deltaPercent,
    expectedUsedPercent,
    etaSeconds,
    willLastToReset: etaSeconds === undefined || etaSeconds * 1000 >= remainingMs,
  };
}

export function capacityResultFromAppServer(
  accountValue: unknown,
  rateLimitValue: unknown,
  now = Date.now(),
): CapacityResult | undefined {
  const account = accountValue as AppServerAccount | undefined;
  const response = rateLimitValue as AppServerRateLimitResponse | undefined;
  if (account?.type !== "chatgpt" || typeof account.email !== "string" || !account.email.includes("@")) return undefined;
  const pool = codexPool(response);
  const [primary = null, secondary = null, tertiary = null] = pool?.windows ?? [];
  if (!primary) return undefined;
  return {
    provider: "codex",
    account: account.email,
    usage: {
      accountEmail: account.email,
      loginMethod: typeof account.planType === "string" ? account.planType : undefined,
      primary,
      secondary,
      tertiary,
      credits: creditsFrom(pool?.limits.credits),
      quotaPool: pool?.id,
      updatedAt: new Date(now).toISOString(),
    },
    pace: {
      primary: paceFor(primary, now),
      secondary: paceFor(secondary, now),
      tertiary: paceFor(tertiary, now),
    },
  };
}

export function codexBinary(
  override = process.env.SPENDWATCH_CODEX_BIN,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (override) return override;
  // Installed native CLI precedes home wrappers to preserve each profile's CODEX_HOME.
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local", "bin", "codex"),
  ];
  return candidates.find(exists) ?? "codex";
}

async function liveProfileCapacity(profileHome: string, now: number): Promise<CapacityResult | undefined> {
  const child = Bun.spawn([codexBinary(), "app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: profileHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const responses = new Map<number, RpcResponse>();

  const write = async (message: unknown) => {
    child.stdin.write(JSON.stringify(message) + "\n");
    await child.stdin.flush();
  };
  const waitFor = async (ids: number[], timeoutMs = 12_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (ids.some((id) => !responses.has(id))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Codex app-server timed out for ${profileHome}`);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Codex app-server timed out for ${profileHome}`)), remaining);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (chunk.done) throw new Error(`Codex app-server closed for ${profileHome}`);
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as RpcResponse;
          if (typeof parsed.id === "number") responses.set(parsed.id, parsed);
        } catch {}
      }
    }
  };

  try {
    await write({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "spendwatch", version: "0.3.0" }, capabilities: { experimentalApi: true } },
    });
    await waitFor([1]);
    await write({ method: "initialized" });
    await write({ id: 2, method: "account/read", params: { refreshToken: true } });
    await write({ id: 3, method: "account/rateLimits/read", params: null });
    await waitFor([2, 3]);
    for (const id of [2, 3]) {
      const error = responses.get(id)?.error?.message;
      if (typeof error === "string") throw new Error(error);
    }
    const accountResult = responses.get(2)?.result as { account?: unknown } | undefined;
    return capacityResultFromAppServer(accountResult?.account, responses.get(3)?.result, now);
  } finally {
    child.kill();
    await child.exited;
  }
}

export async function currentCodexCapacity(
  now = Date.now(),
  onFailure?: (failure: CodexCapacityReadFailure) => void,
): Promise<CapacityResult[]> {
  // Discover identity locally before starting app-server, and deduplicate homes
  // before any request. Several profiles may contain the same account.
  const profiles = new Map<string, string>();
  // A live quota read needs a login, not a rollout, so signed-in homes are found by
  // their own `auth.json` first. Feeding `codexClaims` a synthetic `<home>/sessions`
  // path asks it for exactly the file it already reads, without creating a directory
  // or writing any credential.
  for (const home of codexCapacityProfileHomes()) {
    const { email } = codexClaims(join(home, "sessions"));
    if (email && !profiles.has(email.toLowerCase())) profiles.set(email.toLowerCase(), home);
  }
  // History roots remain as well: they carry the Qwen worker homes and any archived
  // home whose live `sessions` directory a worker pruned, and they still win for the
  // accounts only they can name.
  for (const root of defaultCodexRoots()) {
    const { email } = codexClaims(root.path);
    if (email && !profiles.has(email.toLowerCase())) profiles.set(email.toLowerCase(), dirname(root.path));
  }
  const profileEntries = [...profiles];
  const settled = await Promise.allSettled(profileEntries.map(([email, home]) =>
    coordinatedCapacity("codex", email, () => liveProfileCapacity(home, now)),
  ));
  const byAccount = new Map<string, CapacityResult>();
  for (const [index, item] of settled.entries()) {
    if (item.status !== "fulfilled" || !item.value) {
      if (item.status === "rejected" && onFailure) {
        const error = item.reason;
        onFailure({
          email: profileEntries[index]?.[0],
          reason: "unavailable",
          message: error instanceof CapacityCoordinatorUnavailableError
            ? "capacity coordinator unavailable"
            : "capacity unavailable",
        });
      }
      continue;
    }
    // A free plan carries no subscription capacity worth planning against.
    if (item.value.usage?.loginMethod === "free" && process.env.SPENDWATCH_INCLUDE_FREE !== "1") continue;
    byAccount.set(item.value.account.toLowerCase(), item.value);
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

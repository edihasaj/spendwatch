// Current Codex capacity from the official Codex app-server protocol.
//
// `account/rateLimits/read` performs a live, authenticated quota read for the
// selected CODEX_HOME. Rollout events remain useful for history, but are not a
// current-capacity source: an idle profile may have no recent rollout at all.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultCodexRoots } from "./sources";

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

export interface CapacityResult {
  provider: "codex";
  account: string;
  usage: {
    accountEmail: string;
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

interface AppServerRateLimits {
  primary?: AppServerWindow | null;
  secondary?: AppServerWindow | null;
}

interface AppServerRateLimitResponse {
  rateLimits?: AppServerRateLimits;
  rateLimitsByLimitId?: Record<string, AppServerRateLimits> | null;
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
  const snapshot = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!snapshot) return undefined;
  const primary = windowFrom(snapshot.primary);
  const secondary = windowFrom(snapshot.secondary);
  if (!primary && !secondary) return undefined;
  return {
    provider: "codex",
    account: account.email,
    usage: {
      accountEmail: account.email,
      loginMethod: typeof account.planType === "string" ? account.planType : undefined,
      primary,
      secondary,
      tertiary: null,
      updatedAt: new Date(now).toISOString(),
    },
    pace: {
      primary: paceFor(primary, now),
      secondary: paceFor(secondary, now),
      tertiary: null,
    },
  };
}

function codexBinary(): string {
  if (process.env.SPENDWATCH_CODEX_BIN) return process.env.SPENDWATCH_CODEX_BIN;
  const candidates = [
    join(homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find(existsSync) ?? "codex";
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

export async function currentCodexCapacity(now = Date.now()): Promise<CapacityResult[]> {
  const settled = await Promise.allSettled(
    defaultCodexRoots().map((root) => liveProfileCapacity(dirname(root.path), now)),
  );
  const byAccount = new Map<string, CapacityResult>();
  for (const item of settled) {
    if (item.status !== "fulfilled" || !item.value) continue;
    // A free plan carries no subscription capacity worth planning against.
    if (item.value.usage?.loginMethod === "free" && process.env.SPENDWATCH_INCLUDE_FREE !== "1") continue;
    byAccount.set(item.value.account.toLowerCase(), item.value);
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

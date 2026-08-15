// Current Codex capacity, read from local rollouts instead of an external CLI.
//
// Codex records a `rate_limits` snapshot in every rollout event, so the newest
// snapshot per profile carries the same windows a live quota query would return.
// The trade-off is freshness: a profile that has not run recently reports its
// last known state rather than the current one. `updatedAt` makes that visible.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    accountOrganization?: string;
    loginMethod?: string;
    primary: CapacityWindow | null;
    secondary: CapacityWindow | null;
    tertiary: CapacityWindow | null;
    updatedAt: string;
  };
  pace: { primary: CapacityPaceWindow | null; secondary: CapacityPaceWindow | null; tertiary: CapacityPaceWindow | null } | null;
}

function safeJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function jwtClaims(token: unknown): any | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function isoFromEpoch(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

interface Identity {
  email: string;
  organization?: string;
  loginMethod?: string;
}

function identity(profileHome: string): Identity | undefined {
  const auth = safeJson(join(profileHome, "auth.json"));
  if (!auth) return undefined;
  for (const token of [auth?.tokens?.id_token, auth?.tokens?.access_token]) {
    const claims = jwtClaims(token);
    if (!claims) continue;
    let email: unknown = claims.email;
    let organization: unknown;
    let plan: unknown;
    for (const value of Object.values(claims)) {
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        if (typeof nested.email === "string") email = nested.email;
        if (typeof nested.chatgpt_account_id === "string") organization = nested.chatgpt_account_id;
        if (typeof nested.chatgpt_plan_type === "string") plan = nested.chatgpt_plan_type;
      }
    }
    if (typeof email === "string" && email.includes("@")) {
      return {
        email,
        organization: typeof organization === "string" ? organization : undefined,
        loginMethod: typeof plan === "string" ? plan : (typeof auth.auth_mode === "string" ? auth.auth_mode : undefined),
      };
    }
  }
  return undefined;
}

// Newest rollout files first, so the scan stops at the first usable snapshot.
function rolloutsNewestFirst(sessionsPath: string, limit = 40): string[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || found.length > 4000) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) found.push({ path, mtime: stat.mtimeMs });
    }
  };
  if (!existsSync(sessionsPath)) return [];
  walk(sessionsPath, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
}

function windowFrom(value: any): CapacityWindow | null {
  const usedPercent = Number(value?.used_percent);
  const windowMinutes = Number(value?.window_minutes);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: isoFromEpoch(value?.resets_at),
  };
}

// Pace compares actual usage against a linear burn of the window. Without a
// reset time the elapsed fraction is unknowable, so pace stays null rather than
// being guessed.
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
  const willLastToReset = etaSeconds === undefined || etaSeconds * 1000 >= remainingMs;
  return { deltaPercent, expectedUsedPercent, etaSeconds, willLastToReset };
}

function newestSnapshot(sessionsPath: string): { rateLimits: any; sampledAt: string } | undefined {
  for (const path of rolloutsNewestFirst(sessionsPath)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // Later lines are newer; walk backwards to the most recent snapshot.
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line || !line.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(line);
        const rateLimits = parsed?.payload?.rate_limits;
        const sampledAt = parsed?.timestamp;
        if (!rateLimits || rateLimits.limit_id !== "codex") continue;
        if (typeof sampledAt !== "string" || !Number.isFinite(Date.parse(sampledAt))) continue;
        return { rateLimits, sampledAt };
      } catch {}
    }
  }
  return undefined;
}

export function currentCodexCapacity(now = Date.now()): CapacityResult[] {
  const results: CapacityResult[] = [];
  for (const root of defaultCodexRoots()) {
    const sessionsPath = root.path;
    const profileHome = dirname(sessionsPath);
    const who = identity(profileHome);
    if (!who) continue;
    const snapshot = newestSnapshot(sessionsPath);
    if (!snapshot) continue;
    const primary = windowFrom(snapshot.rateLimits?.primary);
    const secondary = windowFrom(snapshot.rateLimits?.secondary);
    const tertiary = windowFrom(snapshot.rateLimits?.tertiary);
    if (!primary && !secondary && !tertiary) continue;
    results.push({
      provider: "codex",
      account: who.email,
      usage: {
        accountEmail: who.email,
        accountOrganization: who.organization,
        loginMethod: who.loginMethod,
        primary,
        secondary,
        tertiary,
        updatedAt: snapshot.sampledAt,
      },
      pace: {
        primary: paceFor(primary, now),
        secondary: paceFor(secondary, now),
        tertiary: paceFor(tertiary, now),
      },
    });
  }
  // One entry per account, newest snapshot wins.
  const byAccount = new Map<string, CapacityResult>();
  for (const result of results.sort((a, b) => a.usage.updatedAt.localeCompare(b.usage.updatedAt))) {
    byAccount.set(result.usage.accountEmail, result);
  }
  return [...byAccount.values()];
}

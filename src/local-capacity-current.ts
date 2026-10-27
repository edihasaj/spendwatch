// Live capacity cards for providers that publish no quota window of their own.
//
// Copilot reports its premium-credit usage through the signed-in GitHub account, Grok is covered by a plan and
// reports only what was sent, and Local Qwen is self-hosted and unlimited. None needs a provider quota read, but
// each card still has to follow the machine's own usage closely, so a scheduler can refresh them as often as the
// quota-based providers. Every read is injected, which keeps this module testable without a network, a
// credential, or a transcript on disk.
//
// Cost: a report build scans the transcripts and the gateway ledger for its whole window whichever agent is asked
// for, so the 30-day window costs far more than the 1-day one. One build per window serves every provider, and
// the 30-day totals are cached for MONTH_TTL_MS, so a frequent schedule normally pays only for the 1-day window.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readGrokAccountEmail } from "./accounts";
import type { Report } from "./aggregate";
import { build, reportsFrom } from "./build";
import { rollingDays } from "./periods";

export type LocalProvider = "copilot" | "grok" | "qwen";
export const LOCAL_PROVIDERS: readonly LocalProvider[] = ["copilot", "grok", "qwen"];

export interface CommandResult { code: number; stdout: string }

export interface LocalCapacityDeps {
  now: number;
  home: string;
  /** Every agent's report for the last `days` days. */
  reports(days: number): Report[];
  run(command: string, args: string[], env?: Record<string, string>): Promise<CommandResult>;
  which(name: string): string | null | undefined;
  exists(path: string): boolean;
  /** Extra file that marks a self-hosted Qwen client as configured on this machine. */
  qwenConfig?: string;
  /** Where the 30-day totals are kept between runs; without it every run reads the full month. */
  cache?: { read(): unknown; write(value: unknown): void };
  /** Where Copilot readings and their failure backoff are kept between runs. */
  copilotCache?: { read(): unknown; write(value: unknown): void };
}

const RECENT_DAYS = 1;
const MONTH_DAYS = 30;
/** How old the 30-day totals may be. The 1-day window is always read fresh. */
export const MONTH_TTL_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const LOCAL_QWEN_MODEL = "qwen3.8-flash-next";
const QWEN_CONFIGS = [
  ".codex/spark-implementer.config.toml",
  "Library/Application Support/Claude-3p/qwen-worker/current/config.toml",
];

const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function fileCache(path: string): NonNullable<LocalCapacityDeps["cache"]> {
  return {
    read: () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } },
    write: (value) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const staged = `${path}.${process.pid}.tmp`;
      writeFileSync(staged, JSON.stringify(value), { mode: 0o600 });
      renameSync(staged, path);
    },
  };
}

export function defaultLocalCapacityDeps(): LocalCapacityDeps {
  const home = homedir();
  return {
    now: Date.now(),
    home,
    reports: (days) => {
      const options = { top: 1 };
      return reportsFrom(build(options, [rollingDays(Date.now(), days)]), options);
    },
    run: async (command, args, env) => {
      const child = Bun.spawn([command, ...args], {
        stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env },
      });
      const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
      try {
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { code, stdout };
      } finally { clearTimeout(timer); }
    },
    which: (name) => Bun.which(name),
    exists: existsSync,
    qwenConfig: process.env.SPENDWATCH_QWEN_CONFIG,
    cache: fileCache(join(home, ".local/state/spendwatch/local-capacity.json")),
    copilotCache: fileCache(join(home, ".local/state/spendwatch/copilot-capacity.json")),
  };
}

function isoSeconds(now: number): string {
  return new Date(now).toISOString();
}

/** What the cards need from one report window. */
interface WindowTotals { grokUsd: number; grokTokens: number; qwenTokens: number }

function sum(reports: Report[], field: "totalCost" | "totalTokens"): number {
  return reports.reduce((total, report) => total + number(report[field]), 0);
}

/** Tokens one report set holds for the self-hosted model, whichever agent routed them. */
export function localQwenTokens(reports: Report[]): number {
  let total = 0;
  for (const report of reports) {
    for (const row of report.models ?? []) {
      const model = String(row.model ?? "").toLowerCase().replace(/^(codex|claude)\//, "");
      if (model !== LOCAL_QWEN_MODEL && model !== `qwen/${LOCAL_QWEN_MODEL}`) continue;
      total += number(row.inTok) + number(row.outTok) + number(row.cacheReadTok) + number(row.cacheWriteTok);
    }
  }
  return total;
}

function totalsOf(reports: Report[]): WindowTotals {
  const grok = reports.filter((report) => report.source === "grok");
  return { grokUsd: sum(grok, "totalCost"), grokTokens: sum(grok, "totalTokens"), qwenTokens: localQwenTokens(reports) };
}

function cachedMonth(deps: LocalCapacityDeps): WindowTotals | undefined {
  let raw: unknown;
  try { raw = deps.cache?.read(); } catch { return undefined; }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const finite = (field: string): number | undefined =>
    typeof value[field] === "number" && Number.isFinite(value[field]) && (value[field] as number) >= 0 ? value[field] as number : undefined;
  const at = finite("at");
  const grokUsd = finite("grokUsd");
  const grokTokens = finite("grokTokens");
  const qwenTokens = finite("qwenTokens");
  // A sample from the future (a clock that moved back) is never trusted.
  if (at === undefined || at > deps.now || deps.now - at >= MONTH_TTL_MS) return undefined;
  if (grokUsd === undefined || grokTokens === undefined || qwenTokens === undefined) return undefined;
  return { grokUsd, grokTokens, qwenTokens };
}

/** Reads each window once however many providers ask for it, and the month from the cache while it is fresh. */
function windowLoader(deps: LocalCapacityDeps): (days: number) => WindowTotals {
  const memo = new Map<number, WindowTotals | Error>();
  return (days) => {
    let value = memo.get(days);
    if (!value) {
      try {
        if (days === MONTH_DAYS) {
          value = cachedMonth(deps);
          if (!value) {
            value = totalsOf(deps.reports(days));
            try { deps.cache?.write({ at: deps.now, ...value }); } catch {}
          }
        } else value = totalsOf(deps.reports(days));
      } catch (error) { value = error instanceof Error ? error : new Error(String(error)); }
      memo.set(days, value);
    }
    if (value instanceof Error) throw value;
    return value;
  };
}

/** How long a Copilot reading is served without asking GitHub again, and the failure backoff (doubling, capped). */
export const COPILOT_TTL_MS = 15 * 60_000;
const COPILOT_BACKOFF_MS = 30 * 60_000;
const COPILOT_BACKOFF_MAX_MS = 4 * 60 * 60_000;

interface CopilotState { fetchedAt: number; failures: number; nextAt: number; rows: Record<string, unknown> }

/** The last Copilot readings by login. Anything malformed or dated in the future is ignored, never trusted. */
function copilotState(deps: LocalCapacityDeps): CopilotState {
  const empty: CopilotState = { fetchedAt: 0, failures: 0, nextAt: 0, rows: {} };
  let raw: unknown;
  try { raw = deps.copilotCache?.read(); } catch { return empty; }
  if (!raw || typeof raw !== "object") return empty;
  const value = raw as Record<string, unknown>;
  const finite = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  const fetchedAt = finite(value.fetchedAt);
  const failures = finite(value.failures);
  const nextAt = finite(value.nextAt);
  if (fetchedAt === undefined || failures === undefined || nextAt === undefined) return empty;
  if (fetchedAt > deps.now || nextAt > deps.now + COPILOT_BACKOFF_MAX_MS) return empty;
  const rows: Record<string, unknown> = {};
  if (value.rows && typeof value.rows === "object") {
    for (const [login, row] of Object.entries(value.rows as Record<string, any>)) {
      const updated = Date.parse(row?.usage?.updatedAt);
      if (/^[A-Za-z0-9-]+$/.test(login) && row?.provider === "copilot" && Number.isFinite(updated) && updated <= deps.now) rows[login] = row;
    }
  }
  return { fetchedAt, failures, nextAt, rows };
}

/** One account's row, or undefined when GitHub did not answer with a usable body. */
async function copilotUser(deps: LocalCapacityDeps, gh: string, login: string, secret: string): Promise<unknown | undefined> {
  const response = await deps.run(gh, ["api", "/copilot_internal/user"], { GH_TOKEN: secret });
  if (response.code !== 0) return undefined;
  let user: any;
  try { user = JSON.parse(response.stdout); } catch { return undefined; }
  if (!user || typeof user !== "object") return undefined;
  const plan = text(user.copilot_plan) || "unknown";
  const label = `${text(user.login) || login} (${plan.toUpperCase()})`;
  const quota = user.quota_snapshots ?? {};
  const premium = quota.premium_interactions ?? {};
  const reset = text(user.quota_reset_date);
  return {
    provider: "copilot",
    account: label,
    usage: {
      accountEmail: label,
      accountOrganization: Array.isArray(user.organization_login_list) ? user.organization_login_list.map(text).filter(Boolean).join(", ") : "",
      loginMethod: plan,
      primary: null, secondary: null, tertiary: null,
      updatedAt: isoSeconds(deps.now),
    },
    copilot: {
      chatUnlimited: quota.chat?.unlimited === true,
      completionsUnlimited: quota.completions?.unlimited === true,
      premiumUnlimited: premium.unlimited === true,
      premiumCreditsUsed: number(premium.credits_used),
      overagePermitted: premium.overage_permitted === true,
      tokenBasedBilling: premium.token_based_billing === true,
      resetsAt: /^\d{4}-\d{2}-\d{2}$/.test(reset) ? `${reset}T00:00:00Z` : undefined,
      seatAssignedAt: text(user.assigned_date) || undefined,
    },
  };
}

/**
 * GitHub is asked at most once per COPILOT_TTL_MS for a machine, and after a failure (a rate limit included) not
 * again for 30 minutes, doubling to 4 hours. Between reads the last good rows are served with their original
 * `updatedAt`, so a card ages honestly instead of looking fresh.
 */
async function copilotRows(deps: LocalCapacityDeps): Promise<unknown[]> {
  const state = copilotState(deps);
  const cached = (): unknown[] => Object.values(state.rows);
  if (state.nextAt > deps.now) return cached();
  if (state.failures === 0 && state.fetchedAt > 0 && deps.now - state.fetchedAt < COPILOT_TTL_MS) return cached();
  const gh = deps.which("gh");
  if (!gh) return [];
  const save = (next: CopilotState): void => { try { deps.copilotCache?.write(next); } catch {} };
  const fail = (rows: Record<string, unknown>): unknown[] => {
    const failures = state.failures + 1;
    const wait = Math.min(COPILOT_BACKOFF_MS * 2 ** (failures - 1), COPILOT_BACKOFF_MAX_MS);
    save({ fetchedAt: state.fetchedAt, failures, nextAt: deps.now + wait, rows });
    return Object.values(rows);
  };
  try {
    const status = await deps.run(gh, ["auth", "status", "--json", "hosts"]);
    if (status.code !== 0) return fail(state.rows);
    let logins: string[] = [];
    try {
      const hosts = JSON.parse(status.stdout)?.hosts?.["github.com"];
      if (Array.isArray(hosts)) logins = hosts.map((host) => text(host?.login)).filter((login) => /^[A-Za-z0-9-]+$/.test(login));
    } catch { return fail(state.rows); }
    const fresh: Record<string, unknown> = {};
    let failed = false;
    for (const login of [...new Set(logins)]) {
      const token = await deps.run(gh, ["auth", "token", "--hostname", "github.com", "--user", login]);
      const secret = token.stdout.trim();
      // No usable token (signed out, expired, keychain locked): nothing can be read for this login. Treat it as a
      // failure so the last good row is kept and the next attempt backs off, rather than caching an empty answer.
      if (token.code !== 0 || !secret) { failed = true; continue; }
      const row = await copilotUser(deps, gh, login, secret);
      if (row) fresh[login] = row; else failed = true;
    }
    if (failed) {
      // Keep the last good row for an account GitHub did not answer for.
      const kept = Object.fromEntries(Object.entries(state.rows).filter(([login]) => logins.includes(login)));
      return fail({ ...kept, ...fresh });
    }
    save({ fetchedAt: deps.now, failures: 0, nextAt: 0, rows: fresh });
    return Object.values(fresh);
  } catch (error) {
    // A spawn failure also backs off; stale rows are served when there are any, otherwise the caller hears why.
    const stale = fail(state.rows);
    if (stale.length) return stale;
    throw error;
  }
}

function grokRows(deps: LocalCapacityDeps, window: (days: number) => WindowTotals): unknown[] {
  const email = readGrokAccountEmail(`${deps.home}/.grok`);
  if (!email) return [];
  const recent = window(RECENT_DAYS);
  const month = window(MONTH_DAYS);
  return [{
    provider: "grok",
    account: email,
    usage: { accountEmail: email, loginMethod: "xAI plan", primary: null, secondary: null, tertiary: null, updatedAt: isoSeconds(deps.now) },
    spend: {
      recentUsd: recent.grokUsd, recentTokens: recent.grokTokens, recentHours: 24,
      monthUsd: month.grokUsd, monthTokens: month.grokTokens, monthDays: MONTH_DAYS,
    },
  }];
}

function qwenRows(deps: LocalCapacityDeps, window: (days: number) => WindowTotals): unknown[] {
  const configured = [...QWEN_CONFIGS.map((path) => `${deps.home}/${path}`), ...(deps.qwenConfig ? [deps.qwenConfig] : [])]
    .some((path) => deps.exists(path));
  let recent: number | undefined;
  let month: number | undefined;
  try { recent = window(RECENT_DAYS).qwenTokens; } catch {}
  try { month = window(MONTH_DAYS).qwenTokens; } catch {}
  const observed = (recent ?? 0) > 0 || (month ?? 0) > 0;
  if (!configured && !observed) return [];
  const measured = recent !== undefined && month !== undefined;
  const detail = !measured ? "Self-hosted Qwen usage report unavailable on this machine."
    : observed ? "Self-hosted Qwen usage recorded on this machine." : "Self-hosted Qwen configured on this machine.";
  return [{
    provider: "qwen",
    account: "Local Qwen",
    usage: { accountEmail: "Local Qwen", loginMethod: "self-hosted", updatedAt: isoSeconds(deps.now) },
    local: { unlimited: true, model: LOCAL_QWEN_MODEL, detail },
    // Self-hosted tokens carry no money.
    ...(measured ? { spend: { recentUsd: 0, recentTokens: recent, recentHours: 24, monthUsd: 0, monthTokens: month, monthDays: MONTH_DAYS } } : {}),
  }];
}

/**
 * Capacity rows for the requested providers. One provider failing never hides the others; the caller learns
 * why through `onFailure`, so an empty result can be told from a failed read.
 */
export async function collectLocalCapacity(
  providers: readonly LocalProvider[] = LOCAL_PROVIDERS,
  deps: LocalCapacityDeps = defaultLocalCapacityDeps(),
  onFailure?: (provider: LocalProvider, message: string) => void,
): Promise<unknown[]> {
  const window = windowLoader(deps);
  const rows: unknown[] = [];
  for (const provider of providers) {
    try {
      if (provider === "copilot") rows.push(...await copilotRows(deps));
      else if (provider === "grok") rows.push(...grokRows(deps, window));
      else rows.push(...qwenRows(deps, window));
    } catch (error) {
      onFailure?.(provider, error instanceof Error ? error.message : String(error));
    }
  }
  return rows;
}

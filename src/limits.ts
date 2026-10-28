import { readFileSync } from "node:fs";
import { BRAND_HEAD_HTML } from "./branding";
import { THEME_HEAD_HTML, THEME_CSS, THEME_CONTROL_HTML } from "./theme";
import type { CapacityAuthenticationRequirement, CapacitySourceHealth } from "./capacity-dashboard";
import { predictWindow } from "./capacity-prediction";
import { windowFreshness, type WindowFreshness } from "./capacity-freshness";
import type { BurnForecast } from "./capacity-burn";
import { buildUtilizationPlans, type AccountUtilizationPlan } from "./capacity-planner";
import { renderCapacityPlan } from "./capacity-card-plan";
import { CAPACITY_CARD_CSS } from "./capacity-card-styles";
import { copilotBudgetStatus, copilotCreditWindow, formatCopilotMoney } from "./copilot-budget";
import { compactDuration } from "./duration";
import { normalizeLocalQwenCapacity } from "./local-capacity";
import type { CapacityCloudCredits, CapacityExtraUsage } from "./capacity-current";
import type {
  OpenRouterCapacity,
  OpenRouterHistory,
  OpenRouterUsageTotals,
} from "./openrouter-types";

export { predictWindow } from "./capacity-prediction";

export interface LimitWindow {
  usedPercent: number;
  resetsAt?: string;
  windowMinutes: number;
  prediction?: CapacityPrediction;
  burn?: BurnForecast;
}

export interface CapacityPrediction {
  deltaPercent: number;
  expectedUsedPercent: number;
  willLastToReset: boolean;
  runsOutAt?: string;
  source: "reported" | "linear";
}

export type CapacityProvider = "codex" | "claude" | "copilot" | "openrouter" | "lokai" | "grok" | "qwen";

// Cards render in this order, so a provider without an allowance sits after
// the metered ones instead of interleaving by name.
const PROVIDER_ORDER: CapacityProvider[] = ["claude", "codex", "copilot", "openrouter", "lokai", "qwen", "grok"];

export interface CopilotCapacity {
  chatUnlimited: boolean;
  completionsUnlimited: boolean;
  premiumUnlimited: boolean;
  premiumCreditsUsed: number;
  overagePermitted: boolean;
  tokenBasedBilling: boolean;
  resetsAt?: string;
  seatAssignedAt?: string;
}

export interface CloudRouteCapacity {
  ready: boolean;
  detail: string;
  available?: boolean;
  balances: ApiCreditBalance[];
}

export interface LocalQwenCapacity {
  /** Qwen has no subscription allowance or provider token fee. */
  unlimited: true;
  model: string;
  /**
   * Readiness is only asserted when every caller reported it. Missing means
   * unknown, not ready.
   */
  ready?: boolean;
  detail?: string;
  /** Machines whose latest local snapshot included measured client tokens. */
  measuredDevices: string[];
  /** Machines whose latest local snapshot could not read client tokens. */
  unmeasuredDevices: string[];
}

export interface ApiCreditBalance {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface CodexLimitAccount {
  provider: CapacityProvider;
  name?: string;
  email: string;
  plan: string;
  organization?: string;
  /** Official Codex quota pool, retained for accurate cross-machine attribution. */
  quotaPool?: string;
  updatedAt?: string;
  session?: LimitWindow;
  weekly?: LimitWindow;
  copilot?: CopilotCapacity;
  route?: CloudRouteCapacity;
  /** Purchased credits that cover usage past the included window. */
  credits?: { balance: string; unlimited: boolean };
  /** Promotional cloud credits reported by a provider in dollars. */
  cloudCredits?: CapacityCloudCredits;
  /** Metered pay-as-you-go usage beyond the plan. */
  extraUsage?: CapacityExtraUsage;
  /** Account balance and retained completed-day usage for OpenRouter. */
  openrouter?: OpenRouterCapacity;
  /** Spend for a plan-covered agent with no quota to report. */
  spend?: AgentSpendSummary;
  /** Self-hosted local capacity, distinct from subscription quotas and API balances. */
  local?: LocalQwenCapacity;
  devices: string[];
  sessionEquivalent?: SessionEquivalentForecast;
}

/**
 * Spend for a plan-covered agent that publishes no quota. The figures are
 * API-equivalent estimates, not billed money: the subscription covers the
 * usage, so there is no allowance to pace and no balance to draw down.
 */
export interface AgentSpendSummary {
  recentUsd: number;
  recentTokens: number;
  /** Rolling, not calendar: the report window is now minus this many hours. */
  recentHours: number;
  monthUsd: number;
  monthTokens: number;
  monthDays: number;
}

export interface SessionEquivalentForecast {
  estimatedQuotasLeft: number;
  sampleCount: number;
  medianWeeklyBurn: number;
  windowsUntilReset?: number;
}

interface RawWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowMinutes?: unknown;
}

interface RawCodexUsage {
  accountEmail?: unknown;
  accountOrganization?: unknown;
  loginMethod?: unknown;
  quotaPool?: unknown;
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  tertiary?: RawWindow | null;
  credits?: { balance?: unknown; unlimited?: unknown } | null;
  cloudCredits?: { limitUsd?: unknown; remainingUsd?: unknown; expiresAt?: unknown; locked?: unknown } | null;
  extraUsage?: { usedAmount?: unknown; limitAmount?: unknown; currency?: unknown } | null;
  updatedAt?: unknown;
}

interface RawPaceWindow {
  deltaPercent?: unknown;
  expectedUsedPercent?: unknown;
  etaSeconds?: unknown;
  willLastToReset?: unknown;
}

interface RawProviderPace {
  primary?: RawPaceWindow | null;
  secondary?: RawPaceWindow | null;
  tertiary?: RawPaceWindow | null;
}

interface RawCodexResult {
  account?: unknown;
  provider?: unknown;
  usage?: RawCodexUsage;
  copilot?: Partial<CopilotCapacity>;
  route?: {
    ready?: unknown;
    detail?: unknown;
    available?: unknown;
    balances?: unknown;
  };
  spend?: {
    recentUsd?: unknown;
    recentTokens?: unknown;
    recentHours?: unknown;
    monthUsd?: unknown;
    monthTokens?: unknown;
    monthDays?: unknown;
  };
  openrouter?: unknown;
  pace?: RawProviderPace | null;
  devices?: unknown;
  sourceDevice?: unknown;
}

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeWindow(value: RawWindow | null | undefined): LimitWindow | undefined {
  if (!value) return undefined;
  const usedPercent = finiteNumber(value.usedPercent);
  const windowMinutes = finiteNumber(value.windowMinutes);
  if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : undefined,
  };
}

function normalizePrediction(value: RawPaceWindow | null | undefined, updatedAt?: string): CapacityPrediction | undefined {
  if (!value) return undefined;
  const deltaPercent = finiteNumber(value.deltaPercent);
  const expectedUsedPercent = finiteNumber(value.expectedUsedPercent);
  if (deltaPercent === undefined || expectedUsedPercent === undefined || typeof value.willLastToReset !== "boolean") {
    return undefined;
  }
  const etaSeconds = finiteNumber(value.etaSeconds);
  const sampledAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const runsOutAt = !value.willLastToReset && etaSeconds !== undefined && etaSeconds >= 0 && Number.isFinite(sampledAt)
    ? new Date(sampledAt + etaSeconds * 1000).toISOString()
    : undefined;
  return {
    deltaPercent,
    expectedUsedPercent: Math.min(100, Math.max(0, expectedUsedPercent)),
    willLastToReset: value.willLastToReset,
    runsOutAt,
    source: "reported",
  };
}

function sourceDevices(result: RawCodexResult): string[] {
  const listed = Array.isArray(result.devices) ? result.devices : [];
  return [...new Set([
    ...listed.filter((device): device is string => typeof device === "string"),
    ...(typeof result.sourceDevice === "string" ? [result.sourceDevice] : []),
  ].map((device) => device.trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeBalances(value: unknown): ApiCreditBalance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ApiCreditBalance[] => {
    if (!entry || typeof entry !== "object") return [];
    const balance = entry as Record<string, unknown>;
    const currency = typeof balance.currency === "string" ? balance.currency.trim().toUpperCase() : "";
    const total = finiteNumber(balance.total);
    if (!/^[A-Z]{3}$/.test(currency) || total === undefined) return [];
    return [{
      currency,
      total,
      granted: Math.max(0, finiteNumber(balance.granted) ?? 0),
      toppedUp: finiteNumber(balance.toppedUp) ?? 0,
    }];
  });
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Unknown";
}

function normalizeQuotaPool(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:legacy|codex(?:_[a-z0-9-]+)?)$/u.test(value)
    ? value
    : undefined;
}

// A collector may merge a cache from another build, so every credit block is
// re-validated here even when the snapshot path already checked it. Invalid
// blocks are dropped; quota windows stay.
function moneyAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeCloudCredits(value: unknown): CapacityCloudCredits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as NonNullable<RawCodexUsage["cloudCredits"]>;
  const limitUsd = moneyAmount(raw.limitUsd);
  const remainingUsd = moneyAmount(raw.remainingUsd);
  if (limitUsd === undefined || limitUsd <= 0 || remainingUsd === undefined || remainingUsd > limitUsd) return undefined;
  const expiresAt = typeof raw.expiresAt === "string" && Number.isFinite(Date.parse(raw.expiresAt))
    ? raw.expiresAt
    : undefined;
  return {
    limitUsd,
    remainingUsd,
    ...(expiresAt ? { expiresAt } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  };
}

function normalizeExtraUsage(value: unknown): CapacityExtraUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as NonNullable<RawCodexUsage["extraUsage"]>;
  const usedAmount = moneyAmount(raw.usedAmount);
  const limitAmount = moneyAmount(raw.limitAmount);
  const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  if (usedAmount === undefined || limitAmount === undefined || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { usedAmount, limitAmount, currency };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const year = new Date(parsed).getUTCFullYear();
  return year >= 2000 && year <= 2100 ? value : undefined;
}

function normalizeUsageTotals(value: unknown): OpenRouterUsageTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const costUsd = nonNegativeNumber(raw.costUsd);
  const requests = nonNegativeNumber(raw.requests);
  const promptTokens = nonNegativeNumber(raw.promptTokens);
  const completionTokens = nonNegativeNumber(raw.completionTokens);
  const reasoningTokens = nonNegativeNumber(raw.reasoningTokens);
  const cachedTokens = nonNegativeNumber(raw.cachedTokens);
  if ([costUsd, requests, promptTokens, completionTokens, reasoningTokens, cachedTokens]
    .some((item) => item === undefined)) return undefined;
  return { costUsd, requests, promptTokens, completionTokens, reasoningTokens, cachedTokens } as OpenRouterUsageTotals;
}

function normalizeOpenRouterHistory(value: unknown): OpenRouterHistory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const updatedAt = validIso(raw.updatedAt);
  const availableFrom = validIso(raw.availableFrom);
  const availableThrough = validIso(raw.availableThrough);
  const retainedFrom = raw.retainedFrom === undefined ? undefined : validIso(raw.retainedFrom);
  const totals = normalizeUsageTotals(raw.totals);
  if (!updatedAt || !availableFrom || !availableThrough || !totals
    || Date.parse(availableFrom) > Date.parse(availableThrough)
    || (raw.retainedFrom !== undefined && !retainedFrom)) return undefined;

  const normalizeDated = (items: unknown, key: "date" | "month") => {
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const label = typeof entry[key] === "string" ? entry[key] : "";
      const values = normalizeUsageTotals(entry);
      const pattern = key === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
      if (!pattern.test(label) || !values) return [];
      const parsed = Date.parse(key === "date" ? `${label}T00:00:00Z` : `${label}-01T00:00:00Z`);
      return Number.isFinite(parsed) ? [{ [key]: label, ...values }] : [];
    });
  };
  const models = Array.isArray(raw.models) ? raw.models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const values = normalizeUsageTotals(entry);
    return model && values ? [{ model, ...values }] : [];
  }) : [];
  return {
    updatedAt,
    availableFrom,
    availableThrough,
    ...(retainedFrom ? { retainedFrom } : {}),
    totals,
    days: normalizeDated(raw.days, "date") as OpenRouterHistory["days"],
    months: normalizeDated(raw.months, "month") as OpenRouterHistory["months"],
    models: models as OpenRouterHistory["models"],
    machineAttribution: "unattributed",
  };
}

function normalizeOpenRouter(value: unknown): OpenRouterCapacity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const balanceUsd = nonNegativeNumber(raw.balanceUsd);
  const totalCreditsUsd = nonNegativeNumber(raw.totalCreditsUsd);
  const totalUsageUsd = nonNegativeNumber(raw.totalUsageUsd);
  if (balanceUsd === undefined || totalCreditsUsd === undefined || totalUsageUsd === undefined) return undefined;
  let keyUsage: OpenRouterCapacity["keyUsage"];
  if (raw.keyUsage && typeof raw.keyUsage === "object") {
    const key = raw.keyUsage as Record<string, unknown>;
    const label = typeof key.label === "string" ? key.label.trim() : "";
    const dailyUsd = nonNegativeNumber(key.dailyUsd);
    const weeklyUsd = nonNegativeNumber(key.weeklyUsd);
    const monthlyUsd = nonNegativeNumber(key.monthlyUsd);
    const allTimeUsd = nonNegativeNumber(key.allTimeUsd);
    if (label && [dailyUsd, weeklyUsd, monthlyUsd, allTimeUsd].every((item) => item !== undefined)) {
      const limitUsd = key.limitUsd === undefined ? undefined : nonNegativeNumber(key.limitUsd);
      const remainingUsd = key.remainingUsd === undefined ? undefined : nonNegativeNumber(key.remainingUsd);
      const byokUsd = key.byokUsd === undefined ? undefined : nonNegativeNumber(key.byokUsd);
      const reset = key.reset === undefined ? undefined : validIso(key.reset);
      const expiresAt = key.expiresAt === undefined ? undefined : validIso(key.expiresAt);
      if ((key.limitUsd === undefined || limitUsd !== undefined)
        && (key.remainingUsd === undefined || remainingUsd !== undefined)
        && (key.byokUsd === undefined || byokUsd !== undefined)
        && (key.reset === undefined || reset !== undefined)
        && (key.expiresAt === undefined || expiresAt !== undefined)
        && !(limitUsd !== undefined && remainingUsd !== undefined && remainingUsd > limitUsd)) {
        keyUsage = {
          label, dailyUsd, weeklyUsd, monthlyUsd, allTimeUsd,
          ...(limitUsd !== undefined ? { limitUsd } : {}),
          ...(remainingUsd !== undefined ? { remainingUsd } : {}),
          ...(reset ? { reset } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          ...(byokUsd !== undefined ? { byokUsd } : {}),
        };
      }
    }
  }
  const history = normalizeOpenRouterHistory(raw.history);
  return {
    balanceUsd,
    totalCreditsUsd,
    totalUsageUsd,
    ...(keyUsage ? { keyUsage } : {}),
    ...(history ? { history } : {}),
  };
}

// Shared by both renderers: a credit block earns a line only when the provider
// actually reported a positive amount. Visibility rules match across HTML and
// text so neither surface can show a credit the other hides. The text surface
// ignores the title; the HTML surface surfaces it as hover text.
interface CreditLine {
  text: string;
  title: string;
}

function creditLines(account: CodexLimitAccount, nowMs: number, capitalizeUnlimited = true): CreditLine[] {
  const lines: CreditLine[] = [];
  if (account.credits) {
    lines.push({
      text: account.credits.unlimited
        ? `${capitalizeUnlimited ? "Unlimited" : "unlimited"} credits`
        : `${formatCredits(account.credits.balance)} credits`,
      title: "Purchased credits, used once the included window runs out",
    });
  }
  const cloud = account.cloudCredits;
  if (cloud && cloud.locked !== true && cloud.remainingUsd > 0 &&
      (cloud.expiresAt === undefined || Date.parse(cloud.expiresAt) > nowMs)) {
    const expiresAt = cloud.expiresAt === undefined ? undefined : Date.parse(cloud.expiresAt);
    if (expiresAt === undefined || Number.isFinite(expiresAt)) {
      const shown = Math.min(cloud.remainingUsd, cloud.limitUsd);
      const isoDate = expiresAt === undefined ? undefined : new Date(expiresAt).toISOString().slice(0, 10);
      lines.push({
        text: `${formatMoney(shown, "USD")} cloud credits`,
        title: `Promotional cloud credits${isoDate ? `, expires ${isoDate}` : ""}`,
      });
    }
  }
  const extra = account.extraUsage;
  if (extra && (extra.limitAmount > 0 || extra.usedAmount > 0)) {
    lines.push({
      text: `${formatMoney(extra.usedAmount, extra.currency)} / ${formatMoney(extra.limitAmount, extra.currency)} extra usage`,
      title: "Paid extra usage this month, used after the plan limits",
    });
  }
  return lines;
}

export function normalizeCodexLimits(input: unknown): CodexLimitAccount[] {
  const items = Array.isArray(input) ? input : [input];
  const accounts = new Map<string, CodexLimitAccount>();
  const localQwen = normalizeLocalQwenCapacity(items);
  if (localQwen) accounts.set("qwen:local qwen", localQwen);

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const result = item as RawCodexResult;
    const provider = result.provider;
    if (provider !== "codex" && provider !== "claude" && provider !== "copilot" && provider !== "lokai"
      && provider !== "openrouter" && provider !== "grok") continue;
    const usage = result.usage;
    if (!usage || typeof usage !== "object") continue;
    // A free Codex plan carries no capacity worth planning against. Filtering at
    // render time as well as at collection keeps stale free accounts out of the
    // dashboard: a collector merge carries every account it has ever seen
    // forward, so an account that was dropped upstream would otherwise linger.
    if (provider === "codex" && usage.loginMethod === "free" && process.env.SPENDWATCH_INCLUDE_FREE !== "1") continue;
    const emailValue = usage.accountEmail ?? result.account;
    if (typeof emailValue !== "string" || !emailValue.trim()) continue;

    const updatedAt = typeof usage.updatedAt === "string" ? usage.updatedAt : undefined;
    const slots = [
      { window: normalizeWindow(usage.primary), pace: normalizePrediction(result.pace?.primary, updatedAt) },
      { window: normalizeWindow(usage.secondary), pace: normalizePrediction(result.pace?.secondary, updatedAt) },
      { window: normalizeWindow(usage.tertiary), pace: normalizePrediction(result.pace?.tertiary, updatedAt) },
    ].filter((slot): slot is { window: LimitWindow; pace: CapacityPrediction | undefined } => Boolean(slot.window));
    for (const slot of slots) slot.window.prediction = slot.pace;
    const session = slots
      .map((slot) => slot.window)
      .filter((window) => window.windowMinutes < 7 * 24 * 60)
      .sort((a, b) => a.windowMinutes - b.windowMinutes)[0];
    const weekly = slots
      .map((slot) => slot.window)
      .filter((window) => window.windowMinutes >= 7 * 24 * 60)
      .sort((a, b) => b.windowMinutes - a.windowMinutes)[0];

    const account: CodexLimitAccount = {
      provider,
      name: providerLabel(provider),
      email: emailValue.trim(),
      plan: titleCase(typeof usage.loginMethod === "string" ? usage.loginMethod : "unknown"),
      organization: typeof usage.accountOrganization === "string" ? usage.accountOrganization : undefined,
      quotaPool: provider === "codex" ? normalizeQuotaPool(usage.quotaPool) : undefined,
      updatedAt,
      session,
      weekly,
      devices: sourceDevices(result),
    };
    const rawCredits = usage.credits;
    if (rawCredits) {
      const unlimited = rawCredits.unlimited === true;
      const balance = typeof rawCredits.balance === "string"
        ? rawCredits.balance
        : Number.isFinite(Number(rawCredits.balance))
          ? String(rawCredits.balance)
          : undefined;
      if (unlimited) account.credits = { balance: balance ?? "0", unlimited: true };
      else if (balance !== undefined && Number(balance) > 0) account.credits = { balance, unlimited: false };
    }
    const cloudCredits = normalizeCloudCredits(usage.cloudCredits);
    if (cloudCredits) account.cloudCredits = cloudCredits;
    const extraUsage = normalizeExtraUsage(usage.extraUsage);
    if (extraUsage) account.extraUsage = extraUsage;
    if (provider === "openrouter") {
      const openrouter = normalizeOpenRouter(result.openrouter);
      if (!openrouter) continue;
      account.openrouter = openrouter;
      account.plan = "Pay as you go";
    }
    if (provider === "copilot" && result.copilot) {
      account.copilot = {
        chatUnlimited: Boolean(result.copilot.chatUnlimited),
        completionsUnlimited: Boolean(result.copilot.completionsUnlimited),
        premiumUnlimited: Boolean(result.copilot.premiumUnlimited),
        premiumCreditsUsed: finiteNumber(result.copilot.premiumCreditsUsed) ?? 0,
        overagePermitted: typeof result.copilot.overagePermitted === "boolean"
          ? result.copilot.overagePermitted
          : Boolean(result.copilot.premiumUnlimited),
        tokenBasedBilling: Boolean(result.copilot.tokenBasedBilling),
        resetsAt: typeof result.copilot.resetsAt === "string" ? result.copilot.resetsAt : undefined,
        seatAssignedAt: typeof result.copilot.seatAssignedAt === "string" ? result.copilot.seatAssignedAt : undefined,
      };
    }
    if (provider === "grok" && result.spend) {
      const spend = result.spend;
      account.spend = {
        recentUsd: finiteNumber(spend.recentUsd) ?? 0,
        recentTokens: finiteNumber(spend.recentTokens) ?? 0,
        recentHours: finiteNumber(spend.recentHours) ?? 24,
        monthUsd: finiteNumber(spend.monthUsd) ?? 0,
        monthTokens: finiteNumber(spend.monthTokens) ?? 0,
        monthDays: finiteNumber(spend.monthDays) ?? 30,
      };
    }
    if (provider === "lokai" && result.route) {
      account.route = {
        ready: Boolean(result.route.ready),
        detail: typeof result.route.detail === "string" && result.route.detail.trim()
          ? result.route.detail.trim()
          : "Cloud API route",
        available: typeof result.route.available === "boolean" ? result.route.available : undefined,
        balances: normalizeBalances(result.route.balances),
      };
    }
    const key = `${provider}:${account.email.toLowerCase()}`;
    const current = accounts.get(key);
    const incomingTime = account.updatedAt ? Date.parse(account.updatedAt) : 0;
    const currentTime = current?.updatedAt ? Date.parse(current.updatedAt) : 0;
    const devices = [...new Set([...(current?.devices ?? []), ...account.devices])].sort();
    if (!current || incomingTime >= currentTime) {
      account.devices = devices;
      accounts.set(key, account);
    } else {
      current.devices = devices;
    }
  }

  const normalized = [...accounts.values()];
  for (const provider of ["codex", "claude", "copilot", "openrouter", "grok"] as const) {
    const group = normalized
      .filter((account) => account.provider === provider)
      .sort((a, b) => a.email.localeCompare(b.email));
    for (const [index, account] of group.entries()) {
      const suffix = group.length === 1 ? "" : index === 0 ? " Primary" : index === 1 ? " Secondary" : ` ${index + 1}`;
      account.name = `${providerLabel(provider)}${suffix}`;
    }
  }
  for (const account of normalized) {
    if (account.provider === "lokai") account.name = account.email;
  }
  return normalized.sort((a, b) =>
    PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider)
    || (a.name ?? a.email).localeCompare(b.name ?? b.email)
    || a.email.localeCompare(b.email));
}

export function loadCodexLimits(paths: string[]): CodexLimitAccount[] {
  const combined: unknown[] = [];
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) combined.push(...parsed);
    else combined.push(parsed);
  }
  const accounts = normalizeCodexLimits(combined);
  if (!accounts.length) throw new Error("no valid Codex limit accounts in input");
  return accounts;
}

function leftPercent(window?: LimitWindow): number | undefined {
  return window ? Math.round(100 - window.usedPercent) : undefined;
}

function providerLabel(provider: CapacityProvider): string {
  return ({ codex: "Codex", claude: "Claude", copilot: "Copilot", openrouter: "OpenRouter", lokai: "Lokai", grok: "Grok", qwen: "Qwen" })[provider];
}

function providerAccent(provider: CapacityProvider): string {
  return ({ codex: "#68d5dc", claude: "#e69a73", copilot: "#8ea9ff", openrouter: "#f5a623", lokai: "#b8d96b", grok: "#c58af9", qwen: "#e6bf66" })[provider];
}

function formatBalance(balance: ApiCreditBalance): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: balance.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(balance.total);
  } catch {
    return `${balance.total.toFixed(2)} ${balance.currency}`;
  }
}

function routeBalanceBlock(route: CloudRouteCapacity): string {
  const total = route.balances.map(formatBalance).join(" + ");
  const value = total ? `${total} left` : route.ready ? "Balance unavailable" : "Route offline";
  const tone = route.available === false || !route.ready ? "danger" : "good";
  return `<section class="limit balance ${tone}">
    <div class="limit-head"><span>API balance</span><strong>${esc(value)}</strong></div>
    <div class="limit-meta"><span>${esc(route.detail)}</span></div>
  </section>`;
}

function paceLabel(window: LimitWindow, nowMs: number): string | undefined {
  const prediction = predictWindow(window, nowMs);
  if (!prediction) return undefined;
  const roundedDelta = Math.round(Math.abs(prediction.deltaPercent));
  return roundedDelta <= 2
    ? "On pace"
    : prediction.deltaPercent > 0
      ? `${roundedDelta}% over pace`
      : `${roundedDelta}% under pace`;
}

// One run-out verdict per window. The recent burn rate is the more current
// signal, so it wins when it has a reading; otherwise the cycle-average pace
// supplies the forecast. The client hydrates data-exhaust into "Runs out in …".
function runOutForecast(window: LimitWindow, nowMs: number): string | undefined {
  if (window.usedPercent >= 100) return `<strong title="This window is used up">Ran out</strong>`;
  const burn = window.burn;
  if (burn) {
    const basis = `From the last ${burn.lookbackMinutes} minutes of use`;
    if (burn.ratePerHour <= 0 || burn.lastsToReset) return `<strong title="${esc(basis)}">Lasts until reset</strong>`;
    if (burn.runsOutAt) {
      return `<strong title="${esc(basis)}"><span class="exhaust" data-exhaust="${esc(burn.runsOutAt)}">Run-out forecast loading</span></strong>`;
    }
  }
  const prediction = predictWindow(window, nowMs);
  if (!prediction) return undefined;
  const basis = "From the average pace this cycle";
  if (prediction.willLastToReset) return `<strong title="${esc(basis)}">Lasts until reset</strong>`;
  if (prediction.runsOutAt) {
    return `<strong title="${esc(basis)}"><span class="exhaust" data-exhaust="${esc(prediction.runsOutAt)}">Run-out forecast loading</span></strong>`;
  }
  return undefined;
}

export function formatBurnRate(ratePerHour: number): string {
  const rounded = ratePerHour >= 10 ? Math.round(ratePerHour) : Math.round(ratePerHour * 10) / 10;
  // A slow but non-zero rate reading "0%/h" would look like nothing is moving.
  if (rounded === 0 && ratePerHour > 0) return "<0.1%/h";
  return `${rounded}%/h`;
}

function paceMarker(window: LimitWindow, nowMs: number, orientation: "remaining" | "used" = "remaining"): string {
  const prediction = predictWindow(window, nowMs);
  if (!prediction) return "";
  const expectedLeft = Math.min(100, Math.max(0, 100 - prediction.expectedUsedPercent));
  const expected = orientation === "used" ? 100 - expectedLeft : expectedLeft;
  const roundedDelta = Math.round(Math.abs(prediction.deltaPercent));
  const onPace = roundedDelta <= 2;
  const tone = onPace ? "steady" : prediction.deltaPercent > 0 ? "deficit" : "reserve";
  const trend = prediction.deltaPercent > 0 ? "over" : "under";
  const label = onPace
    ? `Expected pace: ${Math.round(expected)}% ${orientation === "used" ? "used" : "left"}, on pace`
    : `Expected pace: ${Math.round(expected)}% ${orientation === "used" ? "used" : "left"}, ${roundedDelta}% ${trend}`;
  return `<span class="pace-marker ${tone}" style="--pace-position:${expected}%" role="img" aria-label="${esc(label)}" title="${esc(label)}"><b></b><b></b><b></b></span>`;
}

// Money lines render at cents precision: a credit figure is exact provider
// data, so 0 shows as "$0.00" rather than the abbreviated "$0".
function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // The shape was validated, but Intl only renders currencies it knows.
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatUsd(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(value);
}

function formatCredits(balance: string): string {
  const value = Number(balance);
  if (!Number.isFinite(value)) return balance;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function copilotLimits(account: CodexLimitAccount, nowMs: number): string {
  const capacity = account.copilot!;
  const status = copilotBudgetStatus(account);
  const budget = status.budget;
  const window = copilotCreditWindow(account, nowMs, budget);
  const left = Math.max(0, Math.round(100 - (window?.usedPercent ?? 0)));
  const tone = status.over || left <= 15 ? "danger" : left <= 35 ? "warn" : "good";
  const marker = window && !status.over ? paceMarker(window, nowMs) : "";
  const reset = window
    ? `<span class="reset" data-reset="${esc(window.resetsAt!)}">Reset time loading</span>`
    : "<span>Monthly reset</span>";
  const billing = capacity.tokenBasedBilling ? "Token-based billing" : "AI credit billing";
  const overflow = capacity.overagePermitted ? "Paid overflow on" : "Overflow off at GitHub";
  const standing = status.over
    ? `Over budget by ${status.creditsOver.toLocaleString()} credits`
    : `${left}% of budget left`;
  const money = status.over
    ? `${esc(formatCopilotMoney(status.usdOver, budget))} over the ${esc(formatCopilotMoney(budget.usd, budget))} ceiling`
    : `${esc(overflow)}`;
  return `<section class="limit copilot-usage ${tone}">
    <div class="limit-head"><span>AI credits used</span><strong>${status.creditsUsed.toLocaleString()} / ${budget.credits.toLocaleString()}</strong></div>
    <div class="track" role="progressbar" aria-label="${status.over ? "Monthly AI credit budget spent" : "Monthly AI credit budget remaining"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${status.over ? 100 : left}"><i style="width:${status.over ? 100 : left}%"></i>${marker}</div>
    <div class="limit-meta split"><span>${esc(standing)}</span>${reset}</div>
    ${window && !status.over && paceLabel(window, nowMs) ? `<div class="pace"><span>${esc(paceLabel(window, nowMs)!)}</span></div>` : ""}
  </section><section class="limit copilot-pool ${tone}">
    <div class="limit-head"><span>Monthly budget</span><strong>${esc(formatCopilotMoney(status.usdSpent, budget))} / ${esc(formatCopilotMoney(budget.usd, budget))}</strong></div>
    <div class="limit-meta split"><span>${money}</span><span>${esc(formatCopilotMoney(budget.creditUsd, budget, 4))} per credit</span></div>
    ${budget.currency === "EUR" ? `<div class="limit-meta" title="ECB reference conversion; credit value excludes subscription fees and taxes"><span>EUR estimate · FX ${esc(budget.rateDate ?? "date unavailable")}</span></div>` : ""}
    <div class="pace"><span>${status.over ? "Ceiling passed, spending allowed" : "Manual ceiling"}</span><strong>${esc(billing)}</strong></div>
  </section>`;
}

function formatTokens(total: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(total);
}

function spendLimits(account: CodexLimitAccount): string {
  const spend = account.spend!;
  const block = (label: string, usd: number, tokens: number, meta: string) => `<section class="limit spend good">
    <div class="limit-head"><span>${esc(label)}</span><strong>${esc(formatUsd(usd))}</strong></div>
    <div class="limit-meta split"><span>${esc(formatTokens(tokens))} tokens</span><span>${esc(meta)}</span></div>
  </section>`;
  const days = Math.round(spend.monthDays);
  const hours = Math.round(spend.recentHours);
  return [
    block(`Sent · last ${hours}h`, spend.recentUsd, spend.recentTokens, "API-equivalent"),
    block(`Sent · last ${days} days`, spend.monthUsd, spend.monthTokens, "Plan covers it"),
  ].join("");
}

function localQwenLimits(account: CodexLimitAccount): string {
  const tokens = (label: string, count: number) => `<section class="limit local-usage good">
    <div class="limit-head"><span>${esc(label)}</span><strong>${esc(formatTokens(count))} tokens</strong></div>
  </section>`;
  return `<section class="limit local-unlimited good">
    <div class="limit-head"><span>Capacity</span><strong>Unlimited</strong></div>
  </section>${account.spend
    ? `${tokens(`Measured · ${Math.round(account.spend.recentHours)}h`, account.spend.recentTokens)}
  ${tokens(`Measured · ${Math.round(account.spend.monthDays)}d`, account.spend.monthTokens)}`
    : `<section class="limit local-usage unreadable"><div class="limit-head"><span>Measured usage</span><strong>Unavailable</strong></div></section>`}`;
}

function openRouterHistoryBlock(history: OpenRouterHistory): string {
  const latestDays = [...history.days]
    .sort((a, b) => b.date.localeCompare(a.date));
  const days = latestDays.map((day) => `<div class="or-row"><span>${esc(day.date)}</span><strong>${esc(formatUsd(day.costUsd, 4))}</strong><span>${esc(formatTokens(day.requests))} calls</span></div>`).join("");
  const months = history.months.length
    ? `<div class="or-models"><span>Retained months</span>${history.months.map((month) => `<div class="or-row"><span>${esc(month.month)}</span><strong>${esc(formatUsd(month.costUsd, 4))}</strong><span>${esc(formatTokens(month.requests))} calls</span></div>`).join("")}</div>`
    : "";
  const models = [...history.models]
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((model) => `<div class="or-row"><span title="${esc(model.model)}">${esc(model.model)}</span><strong>${esc(formatUsd(model.costUsd, 4))}</strong><span>${esc(formatTokens(model.requests))} calls</span></div>`)
    .join("");
  const retained = history.retainedFrom
    ? `Retained from ${esc(history.retainedFrom.slice(0, 10))}`
    : `API window from ${esc(history.availableFrom.slice(0, 10))}`;
  return `<details class="openrouter-history"><summary><span>Completed-day history</span><strong>${esc(formatUsd(history.totals.costUsd, 4))}</strong></summary>
    <div class="or-coverage"><span>${retained} · through ${esc(history.availableThrough.slice(0, 10))}</span><span>Unattributed across machines</span></div>
    <div class="or-coverage"><span>${esc(formatTokens(history.totals.requests))} calls · ${esc(formatTokens(history.totals.promptTokens + history.totals.completionTokens))} tokens</span><span>Account-wide</span></div>
    <div class="or-days">${days || '<div class="or-empty">No completed-day rows retained</div>'}</div>
    ${months}
    ${models ? `<div class="or-models"><span>Models</span>${models}</div>` : ""}
  </details>`;
}

function openRouterLimits(account: CodexLimitAccount): string {
  const capacity = account.openrouter!;
  const balanceTone = capacity.balanceUsd <= 0 ? "danger" : capacity.balanceUsd < 5 ? "warn" : "good";
  const key = capacity.keyUsage;
  const cap = key?.limitUsd === undefined
    ? "No key spending cap"
    : `${formatUsd(key.remainingUsd ?? Math.max(0, key.limitUsd - key.allTimeUsd), 4)} of ${formatUsd(key.limitUsd, 4)} left`;
  const expiry = key?.expiresAt
    ? `<span>Key expires ${esc(key.expiresAt.slice(0, 10))}</span>`
    : "<span>Shared inference key</span>";
  const devices = account.devices.length
    ? `<span>Collected on ${esc(account.devices.join(", "))}</span>`
    : "<span>Machine attribution unavailable</span>";
  return `<section class="limit openrouter-balance ${balanceTone}">
    <div class="limit-head"><span>Prepaid balance</span><strong>${esc(formatUsd(capacity.balanceUsd, 4))}</strong></div>
    <div class="limit-meta split"><span>${esc(formatUsd(capacity.totalCreditsUsd))} purchased</span><span>${esc(formatUsd(capacity.totalUsageUsd, 4))} account billed</span></div>
  </section>${key ? `<section class="limit openrouter-key good">
    <div class="limit-head"><span>Shared inference key</span><strong>${esc(formatUsd(key.allTimeUsd, 4))} all time</strong></div>
    <div class="or-key-grid"><span><b>Today</b>${esc(formatUsd(key.dailyUsd, 4))}</span><span><b>Week</b>${esc(formatUsd(key.weeklyUsd, 4))}</span><span><b>Month</b>${esc(formatUsd(key.monthlyUsd, 4))}</span></div>
    <div class="limit-meta split"><span>${esc(cap)}</span>${expiry}</div>
    <div class="limit-meta">${devices}</div>
  </section>` : `<section class="limit unreadable"><div class="limit-head"><span>Key usage</span><strong>Unavailable</strong></div></section>`}${capacity.history ? openRouterHistoryBlock(capacity.history) : ""}`;
}

function providerLimits(account: CodexLimitAccount, nowMs: number): string {
  if (account.provider === "openrouter" && account.openrouter) {
    return openRouterLimits(account);
  }
  if (account.provider === "lokai" && account.route) {
    return routeBalanceBlock(account.route);
  }
  if (account.provider === "copilot" && account.copilot) {
    return copilotLimits(account, nowMs);
  }
  if (account.provider === "qwen" && account.local) {
    return localQwenLimits(account);
  }
  // No quota and no balance: the plan absorbs the usage, so the card reports
  // what was sent rather than inventing an allowance to pace against.
  if (account.provider === "grok" && account.spend) {
    return spendLimits(account);
  }
  return [
    account.session
      ? limitBlock(account.provider === "lokai" ? "5-hour session" : "5-hour window", account.session, nowMs, account.updatedAt)
      : "",
    account.weekly ? limitBlock("Weekly window", account.weekly, nowMs, account.updatedAt) : "",
  ].join("");
}

function limitBlock(
  label: string,
  window: LimitWindow,
  nowMs: number,
  updatedAt?: string,
): string {
  const left = Math.round(100 - window.usedPercent);
  const freshness = windowFreshness(window, updatedAt, nowMs);
  if (freshness !== "live") return unreadableLimitBlock(label, window, left, freshness);
  const tone = left <= 15 ? "danger" : left <= 35 ? "warn" : "good";
  // The bar drains as the window is used: a full bar means room to work.
  const marker = paceMarker(window, nowMs);
  const fill = Math.min(100, Math.max(0, left));
  const pace = paceLabel(window, nowMs);
  const forecast = runOutForecast(window, nowMs);
  return `<section class="limit ${tone}">
    <div class="limit-head"><span>${esc(label)}</span><strong>${fill}% left</strong></div>
    <div class="track" role="progressbar" aria-label="${esc(label)} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fill}"><i style="width:${fill}%"></i>${marker}</div>
    <div class="limit-meta"><span class="reset" data-reset="${esc(window.resetsAt ?? "")}">${window.resetsAt ? "Reset time loading" : "Reset time unavailable"}</span></div>
    ${pace || forecast ? `<div class="pace"><span>${esc(pace ?? "")}</span>${forecast ?? ""}</div>` : ""}
  </section>`;
}

// An expired or stale sample is shown as the history it is: the last reading and
// its age, never a live percentage, and never a pace forecast built on it.
function unreadableLimitBlock(
  label: string,
  window: LimitWindow,
  left: number,
  freshness: WindowFreshness,
): string {
  const headline = freshness === "expired" ? "Cycle ended" : "Not current";
  const detail = freshness === "expired"
    ? "Window already reset; awaiting a fresh read"
    : "Collector has not refreshed this account";
  return `<section class="limit unreadable ${freshness}" title="${esc(detail)}">
    <div class="limit-head"><span>${esc(label)}</span><strong>${esc(headline)}</strong></div>
    <div class="track stale" role="img" aria-label="${esc(label)} is not current"><i style="width:${Math.min(100, Math.max(0, left))}%"></i></div>
    <div class="limit-meta"><span>Last read ${left}% left</span></div>
  </section>`;
}


function accountCard(account: CodexLimitAccount, index: number, nowMs: number, plan?: AccountUtilizationPlan): string {
  const accountKey = `${account.provider}:${account.email.toLowerCase()}`;
  const name = account.name ?? (account.provider === "qwen" ? "Local Qwen" : account.provider === "lokai" ? account.email : providerLabel(account.provider));
  const provider = providerLabel(account.provider);
  const showProvider = !name.toLowerCase().includes(provider.toLowerCase());
  const credits = creditLines(account, nowMs)
    .map((line) => `<span class="credits" title="${esc(line.title)}">${esc(line.text)}</span>`)
    .join("");
  return `<article class="account-card provider-${account.provider}" data-account-key="${esc(accountKey)}" style="--delay:${index * 60}ms;--accent:${providerAccent(account.provider)}">
    <header class="account-head">
      <div class="identity">${showProvider ? `<span class="provider-label">${provider}</span>` : ""}<h2>${esc(name)}</h2>${name === account.email ? "" : `<span class="account-email">${esc(account.email)}</span>`}</div>
      <div class="account-meta"><strong>${esc(account.plan)}</strong><span class="updated" data-captured="${esc(account.updatedAt ?? "")}" title="Provider capture time">${account.updatedAt ? "Captured recently" : "Capture time unavailable"}</span></div>
    </header>
    <div class="account-credits">${credits}</div>
    <div class="limits">${providerLimits(account, nowMs)}</div>
    ${plan ? renderCapacityPlan(plan) : ""}
  </article>`;
}

export function renderLimitsText(accounts: CodexLimitAccount[], nowMs = Date.now()): string {
  return accounts.map((account) => {
    if (account.provider === "openrouter" && account.openrouter) {
      const capacity = account.openrouter;
      const key = capacity.keyUsage;
      const usage = key
        ? `${formatUsd(key.dailyUsd, 4)} today · ${formatUsd(key.monthlyUsd, 4)} 30d · ${formatUsd(key.allTimeUsd, 4)} key all time`
        : "shared-key usage unavailable";
      const history = capacity.history
        ? ` · ${formatUsd(capacity.history.totals.costUsd, 4)} completed-day history (${capacity.history.availableFrom.slice(0, 10)} to ${capacity.history.availableThrough.slice(0, 10)}, unattributed)`
        : "";
      return `OpenRouter · ${account.email}\t${formatUsd(capacity.balanceUsd, 4)} left\t${formatUsd(capacity.totalUsageUsd, 4)} account billed\t${usage}${history}`;
    }
    if (account.copilot) {
      const status = copilotBudgetStatus(account);
      const standing = status.over
        ? `over budget by ${status.creditsOver} credits (${formatCopilotMoney(status.usdOver, status.budget)})`
        : `${status.creditsLeft} credits left`;
      return `${account.email}\t${account.plan}\t${status.creditsUsed} of ${status.budget.credits} AI credits used (${formatCopilotMoney(status.usdSpent, status.budget)} of ${formatCopilotMoney(status.budget.usd, status.budget)})\t${standing}`;
    }
    if (account.provider === "qwen" && account.local) {
      const usage = account.spend
        ? `Measured ${Math.round(account.spend.recentHours)}h ${formatTokens(account.spend.recentTokens)} tokens\tMeasured ${Math.round(account.spend.monthDays)}d ${formatTokens(account.spend.monthTokens)} tokens`
        : "Measured usage unavailable";
      return `Qwen · ${account.email}\tUnlimited\t${usage}`;
    }
    if (account.spend) {
      const days = Math.round(account.spend.monthDays);
      const hours = Math.round(account.spend.recentHours);
      return `${providerLabel(account.provider)} · ${account.email}\t${hours}h ${formatUsd(account.spend.recentUsd)} (${formatTokens(account.spend.recentTokens)} tokens)\t${days}d ${formatUsd(account.spend.monthUsd)} (${formatTokens(account.spend.monthTokens)} tokens)\tplan-covered, API-equivalent`;
    }
    if (account.route) {
      const balance = account.route.balances.map(formatBalance).join(" + ");
      return `${providerLabel(account.provider)} · ${account.email}\t${balance ? `${balance} left` : "balance unavailable"}\t${account.route.detail}`;
    }
    const credit = creditLines(account, nowMs, false).map((line) => `\t${line.text}`).join("");
    const describe = (window: LimitWindow | undefined, missing: string): string => {
      if (!window) return missing;
      const freshness = windowFreshness(window, account.updatedAt, nowMs);
      const left = leftPercent(window)!;
      if (freshness === "expired") return `cycle ended (last ${left}% left)`;
      if (freshness === "stale") return `not current (last ${left}% left)`;
      const burn = window.burn;
      if (!burn) return `${left}% left`;
      if (burn.ratePerHour <= 0) return `${left}% left (idle, safe ${formatBurnRate(burn.sustainableRatePerHour)})`;
      const pace = `${formatBurnRate(burn.ratePerHour)} vs safe ${formatBurnRate(burn.sustainableRatePerHour)}`;
      if (burn.lastsToReset) return `${left}% left (${pace})`;
      return `${left}% left (${pace}, out in ${compactDuration(Date.parse(burn.runsOutAt!) - nowMs)})`;
    };
    return `${providerLabel(account.provider)} · ${account.email}\t5h ${describe(account.session, "not active")}\tweekly ${describe(account.weekly, "unavailable")}${credit}`;
  }).join("\n") + "\n";
}

export function renderLimitsHtml(
  accounts: CodexLimitAccount[],
  opts: { generatedAt: number; nowMs?: number; spendHref?: string; historyHref?: string; sources?: CapacitySourceHealth[]; authentication?: CapacityAuthenticationRequirement[] } = { generatedAt: Date.now() },
): string {
  const nowMs = opts.nowMs ?? opts.generatedAt;
  const generated = new Date(opts.generatedAt).toISOString();
  const plans = new Map(buildUtilizationPlans(accounts, nowMs).map(plan => [`${plan.provider}:${plan.account.toLowerCase()}`, plan]));
  const cards = accounts.map((account, index) => accountCard(account, index, nowMs, plans.get(`${account.provider}:${account.email.toLowerCase()}`))).join("");
  const spendHref = opts.spendHref ?? "spend.html";
  const historyHref = opts.historyHref ?? "history.html";
  const authenticationHtml = (opts.authentication ?? []).map((item) => {
    const provider = providerLabel(item.provider);
    const label = item.account ? `${provider} · ${item.account}` : provider;
    return `<section class="auth-required" data-auth-provider="${item.provider}" data-auth-profile="${esc(item.profile ?? "default")}"><div><strong>Authentication required</strong><span>${esc(label)} on ${esc(item.device)}</span></div><a href="#setup">Sign in with ${esc(item.provider === "codex" ? "ChatGPT" : item.provider === "claude" ? "Claude" : "GitHub")}</a></section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${BRAND_HEAD_HTML}
${THEME_HEAD_HTML}
<title>Spendwatch Capacity</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono:ital@0;1&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0c0f;--surface:#11151a;--raised:#151a20;--line:#29313a;--ink:#f2f5f7;--muted:#89939d;--cyan:#68d5dc;--cyan2:#2aa7b3;--good:#75d598;--warn:#f2bd64;--danger:#f27b70}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:"Manrope",sans-serif;background-image:linear-gradient(var(--grid,rgba(255,255,255,.018)) 1px,transparent 1px),linear-gradient(90deg,var(--grid,rgba(255,255,255,.018)) 1px,transparent 1px),radial-gradient(800px 500px at 50% -180px,rgba(104,213,220,.13),transparent 70%);background-size:38px 38px,38px 38px,auto}
.shell{width:min(1460px,calc(100% - 36px));margin:0 auto;padding:30px 0 64px}.topbar{display:flex;align-items:center;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.brand{font-family:"Fragment Mono",monospace;font-size:14px;letter-spacing:-.04em}.brand b{color:var(--cyan);font-weight:400}.nav{display:flex;gap:5px;margin-left:18px;padding:4px;background:var(--nav-bg,#0d1014);border:1px solid var(--line,#20262d);border-radius:9px}.nav a{padding:7px 11px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:12px;font-weight:600}.nav a.active{color:var(--ink);background:var(--raised)}
.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.button.icon{display:grid;place-items:center;width:38px;height:38px;padding:0;font-size:16px;line-height:1}.button.icon[aria-busy=true]{animation:spin 1s linear infinite}.menu{position:relative}.menu summary{list-style:none}.menu summary::-webkit-details-marker{display:none}.menu-list{position:absolute;right:0;top:calc(100% + 6px);z-index:20;display:flex;flex-direction:column;gap:4px;min-width:170px;padding:6px;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.35)}.menu-list .button{text-align:left;border-color:transparent;background:none}.menu-list .button:hover{border-color:var(--line);transform:none}.menu-list .button[hidden]{display:none}.button{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:9px 12px;font:600 12px "Manrope",sans-serif;cursor:pointer;text-decoration:none;transition:border-color .15s,transform .15s}.button:hover{border-color:#52606d;transform:translateY(-1px)}.button.primary{border-color:rgba(104,213,220,.5);background:rgba(104,213,220,.09);color:var(--accent-text,#bdf5f7)}.button.push-on{border-color:rgba(117,213,152,.48);color:var(--positive-text,#bdf2ce);background:rgba(117,213,152,.08)}
.summary{display:flex;align-items:baseline;justify-content:space-between;gap:20px;padding:20px 0 10px}.summary h1{font-size:22px;line-height:1;letter-spacing:-.045em;margin:0}.summary span{color:var(--muted);font:12px "Fragment Mono",monospace}.planning{display:flex;align-items:center;justify-content:flex-end;margin-bottom:14px;padding:8px 11px;background:var(--surface,rgba(17,21,26,.8));border:1px solid var(--line);border-radius:10px}.planning:empty{display:none}.sources{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 12px;min-width:0}.source{display:flex;align-items:center;gap:5px;white-space:nowrap;color:var(--muted);font:10px "Fragment Mono",monospace}.source i{width:6px;height:6px;border-radius:50%;background:var(--good)}.source.snapshot i{background:var(--subtle,#6f7a83)}.source.stale i{background:var(--warn)}.source.offline i,.source.error i{background:var(--danger)}.source b{color:var(--secondary,#c8d0d6);font-weight:400}.source em{font-style:normal}
.auth-required{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;padding:12px 14px;border:1px solid rgba(242,189,100,.42);border-radius:10px;background:rgba(242,189,100,.07)}.auth-required div{display:flex;flex-direction:column;gap:2px}.auth-required strong{color:var(--warn);font:11px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.08em}.auth-required span{color:var(--secondary,#cbd2d7);font-size:12px}.auth-required a{flex:none;color:#101317;background:var(--warn);border-radius:7px;padding:8px 10px;font:700 11px "Manrope",sans-serif;text-decoration:none}
.setup{display:none;margin-top:14px;padding:20px;background:var(--inset,#0d1115);border:1px solid var(--line,#34414c);border-radius:12px}.setup.open{display:block;animation:enter .25s both}.setup-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:15px}.setup h2{font-size:18px;margin:0 0 5px}.setup-head p{color:var(--muted);font-size:12px;margin:0}.profile-field{display:flex;flex-direction:column;gap:5px;flex:0 0 210px}.profile-field span{color:var(--secondary,#aab3ba);font:10px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.08em}.profile-field input{width:100%;padding:9px 10px;color:var(--ink);background:var(--input-bg,#07090b);border:1px solid var(--line,#34414c);border-radius:7px;font:12px "Fragment Mono",monospace;outline:none}.profile-field input:focus{border-color:var(--cyan)}.provider-setup{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}.setup-item{min-width:0;padding:13px;border:1px solid var(--line,#242c34);border-radius:9px}.setup-label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.setup-label b{color:var(--item-accent);font:11px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.1em}.auth-kind{padding:3px 6px;border:1px solid color-mix(in srgb,var(--item-accent) 45%,var(--line,#242c34));border-radius:99px;color:var(--secondary,#cbd3d8);font:9px "Fragment Mono",monospace;text-transform:uppercase}.setup-item p{font-size:12px;line-height:1.45;color:var(--secondary,#aab3ba);margin:0 0 10px}.command{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 11px;background:var(--input-bg,#07090b);border:1px solid var(--line,#202830);border-radius:8px}.command+.command{margin-top:7px}.command code{flex:1;min-width:0;font:11px "Fragment Mono",monospace;color:var(--secondary,#d5dce0);overflow:auto;white-space:nowrap}.copy{margin-left:auto;flex:none;background:none;border:0;color:var(--item-accent,var(--cyan));font:10px "Fragment Mono",monospace;cursor:pointer}.alternatives{margin-top:8px;color:var(--muted);font-size:11px}.alternatives summary{cursor:pointer}.alternatives .command{margin-top:7px}.page-meta{text-align:right;margin-top:14px;color:var(--subtle,#6e7881);font:11px "Fragment Mono",monospace}
@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes fill{from{width:0}}@keyframes spin{to{transform:rotate(360deg)}}
.openrouter-balance,.openrouter-key{display:flex;flex-direction:column;justify-content:center;min-height:50px}.openrouter-balance .limit-meta,.openrouter-key .limit-meta{margin-top:7px}.or-key-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:7px}.or-key-grid span{color:var(--secondary,#cbd3d8);font:11px "Fragment Mono",monospace}.or-key-grid b{display:block;margin-bottom:2px;color:var(--subtle,#77828b);font-size:8px;font-weight:400;text-transform:uppercase;letter-spacing:.07em}.openrouter-history{grid-column:1/-1;border-top:1px solid #29313a;padding-top:10px}.openrouter-history summary{display:flex;justify-content:space-between;cursor:pointer;color:var(--secondary,#b9c1c8);font-size:11px;font-weight:600}.openrouter-history summary strong{color:var(--accent);font:12px "Fragment Mono",monospace}.or-coverage,.or-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:baseline}.or-coverage{margin-top:8px;color:var(--subtle,#7f8a93);font:9px/1.4 "Fragment Mono",monospace}.or-coverage span:last-child{text-align:right}.or-days,.or-models{margin-top:7px}.or-models>span{color:var(--subtle,#77828b);font:8px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.07em}.or-row{padding:4px 0;border-bottom:1px solid var(--divider,rgba(41,49,58,.55));font:10px "Fragment Mono",monospace}.or-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--subtle,#8e99a2)}.or-row strong{color:var(--secondary,#dce2e6);font-weight:400}.or-empty{padding:8px 0;color:var(--subtle,#7f8a93);font-size:10px}
@media(max-width:720px){.shell{width:min(100% - 24px,1460px);padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(64px,env(safe-area-inset-bottom))}.topbar{display:grid;grid-template-columns:1fr auto;gap:12px 8px}.nav{grid-column:1/-1;grid-row:2;width:100%;margin:0;display:grid;grid-template-columns:repeat(3,1fr)}.nav a{display:grid;place-items:center;min-height:44px;padding:7px 5px;text-align:center}.top-actions{margin:0}.button{min-height:44px}.summary{padding-top:18px}.planning{align-items:flex-start;flex-direction:column}.sources{justify-content:flex-start}.provider-setup{grid-template-columns:1fr}.updated{white-space:normal}.setup-head{align-items:stretch;flex-direction:column}.profile-field{flex-basis:auto}}
@media(max-width:480px){.topbar{grid-template-columns:1fr auto}.brand{padding-top:2px}.top-actions{grid-row:1;grid-column:2}.nav{grid-row:2}.summary{align-items:flex-start;flex-direction:column;gap:5px}.planning{padding:11px}.sources{flex-wrap:wrap}.auth-required{align-items:stretch;flex-direction:column}.auth-required a{text-align:center;min-height:44px;display:grid;place-items:center}.setup{padding:15px}.command{gap:6px;padding:9px}.copy{min-width:44px;min-height:44px}}
@media(max-width:480px){.sources{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;width:100%}.source{display:grid;grid-template-columns:6px minmax(0,1fr);column-gap:6px;row-gap:1px;min-width:0}.source i{align-self:start;margin-top:3px}.source b,.source em{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source em{color:var(--subtle,#6f7a83)}}
.openrouter-history[open]{grid-column:1/-1}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}

${CAPACITY_CARD_CSS}
${THEME_CSS}
</style></head><body><main class="shell">
<div class="topbar"><div class="brand"><b>spend</b>watch</div><nav class="nav"><a class="active" href="./">Capacity</a><a href="${esc(spendHref)}">Spend detail</a><a href="${esc(historyHref)}">History</a></nav><div class="top-actions">${THEME_CONTROL_HTML}<button class="button icon" id="refresh" title="Refresh" aria-label="Refresh">&#8635;</button><details class="menu"><summary class="button icon" title="More" aria-label="More actions">&#8943;</summary><div class="menu-list"><button class="button" id="install" hidden>Install app</button><button class="button" id="alerts">Enable alerts</button><button class="button" id="add">Add account</button></div></details></div></div>
${authenticationHtml}
<section class="setup" id="setup"><div class="setup-head"><div><h2>Connect another account</h2><p>Copy one command to a trusted Mac. Provider credentials never reach this dashboard.</p></div><label class="profile-field"><span>Profile name</span><input id="profile-name" value="new-account" maxlength="32" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false"></label></div><div class="provider-setup">
  <div class="setup-item" style="--item-accent:#68d5dc"><div class="setup-label"><b>Codex</b><span class="auth-kind">ChatGPT OAuth</span></div><p>Official browser sign-in. Each named profile stays logged in and refreshes independently.</p><div class="command"><code data-template="spendwatch account add codex --name {name}">spendwatch account add codex --name new-account</code><button class="copy">COPY</button></div><details class="alternatives"><summary>Headless or metered API key</summary><div class="command"><code data-template="spendwatch account add codex --name {name} --device-auth">spendwatch account add codex --name new-account --device-auth</code><button class="copy">COPY</button></div><div class="command"><code data-template="spendwatch account add codex --name {name} --api-key-env OPENAI_API_KEY">spendwatch account add codex --name new-account --api-key-env OPENAI_API_KEY</code><button class="copy">COPY</button></div></details></div>
  <div class="setup-item" style="--item-accent:#e69a73"><div class="setup-label"><b>Claude</b><span class="auth-kind">Claude OAuth</span></div><p>Official browser sign-in in a separate local Claude configuration.</p><div class="command"><code data-template="spendwatch account add claude --name {name}">spendwatch account add claude --name new-account</code><button class="copy">COPY</button></div></div>
  <div class="setup-item" style="--item-accent:#8ea9ff"><div class="setup-label"><b>Copilot</b><span class="auth-kind">GitHub OAuth</span></div><p>GitHub CLI keeps multiple identities; Copilot Business capacity follows the signed-in account.</p><div class="command"><code>spendwatch account add copilot</code><button class="copy">COPY</button></div></div>
  <div class="setup-item" style="--item-accent:#b8d96b"><div class="setup-label"><b>Lokai</b><span class="auth-kind">API keys</span></div><p>Keys stay in the existing local LiteLLM/1Password setup. This only verifies routes and balances.</p><div class="command"><code>lokai-router check</code><button class="copy">COPY</button></div></div>
</div></section>
<section class="accounts">${cards}</section>

<div class="page-meta"><span id="generated" data-generated="${esc(generated)}">Generated ${esc(generated)}</span></div>
</main><script>
const compactDuration=${compactDuration.toString()};
const installButton=document.querySelector('#install'),topActions=document.querySelector('.top-actions');let installPrompt;
const hideInstall=()=>{installButton.hidden=true;topActions.classList.remove('install-ready');installPrompt=undefined};
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;installButton.hidden=false;topActions.classList.add('install-ready')});
addEventListener('appinstalled',hideInstall);
installButton.addEventListener('click',async()=>{if(!installPrompt)return;await installPrompt.prompt();await installPrompt.userChoice;hideInstall()});
const relative=(iso,mode)=>{if(!iso)return mode==='reset'?'Reset unavailable':mode==='exhaust'?'Forecast unavailable':'Update unavailable';const t=Date.parse(iso);if(!Number.isFinite(t))return mode==='reset'?'Reset unavailable':mode==='exhaust'?'Forecast unavailable':'Update unavailable';const delta=t-Date.now(),abs=Math.abs(delta);if(mode==='reset'||mode==='exhaust'){if(delta<=0)return mode==='reset'?'Refreshing limit':'Ran out';const duration=compactDuration(abs);if(duration==='now')return mode==='reset'?'Resets now':'Runs out now';return(mode==='reset'?'Resets in ':'Runs out in ')+duration}if(abs<90000)return'Updated just now';return'Updated '+compactDuration(abs)+' ago'};
const hydrateRelative=(root=document)=>{root.querySelectorAll('[data-reset]').forEach(el=>el.textContent=relative(el.dataset.reset,'reset'));root.querySelectorAll('[data-exhaust]').forEach(el=>el.textContent=relative(el.dataset.exhaust,'exhaust'));root.querySelectorAll('[data-captured]').forEach(el=>el.textContent=relative(el.dataset.captured,'updated').replace(/^Updated/,'Captured'));root.querySelectorAll('[data-source-status]').forEach(el=>{const raw=el.dataset.sourceStatus,timestamp=Date.parse(el.dataset.sourceLast),elapsed=Number.isFinite(timestamp)&&timestamp<=Date.now()?Date.now()-timestamp:Infinity,age=compactDuration(elapsed),status=raw==='snapshot'?'snapshot':raw==='live'&&elapsed<=240000?'live':(raw==='live'||raw==='stale')&&elapsed<=300000?'stale':(raw==='live'||raw==='stale')?'offline':raw,source=el.closest('.source');source?.classList.remove('live','snapshot','stale','offline','error');source?.classList.add(status);el.textContent=status==='live'?'live':status==='snapshot'?'snapshot · on demand '+age:status+' '+age});const generated=root.querySelector('#generated');if(generated)generated.textContent=relative(generated.dataset.generated,'updated')+' · view sync 15s; collection is separate'};
const syncAttrs=(current,next)=>{for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value)};
const patchNode=(current,next)=>{if(current.nodeType!==next.nodeType||current.nodeName!==next.nodeName){current.replaceWith(next.cloneNode(true));return}if(current.nodeType===Node.TEXT_NODE){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return}syncAttrs(current,next);const before=[...current.childNodes],after=[...next.childNodes],shared=Math.min(before.length,after.length);for(let i=0;i<shared;i++)patchNode(before[i],after[i]);for(let i=before.length-1;i>=after.length;i--)before[i].remove();for(let i=shared;i<after.length;i++)current.append(after[i].cloneNode(true))};
const refreshButton=document.querySelector('#refresh');let refreshing=false;
const alertButton=document.querySelector('#alerts');
const pushSupported=()=>window.isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
const applicationKey=value=>{const padding='='.repeat((4-value.length%4)%4),base64=(value+padding).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(base64);return Uint8Array.from([...raw].map(char=>char.charCodeAt(0)))};
const subscriptionRequest=(path,subscription)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:subscription.toJSON()})});
const updateAlertButton=async()=>{alertButton.hidden=false;if(!pushSupported()){alertButton.textContent='Alerts unavailable';alertButton.disabled=true;return}if(Notification.permission==='denied'){alertButton.textContent='Alerts blocked';alertButton.title='Allow notifications for this site in browser settings';return}const registration=await navigator.serviceWorker.getRegistration('/'),subscription=await registration?.pushManager.getSubscription();if(!subscription){alertButton.textContent='Enable alerts';alertButton.classList.remove('push-on');alertButton.title='Enable background alerts on this device';return}try{const response=await subscriptionRequest('/api/push/status',subscription),status=await response.json();if(response.ok&&status.verified){alertButton.hidden=true;return}}catch{}alertButton.textContent='Test alerts';alertButton.classList.add('push-on');alertButton.title='Send one test alert to verify background delivery'};
const enableOrTestAlerts=async()=>{if(!pushSupported())return;alertButton.disabled=true;alertButton.textContent='Connecting';try{const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission not granted');const configResponse=await fetch('/api/push/config',{cache:'no-store'});if(!configResponse.ok)throw new Error('Push configuration unavailable');const config=await configResponse.json();let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});const response=await subscriptionRequest('/api/push/subscribe',subscription);const result=await response.json();if(!response.ok)throw new Error(result.error||'Subscription failed');alertButton.textContent=result.testSent?'Test sent':'Alerts active';alertButton.classList.add('push-on');if(result.testSent)alertButton.hidden=true;else setTimeout(()=>void updateAlertButton(),1800)}catch(error){alertButton.hidden=false;alertButton.textContent='Retry alerts';alertButton.title=String(error)}finally{alertButton.disabled=false}};
const refreshValues=async(interactive=false)=>{if(refreshing)return;refreshing=true;if(interactive){refreshButton.setAttribute('aria-busy','true');refreshButton.title='Syncing'}try{const url=new URL(location.href);url.hash='';url.searchParams.set('_',Date.now().toString());const response=await fetch(url,{cache:'no-store',headers:{Accept:'text/html'}});if(!response.ok)throw new Error('HTTP '+response.status);const next=new DOMParser().parseFromString(await response.text(),'text/html');hydrateRelative(next);const host=document.querySelector('.accounts'),current=new Map([...host.querySelectorAll('[data-account-key]')].map(card=>[card.dataset.accountKey,card])),seen=new Set();let index=0;for(const nextCard of next.querySelectorAll('[data-account-key]')){const key=nextCard.dataset.accountKey;seen.add(key);let card=current.get(key);if(card){const disclosures=[...card.querySelectorAll('details')].map(detail=>detail.open);if(card.outerHTML!==nextCard.outerHTML)patchNode(card,nextCard);card.querySelectorAll('details').forEach((detail,i)=>detail.open=disclosures[i]??false)}else{card=nextCard.cloneNode(true)}if(host.children[index]!==card)host.insertBefore(card,host.children[index]||null);index++}for(const [key,card] of current){if(!seen.has(key))card.remove()}const nextGenerated=next.querySelector('#generated'),generated=document.querySelector('#generated');if(nextGenerated&&generated&&generated.dataset.generated!==nextGenerated.dataset.generated)generated.dataset.generated=nextGenerated.dataset.generated||'';if(interactive)refreshButton.title='Updated';refreshButton.title='Values updated without reloading the page'}catch(error){refreshButton.title='Value refresh failed: '+String(error);if(interactive)refreshButton.title='Retry'}finally{refreshing=false;if(interactive)refreshButton.removeAttribute('aria-busy');hydrateRelative()}};
hydrateRelative();refreshButton.addEventListener('click',()=>refreshValues(true));setInterval(()=>refreshValues(false),15000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshValues(false)});
alertButton.addEventListener('click',enableOrTestAlerts);const actionMenu=document.querySelector('.menu');actionMenu.querySelectorAll('.menu-list button').forEach(b=>b.addEventListener('click',()=>{actionMenu.open=false}));document.addEventListener('click',e=>{if(actionMenu.open&&!actionMenu.contains(e.target))actionMenu.open=false});void updateAlertButton();
const setup=document.querySelector('#setup');
// Closing has to drop the #setup hash too. A sign-in link or a cross-page Add
// account link leaves it in the URL, and every later reload reopened the panel
// on top of the dashboard however many times it had been closed.
const showSetup=open=>{setup.classList.toggle('open',open);if(!open&&location.hash==='#setup')history.replaceState(null,'',location.pathname+location.search)};
document.querySelector('#add').addEventListener('click',()=>showSetup(!setup.classList.contains('open')));
if(location.hash==='#setup')setup.classList.add('open');
addEventListener('hashchange',()=>{if(location.hash==='#setup')setup.classList.add('open')});
document.querySelectorAll('.auth-required a').forEach(link=>link.addEventListener('click',event=>{const row=event.currentTarget.closest('.auth-required');showSetup(true);profileName.value=row.dataset.authProfile==='default'?'default':row.dataset.authProfile;updateCommands();setTimeout(()=>setup.scrollIntoView({behavior:'smooth',block:'start'}),0)}));
const profileName=document.querySelector('#profile-name');const updateCommands=()=>{const name=(profileName.value.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'new-account');document.querySelectorAll('[data-template]').forEach(code=>code.textContent=code.dataset.template.replace('{name}',name))};profileName.addEventListener('input',updateCommands);updateCommands();
document.querySelectorAll('.copy').forEach(button=>button.addEventListener('click',async event=>{const code=event.currentTarget.parentElement.querySelector('code').textContent;await navigator.clipboard.writeText(code);event.currentTarget.textContent='COPIED';setTimeout(()=>event.currentTarget.textContent='COPY',1400)}));
</script></body></html>`;
}

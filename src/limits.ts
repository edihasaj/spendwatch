import { readFileSync } from "node:fs";
import { BRAND_HEAD_HTML } from "./branding";
import type { CapacityAuthenticationRequirement, CapacitySourceHealth } from "./capacity-dashboard";
import { predictWindow } from "./capacity-prediction";
import { windowFreshness, type WindowFreshness } from "./capacity-freshness";
import { buildUtilizationPlans, recommendAccount, UTILIZATION_TARGET_PERCENT, type AccountUtilizationPlan } from "./capacity-planner";
import { copilotBudgetStatus, copilotCreditWindow } from "./copilot-budget";
import { compactDuration } from "./duration";

export { predictWindow } from "./capacity-prediction";

export interface LimitWindow {
  usedPercent: number;
  resetsAt?: string;
  windowMinutes: number;
  prediction?: CapacityPrediction;
}

export interface CapacityPrediction {
  deltaPercent: number;
  expectedUsedPercent: number;
  willLastToReset: boolean;
  runsOutAt?: string;
  source: "reported" | "linear";
}

export type CapacityProvider = "codex" | "claude" | "copilot" | "lokai";

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
  updatedAt?: string;
  session?: LimitWindow;
  weekly?: LimitWindow;
  copilot?: CopilotCapacity;
  route?: CloudRouteCapacity;
  devices: string[];
  sessionEquivalent?: SessionEquivalentForecast;
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
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  tertiary?: RawWindow | null;
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

export function normalizeCodexLimits(input: unknown): CodexLimitAccount[] {
  const items = Array.isArray(input) ? input : [input];
  const accounts = new Map<string, CodexLimitAccount>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const result = item as RawCodexResult;
    const provider = result.provider;
    if (provider !== "codex" && provider !== "claude" && provider !== "copilot" && provider !== "lokai") continue;
    const usage = result.usage;
    if (!usage || typeof usage !== "object") continue;
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
      updatedAt,
      session,
      weekly,
      devices: sourceDevices(result),
    };
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
  for (const provider of ["codex", "claude", "copilot"] as const) {
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
  return normalized.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email) || a.email.localeCompare(b.email));
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
  return ({ codex: "Codex", claude: "Claude", copilot: "Copilot", lokai: "Lokai" })[provider];
}

function providerAccent(provider: CapacityProvider): string {
  return ({ codex: "#68d5dc", claude: "#e69a73", copilot: "#8ea9ff", lokai: "#b8d96b" })[provider];
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

function paceBlock(window: LimitWindow, nowMs: number): string {
  const prediction = predictWindow(window, nowMs);
  if (!prediction) return "";
  const roundedDelta = Math.round(Math.abs(prediction.deltaPercent));
  const pace = roundedDelta <= 2
    ? "On pace"
    : prediction.deltaPercent > 0
      ? `${roundedDelta}% over pace`
      : `${roundedDelta}% under pace`;
  const forecast = window.usedPercent >= 100
    ? "Ran out"
    : prediction.willLastToReset
      ? "Lasts until reset"
      : prediction.runsOutAt
        ? `<span class="exhaust" data-exhaust="${esc(prediction.runsOutAt)}">Run-out forecast loading</span>`
        : "Run-out likely";
  return `<div class="pace"><span>${esc(pace)}</span><strong>${forecast}</strong></div>`;
}

function paceMarker(window: LimitWindow, nowMs: number): string {
  const prediction = predictWindow(window, nowMs);
  if (!prediction) return "";
  const expectedLeft = Math.min(100, Math.max(0, 100 - prediction.expectedUsedPercent));
  const roundedDelta = Math.round(Math.abs(prediction.deltaPercent));
  const onPace = roundedDelta <= 2;
  const tone = onPace ? "steady" : prediction.deltaPercent > 0 ? "deficit" : "reserve";
  const direction = prediction.deltaPercent > 0 ? "over" : "under";
  const label = onPace
    ? `Expected pace: ${Math.round(expectedLeft)}% left, on pace`
    : `Expected pace: ${Math.round(expectedLeft)}% left, ${roundedDelta}% ${direction}`;
  return `<span class="pace-marker ${tone}" style="--pace-left:${expectedLeft}%" role="img" aria-label="${esc(label)}" title="${esc(label)}"><b></b><b></b><b></b></span>`;
}

function formatUsd(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
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
    ? `${esc(formatUsd(status.usdOver))} over the ${esc(formatUsd(budget.usd))} ceiling`
    : `${esc(overflow)}`;
  return `<section class="limit copilot-usage ${tone}">
    <div class="limit-head"><span>AI credits used</span><strong>${status.creditsUsed.toLocaleString()} / ${budget.credits.toLocaleString()}</strong></div>
    <div class="track" role="progressbar" aria-label="${status.over ? "Monthly AI credit budget spent" : "Monthly AI credit budget remaining"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${status.over ? 100 : left}"><i style="width:${status.over ? 100 : left}%"></i>${marker}</div>
    <div class="limit-meta split"><span>${esc(standing)}</span>${reset}</div>
    ${window && !status.over ? paceBlock(window, nowMs) : ""}
  </section><section class="limit copilot-pool ${tone}">
    <div class="limit-head"><span>Monthly budget</span><strong>${esc(formatUsd(status.usdSpent))} / ${esc(formatUsd(budget.usd))}</strong></div>
    <div class="limit-meta split"><span>${money}</span><span>${esc(formatUsd(budget.creditUsd, 4))} per credit</span></div>
    <div class="pace"><span>${status.over ? "Ceiling passed, spending allowed" : "Manual ceiling"}</span><strong>${esc(billing)}</strong></div>
  </section>`;
}

function providerLimits(account: CodexLimitAccount, nowMs: number): string {
  if (account.provider === "lokai" && account.route) {
    return routeBalanceBlock(account.route);
  }
  if (account.provider === "copilot" && account.copilot) {
    return copilotLimits(account, nowMs);
  }
  return [
    account.session
      ? limitBlock(account.provider === "lokai" ? "5-hour session" : "5-hour window", account.session, nowMs, account.updatedAt)
      : "",
    account.weekly ? limitBlock("Weekly window", account.weekly, nowMs, account.updatedAt, account.sessionEquivalent) : "",
  ].join("");
}

function limitBlock(
  label: string,
  window: LimitWindow,
  nowMs: number,
  updatedAt?: string,
  equivalent?: SessionEquivalentForecast,
): string {
  const left = Math.round(100 - window.usedPercent);
  const freshness = windowFreshness(window, updatedAt, nowMs);
  if (freshness !== "live") return unreadableLimitBlock(label, window, left, freshness, updatedAt);
  const tone = left <= 15 ? "danger" : left <= 35 ? "warn" : "good";
  const marker = paceMarker(window, nowMs);
  return `<section class="limit ${tone}">
    <div class="limit-head"><span>${esc(label)}</span><strong>${left}% left</strong></div>
    <div class="track" role="progressbar" aria-label="${esc(label)} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}"><i style="width:${left}%"></i>${marker}</div>
    <div class="limit-meta"><span class="reset" data-reset="${esc(window.resetsAt ?? "")}">${window.resetsAt ? "Reset time loading" : "Reset time unavailable"}</span></div>
    ${paceBlock(window, nowMs)}
    ${equivalent ? `<div class="equivalent"><span>Est. ${equivalent.estimatedQuotasLeft} session quota${equivalent.estimatedQuotasLeft === 1 ? "" : "s"} left</span><strong>${equivalent.sampleCount} learned</strong></div>` : ""}
  </section>`;
}

// An expired or stale sample is shown as the history it is: the last reading and
// its age, never a live percentage, and never a pace forecast built on it.
function unreadableLimitBlock(
  label: string,
  window: LimitWindow,
  left: number,
  freshness: WindowFreshness,
  updatedAt?: string,
): string {
  const headline = freshness === "expired" ? "Cycle ended" : "Not current";
  const detail = freshness === "expired"
    ? "Window already reset; awaiting a fresh read"
    : "Collector has not refreshed this account";
  const age = updatedAt
    ? `<span data-updated="${esc(updatedAt)}">Update time loading</span>`
    : "<span>Sample age unknown</span>";
  return `<section class="limit unreadable ${freshness}">
    <div class="limit-head"><span>${esc(label)}</span><strong>${esc(headline)}</strong></div>
    <div class="track stale" role="img" aria-label="${esc(label)} is not current"><i style="width:${Math.min(100, Math.max(0, left))}%"></i></div>
    <div class="limit-meta split"><span>Last read ${left}% left</span>${age}</div>
    <div class="pace"><span>${detail}</span></div>
  </section>`;
}


function accountCard(account: CodexLimitAccount, index: number, nowMs: number): string {
  const deviceLabel = account.devices.length ? ` · ${account.devices.join(" + ")}` : "";
  const accountKey = `${account.provider}:${account.email.toLowerCase()}`;
  const name = account.name ?? (account.provider === "lokai" ? account.email : providerLabel(account.provider));
  return `<article class="account-card provider-${account.provider}" data-account-key="${esc(accountKey)}" style="--delay:${index * 60}ms;--accent:${providerAccent(account.provider)}">
    <header class="account-head">
      <div class="identity"><h2>${esc(name)}</h2>${name === account.email ? "" : `<span class="account-email">${esc(account.email)}</span>`}</div>
      <div class="account-meta"><strong>${esc(account.plan)}</strong><span class="updated" data-updated="${esc(account.updatedAt ?? "")}" data-devices="${esc(deviceLabel)}">${account.updatedAt ? "Updated recently" : "Update time unavailable"}${esc(deviceLabel)}</span></div>
    </header>
    <div class="limits">${providerLimits(account, nowMs)}</div>
  </article>`;
}

function utilizationActionLabel(plan: AccountUtilizationPlan): string {
  if (plan.action === "more") return plan.confidence === "early" ? "Shift away" : "More capacity";
  if (plan.action === "less") return "Less capacity";
  if (plan.action === "keep") return "Keep";
  if (plan.action === "rebalance") return plan.confidence === "early" ? "Shift here" : "Rebalance";
  return "Needs data";
}

function utilizationPlanCard(plan: AccountUtilizationPlan, index: number): string {
  const window = plan.window;
  const projected = window?.projectedUsedPercent === undefined
    ? window ? "Awaiting live use" : plan.currentValue ?? "Not measurable"
    : `${Math.round(window.projectedUsedPercent)}% ${plan.confidence === "early" ? "live projection" : "projected"}`;
  const current = window ? `${Math.round(window.currentUsedPercent)}% used` : plan.currentValue ?? "Allowance unknown";
  const required = window?.requiredRate === undefined
    ? plan.paceValue ?? "Pace unavailable"
    : window.remainingToTargetPercent <= 0
      ? "Target banked"
      : `${window.requiredRate.toFixed(window.requiredRate < 10 ? 1 : 0)} pts / ${window.rateUnit}`;
  const reset = window || plan.resetsAt
    ? `<span class="reset" data-reset="${esc(window?.resetsAt ?? plan.resetsAt!)}">Reset time loading</span>`
    : `<span>No fixed cycle</span>`;
  const meter = window ? `<div class="util-track" role="progressbar" aria-label="${esc(plan.account)} utilization" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(window.currentUsedPercent)}"><i style="width:${Math.min(100, window.currentUsedPercent)}%"></i><b style="left:${window.targetPercent}%" title="${window.targetPercent}% target"></b></div>` : "";
  return `<article class="util-card action-${plan.action}" data-utilization-key="${esc(`${plan.provider}:${plan.account.toLowerCase()}`)}" style="--delay:${index * 45}ms;--accent:${providerAccent(plan.provider)}">
    <header><div><span>${providerLabel(plan.provider)} · ${esc(plan.resource)}</span><h3>${esc(plan.account)}</h3></div><strong>${utilizationActionLabel(plan)}</strong></header>
    <div class="util-projection">${esc(projected)}</div>${meter}
    <div class="util-metrics"><span><b>Now</b>${esc(current)}</span><span><b>To 90%</b>${esc(required)}</span><span><b>Cycle</b>${reset}</span></div>
    <p>${esc(plan.detail)}</p>
  </article>`;
}

export function renderLimitsText(accounts: CodexLimitAccount[], nowMs = Date.now()): string {
  return accounts.map((account) => {
    if (account.copilot) {
      const status = copilotBudgetStatus(account);
      const standing = status.over
        ? `over budget by ${status.creditsOver} credits (${formatUsd(status.usdOver)})`
        : `${status.creditsLeft} credits left`;
      return `${account.email}\t${account.plan}\t${status.creditsUsed} of ${status.budget.credits} AI credits used (${formatUsd(status.usdSpent)} of ${formatUsd(status.budget.usd)})\t${standing}`;
    }
    if (account.route) {
      const balance = account.route.balances.map(formatBalance).join(" + ");
      return `${providerLabel(account.provider)} · ${account.email}\t${balance ? `${balance} left` : "balance unavailable"}\t${account.route.detail}`;
    }
    const describe = (window: LimitWindow | undefined, missing: string): string => {
      if (!window) return missing;
      const freshness = windowFreshness(window, account.updatedAt, nowMs);
      const left = leftPercent(window)!;
      if (freshness === "expired") return `cycle ended (last ${left}% left)`;
      if (freshness === "stale") return `not current (last ${left}% left)`;
      return `${left}% left`;
    };
    return `${providerLabel(account.provider)} · ${account.email}\t5h ${describe(account.session, "not active")}\tweekly ${describe(account.weekly, "unavailable")}`;
  }).join("\n") + "\n";
}

export function renderLimitsHtml(
  accounts: CodexLimitAccount[],
  opts: { generatedAt: number; spendHref?: string; historyHref?: string; sources?: CapacitySourceHealth[]; authentication?: CapacityAuthenticationRequirement[] } = { generatedAt: Date.now() },
): string {
  const providerCount = new Set(accounts.map((account) => account.provider)).size;
  const generated = new Date(opts.generatedAt).toISOString();
  const cards = accounts.map((account, index) => accountCard(account, index, opts.generatedAt)).join("");
  const spendHref = opts.spendHref ?? "spend.html";
  const historyHref = opts.historyHref ?? "history.html";
  const sources = opts.sources ?? [];
  const recommendation = recommendAccount(accounts, sources, opts.generatedAt);
  const utilizationPlans = buildUtilizationPlans(accounts, opts.generatedAt);
  const utilizationHtml = utilizationPlans.map(utilizationPlanCard).join("");
  const recommendationHtml = recommendation
    ? `<div class="best"><span>Best now</span><strong>${providerLabel(recommendation.provider)} · ${esc(recommendation.account)}</strong><em>${recommendation.weeklyLeft}% weekly${recommendation.sessionLeft === undefined ? "" : ` · ${recommendation.sessionLeft}% session`} · ${recommendation.willLastToReset ? "lasts to reset" : "run-out risk"}</em></div>`
    : `<div class="best unavailable"><span>Best now</span><strong>No fresh recommendation</strong></div>`;
  const sourceHtml = sources.length ? `<div class="sources">${sources.map((source) => `<span class="source ${source.status}" title="${esc(source.detail ?? source.status)}"><i></i><b>${esc(source.device)}</b><em data-source-status="${source.status}" data-source-last="${esc(source.lastSuccessAt ?? source.checkedAt)}">${source.status}</em></span>`).join("")}</div>` : "";
  const authenticationHtml = (opts.authentication ?? []).map((item) => {
    const provider = providerLabel(item.provider);
    const label = item.account ? `${provider} · ${item.account}` : provider;
    return `<section class="auth-required" data-auth-provider="${item.provider}" data-auth-profile="${esc(item.profile ?? "default")}"><div><strong>Authentication required</strong><span>${esc(label)} on ${esc(item.device)}</span></div><a href="#setup">Sign in with ${esc(item.provider === "codex" ? "ChatGPT" : item.provider === "claude" ? "Claude" : "GitHub")}</a></section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
${BRAND_HEAD_HTML}
<title>Spendwatch Capacity</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono:ital@0;1&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0c0f;--surface:#11151a;--raised:#151a20;--line:#29313a;--ink:#f2f5f7;--muted:#89939d;--cyan:#68d5dc;--cyan2:#2aa7b3;--good:#75d598;--warn:#f2bd64;--danger:#f27b70}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:"Manrope",sans-serif;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px),radial-gradient(800px 500px at 50% -180px,rgba(104,213,220,.13),transparent 70%);background-size:38px 38px,38px 38px,auto}
.shell{width:min(1120px,calc(100% - 36px));margin:0 auto;padding:30px 0 64px}.topbar{display:flex;align-items:center;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.brand{font-family:"Fragment Mono",monospace;font-size:14px;letter-spacing:-.04em}.brand b{color:var(--cyan);font-weight:400}.nav{display:flex;gap:5px;margin-left:18px;padding:4px;background:#0d1014;border:1px solid #20262d;border-radius:9px}.nav a{padding:7px 11px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:12px;font-weight:600}.nav a.active{color:var(--ink);background:var(--raised)}
.top-actions{margin-left:auto;display:flex;gap:8px}.button{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:9px 12px;font:600 12px "Manrope",sans-serif;cursor:pointer;text-decoration:none;transition:border-color .15s,transform .15s}.button:hover{border-color:#52606d;transform:translateY(-1px)}.button.primary{border-color:rgba(104,213,220,.5);background:rgba(104,213,220,.09);color:#bdf5f7}.button.push-on{border-color:rgba(117,213,152,.48);color:#bdf2ce;background:rgba(117,213,152,.08)}
.summary{display:flex;align-items:baseline;justify-content:space-between;gap:20px;padding:20px 0 10px}.summary h1{font-size:22px;line-height:1;letter-spacing:-.045em;margin:0}.summary span{color:var(--muted);font:12px "Fragment Mono",monospace}.planning{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding:9px 11px;background:rgba(17,21,26,.8);border:1px solid var(--line);border-radius:10px}.best{display:flex;align-items:center;gap:9px;min-width:0;font:11px "Fragment Mono",monospace}.best>span{color:var(--cyan);text-transform:uppercase;letter-spacing:.08em}.best strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.best em{color:var(--muted);font-style:normal;white-space:nowrap}.best.unavailable strong{color:var(--muted)}.sources{display:flex;gap:8px;flex:none}.source{display:flex;align-items:center;gap:5px;color:var(--muted);font:10px "Fragment Mono",monospace}.source i{width:6px;height:6px;border-radius:50%;background:var(--good)}.source.stale i{background:var(--warn)}.source.offline i,.source.error i{background:var(--danger)}.source b{color:#c8d0d6;font-weight:400}.source em{font-style:normal}
.utilization{margin:18px 0;padding:17px;background:linear-gradient(145deg,rgba(20,27,31,.96),rgba(12,16,20,.98));border:1px solid rgba(104,213,220,.26);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.18)}.util-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:12px}.util-head h2{margin:0;font-size:18px;letter-spacing:-.035em}.util-head p{margin:4px 0 0;color:var(--muted);font-size:11px}.target-chip{flex:none;padding:6px 8px;border:1px solid rgba(104,213,220,.38);border-radius:99px;color:#bdf5f7;background:rgba(104,213,220,.07);font:10px "Fragment Mono",monospace}.pace-policy{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin-bottom:12px;overflow:hidden;border:1px solid #252e36;border-radius:8px;background:#252e36}.pace-policy span{padding:7px 8px;background:#0c1014;color:#87929b;font:9px/1.35 "Fragment Mono",monospace}.pace-policy b{display:block;margin-bottom:2px;color:#cbd3d8;font-weight:400}.util-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.util-card{min-width:0;padding:12px 13px;background:#0c1014;border:1px solid #252e36;border-left:2px solid var(--accent);border-radius:9px;animation:enter .38s both;animation-delay:var(--delay)}.util-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.util-card header span{color:var(--accent);font:9px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.08em}.util-card h3{margin:3px 0 0;font-size:12px;line-height:1.25;overflow-wrap:anywhere}.util-card header strong{flex:none;padding:4px 6px;border-radius:5px;background:rgba(117,213,152,.1);color:var(--good);font:9px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.06em}.util-card.action-more header strong{background:rgba(242,123,112,.1);color:var(--danger)}.util-card.action-less header strong,.util-card.action-rebalance header strong{background:rgba(242,189,100,.1);color:var(--warn)}.util-card.action-measure header strong{background:rgba(142,169,255,.1);color:#aebfff}.util-projection{margin-top:12px;color:var(--ink);font:18px "Fragment Mono",monospace;letter-spacing:-.04em}.util-track{position:relative;height:5px;margin:8px 0;background:#050709;border-radius:99px}.util-track i{display:block;height:100%;border-radius:99px;background:var(--accent)}.util-track b{position:absolute;top:-3px;width:2px;height:11px;border-radius:2px;background:#fff;box-shadow:0 0 0 1px #050709;transform:translateX(-50%)}.util-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px;color:#c3cbd1;font:10px/1.3 "Fragment Mono",monospace}.util-metrics span{min-width:0}.util-metrics b{display:block;margin-bottom:2px;color:#6f7a83;font-size:8px;font-weight:400;text-transform:uppercase;letter-spacing:.08em}.util-card p{margin:10px 0 0;padding-top:9px;border-top:1px solid #202830;color:#8f9aa3;font-size:10px;line-height:1.45}
.accounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.account-card{display:flex;flex-direction:column;background:linear-gradient(145deg,rgba(21,26,32,.98),rgba(15,19,24,.98));border:1px solid var(--line);border-top-color:color-mix(in srgb,var(--accent) 36%,var(--line));border-radius:13px;padding:15px 16px;box-shadow:0 14px 40px rgba(0,0,0,.16);animation:enter .45s cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--delay)}
.auth-required{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;padding:12px 14px;border:1px solid rgba(242,189,100,.42);border-radius:10px;background:rgba(242,189,100,.07)}.auth-required div{display:flex;flex-direction:column;gap:2px}.auth-required strong{color:var(--warn);font:11px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.08em}.auth-required span{color:#cbd2d7;font-size:12px}.auth-required a{flex:none;color:#101317;background:var(--warn);border-radius:7px;padding:8px 10px;font:700 11px "Manrope",sans-serif;text-decoration:none}
.account-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.identity{min-width:0}.identity h2{font-size:16px;line-height:1.16;letter-spacing:-.025em;margin:0;overflow-wrap:anywhere}.account-email{display:block;margin-top:4px;color:var(--muted);font:10px/1.3 "Fragment Mono",monospace;overflow-wrap:anywhere}.account-meta{flex:none;text-align:right}.account-meta strong{display:block;font:12px "Fragment Mono",monospace;color:#dce2e6}.updated{display:block;color:var(--muted);font:11px/1.3 "Fragment Mono",monospace;margin-top:4px;white-space:nowrap}
.limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(41,49,58,.75)}.limit-head,.limit-meta,.pace,.equivalent{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.limit-head span{color:#b9c1c8;font-size:11px;font-weight:600}.limit-head strong{font:14px "Fragment Mono",monospace;white-space:nowrap}.track{position:relative;height:6px;margin:8px 0 7px;background:#080a0d;border:1px solid #1b2229;border-radius:99px;overflow:visible}.track>i{display:block;max-width:100%;height:100%;background:var(--accent,var(--cyan));border-radius:99px;box-shadow:0 0 18px color-mix(in srgb,var(--accent,var(--cyan)) 30%,transparent);animation:fill .8s cubic-bezier(.2,.8,.2,1) both}.limit.warn .track>i{background:var(--warn)}.limit.danger .track>i{background:var(--danger)}.pace-marker{--marker-color:#a8ffb9;position:absolute;z-index:2;top:50%;left:var(--pace-left);display:flex;height:12px;gap:3px;transform:translate(-50%,-50%);pointer-events:none}.pace-marker b{display:block;width:2px;height:100%;border-radius:2px;background:var(--marker-color);box-shadow:0 0 0 1px #020304,0 0 7px var(--marker-color)}.pace-marker.deficit{--marker-color:#ff776d}.limit-meta{justify-content:flex-end;color:var(--muted);font:12px/1.35 "Fragment Mono",monospace}.limit-meta.split{justify-content:space-between}.pace{margin-top:6px;color:#aab3ba;font:12px/1.35 "Fragment Mono",monospace}.pace strong{color:var(--accent);font-weight:400;white-space:nowrap}.equivalent{margin-top:6px;color:#aab3ba;font:12px/1.35 "Fragment Mono",monospace;padding-top:5px;border-top:1px solid rgba(41,49,58,.55)}.equivalent strong{color:var(--muted);font-weight:400;white-space:nowrap}.limit.balance{justify-content:center;min-height:45px}.limit.unreadable .limit-head strong{color:var(--warn)}.limit.unreadable .limit-meta,.limit.unreadable .pace{color:#7d868e}.track.stale>i{background:#3a444d;box-shadow:none;opacity:.65}.limit.balance .limit-meta{margin-top:7px}.copilot-usage,.copilot-pool{display:flex;flex-direction:column;justify-content:center;min-height:50px}.copilot-usage .limit-meta,.copilot-pool .limit-meta{margin-top:7px}
.setup{display:none;margin-top:14px;padding:20px;background:#0d1115;border:1px solid #34414c;border-radius:12px}.setup.open{display:block;animation:enter .25s both}.setup-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:15px}.setup h2{font-size:18px;margin:0 0 5px}.setup-head p{color:var(--muted);font-size:12px;margin:0}.profile-field{display:flex;flex-direction:column;gap:5px;flex:0 0 210px}.profile-field span{color:#aab3ba;font:10px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.08em}.profile-field input{width:100%;padding:9px 10px;color:var(--ink);background:#07090b;border:1px solid #34414c;border-radius:7px;font:12px "Fragment Mono",monospace;outline:none}.profile-field input:focus{border-color:var(--cyan)}.provider-setup{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}.setup-item{min-width:0;padding:13px;border:1px solid #242c34;border-radius:9px}.setup-label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.setup-label b{color:var(--item-accent);font:11px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.1em}.auth-kind{padding:3px 6px;border:1px solid color-mix(in srgb,var(--item-accent) 45%,#242c34);border-radius:99px;color:#cbd3d8;font:9px "Fragment Mono",monospace;text-transform:uppercase}.setup-item p{font-size:12px;line-height:1.45;color:#aab3ba;margin:0 0 10px}.command{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 11px;background:#07090b;border:1px solid #202830;border-radius:8px}.command+.command{margin-top:7px}.command code{flex:1;min-width:0;font:11px "Fragment Mono",monospace;color:#d5dce0;overflow:auto;white-space:nowrap}.copy{margin-left:auto;flex:none;background:none;border:0;color:var(--item-accent,var(--cyan));font:10px "Fragment Mono",monospace;cursor:pointer}.alternatives{margin-top:8px;color:var(--muted);font-size:11px}.alternatives summary{cursor:pointer}.alternatives .command{margin-top:7px}.page-meta{text-align:right;margin-top:14px;color:#6e7881;font:11px "Fragment Mono",monospace}
@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes fill{from{width:0}}
@media(max-width:900px){.accounts,.util-grid{grid-template-columns:1fr}.pace-policy{grid-template-columns:repeat(3,1fr)}}
@media(max-width:720px){.shell{width:min(100% - 24px,1120px);padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(64px,env(safe-area-inset-bottom))}.topbar{display:grid;grid-template-columns:1fr auto;gap:12px 8px}.nav{grid-column:1/-1;grid-row:2;width:100%;margin:0;display:grid;grid-template-columns:repeat(3,1fr)}.nav a{display:grid;place-items:center;min-height:44px;padding:7px 5px;text-align:center}.top-actions{margin:0}.button{min-height:44px}.summary{padding-top:18px}.planning,.util-head{align-items:flex-start;flex-direction:column}.best{flex-wrap:wrap}.best em{white-space:normal}.pace-policy{grid-template-columns:1fr 1fr}.limits,.provider-setup{grid-template-columns:1fr}.updated{white-space:normal}.setup-head{align-items:stretch;flex-direction:column}.profile-field{flex-basis:auto}}
@media(max-width:480px){.topbar{grid-template-columns:1fr}.brand{padding-top:2px}.top-actions{grid-row:2;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;gap:6px}.top-actions.install-ready{grid-template-columns:repeat(2,minmax(0,1fr))}.top-actions .button{min-width:0;padding:8px 5px;white-space:normal}.nav{grid-row:3}.summary{align-items:flex-start;flex-direction:column;gap:5px}.planning{padding:11px}.sources{flex-wrap:wrap}.account-card{padding:14px}.account-head{display:block;position:relative;padding-right:42px}.account-meta{text-align:left}.account-meta strong{position:absolute;right:0;top:0}.updated{margin-top:8px;font-size:10px}.auth-required{align-items:stretch;flex-direction:column}.auth-required a{text-align:center;min-height:44px;display:grid;place-items:center}.utilization{padding:14px}.util-metrics{gap:5px}.setup{padding:15px}.command{gap:6px;padding:9px}.copy{min-width:44px;min-height:44px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head><body><main class="shell">
<div class="topbar"><div class="brand"><b>spend</b>watch</div><nav class="nav"><a class="active" href="./">Capacity</a><a href="${esc(spendHref)}">Spend detail</a><a href="${esc(historyHref)}">History</a></nav><div class="top-actions"><button class="button primary" id="install" hidden>Install app</button><button class="button" id="alerts">Enable alerts</button><button class="button" id="refresh">Refresh</button><button class="button primary" id="add">Add account</button></div></div>
<section class="summary"><h1>Current capacity</h1><span>${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${providerCount} service${providerCount === 1 ? "" : "s"}</span></section>
<section class="planning">${recommendationHtml}${sourceHtml}</section>
${authenticationHtml}
<section class="setup" id="setup"><div class="setup-head"><div><h2>Connect another account</h2><p>Copy one command to a trusted Mac. Provider credentials never reach this dashboard.</p></div><label class="profile-field"><span>Profile name</span><input id="profile-name" value="new-account" maxlength="32" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false"></label></div><div class="provider-setup">
  <div class="setup-item" style="--item-accent:#68d5dc"><div class="setup-label"><b>Codex</b><span class="auth-kind">ChatGPT OAuth</span></div><p>Official browser sign-in. Each named profile stays logged in and refreshes independently.</p><div class="command"><code data-template="spendwatch account add codex --name {name}">spendwatch account add codex --name new-account</code><button class="copy">COPY</button></div><details class="alternatives"><summary>Headless or metered API key</summary><div class="command"><code data-template="spendwatch account add codex --name {name} --device-auth">spendwatch account add codex --name new-account --device-auth</code><button class="copy">COPY</button></div><div class="command"><code data-template="spendwatch account add codex --name {name} --api-key-env OPENAI_API_KEY">spendwatch account add codex --name new-account --api-key-env OPENAI_API_KEY</code><button class="copy">COPY</button></div></details></div>
  <div class="setup-item" style="--item-accent:#e69a73"><div class="setup-label"><b>Claude</b><span class="auth-kind">Claude OAuth</span></div><p>Official browser sign-in in a separate local Claude configuration.</p><div class="command"><code data-template="spendwatch account add claude --name {name}">spendwatch account add claude --name new-account</code><button class="copy">COPY</button></div></div>
  <div class="setup-item" style="--item-accent:#8ea9ff"><div class="setup-label"><b>Copilot</b><span class="auth-kind">GitHub OAuth</span></div><p>GitHub CLI keeps multiple identities; Copilot Business capacity follows the signed-in account.</p><div class="command"><code>spendwatch account add copilot</code><button class="copy">COPY</button></div></div>
  <div class="setup-item" style="--item-accent:#b8d96b"><div class="setup-label"><b>Lokai</b><span class="auth-kind">API keys</span></div><p>Keys stay in the existing local LiteLLM/1Password setup. This only verifies routes and balances.</p><div class="command"><code>lokai-router check</code><button class="copy">COPY</button></div></div>
</div></section>
<section class="accounts">${cards}</section>
<section class="utilization"><header class="util-head"><div><h2>${UTILIZATION_TARGET_PERCENT}% utilization plan</h2><p>Use paid capacity deliberately while preserving a ${100 - UTILIZATION_TARGET_PERCENT}% interruption buffer.</p></div><span class="target-chip">Target ${UTILIZATION_TARGET_PERCENT}% · buffer ${100 - UTILIZATION_TARGET_PERCENT}%</span></header><div class="pace-policy"><span><b>&lt;60% projected</b>Less, after 2 cycles</span><span><b>60–80%</b>Shift work here</span><span><b>80–95%</b>Keep plan</span><span><b>95–105%</b>Keep, ease pace</span><span><b>&gt;105%</b>More capacity</span></div><div class="util-grid">${utilizationHtml}</div></section>
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
const hydrateRelative=(root=document)=>{root.querySelectorAll('[data-reset]').forEach(el=>el.textContent=relative(el.dataset.reset,'reset'));root.querySelectorAll('[data-exhaust]').forEach(el=>el.textContent=relative(el.dataset.exhaust,'exhaust'));root.querySelectorAll('[data-updated]').forEach(el=>el.textContent=relative(el.dataset.updated,'updated')+(el.dataset.devices||''));root.querySelectorAll('[data-source-status]').forEach(el=>{const status=el.dataset.sourceStatus;el.textContent=status==='live'?'live':status+' '+compactDuration(Math.max(0,Date.now()-Date.parse(el.dataset.sourceLast)))});const generated=root.querySelector('#generated');if(generated)generated.textContent=relative(generated.dataset.generated,'updated')+' · auto 15s'};
const syncAttrs=(current,next)=>{for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value)};
const patchNode=(current,next)=>{if(current.nodeType!==next.nodeType||current.nodeName!==next.nodeName){current.replaceWith(next.cloneNode(true));return}if(current.nodeType===Node.TEXT_NODE){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return}syncAttrs(current,next);const before=[...current.childNodes],after=[...next.childNodes],shared=Math.min(before.length,after.length);for(let i=0;i<shared;i++)patchNode(before[i],after[i]);for(let i=before.length-1;i>=after.length;i--)before[i].remove();for(let i=shared;i<after.length;i++)current.append(after[i].cloneNode(true))};
const refreshButton=document.querySelector('#refresh');let refreshing=false;
const alertButton=document.querySelector('#alerts');
const pushSupported=()=>window.isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
const applicationKey=value=>{const padding='='.repeat((4-value.length%4)%4),base64=(value+padding).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(base64);return Uint8Array.from([...raw].map(char=>char.charCodeAt(0)))};
const subscriptionRequest=(path,subscription)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:subscription.toJSON()})});
const updateAlertButton=async()=>{alertButton.hidden=false;if(!pushSupported()){alertButton.textContent='Alerts unavailable';alertButton.disabled=true;return}if(Notification.permission==='denied'){alertButton.textContent='Alerts blocked';alertButton.title='Allow notifications for this site in browser settings';return}const registration=await navigator.serviceWorker.getRegistration('/'),subscription=await registration?.pushManager.getSubscription();if(!subscription){alertButton.textContent='Enable alerts';alertButton.classList.remove('push-on');alertButton.title='Enable background alerts on this device';return}try{const response=await subscriptionRequest('/api/push/status',subscription),status=await response.json();if(response.ok&&status.verified){alertButton.hidden=true;return}}catch{}alertButton.textContent='Test alerts';alertButton.classList.add('push-on');alertButton.title='Send one test alert to verify background delivery'};
const enableOrTestAlerts=async()=>{if(!pushSupported())return;alertButton.disabled=true;alertButton.textContent='Connecting';try{const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission not granted');const configResponse=await fetch('/api/push/config',{cache:'no-store'});if(!configResponse.ok)throw new Error('Push configuration unavailable');const config=await configResponse.json();let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});const response=await subscriptionRequest('/api/push/subscribe',subscription);const result=await response.json();if(!response.ok)throw new Error(result.error||'Subscription failed');alertButton.textContent=result.testSent?'Test sent':'Alerts active';alertButton.classList.add('push-on');if(result.testSent)alertButton.hidden=true;else setTimeout(()=>void updateAlertButton(),1800)}catch(error){alertButton.hidden=false;alertButton.textContent='Retry alerts';alertButton.title=String(error)}finally{alertButton.disabled=false}};
const refreshValues=async(interactive=false)=>{if(refreshing)return;refreshing=true;if(interactive){refreshButton.setAttribute('aria-busy','true');refreshButton.textContent='Syncing'}try{const url=new URL(location.href);url.hash='';url.searchParams.set('_',Date.now().toString());const response=await fetch(url,{cache:'no-store',headers:{Accept:'text/html'}});if(!response.ok)throw new Error('HTTP '+response.status);const next=new DOMParser().parseFromString(await response.text(),'text/html');hydrateRelative(next);for(const selector of ['.summary','.planning','.utilization']){const incoming=next.querySelector(selector),current=document.querySelector(selector);if(incoming&&current&&current.innerHTML!==incoming.innerHTML)patchNode(current,incoming)}const host=document.querySelector('.accounts'),current=new Map([...host.querySelectorAll('[data-account-key]')].map(card=>[card.dataset.accountKey,card])),seen=new Set();let index=0;for(const nextCard of next.querySelectorAll('[data-account-key]')){const key=nextCard.dataset.accountKey;seen.add(key);let card=current.get(key);if(card){if(card.outerHTML!==nextCard.outerHTML)patchNode(card,nextCard)}else{card=nextCard.cloneNode(true)}if(host.children[index]!==card)host.insertBefore(card,host.children[index]||null);index++}for(const [key,card] of current){if(!seen.has(key))card.remove()}const nextGenerated=next.querySelector('#generated'),generated=document.querySelector('#generated');if(nextGenerated&&generated&&generated.dataset.generated!==nextGenerated.dataset.generated)generated.dataset.generated=nextGenerated.dataset.generated||'';if(interactive)refreshButton.textContent='Updated';refreshButton.title='Values updated without reloading the page'}catch(error){refreshButton.title='Value refresh failed: '+String(error);if(interactive)refreshButton.textContent='Retry'}finally{refreshing=false;if(interactive)refreshButton.removeAttribute('aria-busy');hydrateRelative()}};
hydrateRelative();refreshButton.addEventListener('click',()=>refreshValues(true));setInterval(()=>refreshValues(false),15000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshValues(false)});
alertButton.addEventListener('click',enableOrTestAlerts);void updateAlertButton();
const setup=document.querySelector('#setup');
document.querySelector('#add').addEventListener('click',()=>setup.classList.toggle('open'));
if(location.hash==='#setup')setup.classList.add('open');
document.querySelectorAll('.auth-required a').forEach(link=>link.addEventListener('click',event=>{const row=event.currentTarget.closest('.auth-required');setup.classList.add('open');profileName.value=row.dataset.authProfile==='default'?'default':row.dataset.authProfile;updateCommands();setTimeout(()=>setup.scrollIntoView({behavior:'smooth',block:'start'}),0)}));
const profileName=document.querySelector('#profile-name');const updateCommands=()=>{const name=(profileName.value.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'new-account');document.querySelectorAll('[data-template]').forEach(code=>code.textContent=code.dataset.template.replace('{name}',name))};profileName.addEventListener('input',updateCommands);updateCommands();
document.querySelectorAll('.copy').forEach(button=>button.addEventListener('click',async event=>{const code=event.currentTarget.parentElement.querySelector('code').textContent;await navigator.clipboard.writeText(code);event.currentTarget.textContent='COPIED';setTimeout(()=>event.currentTarget.textContent='COPY',1400)}));
</script></body></html>`;
}

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OpenRouterActivityRow,
  OpenRouterCapacity,
  OpenRouterCapacityResult,
  OpenRouterHistory,
  OpenRouterUsageTotals,
} from "./openrouter-types";
import {
  loadOpenRouterPriceCache,
  normalizeOpenRouterModelPrices,
  validateOpenRouterPriceCache,
  type OpenRouterModelPrice,
  type OpenRouterPriceCache,
  type OpenRouterPriceOverride,
} from "./openrouter-prices";

export {
  loadOpenRouterPriceCache,
  normalizeOpenRouterModelPrices,
  validateOpenRouterPriceCache,
  type OpenRouterModelPrice,
  type OpenRouterPriceCache,
  type OpenRouterPriceOverride,
};

const API_ORIGIN = "https://openrouter.ai/api/v1";
const DEFAULT_CONFIG = "~/.config/spendwatch/openrouter.json";
const DEFAULT_PRICES = "~/.config/spendwatch/openrouter-model-prices.json";
const DEFAULT_CACHE_DIR = "~/.local/state/spendwatch/openrouter";
const CREDIT_TTL_MS = 5 * 60_000;
const ACTIVITY_TTL_MS = 60 * 60_000;
const PRICES_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface CollectOpenRouterOptions {
  configPath?: string;
  pricesPath?: string;
  now?: number;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface Config {
  account: string;
  apiKeyFile: string;
  usageKeyFile?: string;
  cacheDir: string;
}

interface CreditCache {
  capturedAt: string;
  totalCreditsUsd: number;
  totalUsageUsd: number;
}

interface KeyCache {
  capturedAt: string;
  keyUsage: NonNullable<OpenRouterCapacity["keyUsage"]>;
}

interface ActivityCache {
  capturedAt: string;
  fetchedFrom: string;
  fetchedThrough: string;
  rows: OpenRouterActivityRow[];
}

type NetworkResult<T> = { ok: true; value: T } | { ok: false };

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, maximum = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= maximum && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function wrapped(value: unknown): unknown {
  const root = object(value);
  return root?.data !== undefined ? root.data : value;
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function privateRegularFile(path: string): boolean {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`OpenRouter private file permissions are invalid: ${path}`);
  }
  return true;
}

function readSecret(path: string): string {
  privateRegularFile(path);
  const value = readFileSync(path, "utf8").trim();
  if (!value || value.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("OpenRouter credential file is invalid");
  }
  return value;
}

function loadConfig(path: string): Config | null {
  if (!existsSync(path)) return null;
  privateRegularFile(path);
  const raw = object(JSON.parse(readFileSync(path, "utf8")));
  if (!raw) throw new Error("OpenRouter config must be a JSON object");
  const apiKeyFile = text(raw.apiKeyFile, 4096);
  if (!apiKeyFile) throw new Error("OpenRouter config requires apiKeyFile");
  const usageKeyFile = raw.usageKeyFile === undefined ? undefined : text(raw.usageKeyFile, 4096);
  if (raw.usageKeyFile !== undefined && !usageKeyFile) throw new Error("OpenRouter usageKeyFile is invalid");
  const cacheDir = raw.cacheDir === undefined ? DEFAULT_CACHE_DIR : text(raw.cacheDir, 4096);
  if (!cacheDir) throw new Error("OpenRouter cacheDir is invalid");
  return {
    account: text(raw.account, 200) ?? "OpenRouter account",
    apiKeyFile: expandPath(apiKeyFile),
    ...(usageKeyFile ? { usageKeyFile: expandPath(usageKeyFile) } : {}),
    cacheDir: expandPath(cacheDir),
  };
}

function readJson(path: string): unknown {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function validCapture(value: unknown, now: number): string | undefined {
  const capturedAt = iso(value);
  if (!capturedAt || Date.parse(capturedAt) > now + MAX_FUTURE_SKEW_MS) return undefined;
  return capturedAt;
}

function loadCreditCache(path: string, now: number): CreditCache | undefined {
  const raw = object(readJson(path));
  const capturedAt = validCapture(raw?.capturedAt, now);
  const totalCreditsUsd = finiteNonNegative(raw?.totalCreditsUsd);
  const totalUsageUsd = finiteNonNegative(raw?.totalUsageUsd);
  return capturedAt && totalCreditsUsd !== undefined && totalUsageUsd !== undefined
    ? { capturedAt, totalCreditsUsd, totalUsageUsd }
    : undefined;
}

function normalizeKeyUsage(value: unknown): KeyCache | undefined {
  const raw = object(wrapped(value));
  if (!raw) return undefined;
  const label = text(raw.label, 200);
  const dailyUsd = finiteNonNegative(raw.usage_daily);
  const weeklyUsd = finiteNonNegative(raw.usage_weekly);
  const monthlyUsd = finiteNonNegative(raw.usage_monthly);
  const allTimeUsd = finiteNonNegative(raw.usage);
  if (!label || [dailyUsd, weeklyUsd, monthlyUsd, allTimeUsd].some((item) => item === undefined)) return undefined;
  const limitUsd = raw.limit == null ? undefined : finiteNonNegative(raw.limit);
  const remainingUsd = raw.limit_remaining == null ? undefined : finiteNonNegative(raw.limit_remaining);
  const byokUsd = raw.byok_usage == null ? undefined : finiteNonNegative(raw.byok_usage);
  const reset = raw.limit_reset == null ? undefined : iso(raw.limit_reset);
  const expiresAt = raw.expires_at == null ? undefined : iso(raw.expires_at);
  if ((raw.limit != null && limitUsd === undefined) || (raw.limit_remaining != null && remainingUsd === undefined)
    || (raw.byok_usage != null && byokUsd === undefined) || (raw.limit_reset != null && !reset)
    || (raw.expires_at != null && !expiresAt) || (limitUsd !== undefined && remainingUsd !== undefined && remainingUsd > limitUsd)) {
    return undefined;
  }
  return {
    capturedAt: "",
    keyUsage: {
      label, dailyUsd: dailyUsd!, weeklyUsd: weeklyUsd!, monthlyUsd: monthlyUsd!, allTimeUsd: allTimeUsd!,
      ...(limitUsd !== undefined ? { limitUsd } : {}),
      ...(remainingUsd !== undefined ? { remainingUsd } : {}),
      ...(reset ? { reset } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(byokUsd !== undefined ? { byokUsd } : {}),
    },
  };
}

function loadKeyCache(path: string, now: number): KeyCache | undefined {
  const raw = object(readJson(path));
  const capturedAt = validCapture(raw?.capturedAt, now);
  const keyUsage = object(raw?.keyUsage);
  const label = text(keyUsage?.label, 200);
  const dailyUsd = finiteNonNegative(keyUsage?.dailyUsd);
  const weeklyUsd = finiteNonNegative(keyUsage?.weeklyUsd);
  const monthlyUsd = finiteNonNegative(keyUsage?.monthlyUsd);
  const allTimeUsd = finiteNonNegative(keyUsage?.allTimeUsd);
  const limitUsd = keyUsage?.limitUsd === undefined ? undefined : finiteNonNegative(keyUsage.limitUsd);
  const remainingUsd = keyUsage?.remainingUsd === undefined ? undefined : finiteNonNegative(keyUsage.remainingUsd);
  const byokUsd = keyUsage?.byokUsd === undefined ? undefined : finiteNonNegative(keyUsage.byokUsd);
  const reset = keyUsage?.reset === undefined ? undefined : iso(keyUsage.reset);
  const expiresAt = keyUsage?.expiresAt === undefined ? undefined : iso(keyUsage.expiresAt);
  if (!capturedAt || !label || [dailyUsd, weeklyUsd, monthlyUsd, allTimeUsd].some((item) => item === undefined)
    || (keyUsage?.limitUsd !== undefined && limitUsd === undefined)
    || (keyUsage?.remainingUsd !== undefined && remainingUsd === undefined)
    || (keyUsage?.byokUsd !== undefined && byokUsd === undefined)
    || (keyUsage?.reset !== undefined && !reset) || (keyUsage?.expiresAt !== undefined && !expiresAt)) return undefined;
  return { capturedAt, keyUsage: {
    label, dailyUsd: dailyUsd!, weeklyUsd: weeklyUsd!, monthlyUsd: monthlyUsd!, allTimeUsd: allTimeUsd!,
    ...(limitUsd !== undefined ? { limitUsd } : {}), ...(remainingUsd !== undefined ? { remainingUsd } : {}),
    ...(reset ? { reset } : {}), ...(expiresAt ? { expiresAt } : {}), ...(byokUsd !== undefined ? { byokUsd } : {}),
  } };
}

function keyCacheFromNetwork(value: unknown, capturedAt: string): KeyCache {
  const normalized = normalizeKeyUsage(value);
  if (!normalized) throw new Error("invalid OpenRouter key response");
  return { capturedAt, keyUsage: normalized.keyUsage };
}

function utcDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.000)?Z?)?$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === match[1] ? match[1] : undefined;
}

export function normalizeOpenRouterActivity(value: unknown): OpenRouterActivityRow[] {
  const rawRows = wrapped(value);
  if (!Array.isArray(rawRows)) throw new Error("invalid OpenRouter activity response");
  const rows = rawRows.flatMap((value) => {
    const raw = object(value);
    const date = utcDate(raw?.date);
    if (!raw || !date) return [];
    const model = text(raw.model ?? raw.model_permaslug, 300) ?? "unknown";
    const provider = text(raw.provider_name, 300) ?? "";
    const endpointId = text(raw.endpoint_id, 300) ?? "";
    const costUsd = finiteNonNegative(raw.usage);
    const requests = finiteInteger(raw.requests);
    const promptTokens = finiteInteger(raw.prompt_tokens);
    const completionTokens = finiteInteger(raw.completion_tokens);
    const reasoningTokens = finiteInteger(raw.reasoning_tokens ?? 0);
    const cachedTokens = finiteInteger(raw.cached_tokens ?? 0);
    const byokCostUsd = finiteNonNegative(raw.byok_usage_inference ?? 0);
    const byokRequests = finiteInteger(raw.byok_requests ?? 0);
    if ([costUsd, requests, promptTokens, completionTokens, reasoningTokens, cachedTokens, byokCostUsd, byokRequests]
      .some((item) => item === undefined)) return [];
    return [{ date, model, provider, endpointId, costUsd: costUsd!, requests: requests!, promptTokens: promptTokens!,
      completionTokens: completionTokens!, reasoningTokens: reasoningTokens!, cachedTokens: cachedTokens!,
      byokCostUsd: byokCostUsd!, byokRequests: byokRequests! }];
  });
  if (rows.length !== rawRows.length) throw new Error("invalid OpenRouter activity row");
  return rows;
}

export function normalizeOpenRouterCredits(value: unknown): Pick<CreditCache, "totalCreditsUsd" | "totalUsageUsd"> {
  const raw = object(wrapped(value));
  const totalCreditsUsd = finiteNonNegative(raw?.total_credits);
  const totalUsageUsd = finiteNonNegative(raw?.total_usage);
  if (totalCreditsUsd === undefined || totalUsageUsd === undefined) throw new Error("invalid OpenRouter credits response");
  return { totalCreditsUsd, totalUsageUsd };
}

function activityKey(row: OpenRouterActivityRow): string {
  return [row.date, row.model, row.provider, row.endpointId].join("\u0000");
}

export function mergeOpenRouterActivity(previous: OpenRouterActivityRow[], incoming: OpenRouterActivityRow[]): OpenRouterActivityRow[] {
  const rows = new Map(previous.map((row) => [activityKey(row), row]));
  for (const row of incoming) rows.set(activityKey(row), row);
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model)
    || a.provider.localeCompare(b.provider) || a.endpointId.localeCompare(b.endpointId));
}

function validActivityCache(value: unknown, now: number): ActivityCache | undefined {
  const raw = object(value);
  // The archive may contain rows older than the refresh window. Only the
  // capture timestamp, not the rows' dates, participates in freshness.
  const capturedAt = validCapture(raw?.capturedAt, now);
  const fetchedFrom = iso(raw?.fetchedFrom);
  const fetchedThrough = iso(raw?.fetchedThrough);
  if (!capturedAt || !fetchedFrom || !fetchedThrough || !Array.isArray(raw?.rows)) return undefined;
  try {
    const rows = raw.rows.flatMap((value): OpenRouterActivityRow[] => {
      const entry = object(value);
      const date = utcDate(entry?.date);
      const model = text(entry?.model, 300);
      const provider = text(entry?.provider, 300);
      const endpointId = text(entry?.endpointId, 300);
      const costUsd = finiteNonNegative(entry?.costUsd);
      const requests = finiteInteger(entry?.requests);
      const promptTokens = finiteInteger(entry?.promptTokens);
      const completionTokens = finiteInteger(entry?.completionTokens);
      const reasoningTokens = finiteInteger(entry?.reasoningTokens);
      const cachedTokens = finiteInteger(entry?.cachedTokens);
      const byokCostUsd = finiteNonNegative(entry?.byokCostUsd);
      const byokRequests = finiteInteger(entry?.byokRequests);
      if (!date || !model || provider === undefined || endpointId === undefined
        || [costUsd, requests, promptTokens, completionTokens, reasoningTokens, cachedTokens, byokCostUsd, byokRequests]
          .some((item) => item === undefined)) return [];
      return [{ date, model, provider, endpointId, costUsd: costUsd!, requests: requests!, promptTokens: promptTokens!,
        completionTokens: completionTokens!, reasoningTokens: reasoningTokens!, cachedTokens: cachedTokens!,
        byokCostUsd: byokCostUsd!, byokRequests: byokRequests! }];
    });
    if (rows.length !== raw.rows.length) return undefined;
    return { capturedAt, fetchedFrom, fetchedThrough, rows };
  } catch { return undefined; }
}

export function openRouterCompletedWindow(now: number): { from: string; through: string } {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const through = today - 1;
  return { from: new Date(today - 30 * DAY_MS).toISOString(), through: new Date(through).toISOString() };
}

function emptyTotals(): OpenRouterUsageTotals {
  return { costUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
}

function addTotals(total: OpenRouterUsageTotals, row: OpenRouterActivityRow): void {
  total.costUsd += row.costUsd;
  total.requests += row.requests;
  total.promptTokens += row.promptTokens;
  total.completionTokens += row.completionTokens;
  total.reasoningTokens += row.reasoningTokens;
  total.cachedTokens += row.cachedTokens;
}

export function openRouterHistory(cache: Pick<ActivityCache, "capturedAt" | "fetchedFrom" | "fetchedThrough" | "rows">): OpenRouterHistory {
  const totals = emptyTotals();
  const days = new Map<string, OpenRouterUsageTotals>();
  const months = new Map<string, OpenRouterUsageTotals>();
  const models = new Map<string, OpenRouterUsageTotals>();
  for (const row of cache.rows) {
    addTotals(totals, row);
    const day = days.get(row.date) ?? emptyTotals(); addTotals(day, row); days.set(row.date, day);
    const monthKey = row.date.slice(0, 7);
    const month = months.get(monthKey) ?? emptyTotals(); addTotals(month, row); months.set(monthKey, month);
    const model = models.get(row.model) ?? emptyTotals(); addTotals(model, row); models.set(row.model, model);
  }
  const retainedFrom = cache.rows.reduce<string | undefined>((oldest, row) =>
    !oldest || row.date < oldest ? row.date : oldest, undefined);
  return {
    updatedAt: cache.capturedAt,
    availableFrom: cache.fetchedFrom,
    availableThrough: cache.fetchedThrough,
    ...(retainedFrom ? { retainedFrom: `${retainedFrom}T00:00:00.000Z` } : {}),
    totals,
    days: [...days].map(([date, values]) => ({ date, ...values })).sort((a, b) => b.date.localeCompare(a.date)),
    months: [...months].map(([month, values]) => ({ month, ...values })).sort((a, b) => b.month.localeCompare(a.month)),
    models: [...models].map(([model, values]) => ({ model, ...values })).sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)),
    machineAttribution: "unattributed",
  };
}

function loadPriceCache(path: string, now: number): OpenRouterPriceCache | undefined {
  return loadOpenRouterPriceCache({ pricesPath: path, now });
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new Error("OpenRouter response is too large");
  if (!response.body) throw new Error("OpenRouter response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("OpenRouter response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("OpenRouter returned invalid JSON"); }
}

async function apiJson(path: string, credential: string, maximum: number, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_ORIGIN}${path}`, {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${credential}`, "User-Agent": "spendwatch/0.3" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch { throw new Error(`OpenRouter request failed for ${path}`); }
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status} for ${path}`);
  return boundedJson(response, maximum);
}

async function publicModels(fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_ORIGIN}/models`, { method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "spendwatch/0.3" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new Error("OpenRouter model catalog request failed"); }
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status} for /models`);
  return boundedJson(response, 8 * 1024 * 1024);
}

async function attempt<T>(operation: () => Promise<T>): Promise<NetworkResult<T>> {
  try { return { ok: true, value: await operation() }; } catch { return { ok: false }; }
}

export async function collectOpenRouterCapacity(options: CollectOpenRouterOptions = {}): Promise<OpenRouterCapacityResult | null> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const configPath = expandPath(options.configPath ?? env.SPENDWATCH_OPENROUTER_CONFIG ?? DEFAULT_CONFIG);
  const config = loadConfig(configPath);
  if (!config) return null;
  const pricesPath = expandPath(options.pricesPath ?? env.SPENDWATCH_OPENROUTER_PRICES ?? DEFAULT_PRICES);
  const fetchImpl = options.fetch ?? fetch;
  const managementKey = readSecret(config.apiKeyFile);
  let usageKey: string | undefined;
  try { usageKey = config.usageKeyFile ? readSecret(config.usageKeyFile) : undefined; } catch {
    // An unavailable inference credential cannot hide account credits/history.
  }
  mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });

  const creditPath = join(config.cacheDir, "credits.json");
  const keyPath = join(config.cacheDir, "key.json");
  const activityPath = join(config.cacheDir, "activity.json");
  const creditCache = loadCreditCache(creditPath, now);
  const keyCache = loadKeyCache(keyPath, now);
  const activityCache = validActivityCache(readJson(activityPath), now);
  const priceCache = loadPriceCache(pricesPath, now);
  const stale = (capturedAt: string | undefined, ttl: number) => !capturedAt || now - Date.parse(capturedAt) >= ttl;
  const window = openRouterCompletedWindow(now);

  const [creditNetwork, keyNetwork, activityNetwork, pricesNetwork] = await Promise.all([
    stale(creditCache?.capturedAt, CREDIT_TTL_MS)
      ? attempt(async () => ({ ...normalizeOpenRouterCredits(await apiJson("/credits", managementKey, 64 * 1024, fetchImpl)),
        capturedAt: new Date(now).toISOString() }))
      : Promise.resolve<NetworkResult<CreditCache>>({ ok: false }),
    usageKey && stale(keyCache?.capturedAt, CREDIT_TTL_MS)
      ? attempt(async () => keyCacheFromNetwork(await apiJson("/key", usageKey, 64 * 1024, fetchImpl), new Date(now).toISOString()))
      : Promise.resolve<NetworkResult<KeyCache>>({ ok: false }),
    stale(activityCache?.capturedAt, ACTIVITY_TTL_MS)
      ? attempt(async () => ({ capturedAt: new Date(now).toISOString(), fetchedFrom: window.from, fetchedThrough: window.through,
        rows: normalizeOpenRouterActivity(await apiJson("/activity", managementKey, 16 * 1024 * 1024, fetchImpl)) }))
      : Promise.resolve<NetworkResult<ActivityCache>>({ ok: false }),
    stale(priceCache?.updatedAt, PRICES_TTL_MS)
      ? attempt(async () => normalizeOpenRouterModelPrices(await publicModels(fetchImpl), new Date(now).toISOString()))
      : Promise.resolve<NetworkResult<OpenRouterPriceCache>>({ ok: false }),
  ]);

  if (creditNetwork.ok) writePrivateJson(creditPath, creditNetwork.value);
  if (keyNetwork.ok) writePrivateJson(keyPath, keyNetwork.value);
  if (pricesNetwork.ok) writePrivateJson(pricesPath, pricesNetwork.value);
  let historyCache = activityCache;
  if (activityNetwork.ok) {
    historyCache = { ...activityNetwork.value, rows: mergeOpenRouterActivity(activityCache?.rows ?? [], activityNetwork.value.rows) };
    writePrivateJson(activityPath, historyCache);
  }

  const credits = creditNetwork.ok ? creditNetwork.value : creditCache;
  if (!credits) throw new Error("OpenRouter credits are unavailable");
  const key = keyNetwork.ok ? keyNetwork.value : keyCache;
  const capturedAt = key && Date.parse(key.capturedAt) < Date.parse(credits.capturedAt) ? key.capturedAt : credits.capturedAt;
  return {
    provider: "openrouter",
    account: config.account,
    usage: { accountEmail: config.account, loginMethod: "Pay as you go", primary: null, secondary: null, tertiary: null, updatedAt: capturedAt },
    openrouter: {
      balanceUsd: Math.max(0, credits.totalCreditsUsd - credits.totalUsageUsd),
      totalCreditsUsd: credits.totalCreditsUsd,
      totalUsageUsd: credits.totalUsageUsd,
      ...(key ? { keyUsage: key.keyUsage } : {}),
      ...(historyCache ? { history: openRouterHistory(historyCache) } : {}),
    },
  };
}

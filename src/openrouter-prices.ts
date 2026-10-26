import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface OpenRouterPriceOverride {
  utcDays?: string[];
  utcStart?: number;
  utcEnd?: number;
  minPromptTokens?: number;
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** Offline per-million-token pricing derived from the public model catalog. */
export interface OpenRouterModelPrice {
  id: string;
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  overrides?: OpenRouterPriceOverride[];
}

export interface OpenRouterPriceCache {
  updatedAt: string;
  models: OpenRouterModelPrice[];
}

export interface LoadOpenRouterPricesOptions {
  pricesPath?: string;
  now?: number;
  env?: Record<string, string | undefined>;
}

export interface RefreshOpenRouterPricesOptions extends LoadOpenRouterPricesOptions {
  fetch?: typeof fetch;
}

const DEFAULT_PRICES_PATH = "~/.config/spendwatch/openrouter-model-prices.json";
const PRICE_CACHE_LIMIT = 8;
const PRICE_TTL_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MODEL_RESPONSE_LIMIT = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface PriceMemo {
  identity: string;
  cache: OpenRouterPriceCache;
}

const priceMemos = new Map<string, PriceMemo>();
let parsedCatalogsForTesting = 0;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function wrapped(value: unknown): unknown {
  const root = object(value);
  return root?.data !== undefined ? root.data : value;
}

function text(value: unknown, maximum = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= maximum && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : undefined;
}

function normalizeOverride(value: unknown): OpenRouterPriceOverride | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const utcDays = Array.isArray(raw.utc_days) ? raw.utc_days.flatMap((day) => {
    const clean = text(day, 12)?.toLowerCase();
    return clean && ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(clean) ? [clean] : [];
  }) : undefined;
  const utcStart = finiteInteger(raw.utc_start);
  const utcEnd = finiteInteger(raw.utc_end);
  const minPromptTokens = finiteInteger(raw.min_prompt_tokens);
  const input = perMillion(raw.prompt);
  const output = perMillion(raw.completion);
  const cachedInput = perMillion(raw.input_cache_read);
  const cacheWrite5m = perMillion(raw.input_cache_write);
  const cacheWrite1h = perMillion(raw.input_cache_write_1h);
  if ([utcStart, utcEnd].some((item) => item !== undefined && item > 2359)) return undefined;
  if (!utcDays?.length && utcStart === undefined && utcEnd === undefined && minPromptTokens === undefined) return undefined;
  if ([input, output, cachedInput, cacheWrite5m, cacheWrite1h].every((item) => item === undefined)) return undefined;
  return {
    ...(utcDays?.length ? { utcDays: [...new Set(utcDays)] } : {}),
    ...(utcStart !== undefined ? { utcStart } : {}), ...(utcEnd !== undefined ? { utcEnd } : {}),
    ...(minPromptTokens !== undefined ? { minPromptTokens } : {}),
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(cachedInput !== undefined ? { cachedInput } : {}), ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  };
}

function validateCachedOverride(value: unknown): OpenRouterPriceOverride | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const utcDays = Array.isArray(raw.utcDays) ? raw.utcDays.flatMap((day) => {
    const clean = text(day, 12)?.toLowerCase();
    return clean && ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(clean) ? [clean] : [];
  }) : undefined;
  const utcStart = finiteInteger(raw.utcStart);
  const utcEnd = finiteInteger(raw.utcEnd);
  const minPromptTokens = finiteInteger(raw.minPromptTokens);
  const input = finiteNonNegative(raw.input);
  const output = finiteNonNegative(raw.output);
  const cachedInput = raw.cachedInput === undefined ? undefined : finiteNonNegative(raw.cachedInput);
  const cacheWrite5m = raw.cacheWrite5m === undefined ? undefined : finiteNonNegative(raw.cacheWrite5m);
  const cacheWrite1h = raw.cacheWrite1h === undefined ? undefined : finiteNonNegative(raw.cacheWrite1h);
  if ([utcStart, utcEnd].some((item) => item !== undefined && item > 2359)) return undefined;
  if (!utcDays?.length && utcStart === undefined && utcEnd === undefined && minPromptTokens === undefined) return undefined;
  if ([input, output, cachedInput, cacheWrite5m, cacheWrite1h].every((item) => item === undefined)) return undefined;
  return {
    ...(utcDays?.length ? { utcDays: [...new Set(utcDays)] } : {}),
    ...(utcStart !== undefined ? { utcStart } : {}), ...(utcEnd !== undefined ? { utcEnd } : {}),
    ...(minPromptTokens !== undefined ? { minPromptTokens } : {}),
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(cachedInput !== undefined ? { cachedInput } : {}), ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  };
}

export function normalizeOpenRouterModelPrices(value: unknown, capturedAt: string): OpenRouterPriceCache {
  const rawModels = wrapped(value);
  if (!Array.isArray(rawModels)) throw new Error("invalid OpenRouter models response");
  const models = rawModels.flatMap((value): OpenRouterModelPrice[] => {
    const raw = object(value);
    const pricing = object(raw?.pricing);
    const id = text(raw?.id, 300);
    const input = perMillion(pricing?.prompt);
    const output = perMillion(pricing?.completion);
    if (!id || input === undefined || output === undefined) return [];
    const cachedInput = perMillion(pricing?.input_cache_read);
    const cacheWrite5m = perMillion(pricing?.input_cache_write);
    const cacheWrite1h = perMillion(pricing?.input_cache_write_1h);
    const overrides = Array.isArray(pricing?.overrides)
      ? pricing.overrides.flatMap((item) => { const normalized = normalizeOverride(item); return normalized ? [normalized] : []; })
      : [];
    return [{ id, input, output, ...(cachedInput !== undefined ? { cachedInput } : {}),
      ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}), ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
      ...(overrides.length ? { overrides } : {}) }];
  });
  if (!models.length) throw new Error("OpenRouter models response had no usable prices");
  return { updatedAt: capturedAt, models };
}

/** Validate the exact compact cache shape written by the collector. */
export function validateOpenRouterPriceCache(value: unknown): OpenRouterPriceCache | undefined {
  const raw = object(value);
  const updatedAt = typeof raw?.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
    ? new Date(Date.parse(raw.updatedAt)).toISOString()
    : undefined;
  if (!updatedAt || !Array.isArray(raw?.models)) return undefined;
  const models = raw.models.flatMap((value): OpenRouterModelPrice[] => {
    const model = object(value);
    const id = text(model?.id, 300);
    const input = finiteNonNegative(model?.input);
    const output = finiteNonNegative(model?.output);
    const cachedInput = model?.cachedInput === undefined ? undefined : finiteNonNegative(model.cachedInput);
    const cacheWrite5m = model?.cacheWrite5m === undefined ? undefined : finiteNonNegative(model.cacheWrite5m);
    const cacheWrite1h = model?.cacheWrite1h === undefined ? undefined : finiteNonNegative(model.cacheWrite1h);
    const overrides = Array.isArray(model?.overrides) ? model.overrides.flatMap((item) => {
      const normalized = validateCachedOverride(item);
      return normalized ? [normalized] : [];
    }) : [];
    if (!id || input === undefined || output === undefined
      || (model?.cachedInput !== undefined && cachedInput === undefined)
      || (model?.cacheWrite5m !== undefined && cacheWrite5m === undefined)
      || (model?.cacheWrite1h !== undefined && cacheWrite1h === undefined)
      || (Array.isArray(model?.overrides) && overrides.length !== model.overrides.length)) return [];
    return [{ id, input, output, ...(cachedInput !== undefined ? { cachedInput } : {}),
      ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}), ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
      ...(overrides.length ? { overrides } : {}) }];
  });
  return models.length && models.length === raw.models.length ? { updatedAt, models } : undefined;
}

/** Read the durable public catalog snapshot without contacting OpenRouter. */
function pricePath(options: LoadOpenRouterPricesOptions): string {
  const env = options.env ?? process.env;
  const configured = options.pricesPath ?? env.SPENDWATCH_OPENROUTER_PRICES ?? DEFAULT_PRICES_PATH;
  return configured === "~" ? homedir()
    : configured.startsWith("~/") ? join(homedir(), configured.slice(2))
      : isAbsolute(configured) ? configured : resolve(configured);
}

export function loadOpenRouterPriceCache(options: LoadOpenRouterPricesOptions = {}): OpenRouterPriceCache | undefined {
  const path = pricePath(options);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return undefined;
    const identity = `${info.ino}:${info.size}:${info.mtimeMs}`;
    const memo = priceMemos.get(path);
    if (memo?.identity === identity) {
      priceMemos.delete(path);
      priceMemos.set(path, memo);
      return memo.cache;
    }
    const cache = validateOpenRouterPriceCache(JSON.parse(readFileSync(path, "utf8")));
    const now = options.now ?? Date.now();
    if (!cache || Date.parse(cache.updatedAt) > now + 5 * 60_000) {
      priceMemos.delete(path);
      return undefined;
    }
    parsedCatalogsForTesting++;
    priceMemos.delete(path);
    priceMemos.set(path, { identity, cache });
    while (priceMemos.size > PRICE_CACHE_LIMIT) priceMemos.delete(priceMemos.keys().next().value!);
    return cache;
  } catch { return undefined; }
}

/** Parser invocations observed by tests; reading an unchanged stat is not a parse. */
export function openRouterPriceParseCountForTesting(): number {
  return parsedCatalogsForTesting;
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

async function boundedModelsJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MODEL_RESPONSE_LIMIT) throw new Error("OpenRouter model catalog is too large");
  if (!response.body) throw new Error("OpenRouter model catalog has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("OpenRouter model catalog is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("OpenRouter returned invalid model catalog JSON"); }
}

async function fetchPublicModels(fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_MODELS_URL, {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "spendwatch/0.3" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch { throw new Error("OpenRouter model catalog request failed"); }
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status} for /models`);
  return boundedModelsJson(response);
}

/**
 * Refresh the account-independent public price catalog at most once per day.
 * A failed refresh keeps and returns the last valid snapshot without advancing
 * its updatedAt timestamp. No management configuration or credential is read.
 */
export async function refreshOpenRouterPrices(
  options: RefreshOpenRouterPricesOptions = {},
): Promise<OpenRouterPriceCache | undefined> {
  const now = options.now ?? Date.now();
  const path = pricePath(options);
  const cached = loadOpenRouterPriceCache({ pricesPath: path, now });
  if (cached && now - Date.parse(cached.updatedAt) < PRICE_TTL_MS) return cached;

  try {
    const fetched = await fetchPublicModels(options.fetch ?? fetch);
    const next = normalizeOpenRouterModelPrices(fetched, new Date(now).toISOString());
    writePrivateJson(path, next);
    return next;
  } catch {
    return cached && Date.parse(cached.updatedAt) <= now + MAX_FUTURE_SKEW_MS ? cached : undefined;
  }
}

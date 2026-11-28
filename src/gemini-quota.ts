// The Gemini quota reading, in the shape the capacity dashboard keeps.
//
// Google's Code Assist `retrieveUserQuota` answers with one bucket per model:
// the fraction left, an optional absolute amount, and when the allowance
// resets (Gemini CLI 0.70, chunk-37D3S3FZ.js:406010 `refreshUserQuota`). It
// reports no window length, so the cycle here is nominal and `resetsAt` is the
// only real deadline. Nothing in this file talks to a network: the collector
// hands it a parsed response, and the dashboard hands it a cached snapshot, so
// the same validation covers a provider reply and a stranger's cached file.
import type { CapacityWindow } from "./capacity-current";

/**
 * Gemini's buckets carry a reset instant, never a cycle length. One day is the
 * nominal cycle the pace and burn maths compare against; `resetsAt` stays the
 * fact a caller should act on.
 */
export const GEMINI_NOMINAL_WINDOW_MINUTES = 1440;

/**
 * `antigravity-gemini` and `antigravity-partner` are the two pools an Antigravity sign-in reports: every Gemini
 * model shares one allowance, and the Claude and GPT models Antigravity also serves share another.
 */
export type GeminiModelFamily = "pro" | "flash" | "flash-lite" | "other" | "antigravity-gemini" | "antigravity-partner";

/** One collapsed quota row: several reported model ids can share one allowance. */
export interface GeminiQuotaRow {
  label: string;
  family: GeminiModelFamily;
  /** Every reported model id folded into this row, sorted. */
  models: string[];
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
  /** Absolute allowance when the API reported one, kept for the row's detail. */
  remainingAmount?: number;
  limit?: number;
  tokenType?: string;
}

export interface GeminiQuota {
  rows: GeminiQuotaRow[];
  /** The seven-day ledger the collector carries, when the reading has one. */
  week?: GeminiWeek;
  /** The card headline: the most constrained Pro bucket, else the tightest row. */
  headline: GeminiQuotaRow | null;
  primary: CapacityWindow | null;
  secondary: CapacityWindow | null;
  tertiary: CapacityWindow | null;
}

interface RawBucket {
  modelId?: unknown;
  remainingFraction?: unknown;
  remainingAmount?: unknown;
  resetTime?: unknown;
  tokenType?: unknown;
}

// A model id goes into a dashboard attribute and a history key, so it is
// restricted instead of merely escaped.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TOKEN_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// How far ahead of `now` a reported reset may sit before it is treated as
// nonsense. A reset in the *past* is never nonsense: it says the cycle already
// closed, which is a state the card renders ("Refreshing limit") and the burn
// maths must not invent a window for.
const RESET_HORIZON_MS = 366 * 86_400_000;

const FAMILY_ORDER: Record<GeminiModelFamily, number> = {
  "antigravity-gemini": 0, "antigravity-partner": 1, pro: 2, flash: 3, "flash-lite": 4, other: 5,
};
const FAMILY_LABEL: Record<GeminiModelFamily, string> = {
  pro: "Gemini Pro",
  flash: "Gemini Flash",
  "flash-lite": "Gemini Flash Lite",
  other: "Gemini",
  "antigravity-gemini": "Gemini models",
  "antigravity-partner": "Claude & GPT models",
};

/**
 * Antigravity refills each pool five hours after it was first used, and the models report only the reset instant,
 * so five hours is the cycle the pace and burn maths compare against.
 */
export const ANTIGRAVITY_WINDOW_MINUTES = 300;

// The CLI folds a model's version aliases onto one allowance rather than
// rendering one line per released id (chunk-37D3S3FZ.js:406024-406032, with
// `gemini-3-flash`, `gemini-3.5-flash` and `gemini-3.8-flash` as one family and
// `gemini-3.1-flash-lite` with `gemini-3.5-flash-lite` as another, at
// 292000-292006). Spendwatch has no general-access signal, so every alias in a
// family collapses to that family's canonical row instead of a base-or-latest
// pick; the reported ids stay on the row for the row's own detail.
const FLASH_LITE_IDS = new Set(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
const FLASH_IDS = new Set(["gemini-3-flash", "gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.8-flash"]);
const PRO_IDS = new Set(["gemini-2.5-pro", "gemini-3-pro", "gemini-3-pro-preview", "gemini-3.1-pro"]);

export function geminiModelFamily(modelId: string): GeminiModelFamily {
  const id = modelId.toLowerCase();
  if (FLASH_LITE_IDS.has(id) || id.includes("flash-lite")) return "flash-lite";
  if (FLASH_IDS.has(id) || id.includes("flash")) return "flash";
  if (PRO_IDS.has(id) || id.includes("pro")) return "pro";
  return "other";
}

/**
 * The bucket's reset instant.
 *
 * The CLI sorts these strings to find the latest reset (chunk-37D3S3FZ.js:405836),
 * which is only meaningful for ISO-8601 stamps, so an ISO string is the expected
 * wire shape. The protobuf-JSON duration form (`"900s"`) is also accepted,
 * anchored to `now`, because the same API family returns durations elsewhere.
 *
 * Only the future is bounded. A `resetTime` already behind us is carried
 * through, because `resetsAt` is the one figure Gemini offers for "when does
 * this allowance refill" and dropping it would let the card claim a cycle is
 * still running after Google said it ended.
 */
export function geminiResetFrom(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const duration = /^(\d+(?:\.\d+)?)s$/.exec(text);
  if (duration) {
    const seconds = Number(duration[1]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > RESET_HORIZON_MS) return undefined;
    return new Date(now + Math.round(seconds * 1000)).toISOString();
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed - now > RESET_HORIZON_MS) return undefined;
  return new Date(parsed).toISOString();
}

function clampPercent(fractionRemaining: number): number {
  return Math.min(100, Math.max(0, Math.round((1 - fractionRemaining) * 10_000) / 100));
}

function amountOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/**
 * The reported fraction left, or undefined when the bucket reported none.
 *
 * This is type-checked rather than converted: `Number(null)`, `Number("")` and
 * `Number(false)` are all 0, and a coerced 0 renders as a fully spent allowance
 * the account may not have spent at all. A bucket that did not answer is
 * dropped, as the CLI drops it (chunk-37D3S3FZ.js:406021). A numeric string is
 * accepted because this API family does answer some numeric fields that way.
 */
function fractionOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

/**
 * One valid bucket, or undefined when the bucket says nothing usable.
 *
 * The CLI skips a bucket with no model id or no fraction (chunk-37D3S3FZ.js:406021)
 * and computes the limit from the amount over the fraction, so a bucket here
 * agrees with the number the CLI itself shows.
 */
function rowFromBucket(bucket: RawBucket, now: number): GeminiQuotaRow | undefined {
  if (typeof bucket.modelId !== "string" || !MODEL_PATTERN.test(bucket.modelId)) return undefined;
  const fraction = fractionOf(bucket.remainingFraction);
  if (fraction === undefined) return undefined;
  const remaining = amountOf(bucket.remainingAmount);
  const limit = remaining !== undefined && fraction > 0 ? Math.round(remaining / fraction) : undefined;
  const tokenType = typeof bucket.tokenType === "string" && TOKEN_TYPE_PATTERN.test(bucket.tokenType)
    ? bucket.tokenType : undefined;
  const family = geminiModelFamily(bucket.modelId);
  const resetsAt = geminiResetFrom(bucket.resetTime, now);
  return {
    label: FAMILY_LABEL[family],
    family,
    models: [bucket.modelId],
    usedPercent: clampPercent(fraction),
    windowMinutes: GEMINI_NOMINAL_WINDOW_MINUTES,
    ...(resetsAt ? { resetsAt } : {}),
    ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
    ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

function moreConstrained(a: GeminiQuotaRow, b: GeminiQuotaRow): number {
  if (a.usedPercent !== b.usedPercent) return b.usedPercent - a.usedPercent;
  const aReset = a.resetsAt ? Date.parse(a.resetsAt) : Number.POSITIVE_INFINITY;
  const bReset = b.resetsAt ? Date.parse(b.resetsAt) : Number.POSITIVE_INFINITY;
  if (aReset !== bReset) return aReset - bReset;
  return a.models[0]!.localeCompare(b.models[0]!);
}

/**
 * The allowance a reported id is charged against.
 *
 * Only the two sets the CLI itself folds are merged here
 * (chunk-37D3S3FZ.js:406024-406032): `gemini-3-flash`/`-3.5-flash`/`-3.8-flash`
 * share one Flash allowance and the two flash-lite ids share one of theirs.
 * Every other reported id keeps its own row, because two Pro versions are two
 * allowances and merging them would report one averaged figure for a quota that
 * is really two. `family` still groups them visually on the card.
 */
function allowanceKey(row: GeminiQuotaRow): string {
  const id = row.models[0]!.toLowerCase();
  if (FLASH_LITE_IDS.has(id)) return "allowance:flash-lite";
  if (FLASH_IDS.has(id)) return "allowance:flash";
  return `model:${id}`;
}

/** Collapse the reported buckets to one row per allowance. */
function collapseRows(rows: GeminiQuotaRow[]): GeminiQuotaRow[] {
  const groups = new Map<string, GeminiQuotaRow>();
  for (const row of rows) {
    const key = `${allowanceKey(row)}|${row.tokenType ?? ""}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...row, models: [...row.models] });
      continue;
    }
    const models = [...new Set([...current.models, ...row.models])].sort();
    const tightest = moreConstrained(current, row) <= 0 ? current : row;
    groups.set(key, { ...tightest, models });
  }
  return [...groups.values()]
    .map((row) => ({ ...row, label: row.family === "other" ? row.models[0]! : FAMILY_LABEL[row.family] }))
    .sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family] || moreConstrained(a, b));
}

function windowOf(row: GeminiQuotaRow | undefined | null): CapacityWindow | null {
  if (!row) return null;
  return { usedPercent: row.usedPercent, windowMinutes: row.windowMinutes, resetsAt: row.resetsAt };
}

/**
 * The name one row is shown by, given the rows it is shown beside.
 *
 * A row is named by its family, which is what a single allowance wants: "Gemini
 * Pro" reads better than a build number. Once a family holds more than one
 * allowance — two Pro versions are two — every row in it would read the same,
 * and the tighter one is the answer, so those rows are named by the model ids
 * they actually report. One rule here keeps the card and the text output alike.
 */
export function geminiRowName(rows: GeminiQuotaRow[], row: GeminiQuotaRow): string {
  return rows.some((other) => other !== row && other.family === row.family)
    ? row.models.join(", ")
    : row.label;
}

/** Build the card rows and the shared primary/secondary/tertiary windows. */
export function geminiQuotaFromBuckets(buckets: unknown, now = Date.now()): GeminiQuota | undefined {
  if (!Array.isArray(buckets)) return undefined;
  const parsed: GeminiQuotaRow[] = [];
  for (const bucket of buckets.slice(0, 64)) {
    if (!bucket || typeof bucket !== "object") continue;
    const row = rowFromBucket(bucket as RawBucket, now);
    if (row) parsed.push(row);
  }
  return rowsToQuota(collapseRows(parsed));
}

function rowsToQuota(rows: GeminiQuotaRow[]): GeminiQuota | undefined {
  if (!rows.length) return undefined;
  const headline = rows.find((row) => row.family === "antigravity-gemini")
    ?? rows.find((row) => row.family === "pro") ?? [...rows].sort(moreConstrained)[0]!;
  const flash = rows.filter((row) => row !== headline
    && (row.family === "antigravity-partner" || row.family === "flash" || row.family === "flash-lite")).sort(moreConstrained)[0];
  const rest = rows.filter((row) => row !== headline && row !== flash).sort(moreConstrained)[0];
  return {
    rows,
    headline,
    primary: windowOf(headline),
    secondary: windowOf(flash ?? null),
    tertiary: windowOf(rest ?? null),
  };
}

/**
 * Re-validate rows that arrived from a cached snapshot or another collector.
 *
 * A dashboard must never trust a file it did not write: every figure is checked
 * again, and a malformed row is dropped rather than rendered.
 */
export function normalizeGeminiRows(value: unknown, now = Date.now()): GeminiQuotaRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: GeminiQuotaRow[] = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const family = raw.family as GeminiModelFamily;
    if (!Object.hasOwn(FAMILY_ORDER, family ?? "")) continue;
    if (!Array.isArray(raw.models) || !raw.models.length || raw.models.length > 32) continue;
    const models = raw.models.filter((model): model is string =>
      typeof model === "string" && MODEL_PATTERN.test(model));
    if (models.length !== raw.models.length) continue;
    const usedPercent = Number(raw.usedPercent);
    const windowMinutes = Number(raw.windowMinutes);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 527_040) continue;
    // A stored duration would slide forward on every re-read, so a snapshot
    // only ever carries an absolute instant here.
    const resetMs = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : Number.NaN;
    const resetsAt = Number.isFinite(resetMs) && resetMs - now <= RESET_HORIZON_MS
      ? new Date(resetMs).toISOString() : undefined;
    const remainingAmount = amountOf(raw.remainingAmount);
    const limit = amountOf(raw.limit);
    const tokenType = typeof raw.tokenType === "string" && TOKEN_TYPE_PATTERN.test(raw.tokenType)
      ? raw.tokenType : undefined;
    rows.push({
      // The label is always derived, never copied: a snapshot arrives from
      // another machine's collector, and whatever string it carries must not
      // reach the card. `other` falls back to a model id, which MODEL_PATTERN
      // already holds to a safe alphabet.
      label: family === "other" ? models[0]! : FAMILY_LABEL[family],
      family,
      models,
      usedPercent,
      windowMinutes,
      ...(resetsAt ? { resetsAt } : {}),
      ...(remainingAmount !== undefined ? { remainingAmount } : {}),
      ...(limit !== undefined && limit > 0 ? { limit } : {}),
      ...(tokenType ? { tokenType } : {}),
    });
  }
  return rows.length ? rows : undefined;
}

/** Rows from a cached snapshot, with the headline and windows derived again. */
export function geminiQuotaFromRows(value: unknown): GeminiQuota | undefined {
  const rows = normalizeGeminiRows(value);
  return rows ? rowsToQuota(rows) : undefined;
}

/** The pool an Antigravity model id is charged against, or undefined for an internal model such as tab completion. */
export function antigravityPool(modelId: string): "antigravity-gemini" | "antigravity-partner" | undefined {
  const id = modelId.toLowerCase();
  if (id.startsWith("gemini-")) return "antigravity-gemini";
  if (id.startsWith("claude-") || id.startsWith("gpt-")) return "antigravity-partner";
  return undefined;
}

/**
 * Antigravity's `fetchAvailableModels` answer as the two pool rows the card shows: Gemini, and the Claude and GPT
 * models the plan also serves (GateFox offers Claude Opus and Sonnet and GPT-OSS through its Gemini provider).
 *
 * The answer maps each model id to its `quotaInfo` (`remainingFraction`, `resetTime`). Every model in a pool reports
 * the same figures, so a pool is read at its tightest model; ids with no reset (tab completion and the like) are
 * internal and skipped. The same validation as a Code Assist bucket applies to every figure.
 */
export function geminiQuotaFromAntigravityModels(models: unknown, now = Date.now()): GeminiQuota | undefined {
  if (!models || typeof models !== "object" || Array.isArray(models)) return undefined;
  const pools = new Map<GeminiModelFamily, GeminiQuotaRow>();
  for (const [modelId, value] of Object.entries(models as Record<string, unknown>).slice(0, 128)) {
    if (!MODEL_PATTERN.test(modelId) || !value || typeof value !== "object") continue;
    const family = antigravityPool(modelId);
    if (!family) continue;
    const info = (value as { quotaInfo?: unknown }).quotaInfo as RawBucket | undefined;
    if (!info || typeof info !== "object") continue;
    const fraction = fractionOf(info.remainingFraction);
    const resetsAt = geminiResetFrom(info.resetTime, now);
    if (fraction === undefined || !resetsAt) continue;
    const row: GeminiQuotaRow = {
      label: FAMILY_LABEL[family], family, models: [modelId], usedPercent: clampPercent(fraction),
      windowMinutes: ANTIGRAVITY_WINDOW_MINUTES, resetsAt,
    };
    const current = pools.get(family);
    if (!current) { pools.set(family, row); continue; }
    const tightest = moreConstrained(current, row) <= 0 ? current : row;
    pools.set(family, { ...tightest, models: [...new Set([...current.models, modelId])].sort().slice(0, 32) });
  }
  const rows = [...pools.values()].sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
  return rowsToQuota(rows);
}

export type AntigravityPoolFamily = "antigravity-gemini" | "antigravity-partner";
const POOLS: AntigravityPoolFamily[] = ["antigravity-gemini", "antigravity-partner"];

/** One five-hour window of one pool: its reset instant and the most of it a reading saw used. */
export interface GeminiWeekCycle {
  resetsAt: string;
  usedPercent: number;
  /** The reading hit the weekly limit: the pool was spent and its reset sat past one five-hour window. */
  capped?: true;
}

/**
 * The last seven days of windows per pool. Google publishes no weekly figure and the API reports only the current
 * window, so the collector keeps this ledger beside the reading and every snapshot carries it forward.
 */
export type GeminiWeek = Partial<Record<AntigravityPoolFamily, GeminiWeekCycle[]>>;

export const GEMINI_WEEK_MS = 7 * 86_400_000;
/** A spent pool whose reset is further away than one window plus this slack is held by the weekly limit. */
const WEEKLY_CAP_SLACK_MS = 30 * 60_000;
const MAX_CYCLES = 64;
/** Reset instants of one window can differ by a few seconds between reads. */
const SAME_CYCLE_MS = 2 * 60_000;

export function antigravityWeeklyCapped(row: Pick<GeminiQuotaRow, "family" | "usedPercent" | "resetsAt">, readAtMs: number): boolean {
  if (row.family !== "antigravity-gemini" && row.family !== "antigravity-partner") return false;
  const reset = row.resetsAt ? Date.parse(row.resetsAt) : Number.NaN;
  return row.usedPercent >= 100 && Number.isFinite(reset)
    && reset - readAtMs > ANTIGRAVITY_WINDOW_MINUTES * 60_000 + WEEKLY_CAP_SLACK_MS;
}

/** Re-validate a ledger that arrived in a snapshot; anything malformed is dropped. */
export function sanitizeGeminiWeek(value: unknown, now = Date.now()): GeminiWeek | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const week: GeminiWeek = {};
  for (const pool of POOLS) {
    const raw = (value as Record<string, unknown>)[pool];
    if (!Array.isArray(raw)) continue;
    const cycles: GeminiWeekCycle[] = [];
    for (const item of raw.slice(0, MAX_CYCLES)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const reset = typeof entry.resetsAt === "string" ? Date.parse(entry.resetsAt) : Number.NaN;
      const used = Number(entry.usedPercent);
      if (!Number.isFinite(reset) || reset - now > RESET_HORIZON_MS || !Number.isFinite(used) || used <= 0 || used > 100) continue;
      cycles.push({ resetsAt: new Date(reset).toISOString(), usedPercent: used, ...(entry.capped === true ? { capped: true as const } : {}) });
    }
    if (cycles.length) week[pool] = cycles;
  }
  return Object.keys(week).length ? week : undefined;
}

/**
 * Fold one reading into the ledgers it inherits. A window is keyed by its reset instant, so repeated reads of one
 * window keep its highest figure; an untouched pool (0% used) is not a window anyone spent. Windows that ended
 * more than seven days before the reading are dropped.
 */
export function updateGeminiWeek(priors: Array<GeminiWeek | undefined>, rows: GeminiQuotaRow[], readAtMs: number): GeminiWeek | undefined {
  const week: GeminiWeek = {};
  const add = (pool: AntigravityPoolFamily, cycle: GeminiWeekCycle) => {
    const reset = Date.parse(cycle.resetsAt);
    if (!Number.isFinite(reset) || reset <= readAtMs - GEMINI_WEEK_MS) return;
    const cycles = week[pool] ?? (week[pool] = []);
    const same = cycles.find((item) => Math.abs(Date.parse(item.resetsAt) - reset) <= SAME_CYCLE_MS);
    if (!same) { cycles.push({ ...cycle, resetsAt: new Date(reset).toISOString() }); return; }
    same.usedPercent = Math.max(same.usedPercent, cycle.usedPercent);
    if (cycle.capped) same.capped = true;
  };
  for (const prior of priors) for (const pool of POOLS) for (const cycle of prior?.[pool] ?? []) add(pool, cycle);
  for (const row of rows) {
    if ((row.family !== "antigravity-gemini" && row.family !== "antigravity-partner") || row.usedPercent <= 0 || !row.resetsAt) continue;
    add(row.family, {
      resetsAt: row.resetsAt, usedPercent: row.usedPercent,
      ...(antigravityWeeklyCapped(row, readAtMs) ? { capped: true as const } : {}),
    });
  }
  for (const pool of POOLS) {
    const cycles = week[pool];
    if (!cycles) continue;
    cycles.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
    week[pool] = cycles.slice(-MAX_CYCLES);
  }
  return Object.keys(week).length ? week : undefined;
}

/** One pool's last seven days: full windows' worth used, how many windows, and whether the weekly limit was hit. */
export function geminiWeekSummary(cycles: GeminiWeekCycle[] | undefined, nowMs: number): { windowsUsed: number; windows: number; capped: boolean } {
  const recent = (cycles ?? []).filter((cycle) => Date.parse(cycle.resetsAt) > nowMs - GEMINI_WEEK_MS);
  const percent = recent.reduce((sum, cycle) => sum + cycle.usedPercent, 0);
  return { windowsUsed: Math.round(percent / 10) / 10, windows: recent.length, capped: recent.some((cycle) => cycle.capped) };
}

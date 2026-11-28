// The Gemini quota card: one row per model allowance, read as Pro versus Flash.
//
// Gemini reports a fraction per model rather than the two shared windows Codex
// and Claude expose, so a single percentage would hide the model that actually
// stops work. The headline is the most constrained Pro bucket — the one an agent
// hits first — and every bucket then keeps its own row so Pro and Flash never
// blur together. Row markup matches the shared quota blocks so the same client
// script hydrates each reset time.
import { windowFreshness } from "./capacity-freshness";
import { geminiRowName, type GeminiQuota, type GeminiQuotaRow } from "./gemini-quota";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]!));

const GROUP_LABEL = {
  pro: "Pro",
  flash: "Flash",
  "flash-lite": "Flash Lite",
  other: "Other models",
  "antigravity-gemini": "Gemini",
  "antigravity-partner": "Claude & GPT",
} as const;

const GROUP_ORDER = ["antigravity-gemini", "antigravity-partner", "pro", "flash", "flash-lite", "other"] as const;

/** A pool can hold a dozen model ids; the line names a few and the tooltip keeps them all. */
function modelSummary(models: string[]): string {
  return models.length > 3 ? `${models.length} models` : models.join(", ");
}

export interface GeminiCardAccount {
  gemini?: GeminiQuota;
  updatedAt?: string;
}

/**
 * Antigravity starts a pool's five-hour timer on first use, and until then reports a reset five hours from every
 * read. An untouched pool therefore has no reset worth counting down to.
 */
function notStarted(row: GeminiQuotaRow): boolean {
  return (row.family === "antigravity-gemini" || row.family === "antigravity-partner") && row.usedPercent === 0;
}

function resetSpan(row: GeminiQuotaRow, fallback: string): string {
  if (notStarted(row)) return `<span class="reset">Timer starts on first use</span>`;
  return `<span class="reset" data-reset="${esc(row.resetsAt ?? "")}">${row.resetsAt ? "Reset time loading" : fallback}</span>`;
}

function toneFor(remaining: number): string {
  return remaining <= 15 ? "danger" : remaining <= 35 ? "warn" : "good";
}

/** The headline block: the tightest Pro allowance, or the tightest row at all. */
function headlineBlock(row: GeminiQuotaRow, rows: GeminiQuotaRow[], updatedAt: string | undefined, nowMs: number): string {
  const name = geminiRowName(rows, row);
  const freshness = windowFreshness(
    { usedPercent: row.usedPercent, windowMinutes: row.windowMinutes, resetsAt: row.resetsAt },
    updatedAt, nowMs,
  );
  const models = row.models.join(", ");
  const summary = modelSummary(row.models);
  if (freshness !== "live") {
    const last = Math.round(100 - row.usedPercent);
    return `<section class="limit unreadable ${freshness}" title="This reading is no longer current">
    <div class="limit-head"><span>${esc(name)}</span><strong>${freshness === "expired" ? "Cycle ended" : "Not current"}</strong></div>
    <div class="track stale" role="img" aria-label="${esc(name)} is not current"><i style="width:${Math.min(100, Math.max(0, last))}%"></i></div>
    <div class="limit-meta"><span>Last read ${last}% left</span><span title="${esc(models)}">${esc(summary)}</span></div>
  </section>`;
  }
  const left = Math.round(100 - row.usedPercent);
  const spent = row.usedPercent >= 100
    ? `<strong title="This allowance is used up">Ran out</strong>`
    : `<strong>${left}% left</strong>`;
  return `<section class="limit gemini-headline ${toneFor(left)}">
    <div class="limit-head"><span>${esc(name)}</span>${spent}</div>
    <div class="track" role="progressbar" aria-label="${esc(name)} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}"><i style="width:${Math.min(100, Math.max(0, left))}%"></i></div>
    <div class="limit-meta">${resetSpan(row, "Resets on a Google schedule")}<span title="${esc(models)}">${esc(summary)}</span></div>
  </section>`;
}

function bucketRow(row: GeminiQuotaRow, updatedAt: string | undefined, nowMs: number, name: string): string {
  const left = Math.round(100 - row.usedPercent);
  const freshness = windowFreshness(
    { usedPercent: row.usedPercent, windowMinutes: row.windowMinutes, resetsAt: row.resetsAt },
    updatedAt, nowMs,
  );
  // The absolute allowance is the figure Google shows in its own UI, so it reads
  // beside the percentage whenever the API reported one.
  // Without one the column stays empty rather than repeating the percentage beside it.
  const amount = row.remainingAmount !== undefined && row.limit !== undefined
    ? `${row.remainingAmount.toLocaleString()} of ${row.limit.toLocaleString()}`
    : "";
  const value = freshness === "live" ? `${left}% left` : `${left}% left · last read`;
  return `<div class="gemini-row" data-freshness="${freshness}" title="${esc(row.models.join(", "))}">`
    + `<span>${esc(name)}</span>`
    + `<strong>${esc(value)}</strong>`
    + `<span>${esc(amount)}</span>`
    + resetSpan(row, "No reset reported")
    + `</div>`;
}

function groupBlock(rows: GeminiQuotaRow[], family: GeminiQuotaRow["family"], updatedAt: string | undefined, nowMs: number): string {
  if (!rows.length) return "";
  // One row already names its allowance; a heading above it would only say the same words again.
  const heading = rows.length > 1
    ? `<span class="gemini-group-label" data-family="${family}">${esc(GROUP_LABEL[family])}</span>` : "";
  return `<div class="gemini-group">${heading}`
    + rows.map((row) => bucketRow(row, updatedAt, nowMs, geminiRowName(rows, row))).join("")
    + `</div>`;
}

/** A placeholder-free card: no usable bucket means no rows to claim. */
export function geminiLimits(account: GeminiCardAccount, nowMs: number): string {
  const quota = account.gemini;
  if (!quota?.rows.length || !quota.headline) {
    return `<section class="limit unreadable"><div class="limit-head"><span>Gemini quota</span><strong>Unavailable</strong></div>`
      + `<div class="limit-meta"><span>No usable bucket in the last read</span></div></section>`;
  }
  // A card with one allowance is its headline; listing that allowance again below adds nothing.
  if (quota.rows.length === 1) return headlineBlock(quota.headline, quota.rows, account.updatedAt, nowMs);
  const groups = GROUP_ORDER
    .map((family) => groupBlock(
      quota.rows.filter((row) => row.family === family), family, account.updatedAt, nowMs))
    .join("");
  return headlineBlock(quota.headline, quota.rows, account.updatedAt, nowMs) + groups;
}

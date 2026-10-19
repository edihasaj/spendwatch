import { readFileSync } from "node:fs";
import { normalizeCodexLimits, type CapacityProvider, type CodexLimitAccount } from "./limits";

/**
 * A snapshot is an intentional foreground capture. It is neither a failed
 * collector nor evidence that the source is currently polling providers.
 */
export type SourceHealthStatus = "live" | "snapshot" | "stale" | "offline" | "error";

export interface CapacitySourceHealth {
  device: string;
  status: SourceHealthStatus;
  checkedAt: string;
  lastSuccessAt?: string;
  detail?: string;
}

export interface CapacityDashboard {
  accounts: CodexLimitAccount[];
  sources: CapacitySourceHealth[];
  authentication: CapacityAuthenticationRequirement[];
}

export interface CapacityAuthenticationRequirement {
  provider: Exclude<CapacityProvider, "lokai" | "grok" | "qwen">;
  device: string;
  account?: string;
  profile?: string;
}

const LIVE_SOURCE_MS = 120_000;
const STALE_SOURCE_MS = 300_000;

/**
 * Stored source health is a receipt from the most recent render. Automatic
 * source health continues to age between renders; an intentional snapshot
 * remains a neutral historical capture instead.
 */
export function effectiveSourceHealth(
  sources: CapacitySourceHealth[],
  nowMs: number,
): CapacitySourceHealth[] {
  return sources.map((source) => {
    if (source.status === "snapshot" || source.status === "offline" || source.status === "error") return source;
    const observedAt = Date.parse(source.lastSuccessAt ?? source.checkedAt);
    const age = Number.isFinite(observedAt) && observedAt <= nowMs
      ? nowMs - observedAt
      : Number.POSITIVE_INFINITY;
    const status: SourceHealthStatus = source.status === "live" && age <= LIVE_SOURCE_MS
      ? "live"
      : age <= STALE_SOURCE_MS ? "stale" : "offline";
    return status === source.status ? source : { ...source, status };
  });
}

export function normalizeAuthenticationRequirements(input: unknown): CapacityAuthenticationRequirement[] {
  const latest = new Map<string, CapacityAuthenticationRequirement>();
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (value.kind !== "authentication-required") continue;
    if (value.provider !== "codex" && value.provider !== "claude" && value.provider !== "copilot") continue;
    if (typeof value.device !== "string" || !value.device.trim()) continue;
    const requirement: CapacityAuthenticationRequirement = {
      provider: value.provider,
      device: value.device.trim().toLowerCase(),
      account: typeof value.account === "string" && value.account.trim() ? value.account.trim() : undefined,
      profile: typeof value.profile === "string" && value.profile.trim() ? value.profile.trim() : undefined,
    };
    latest.set(`${requirement.provider}:${requirement.device}:${requirement.profile ?? "default"}`, requirement);
  }
  return [...latest.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.device.localeCompare(b.device));
}

function normalizeSource(value: unknown): CapacitySourceHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "source-health" || typeof source.device !== "string") return undefined;
  if (source.status !== "live" && source.status !== "snapshot" && source.status !== "stale" && source.status !== "offline" && source.status !== "error") return undefined;
  if (typeof source.checkedAt !== "string" || !Number.isFinite(Date.parse(source.checkedAt))) return undefined;
  return {
    device: source.device.trim().toLowerCase(),
    status: source.status,
    checkedAt: source.checkedAt,
    lastSuccessAt: typeof source.lastSuccessAt === "string" && Number.isFinite(Date.parse(source.lastSuccessAt))
      ? source.lastSuccessAt
      : undefined,
    detail: typeof source.detail === "string" && source.detail.trim() ? source.detail.trim() : undefined,
  };
}

export function normalizeSourceHealth(input: unknown): CapacitySourceHealth[] {
  const latest = new Map<string, CapacitySourceHealth>();
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    const source = normalizeSource(item);
    if (!source?.device) continue;
    const current = latest.get(source.device);
    if (!current || Date.parse(source.checkedAt) >= Date.parse(current.checkedAt)) latest.set(source.device, source);
  }
  return [...latest.values()].sort((a, b) => a.device.localeCompare(b.device));
}

export function loadCapacityDashboard(paths: string[]): CapacityDashboard {
  const combined: unknown[] = [];
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) combined.push(...parsed);
    else combined.push(parsed);
  }
  const accounts = normalizeCodexLimits(combined);
  if (!accounts.length) throw new Error("no valid capacity accounts in input");
  const sources = normalizeSourceHealth(combined);
  const authentication = normalizeAuthenticationRequirements(combined);
  const activeDevices = new Set(sources.map((source) => source.device));
  return {
    accounts,
    sources,
    authentication: sources.length
      ? authentication.filter((requirement) => activeDevices.has(requirement.device))
      : authentication,
  };
}

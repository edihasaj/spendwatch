import { readFileSync } from "node:fs";
import { normalizeCodexLimits, type CodexLimitAccount } from "./limits";

export type SourceHealthStatus = "live" | "stale" | "offline" | "error";

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
}

function normalizeSource(value: unknown): CapacitySourceHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "source-health" || typeof source.device !== "string") return undefined;
  if (source.status !== "live" && source.status !== "stale" && source.status !== "offline" && source.status !== "error") return undefined;
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
  return { accounts, sources: normalizeSourceHealth(combined) };
}

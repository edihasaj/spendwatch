import type { AgentSpendSummary, CodexLimitAccount, LocalQwenCapacity } from "./limits";

interface RawQwenCapacity {
  provider?: unknown;
  account?: unknown;
  usage?: {
    accountEmail?: unknown;
    loginMethod?: unknown;
    updatedAt?: unknown;
  };
  local?: {
    unlimited?: unknown;
    model?: unknown;
    ready?: unknown;
    detail?: unknown;
  };
  spend?: {
    recentUsd?: unknown;
    recentTokens?: unknown;
    recentHours?: unknown;
    monthUsd?: unknown;
    monthTokens?: unknown;
    monthDays?: unknown;
  };
  devices?: unknown;
  sourceDevice?: unknown;
}

interface LocalQwenSample {
  device: string;
  updatedAt?: string;
  updatedAtMs: number;
  model: string;
  ready?: boolean;
  detail?: string;
  spend?: AgentSpendSummary;
}

const DEFAULT_QWEN_MODEL = "qwen3.8-flash-next";

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizedDevice(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function devicesFor(value: RawQwenCapacity): string[] {
  const source = normalizedDevice(value.sourceDevice);
  if (source) return [source];
  const devices = Array.isArray(value.devices)
    ? value.devices.flatMap((device) => {
      const normalized = normalizedDevice(device);
      return normalized ? [normalized] : [];
    })
    : [];
  // Exporters attach sourceDevice. For older input, a single device can still
  // be attributed safely. A multi-device aggregate stays one sample rather
  // than being copied into each device's total.
  if (devices.length === 1) return devices;
  if (devices.length > 1) return [`combined:${[...new Set(devices)].sort().join("+")}`];
  return ["unknown"];
}

function normalizeSpend(value: RawQwenCapacity["spend"]): AgentSpendSummary | undefined {
  const recentTokens = finiteNonNegative(value?.recentTokens);
  const monthTokens = finiteNonNegative(value?.monthTokens);
  // A report with no token totals is a failed/partial read, not a zero-use
  // report. Keep the device visible but outside the measured aggregate.
  if (recentTokens === undefined || monthTokens === undefined) return undefined;
  return {
    // A self-hosted route has no provider fee. Only client-measured tokens are
    // accepted here; server counters would not identify the calling machine.
    recentUsd: 0,
    recentTokens,
    recentHours: finiteNonNegative(value?.recentHours) ?? 24,
    monthUsd: 0,
    monthTokens,
    monthDays: finiteNonNegative(value?.monthDays) ?? 30,
  };
}

function normalizeSample(value: unknown): LocalQwenSample[] {
  if (!value || typeof value !== "object") return [];
  const input = value as RawQwenCapacity;
  if (input.provider !== "qwen" || input.local?.unlimited !== true) return [];
  const email = input.usage?.accountEmail ?? input.account;
  if (email !== "Local Qwen") return [];

  const updatedAt = typeof input.usage?.updatedAt === "string"
    && Number.isFinite(Date.parse(input.usage.updatedAt))
    ? input.usage.updatedAt
    : undefined;
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NEGATIVE_INFINITY;
  const model = typeof input.local.model === "string" && input.local.model.trim()
    ? input.local.model.trim()
    : DEFAULT_QWEN_MODEL;
  const detail = typeof input.local.detail === "string" && input.local.detail.trim()
    ? input.local.detail.trim()
    : undefined;
  const spend = normalizeSpend(input.spend);
  return devicesFor(input).map((device) => ({
    device,
    updatedAt,
    updatedAtMs,
    model,
    ready: typeof input.local.ready === "boolean" ? input.local.ready : undefined,
    detail,
    spend,
  }));
}

/**
 * Qwen reports one local snapshot per caller. Keep the newest snapshot for
 * each caller before adding totals, so uploads/retries cannot inflate usage.
 */
export function normalizeLocalQwenCapacity(input: unknown[]): CodexLimitAccount | undefined {
  const newestByDevice = new Map<string, LocalQwenSample>();
  for (const item of input) {
    for (const sample of normalizeSample(item)) {
      const previous = newestByDevice.get(sample.device);
      if (!previous || sample.updatedAtMs >= previous.updatedAtMs) newestByDevice.set(sample.device, sample);
    }
  }
  const samples = [...newestByDevice.values()];
  if (!samples.length) return undefined;

  const newest = [...samples].sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.device.localeCompare(b.device))[0]!;
  const knownReadiness = samples.map((sample) => sample.ready);
  const measured = samples.filter((sample): sample is LocalQwenSample & { spend: AgentSpendSummary } => Boolean(sample.spend));
  const local: LocalQwenCapacity = {
    unlimited: true,
    model: newest.model,
    // Do not turn a partial/unknown check into "available". A true value
    // means every current caller sample explicitly observed readiness.
    ready: knownReadiness.every((ready) => ready === true)
      ? true
      : knownReadiness.some((ready) => ready === false)
        ? false
        : undefined,
    detail: newest.detail,
    measuredDevices: measured.map((sample) => sample.device).sort(),
    unmeasuredDevices: samples.filter((sample) => !sample.spend).map((sample) => sample.device).sort(),
  };
  return {
    provider: "qwen",
    name: "Local Qwen",
    email: "Local Qwen",
    plan: "Self-hosted",
    updatedAt: newest.updatedAt,
    devices: samples.map((sample) => sample.device).sort(),
    local,
    spend: measured.length ? {
      recentUsd: 0,
      recentTokens: measured.reduce((sum, sample) => sum + sample.spend.recentTokens, 0),
      recentHours: Math.max(...measured.map((sample) => sample.spend.recentHours)),
      monthUsd: 0,
      monthTokens: measured.reduce((sum, sample) => sum + sample.spend.monthTokens, 0),
      monthDays: Math.max(...measured.map((sample) => sample.spend.monthDays)),
    } : undefined,
  };
}

import { randomUUID } from "node:crypto";

type TelemetryTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelemetryOptions {
  dsn?: string;
  environment?: string;
  release?: string;
  transport?: TelemetryTransport;
  timeoutMs?: number;
}

const SAFE_TAGS = new Set(["command", "component", "method", "status"]);
const SAFE_VALUE = /^[a-z0-9_.:@-]{1,80}$/iu;

export async function reportOperationalError(
  event: string,
  error: unknown,
  tags: Record<string, string | undefined> = {},
  options: TelemetryOptions = {},
): Promise<boolean> {
  const dsn = parseDsn(options.dsn ?? process.env.SPENDWATCH_SENTRY_DSN);
  if (!dsn || !SAFE_VALUE.test(event)) return false;
  const errorType = safeErrorType(error);
  const safeTags = Object.fromEntries(
    Object.entries(tags).filter(
      ([key, value]) =>
        SAFE_TAGS.has(key) && value !== undefined && SAFE_VALUE.test(value),
    ),
  );
  const release = safeSetting(options.release ?? process.env.SPENDWATCH_RELEASE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  timeout.unref?.();
  try {
    const response = await (options.transport ?? fetch)(dsn.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth":
          `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, ` +
          "sentry_client=spendwatch/0.1",
      },
      body: JSON.stringify({
        event_id: randomUUID().replaceAll("-", ""),
        timestamp: Date.now() / 1_000,
        platform: "javascript",
        level: "error",
        logger: "spendwatch",
        message: event,
        fingerprint: ["spendwatch", event, errorType],
        environment: safeSetting(
          options.environment ?? process.env.SPENDWATCH_ENVIRONMENT,
          "production",
        ),
        ...(release ? { release } : {}),
        tags: { service: "spendwatch", error_type: errorType, ...safeTags },
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDsn(dsn: string | undefined): { endpoint: URL; publicKey: string } | null {
  if (!dsn?.trim()) return null;
  try {
    const value = new URL(dsn.trim());
    const parts = value.pathname.split("/").filter(Boolean);
    const projectId = parts.pop();
    if (
      value.protocol !== "https:" ||
      !value.username ||
      value.password ||
      !projectId ||
      !/^\d+$/u.test(projectId)
    ) return null;
    const prefix = parts.length > 0 ? `/${parts.join("/")}` : "";
    return {
      endpoint: new URL(`${prefix}/api/${projectId}/store/`, value.origin),
      publicKey: value.username,
    };
  } catch {
    return null;
  }
}

function safeErrorType(error: unknown): string {
  const candidate = error instanceof Error ? error.name : typeof error;
  return SAFE_VALUE.test(candidate) ? candidate : "Error";
}

function safeSetting(value: string | undefined, fallback?: string): string | undefined {
  return value && SAFE_VALUE.test(value) ? value : fallback;
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ACCESS_CONFIG_PATH = join(homedir(), ".config/spendwatch/cloudflare-access.json");

interface CloudflareAccessConfig {
  origin?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
}

function canonicalHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.includes("*") ||
      url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new Error("invalid capacity coordinator");
  }
  return url;
}

/**
 * Reads a machine-local Cloudflare Access service token only when it is pinned
 * to the exact HTTPS coordinator origin. The token never follows a redirect.
 */
export function coordinatorAccessHeaders(
  coordinator: string,
  configPath = ACCESS_CONFIG_PATH,
): Record<string, string> {
  const target = canonicalHttpsOrigin(coordinator);
  let config: CloudflareAccessConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as CloudflareAccessConfig;
  } catch {
    throw new Error("invalid capacity coordinator access configuration");
  }
  if (typeof config.origin !== "string" || typeof config.client_id !== "string" ||
      typeof config.client_secret !== "string" || !config.client_id || !config.client_secret ||
      config.client_id.length > 4_096 || config.client_secret.length > 16_384) {
    throw new Error("invalid capacity coordinator access configuration");
  }
  let configured: URL;
  try {
    configured = canonicalHttpsOrigin(config.origin);
  } catch {
    throw new Error("invalid capacity coordinator access configuration");
  }
  if (configured.origin !== target.origin) {
    throw new Error("capacity coordinator origin is not trusted");
  }
  return {
    "CF-Access-Client-Id": config.client_id,
    "CF-Access-Client-Secret": config.client_secret,
  };
}

export class CapacityCoordinatorUnavailableError extends Error {
  constructor() {
    super("capacity coordinator unavailable");
    this.name = "CapacityCoordinatorUnavailableError";
  }
}

// Where the subscription gateway keeps its files, read the way the gateway reads them.
//
// Spendwatch only ever reads two kinds of thing from the gateway's own config: the state directory that holds
// the usage ledger, and the `authDirectory` of each Claude or Copilot subscription provider (the account a
// turn was billed to). Everything else in that file is ignored, and nothing from it is ever logged.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";

export type GatewayVendor = "claude" | "copilot";

/** Gateway provider kinds this ledger can bill. */
export const PROVIDER_TYPES: Record<string, GatewayVendor> = {
  "copilot-subscription": "copilot",
  "claude-subscription": "claude",
};

/** The vendor a name stands for in one of these tables; a name an object inherits (`toString`) is not one. */
export function vendorIn(table: Record<string, GatewayVendor>, name: string): GatewayVendor | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

const str = (value: unknown): string => typeof value === "string" ? value : "";

export function home(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Where the installed gateway keeps its files: one product, two platform conventions. */
export function installedConfigDirectory(): string {
  const at = homedir();
  return platform() === "darwin"
    ? join(at, "Library", "Application Support", "Subscription Gateway")
    : join(at, ".config", "subscription-gateway");
}

/**
 * The gateway config file: `$SPENDWATCH_GATEWAY_CONFIG` when set, else the installed one. The gateway's own
 * `GATEWAY_CONFIG` is deliberately not read, because a shell that points it at a development gateway must
 * not redirect the spend of the installed one; name that gateway's state with `SPENDWATCH_GATEWAY_STATE`.
 */
export function gatewayConfigFile(): string {
  const explicit = process.env.SPENDWATCH_GATEWAY_CONFIG;
  return explicit ? resolve(home(explicit)) : join(installedConfigDirectory(), "gateway.json");
}

export interface GatewayConfigView {
  /** The directory every relative path in the config is resolved against. */
  directory: string;
  /** False when there is no readable gateway config, so the gateway's defaults do not apply. */
  found: boolean;
  /** Raw `stateDirectory` key, if any. */
  stateDirectory: string;
  /**
   * Subscription provider id → the login directory it bills through, for providers that set `authDirectory`:
   * a `CLAUDE_CONFIG_DIR` for Claude, a `COPILOT_HOME` for Copilot. Resolved as the gateway resolves it.
   */
  authDirectories: Map<string, AuthDirectory>;
}

export interface AuthDirectory {
  vendor: GatewayVendor;
  directory: string;
}

export function readGatewayConfig(): GatewayConfigView {
  const file = gatewayConfigFile();
  const directory = dirname(file);
  const none: GatewayConfigView = { directory, found: false, stateDirectory: "", authDirectories: new Map() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return none;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return none;
  const config = raw as Record<string, unknown>;
  const authDirectories = new Map<string, AuthDirectory>();
  if (Array.isArray(config.providers)) {
    for (const provider of config.providers as unknown[]) {
      const entry = provider as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object") continue;
      const id = str(entry.id);
      const authDirectory = str(entry.authDirectory);
      // Only a subscription this ledger bills names an account; any other provider's login is not ours to read.
      const vendor = vendorIn(PROVIDER_TYPES, str(entry.type));
      if (id && authDirectory && vendor) authDirectories.set(id, { vendor, directory: resolve(directory, authDirectory) });
    }
  }
  return { directory, found: true, stateDirectory: str(config.stateDirectory), authDirectories };
}

/**
 * The ledger home, in order of who says so: an explicit root, `$SPENDWATCH_GATEWAY_STATE`, the gateway's
 * own config, then the layout `gateway setup` leaves beside it.
 *
 * A readable gateway config answers exactly as the gateway does (`resolve(configDirectory,
 * stateDirectory || ".state")`), so a relative key such as the `.state` that `gateway init` writes lands in
 * the gateway's directory, not in Spendwatch's working directory.
 */
export function resolveStateDirectory(config: GatewayConfigView, override?: string): string | undefined {
  const direct = override ?? process.env.SPENDWATCH_GATEWAY_STATE;
  if (direct) return home(direct);
  if (config.found) return resolve(config.directory, config.stateDirectory || ".state");
  const fallback = join(config.directory, "state");
  return existsSync(fallback) ? fallback : undefined;
}

/** `SPENDWATCH_GATEWAY_PROVIDER_MAP` retargets the provider names telemetry rows carry. */
export function providerMap(): Record<string, GatewayVendor> {
  const map: Record<string, GatewayVendor> = { copilot: "copilot", claude: "claude" };
  const raw = process.env.SPENDWATCH_GATEWAY_PROVIDER_MAP?.trim();
  if (!raw) return map;
  let pairs: Array<[string, unknown]>;
  try {
    pairs = raw.startsWith("{")
      ? Object.entries(JSON.parse(raw) as Record<string, unknown>)
      : raw.split(",").map((entry) => {
        const at = entry.indexOf("=");
        return at < 0 ? [entry.trim(), ""] : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()] as [string, unknown];
      });
  } catch {
    return map;
  }
  for (const [key, value] of pairs) {
    const vendor = str(value);
    if (!key) continue;
    if (vendor === "claude" || vendor === "copilot") map[key] = vendor;
    else delete map[key];
  }
  return map;
}

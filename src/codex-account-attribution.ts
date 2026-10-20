// Reconciles Codex rollout usage with the subscription gateway's content-free
// ledger. It annotates already counted calls only: it never emits a bill.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLAIM_WINDOW_MS } from "./gateway-decisions";
import { gatewayConfigFile, resolveStateDirectory } from "./gateway-config";
import type { Usage } from "./pricing";

export const UNKNOWN_CODEX_ACCOUNT = "Unknown Codex account";
export const CODEX_ACCOUNT_ATTRIBUTION_VERSION = 1;

export type AccountAttributionBasis = "configured-route" | "profile" | "unknown";

export interface AccountAttribution {
  account: string;
  basis: AccountAttributionBasis;
  /** Gateway provider that proved this historical account route. */
  provider?: string;
  /** Stable ledger identity, when the gateway wrote one. */
  ledgerKey?: string;
}

export interface CodexLedgerCall {
  at: number;
  provider: string;
  model: string;
  /** Exact configured alias or upstream slug recorded by the gateway. */
  recordedModel?: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  account: string;
  responseId?: string;
  key?: string;
  origin?: string;
}

export interface CodexAccountRoute {
  provider: string;
  alias: string;
  upstream: string;
  account?: string;
}

interface AccountBinding {
  config?: string;
  provider: string;
  account: string;
  from: number;
  to?: number;
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Each ledger record may correct one rollout call once. Ambiguous matches are
 * deliberately left unknown: a current profile credential cannot prove an old
 * call's account.
 */
export class CodexAccountAttributor {
  private readonly used = new Set<number>();
  private readonly reservations = new Map<string, { vector: string; index: number; attribution: AccountAttribution }>();
  private readonly rows: CodexLedgerCall[];
  /** Complete vectors, indexed before report aggregation starts. */
  private readonly vectors = new Map<string, number[]>();
  private readonly ledgerKeys = new Map<string, number>();

  constructor(private readonly routes: CodexAccountRoute[], rows: CodexLedgerCall[]) {
    // A telemetry echo and its gateway row are one request. The paid gateway
    // record wins, as in the main gateway reader.
    const known = new Map<string, CodexLedgerCall>();
    for (const row of rows) {
      const prior = row.key ? known.get(row.key) : undefined;
      if (!prior || prior.origin === "telemetry" && row.origin === "gateway") known.set(row.key || `row:${known.size}`, row);
    }
    this.rows = [...known.values()];
    for (let index = 0; index < this.rows.length; index++) {
      const row = this.rows[index]!;
      const key = vectorKey(row.provider, row.model, row.input, row.cached, row.cacheWrite, row.output);
      const bucket = this.vectors.get(key);
      if (bucket) bucket.push(index);
      else this.vectors.set(key, [index]);
      if (row.key && !this.ledgerKeys.has(row.key)) this.ledgerKeys.set(row.key, index);
    }
    for (const bucket of this.vectors.values()) bucket.sort((a, b) => this.rows[a]!.at - this.rows[b]!.at);
  }

  /** An exact configured alias is proof of a gateway route even where chatIdentity says "openai". */
  hasConfiguredAlias(model: string | undefined): boolean {
    return !!model && this.routes.some((route) => route.alias === model);
  }

  /**
   * A watch discovery rebuilds the ledger index. Carry reservations only by an
   * immutable gateway row key; that keeps a row already assigned to one rollout
   * from being assigned again by the fresh matcher.
   */
  adoptReservations(previous: CodexAccountAttributor | undefined): void {
    if (!previous) return;
    for (const [requestKey, reservation] of previous.reservations) {
      const ledgerKey = reservation.attribution.ledgerKey;
      const index = ledgerKey ? this.ledgerKeys.get(ledgerKey) : undefined;
      if (index === undefined || this.used.has(index)) continue;
      this.used.add(index);
      this.reservations.set(requestKey, { ...reservation, index });
    }
  }

  resolve(requestKey: string, model: string | undefined, usage: Usage, ts: number, responseId?: string, allowUpstream = false): AccountAttribution | undefined {
    if (!model || !Number.isFinite(ts)) return undefined;
    const gross = usage.input + usage.cacheRead + usage.cache5m + usage.cache1h;
    const vector = `${model}\u0000${gross}\u0000${usage.cacheRead}\u0000${usage.cache5m + usage.cache1h}\u0000${usage.output}\u0000${ts}\u0000${allowUpstream}`;
    const prior = this.reservations.get(requestKey);
    if (prior?.vector === vector) return prior.attribution;
    if (prior) {
      this.used.delete(prior.index);
      this.reservations.delete(requestKey);
    }
    // Rollouts may keep the gateway alias or the exact upstream slug that the
    // configured alias resolved to. Both are explicit configuration values;
    // deliberately do not normalize, trim, or strip provider prefixes.
    const routes = this.routes.filter((route) => route.alias === model || allowUpstream && route.upstream === model);
    const candidates: number[] = [];
    const looked = new Set<string>();
    for (const route of routes) {
      const key = vectorKey(route.provider, route.upstream, gross, usage.cacheRead, usage.cache5m + usage.cache1h, usage.output);
      if (looked.has(key)) continue;
      looked.add(key);
      const bucket = this.vectors.get(key) ?? [];
      for (let at = lowerBound(bucket, this.rows, ts - CLAIM_WINDOW_MS); at < bucket.length; at++) {
        const index = bucket[at]!;
        const row = this.rows[index]!;
        if (row.at > ts + CLAIM_WINDOW_MS) break;
        if (!this.used.has(index)) candidates.push(index);
      }
    }
    // A future gateway row may retain the response id. It resolves an otherwise
    // identical-vector collision, but never waives the complete usage check.
    const pinned = responseId ? candidates.filter((index) => this.rows[index]!.responseId === responseId) : [];
    const chosen = pinned.length ? pinned : candidates;
    // Same vector in multiple providers/accounts is not evidence of either.
    const accounts = new Set(chosen.map((index) => this.rows[index]!.account));
    if (chosen.length !== 1 || accounts.size !== 1) return undefined;
    const index = chosen[0]!;
    this.used.add(index);
    const row = this.rows[index]!;
    const attribution = { account: row.account, basis: "configured-route" as const, provider: row.provider, ...(row.key ? { ledgerKey: row.key } : {}) };
    this.reservations.set(requestKey, { vector, index, attribution });
    return attribution;
  }
}

/** Reads only provider routing, the public email claim, and completed usage vectors. */
export function loadCodexAccountAttributor(sinceMs: number, stateDirectory?: string): CodexAccountAttributor | undefined {
  const file = gatewayConfigFile();
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers)) return undefined;
  const directory = dirname(file);
  const providers = raw.providers.filter((provider: any) =>
    provider && typeof provider === "object" && provider.type === "codex-subscription" &&
    typeof provider.id === "string" && provider.models && typeof provider.models === "object" && !Array.isArray(provider.models));
  if (!providers.length) return undefined;
  const configPath = resolve(file);
  const bindings = loadBindings(configPath);
  if (!bindings.length) return undefined;
  const routes: CodexAccountRoute[] = [];
  for (const provider of providers) {
    for (const [alias, upstream] of Object.entries(provider.models as Record<string, unknown>)) {
      if (typeof upstream === "string" && alias && upstream) routes.push({ provider: provider.id, alias, upstream });
    }
  }
  if (!routes.length) return undefined;
  const state = resolveStateDirectory({ directory, found: true, stateDirectory: text(raw.stateDirectory), authDirectories: new Map() }, stateDirectory);
  if (!state) return undefined;
  const usage = join(state, "usage");
  const rows: CodexLedgerCall[] = [];
  for (const name of safeUsageFiles(usage)) {
    for (const line of readFileSync(join(usage, name), "utf8").split("\n")) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.providerType !== "codex-subscription" || row.status !== "completed") continue;
      const at = typeof row.at === "string" ? Date.parse(row.at) : NaN;
      const input = count(row.inputTokens);
      const cached = count(row.cachedTokens);
      const cacheWrite = count(row.cacheWriteTokens);
      const output = count(row.outputTokens);
      const provider = text(row.provider);
      const model = text(row.model);
      if (!Number.isFinite(at) || at < sinceMs - CLAIM_WINDOW_MS || input === undefined || cached === undefined || cacheWrite === undefined || output === undefined || !provider || !model) continue;
      // Gateway versions have recorded both the request alias and its resolved
      // upstream model. Both values come from the same configured mapping; no
      // prefix stripping or fuzzy model equivalence is allowed.
      const route = routes.find((candidate) => candidate.provider === provider && (candidate.alias === model || candidate.upstream === model));
      const binding = bindingAt(bindings, provider, at);
      if (!route || !binding || cached + cacheWrite > input) continue;
      const host = text(row.host);
      const requestId = text(row.requestId);
      // A fresh watch index can reserve a billed row only when the ledger gives
      // it a durable identity. Refusing anonymous rows is safer than letting one
      // row annotate two rollouts after refresh.
      if (!host || !requestId) continue;
      rows.push({ at, provider, model: route.upstream, recordedModel: model, input, cached, cacheWrite, output, account: binding.account,
        key: `${host}:${requestId}`,
        ...(text(row.responseId) ? { responseId: text(row.responseId) } : {}) });
      const pushed = rows[rows.length - 1]!;
      pushed.origin = text(row.origin);
    }
  }
  return rows.length ? new CodexAccountAttributor(routes, rows) : undefined;
}

/**
 * A public, dated operator binding is the only evidence allowed to name
 * historic gateway rows. Reading the credential currently on disk would
 * relabel old calls after a login change, so it is intentionally not used.
 */
function loadBindings(configPath: string): AccountBinding[] {
  const path = process.env.SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS ||
    join(homedir(), ".config", "spendwatch", "gateway-account-bindings.json");
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.bindings)) return [];
  return raw.bindings.flatMap((value: any): AccountBinding[] => {
    if (!value || typeof value !== "object" || value.basis !== "configured-route" ||
      typeof value.provider !== "string" || !value.provider ||
      typeof value.account !== "string" || !value.account ||
      typeof value.from !== "string") return [];
    const from = Date.parse(value.from);
    const to = value.to === undefined ? undefined : typeof value.to === "string" ? Date.parse(value.to) : NaN;
    if (!Number.isFinite(from) || to !== undefined && !Number.isFinite(to) || to !== undefined && to <= from) return [];
    if (value.config !== undefined && (typeof value.config !== "string" || resolve(value.config) !== configPath)) return [];
    return [{ ...(typeof value.config === "string" ? { config: resolve(value.config) } : {}), provider: value.provider, account: value.account, from, ...(to === undefined ? {} : { to }) }];
  });
}

function bindingAt(bindings: AccountBinding[], provider: string, at: number): AccountBinding | undefined {
  const matches = bindings.filter((binding) => binding.provider === provider && binding.from <= at && (binding.to === undefined || at < binding.to));
  // Overlapping operator declarations conflict; neither identifies the call.
  return matches.length === 1 ? matches[0] : undefined;
}

function vectorKey(provider: string, model: string, input: number, cached: number, cacheWrite: number, output: number): string {
  return `${provider}\u0000${model}\u0000${input}\u0000${cached}\u0000${cacheWrite}\u0000${output}`;
}

function lowerBound(bucket: number[], rows: CodexLedgerCall[], at: number): number {
  let low = 0;
  let high = bucket.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[bucket[middle]!]!.at < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

function safeUsageFiles(directory: string): string[] {
  try {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

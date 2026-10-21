// Opt-in semantic dominance proof for divergent Codex rollout copies.
//
// `codex-rollout-copies.ts` only ever selects a copy whose bytes are a complete prefix of the
// chosen one. When profile homes or archive moves leave copies that diverge at the byte level,
// this module can prove — instead of comparing bytes — that one candidate's parsed Spendwatch
// event model contains every other candidate's: identical ordered API and observed billing
// sequences, an identical response-item multiset, and a nonbilling multiset that is a superset
// of all the others. Nothing is ever merged or counted twice: exactly one existing file is
// returned, or `undefined` keeps the caller's visible divergent-copy error.
//
// Privacy is structural: each manifest keeps only SHA-256 hashes and multiplicities. Prompt
// text, tool arguments, tool output, token totals, credentials and raw JSON are hashed and
// discarded; they never enter the cache or leave this module.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { newCodexCtx, parseCodexLine, settleRouted } from "./codex";
import type { Event } from "./parse";
import type {
  CodexRolloutFileIdentity,
  CodexRolloutSemanticCandidate,
  CodexRolloutSemanticDominance,
} from "./codex-rollout-copies";

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
// A manifest larger than this is not a duplicate proof in v1; it fails closed.
const MAX_EVENTS = 1_000_000;
// Candidate manifests are keyed by their stat signature, so an entry can never describe a
// different revision of a file. Bounded LRU, same discipline as the comparison caches.
const CACHE_LIMIT = 64;
const MAX_CACHED_FACTS = 2_000_000;
const HASH_CHARS = 32;

/** Which billing representation the file emitted. The two must not be mixed within a candidate pair. */
type BillingFormat = "records" | "counts" | "none";

interface Manifest {
  /** Parser-derived facts this manifest retains across its ordered arrays and multisets. */
  facts: number;
  format: BillingFormat;
  /** Ordered event hashes of every emitted API event. */
  api: string[];
  /** Ordered event hashes of every emitted observed event. */
  observed: string[];
  /** Multiset of response-item derived tool-use/tool-result identities. */
  responses: Map<string, number>;
  /** Full canonical response-item records, in source order, hashed and immediately discarded. */
  rawResponses: string[];
  /** Multiset of prompt and non-response-item tool events, hashed with a content digest. */
  nonbilling: Map<string, number>;
}
interface CachedManifest {
  manifest: Manifest;
  facts: number;
}

interface SemanticSource {
  parse: (line: string, ctx: unknown) => Iterable<Event>;
  settle?: (ctx: unknown, final: boolean) => Iterable<Event>;
  semanticCtx: () => unknown;
  semanticKey: string;
  project: string;
}

const defaultSource: SemanticSource = {
  parse: parseCodexLine,
  settle: settleRouted,
  semanticCtx: () => newCodexCtx(),
  semanticKey: "codex-v1",
  project: "?",
};

function semanticSource(value: unknown): SemanticSource | undefined {
  if (value === null || typeof value !== "object" || !("parse" in value)) return defaultSource;
  const source = value as Partial<SemanticSource>;
  if (
    typeof source.parse !== "function"
    || typeof source.semanticCtx !== "function"
    || typeof source.semanticKey !== "string"
    || typeof source.project !== "string"
    || source.semanticKey.length === 0
  ) return undefined;
  return source as SemanticSource;
}

function hashKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, HASH_CHARS);
}

function stableJson(value: unknown, depth = 0): string | undefined {
  if (depth > 128) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const parts = value.map((item) => stableJson(item, depth + 1));
    return parts.some((part) => part === undefined) ? undefined : `[${parts.join(",")}]`;
  }
  if (typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => {
      const encoded = stableJson(item, depth + 1);
      return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
    });
  return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
}

function canonicalResponseItem(row: Record<string, unknown>): string | undefined {
  // `ordinal` is recorder bookkeeping, not response identity or content. Extra nonbilling
  // records shift it in a copied rollout. Only a reasoning item's `payload.content` is optional:
  // JSON null and an omitted field both mean no reasoning content. Every non-null value
  // (including []) remains distinct, as do all fields of every other response type.
  const { ordinal: _ordinal, ...response } = row;
  const payload = response.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).type === "reasoning") {
    const content = (payload as Record<string, unknown>).content;
    if (content === undefined || content === null) response.payload = { ...payload as Record<string, unknown>, content: null };
  }
  return stableJson(response);
}

function addKey(multiset: Map<string, number>, key: string): void {
  multiset.set(key, (multiset.get(key) ?? 0) + 1);
}

function apiKey(e: Extract<Event, { t: "api" }>, project: string): string {
  const u = e.usage;
  // Kind, effective stream identity, timestamp, model/provider/route, normalized usage, and
  // parser request identity. All of these influence the reader's eventual report.
  return hashKey([
    "api", e.sessionId, project, e.ts, e.model ?? "", e.modelProvider ?? "",
    u.input, u.output, u.cacheRead, u.cache5m, u.cache1h, e.requestId,
    e.gateway?.id ?? "", e.gateway?.role ?? "",
  ]);
}

function toolKey(e: Extract<Event, { t: "tooluse" | "toolresult" }>, responseItem: boolean, project: string, contentDigest: string): string {
  const tag = responseItem ? "r" : "n";
  if (e.t === "tooluse") {
    return tag === "r"
      // Response-item identities intentionally carry only the derived fields the parser exposes.
      ? hashKey([tag, "tooluse", e.sessionId, project, e.ts, e.id, e.name, e.argChars])
      // Non-response tools include a digest of the raw parser-relevant row, never its content.
      : hashKey([tag, "tooluse", e.sessionId, project, e.ts, e.id, e.name, e.argChars, contentDigest]);
  }
  return responseItem
    ? hashKey([tag, "toolresult", e.sessionId, project, e.ts, e.id, e.chars, e.exit ?? "", e.error ? 1 : 0])
    : hashKey([tag, "toolresult", e.sessionId, project, e.ts, e.id, e.chars, e.exit ?? "", e.error ? 1 : 0, contentDigest]);
}

/** Parses one complete snapshot with the source's parser and isolated, gateway-free context. */
function buildManifest(
  path: string,
  size: number,
  identity: CodexRolloutFileIdentity,
  source: SemanticSource,
): Manifest | undefined {
  if (size <= 0 || size > MAX_FILE_BYTES || size !== identity.size) return undefined;
  // The source factory deliberately gives this proof no live reader context or gateway ledger.
  // Its parser and final settler still exactly match the source that would consume the rollout.
  let ctx: unknown;
  try {
    ctx = source.semanticCtx();
  } catch {
    return undefined;
  }
  const manifest: Manifest = {
    facts: 0, format: "none", api: [], observed: [], responses: new Map(), rawResponses: [], nonbilling: new Map(),
  };
  let total = 0;
  let sawRecordLine = false;
  let sawCountApi = false;
  let project = source.project;

  const ingest = (line: string): boolean | undefined => {
    if (!line.trim()) return true;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return false; // torn or invalid complete row
    }
    const kind = typeof d?.type === "string" ? d.type : "";
    const sub = kind === "event_msg" && typeof d?.payload?.type === "string" ? d.payload.type : "";
    if (kind === "token_usage_record") sawRecordLine = true;
    if (kind === "response_item") {
      let canonical: string | undefined;
      try {
        canonical = canonicalResponseItem(d as Record<string, unknown>);
      } catch {
        return false;
      }
      if (canonical === undefined) return false;
      if (++total > MAX_EVENTS) return undefined;
      manifest.rawResponses.push(hashKey(["raw-response-item", canonical]));
    }
    let countApi = false;
    let emitted: Iterable<Event>;
    try {
      emitted = source.parse(line, ctx);
    } catch {
      return false;
    }
    const contentDigest = hashKey(["source-row", line]);
    const accept = (e: Event): boolean | undefined => {
      if (!validEvent(e)) return false;
      if (++total > MAX_EVENTS) return undefined; // cap reached: too big to prove in v1
      switch (e.t) {
        case "api":
          if (sub === "token_count") countApi = true;
          manifest.api.push(apiKey(e, project));
          return true;
        case "observed":
          manifest.observed.push(hashKey(["observed", e.sessionId, project, e.ts]));
          return true;
        case "prompt":
          // Event identity plus a content digest; the text itself is never retained.
          addKey(manifest.nonbilling, hashKey(["prompt", e.sessionId, project, e.promptId, e.ts, e.text]));
          return true;
        case "tooluse":
        case "toolresult":
          addKey(kind === "response_item" ? manifest.responses : manifest.nonbilling, toolKey(e, kind === "response_item", project, contentDigest));
          return true;
        case "meta":
          if (e.project !== undefined) project = e.project;
          return true; // redundant metadata can differ; its effective state is in every later identity.
        default:
          return false; // routed output or an unknown event: the parser emitted something we cannot prove
      }
    };
    try {
      for (const e of emitted) {
        const accepted = accept(e);
        if (accepted !== true) return accepted;
      }
    } catch {
      return false;
    }
    if (countApi) sawCountApi = true;
    return true;
  };

  const outcome = forEachLine(path, size, identity, ingest);
  if (outcome !== true) return undefined;
  if (source.settle) {
    let settled: Iterable<Event>;
    try {
      settled = source.settle(ctx, true);
      for (const e of settled) {
        if (!validEvent(e)) return undefined;
        if (++total > MAX_EVENTS) return undefined;
        if (e.t === "api") manifest.api.push(apiKey(e, project));
        else if (e.t === "observed") manifest.observed.push(hashKey(["observed", e.sessionId, project, e.ts]));
        else return undefined; // settling a nonbilling/routed fact has no safe one-sided interpretation.
      }
    } catch {
      return undefined;
    }
  }
  if (sawRecordLine && sawCountApi) return undefined; // mixed billing formats within one file
  manifest.format = sawRecordLine ? "records" : sawCountApi ? "counts" : "none";
  manifest.facts = total;
  return manifest;
}

/**
 * Streams a complete, stable snapshot without retaining it. Any partial or over-long row fails;
 * semantic dominance never proves a file still being written. Returns false on failure and
 * undefined when `onLine` asked to stop (cap).
 */
function forEachLine(
  path: string,
  size: number,
  identity: CodexRolloutFileIdentity,
  onLine: (line: string) => boolean | undefined,
): boolean | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    if (!matchesIdentity(fstatSync(fd), identity)) return false;
    let offset = 0;
    let pending = Buffer.alloc(0);
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count <= 0) return false; // the inspected bytes vanished
      offset += count;
      let start = 0;
      for (let index = 0; index < count; index++) {
        if (buffer[index] !== 0x0a) continue;
        const line = pending.length === 0
          ? buffer.subarray(start, index)
          : Buffer.concat([pending, buffer.subarray(start, index)]);
        pending = Buffer.alloc(0);
        if (line.length > MAX_LINE_BYTES) return false;
        const stop = onLine(line.toString("utf8"));
        if (stop !== true) return stop;
        start = index + 1;
      }
      if (start < count) {
        pending = pending.length === 0
          ? Buffer.from(buffer.subarray(start, count))
          : Buffer.concat([pending, buffer.subarray(start, count)]);
        if (pending.length > MAX_LINE_BYTES) return false;
      }
    }
    // Semantic selection proves complete snapshots only. Byte-prefix comparison continues to
    // ignore a writer's pending tail, but such a tail can never participate in this proof.
    return pending.length === 0 && matchesIdentity(fstatSync(fd), identity);
  } finally {
    closeSync(fd);
  }
}

function matchesIdentity(stats: Stats, expected: CodexRolloutFileIdentity): boolean {
  return stats.isFile()
    && stats.dev === expected.dev
    && stats.ino === expected.ino
    && stats.size === expected.size
    && stats.mtimeMs === expected.mtimeMs
    && stats.ctimeMs === expected.ctimeMs;
}

function validEvent(event: unknown): event is Event {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  if (typeof e.t !== "string" || !nonempty(e.sessionId) || !whole(e.ts)) return false;
  switch (e.t) {
    case "meta":
      return optionalString(e.project) && optionalString(e.model);
    case "observed":
      return true;
    case "prompt":
      return nonempty(e.promptId) && typeof e.text === "string" && typeof e.sidechain === "boolean";
    case "tooluse":
      return nonempty(e.requestId) && nonempty(e.id) && nonempty(e.name) && whole(e.argChars)
        && optionalString(e.sub) && optionalString(e.deep) && optionalString(e.detail);
    case "toolresult":
      return nonempty(e.id) && whole(e.chars) && (e.error === undefined || typeof e.error === "boolean")
        && (e.exit === undefined || whole(e.exit));
    case "api": {
      const usage = e.usage;
      if (!nonempty(e.requestId) || !validUsage(usage) || !optionalString(e.model) || !optionalString(e.modelProvider)) return false;
      if (e.costUsd !== undefined && (typeof e.costUsd !== "number" || !Number.isFinite(e.costUsd) || e.costUsd < 0)) return false;
      if (e.sidechain !== false && e.sidechain !== true) return false;
      if (e.gateway === undefined) return true;
      if (!e.gateway || typeof e.gateway !== "object") return false;
      const gateway = e.gateway as Record<string, unknown>;
      return nonempty(gateway.id) && (gateway.role === "billed" || gateway.role === "unconfirmed");
    }
    default:
      return false;
  }
}

function validUsage(usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as Record<string, unknown>;
  return whole(u.input) && whole(u.output) && whole(u.cacheRead) && whole(u.cache5m) && whole(u.cache1h);
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function sameSeq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameMultiset(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) if (b.get(key) !== count) return false;
  return true;
}

function superset(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  for (const [key, count] of b) if ((a.get(key) ?? 0) < count) return false;
  return true;
}

/** True when `a`'s parsed model contains `b`'s: equal billing and response items, a nonbilling superset. */
function dominates(a: Manifest, b: Manifest): boolean {
  return a.format === b.format
    && sameSeq(a.api, b.api)
    && sameSeq(a.observed, b.observed)
    && sameSeq(a.rawResponses, b.rawResponses)
    && sameMultiset(a.responses, b.responses)
    && superset(a.nonbilling, b.nonbilling);
}

/**
 * Builds the opt-in callback for `selectCodexRolloutCopies`. Manifests are cached per candidate
 * stat signature, so a stable duplicate group is parsed once per process. The cache belongs to
 * this callback alone and never shares state with the byte-prefix decisions.
 */
export function createCodexRolloutSemanticDominance(): CodexRolloutSemanticDominance {
  const cache = new Map<string, CachedManifest>();
  let cachedFacts = 0;
  return <T>(candidates: readonly CodexRolloutSemanticCandidate<T>[]): string | undefined => {
    if (candidates.length < 2) return undefined;
    const parsed: Array<{ candidate: CodexRolloutSemanticCandidate<T>; manifest: Manifest }> = [];
    for (const candidate of candidates) {
      const source = semanticSource(candidate.value);
      if (!source) return undefined;
      // A path can be parsed by a different source variant without changing its stat signature
      // (notably free/Qwen filtering), and the initial project affects every event identity.
      const cacheKey = `${candidate.signature}\0${source.semanticKey}\0${source.project}`;
      let cached = cache.get(cacheKey);
      let manifest: Manifest;
      if (cached === undefined) {
        manifest = buildManifest(candidate.path, candidate.size, candidate.identity, source);
        if (!manifest) return undefined;
        // A single bounded manifest can be retained only when it also fits the
        // process-wide fact budget. Never evict decoded files: this cache owns
        // only in-memory proof summaries.
        if (manifest.facts <= MAX_CACHED_FACTS) {
          while (cache.size >= CACHE_LIMIT || cachedFacts + manifest.facts > MAX_CACHED_FACTS) {
            const [oldestKey, oldest] = cache.entries().next().value! as [string, CachedManifest];
            cache.delete(oldestKey);
            cachedFacts -= oldest.facts;
          }
          cached = { manifest, facts: manifest.facts };
          cache.set(cacheKey, cached);
          cachedFacts += cached.facts;
        }
      } else {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        manifest = cached.manifest;
      }
      parsed.push({ candidate, manifest });
    }
    const winners = parsed.filter((entry) => parsed.every((other) => dominates(entry.manifest, other.manifest)));
    if (winners.length === 0) return undefined;
    if (winners.length === 1) return winners[0]!.candidate.path;
    // Manifests are equal: the existing priority/path tie-breaker decides, as for identical clones.
    return [...winners]
      .map((entry) => entry.candidate)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.path.localeCompare(b.path))[0]!.path;
  };
}

/**
 * Test/diagnostic helper: counts per bucket of one file's manifest, freshly built. Only shapes
 * are returned — never hashes of retained content beyond what selection itself exposes.
 */
export function codexRolloutManifestSummary(path: string): { format: BillingFormat; api: number; observed: number; responses: number; nonbilling: number } | undefined {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const manifest = buildManifest(path, stats.size, {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }, defaultSource);
  if (!manifest) return undefined;
  const multisetSize = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    format: manifest.format,
    api: manifest.api.length,
    observed: manifest.observed.length,
    responses: multisetSize(manifest.responses),
    nonbilling: multisetSize(manifest.nonbilling),
  };
}

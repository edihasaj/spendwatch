// Chooses one complete Codex rollout when profile homes or archive moves leave copies behind.
// A copied basename must be byte-for-byte a prefix of the selected file.  Otherwise we fail
// the collection: choosing either branch would make a successful report silently incomplete.
// A caller may opt into a semantic dominance proof (see codex-rollout-semantics.ts) before
// that failure; without the callback, the byte-prefix rule below is exactly what runs.
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename } from "node:path";

const CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const CACHE_LIMIT = 256;

export interface CodexRolloutCopy<T> {
  path: string;
  /** Lower values win only when complete contents are identical. */
  priority?: number;
  value: T;
}

interface ValidCopy<T> extends CodexRolloutCopy<T> {
  completeBytes: number;
  signature: string;
  size: number;
  symlink: boolean;
  identity: CodexRolloutFileIdentity;
}

export interface CodexRolloutFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * One already-inspected complete duplicate candidate handed to an opt-in semantic dominance
 * proof: its path, the stable stat signature the proof must still describe afterwards, and the
 * caller's value. The callback returns one of these paths, or nothing.
 */
export interface CodexRolloutSemanticCandidate<T> {
  path: string;
  signature: string;
  size: number;
  identity: CodexRolloutFileIdentity;
  priority?: number;
  value: T;
}

/** Returns the existing path whose parsed model dominates all the others, or undefined to keep the visible error. */
export type CodexRolloutSemanticDominance =
  <T>(candidates: readonly CodexRolloutSemanticCandidate<T>[]) => string | undefined;

export interface CodexRolloutCopyOptions<T> {
  semanticDominance?: CodexRolloutSemanticDominance;
}

interface InspectedCopy<T> {
  copy: CodexRolloutCopy<T>;
  signature: string;
  size: number;
  symlink: boolean;
  identity: CodexRolloutFileIdentity;
}

const comparisonCache = new Map<string, string>();
const completePrefixCache = new Map<string, number>();

export class CodexRolloutCopyError extends Error {
  constructor(message: string, readonly paths: readonly string[]) {
    super(message);
    this.name = "CodexRolloutCopyError";
  }
}

/**
 * Selects one rollout for every basename. Only duplicate basenames are validated:
 * ordinary singleton files remain the normal parser's responsibility.
 *
 * A trailing non-newline record is still being written, so it deliberately does not take
 * part in comparison.  `value` is returned unmodified, letting discovery retain its account
 * and parser metadata while this module owns only filesystem safety.
 *
 * Without `options.semanticDominance` this is the strict byte-prefix rule, unchanged. With it,
 * a divergent group may still select one existing copy when the callback proves semantic
 * dominance over every candidate; the proof's caches stay separate from the byte-prefix ones,
 * so neither mode can contaminate the other's decisions.
 */
export function selectCodexRolloutCopies<T>(
  copies: readonly CodexRolloutCopy<T>[],
  options?: CodexRolloutCopyOptions<T>,
): T[] {
  const grouped = new Map<string, CodexRolloutCopy<T>[]>();
  for (const copy of copies) {
    const name = basename(copy.path);
    const members = grouped.get(name);
    if (members) members.push(copy);
    else grouped.set(name, [copy]);
  }

  const selected: T[] = [];
  for (const name of [...grouped.keys()].sort()) {
    const copiesForName = grouped.get(name)!;
    // The normal parser owns ordinary singletons. Do not rescan or reject their
    // contents here: this safeguard exists only where copies can hide new tails.
    selected.push(copiesForName.length === 1 ? copiesForName[0]!.value : selectOne(name, copiesForName, options));
  }
  return selected;
}

function selectOne<T>(name: string, copies: readonly CodexRolloutCopy<T>[], options?: CodexRolloutCopyOptions<T>): T {
  const signatures = copies.map((copy) => inspect(copy, name));
  // A semantic callback is caller-specific. Never cache its decision here: a later caller may
  // use a stricter parser or decline the proof for these same bytes.
  const cacheKey = comparisonKey(name, signatures);
  if (!options?.semanticDominance) {
    const cachedPath = comparisonCache.get(cacheKey);
    if (cachedPath) {
      const cached = copies.find((copy) => copy.path === cachedPath);
      if (cached) {
        touch(comparisonCache, cacheKey, cachedPath);
        return cached.value;
      }
    }
  }

  const valid: ValidCopy<T>[] = signatures.map(({ copy, signature, size, symlink, identity }) => ({
    ...copy,
    signature,
    size,
    symlink,
    identity,
    completeBytes: completedBytes(copy.path, name, signature, size),
  }));
  valid.sort(comparePreferred);
  const winner = valid[0]!;

  // A raw prefix is only a safe fast path when both copies have the same parser contract.
  // SourceFile values opt into this marker: paid Codex and free/Qwen can give the same bytes
  // different emitted billing, so their byte relation alone proves nothing. Plain callers retain
  // the historical prefix behavior because they have no semantic contract.
  if (options?.semanticDominance && hasDifferentSemanticContracts(valid)) {
    const semantic = semanticSelection(name, valid, options.semanticDominance);
    if (semantic) return semantic.value;
    throw new CodexRolloutCopyError(
      `Codex rollout "${name}" has copies with different parser contracts; refusing a partial usage report.`,
      valid.map((entry) => entry.path),
    );
  }

  for (const other of valid.slice(1)) {
    const shared = Math.min(winner.completeBytes, other.completeBytes);
    if (samePrefix(winner.path, other.path, shared)) continue;
    const semantic = options?.semanticDominance
      ? semanticSelection(name, valid, options.semanticDominance)
      : undefined;
    if (semantic) return semantic.value;
    throw new CodexRolloutCopyError(
      `Codex rollout "${name}" has divergent complete copies; refusing a partial usage report.`,
      [winner.path, other.path],
    );
  }
  touch(comparisonCache, cacheKey, winner.path);
  return winner.value;
}

function hasDifferentSemanticContracts<T>(copies: readonly ValidCopy<T>[]): boolean {
  const contracts = new Set(copies.map((copy) => semanticContract(copy.value)));
  return contracts.size > 1 && [...contracts].some((contract) => contract !== undefined);
}

function semanticContract(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as { semanticKey?: unknown; project?: unknown };
  return typeof source.semanticKey === "string" && source.semanticKey.length > 0 && typeof source.project === "string"
    ? `${source.semanticKey}\0${source.project}`
    : undefined;
}

/**
 * Runs the opt-in proof over the already-inspected candidates (longest complete prefix first).
 * A returned path must be one of them, and every candidate must still carry the exact signature
 * the proof was built on: any growth, rewrite, or symlink target change during the proof
 * invalidates it and takes the existing visible error path.
 */
function semanticSelection<T>(
  name: string,
  valid: readonly ValidCopy<T>[],
  dominance: CodexRolloutSemanticDominance,
): ValidCopy<T> | undefined {
  // A path can be retargeted from A to B and back while a callback reads it. The byte-prefix
  // comparison remains safe because it reads both paths directly; the semantic proof has no
  // stable descriptor API, so it fails closed for symlink candidates.
  if (valid.some((entry) => entry.symlink)) return undefined;
  const candidates = valid.map(({ path, signature, size, priority, value, identity }) => ({
    path, signature, size, priority, value, identity,
  }));
  const chosen = dominance(candidates);
  for (const entry of valid) {
    if (inspect(entry, name).signature !== entry.signature) {
      throw new CodexRolloutCopyError(
        `Codex rollout "${name}" changed during the semantic duplicate proof; refusing a partial usage report.`,
        valid.map((entry) => entry.path),
      );
    }
  }
  if (chosen === undefined) return undefined;
  const winner = valid.find((entry) => entry.path === chosen);
  if (!winner) {
    throw new CodexRolloutCopyError(`Codex rollout "${name}" semantic proof returned an unknown path.`, [chosen]);
  }
  return winner;
}

function comparePreferred<T>(a: ValidCopy<T>, b: ValidCopy<T>): number {
  return b.completeBytes - a.completeBytes
    || (a.priority ?? 0) - (b.priority ?? 0)
    || a.path.localeCompare(b.path);
}

function inspect<T>(copy: CodexRolloutCopy<T>, rollout: string): InspectedCopy<T> {
  let stats: Stats;
  let link: Stats;
  let resolved: string;
  try {
    stats = statSync(copy.path);
    link = lstatSync(copy.path);
    resolved = realpathSync(copy.path);
  } catch {
    throw new CodexRolloutCopyError(`Could not stat Codex rollout "${rollout}".`, [copy.path]);
  }
  return {
    copy,
    // A path can never contain NUL, so this is an unambiguous bounded cache key.
    // `stat` describes the current target; `lstat` and the canonical target make an atomic
    // symlink retarget visible even when the replacement file happens to have matching bytes.
    signature: [
      copy.path,
      resolved,
      link.ino,
      link.size,
      link.mtimeMs,
      link.ctimeMs,
      stats.ino,
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join("\0"),
    size: stats.size,
    symlink: link.isSymbolicLink(),
    identity: {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    },
  };
}

function comparisonKey<T>(
  rollout: string,
  copies: readonly InspectedCopy<T>[],
): string {
  return JSON.stringify([
    rollout,
    copies.map(({ copy, signature }) => [signature, copy.priority ?? 0]).sort(),
  ]);
}

function completedBytes(path: string, rollout: string, signature: string, size: number): number {
  const cached = completePrefixCache.get(signature);
  if (cached !== undefined) {
    touch(completePrefixCache, signature, cached);
    return cached;
  }
  const complete = validJsonlBytes(path, rollout, size);
  touch(completePrefixCache, signature, complete);
  return complete;
}

function touch<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/**
 * Returns the byte position immediately after the last complete valid JSONL row.
 * The partial final row is intentionally ignored. A malformed newline-terminated row is
 * unsafe: it could conceal a divergent branch, so callers receive a visible collection error.
 */
function validJsonlBytes(path: string, rollout: string, size: number): number {
  if (size === 0) return 0;

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new CodexRolloutCopyError(`Could not open Codex rollout "${rollout}".`, [path]);
  }

  let offset = 0;
  let completed = 0;
  let pending = Buffer.alloc(0);
  const buffer = Buffer.alloc(CHUNK_BYTES);
  try {
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count <= 0) break;
      offset += count;
      let start = 0;
      for (let index = 0; index < count; index++) {
        if (buffer[index] !== 0x0a) continue;
        const line = pending.length === 0
          ? buffer.subarray(start, index)
          : Buffer.concat([pending, buffer.subarray(start, index)]);
        validateLine(line, path, rollout);
        pending = Buffer.alloc(0);
        completed = offset - count + index + 1;
        start = index + 1;
      }
      if (start < count) {
        pending = pending.length === 0
          ? Buffer.from(buffer.subarray(start, count))
          : Buffer.concat([pending, buffer.subarray(start, count)]);
        if (pending.length > MAX_JSONL_LINE_BYTES) {
          throw new CodexRolloutCopyError(`Codex rollout "${rollout}" has an unterminated row over ${MAX_JSONL_LINE_BYTES} bytes.`, [path]);
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  return completed;
}

function validateLine(bytes: Buffer, path: string, rollout: string): void {
  if (bytes.length === 0) return;
  try {
    JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CodexRolloutCopyError(`Codex rollout "${rollout}" has an invalid complete JSONL row.`, [path]);
  }
}

/** Compares only a shared prefix, without retaining either rollout in memory. */
function samePrefix(left: string, right: string, bytes: number): boolean {
  if (bytes === 0 || left === right) return true;
  let leftFd: number;
  let rightFd: number;
  try {
    leftFd = openSync(left, "r");
    rightFd = openSync(right, "r");
  } catch {
    throw new CodexRolloutCopyError("Could not open Codex rollout copies for comparison.", [left, right]);
  }

  const leftBuffer = Buffer.alloc(CHUNK_BYTES);
  const rightBuffer = Buffer.alloc(CHUNK_BYTES);
  try {
    let offset = 0;
    while (offset < bytes) {
      const want = Math.min(CHUNK_BYTES, bytes - offset);
      const leftRead = readSync(leftFd, leftBuffer, 0, want, offset);
      const rightRead = readSync(rightFd, rightBuffer, 0, want, offset);
      if (leftRead !== want || rightRead !== want || !leftBuffer.subarray(0, want).equals(rightBuffer.subarray(0, want))) return false;
      offset += want;
    }
    return true;
  } finally {
    closeSync(leftFd);
    closeSync(rightFd);
  }
}

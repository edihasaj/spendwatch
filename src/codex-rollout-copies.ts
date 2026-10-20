// Chooses one complete Codex rollout when profile homes or archive moves leave copies behind.
// A copied basename must be byte-for-byte a prefix of the selected file.  Otherwise we fail
// the collection: choosing either branch would make a successful report silently incomplete.
import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
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
}

interface InspectedCopy<T> {
  copy: CodexRolloutCopy<T>;
  signature: string;
  size: number;
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
 */
export function selectCodexRolloutCopies<T>(copies: readonly CodexRolloutCopy<T>[]): T[] {
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
    selected.push(copiesForName.length === 1 ? copiesForName[0]!.value : selectOne(name, copiesForName));
  }
  return selected;
}

function selectOne<T>(name: string, copies: readonly CodexRolloutCopy<T>[]): T {
  const signatures = copies.map((copy) => inspect(copy, name));
  const cacheKey = comparisonKey(name, signatures);
  const cachedPath = comparisonCache.get(cacheKey);
  if (cachedPath) {
    const cached = copies.find((copy) => copy.path === cachedPath);
    if (cached) {
      touch(comparisonCache, cacheKey, cachedPath);
      return cached.value;
    }
  }

  const valid = signatures.map(({ copy, signature, size }) => ({
    ...copy,
    signature,
    completeBytes: completedBytes(copy.path, name, signature, size),
  }));
  valid.sort(comparePreferred);
  const winner = valid[0]!;

  for (const other of valid.slice(1)) {
    const shared = Math.min(winner.completeBytes, other.completeBytes);
    if (!samePrefix(winner.path, other.path, shared)) {
      throw new CodexRolloutCopyError(
        `Codex rollout "${name}" has divergent complete copies; refusing a partial usage report.`,
        [winner.path, other.path],
      );
    }
  }
  touch(comparisonCache, cacheKey, winner.path);
  return winner.value;
}

function comparePreferred<T>(a: ValidCopy<T>, b: ValidCopy<T>): number {
  return b.completeBytes - a.completeBytes
    || (a.priority ?? 0) - (b.priority ?? 0)
    || a.path.localeCompare(b.path);
}

function inspect<T>(copy: CodexRolloutCopy<T>, rollout: string): InspectedCopy<T> {
  let stats: Stats;
  try {
    stats = statSync(copy.path);
  } catch {
    throw new CodexRolloutCopyError(`Could not stat Codex rollout "${rollout}".`, [copy.path]);
  }
  return {
    copy,
    // A path can never contain NUL, so this is an unambiguous bounded cache key.
    signature: [copy.path, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join("\0"),
    size: stats.size,
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

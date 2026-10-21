// Private, checked snapshots let the ordinary Codex parser handle .jsonl.zst
// archives without changing duplicate, account, or gateway semantics.
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync,
  rmSync, statSync, writeFileSync, type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// Native Codex archives include verified sessions around 664 MiB decoded. Keep
// an explicit per-file ceiling while admitting that real retained history.
const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;
// The recovered corpus has 2,628 files; leave room for new archive moves in a
// long-running watch without silently evicting a still-referenced snapshot.
const MAX_SNAPSHOTS = 10_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024 * 1024;

interface SourceIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
interface Snapshot {
  path: string;
  identity: SourceIdentity;
}
const snapshots = new Map<string, Snapshot>();
let totalSnapshotBytes = 0;
let root: string | undefined;
let cleanupInstalled = false;

export class CodexCompressedRolloutError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "CodexCompressedRolloutError";
  }
}

function sameIdentity(actual: Stats, expected: SourceIdentity): boolean {
  return actual.isFile()
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}

function identityOf(path: string): SourceIdentity {
  let link: Stats;
  let fd: number;
  try {
    link = lstatSync(path);
    if (!link.isFile()) throw new Error("not a regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CodexCompressedRolloutError("Could not safely open compressed Codex rollout.", path);
  }
  try {
    const actual = fstatSync(fd);
    if (!sameIdentity(actual, link)) throw new Error("changed while opening");
    return { dev: actual.dev, ino: actual.ino, size: actual.size, mtimeMs: actual.mtimeMs, ctimeMs: actual.ctimeMs };
  } catch {
    throw new CodexCompressedRolloutError("Compressed Codex rollout changed while opening.", path);
  } finally {
    closeSync(fd);
  }
}

/** Admits a compressed native file before callers decide whether its mtime is in range. */
export function assertSafeCodexCompressedRollout(path: string): void {
  if (path.endsWith(".jsonl.zst")) identityOf(path);
}

function cacheKey(path: string, identity: SourceIdentity): string {
  return [path, identity.dev, identity.ino, identity.size, identity.mtimeMs, identity.ctimeMs].join("\0");
}

function safeStat(path: string): Stats | undefined {
  try { return statSync(path); } catch { return undefined; }
}

function cleanup(): void {
  if (!root) return;
  rmSync(root, { recursive: true, force: true });
  root = undefined;
  snapshots.clear();
  totalSnapshotBytes = 0;
}

function snapshotRoot(): string {
  if (root) return root;
  // A fresh mode-0700 directory prevents another process from seeing decoded
  // transcript bytes or replacing an archive cache entry.
  root = mkdtempSync(join(tmpdir(), "spendwatch-codex-zstd-"));
  chmodSync(root, 0o700);
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.once("exit", cleanup);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  }
  return root;
}

function validateJsonl(bytes: Buffer, source: string): void {
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(start, index);
    start = index + 1;
    if (line.length === 0) continue;
    if (line.length > MAX_LINE_BYTES) {
      throw new CodexCompressedRolloutError("Decoded Codex rollout has an overlong JSONL row.", source);
    }
    try { JSON.parse(line.toString("utf8")); }
    catch { throw new CodexCompressedRolloutError("Decoded Codex rollout has an invalid or incomplete JSONL row.", source); }
  }
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    throw new CodexCompressedRolloutError("Decoded Codex rollout has an incomplete final JSONL row.", source);
  }
}

function createSnapshot(source: string, identity: SourceIdentity, remainingBytes: number): Snapshot {
  let fd: number;
  try { fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new CodexCompressedRolloutError("Could not safely open compressed Codex rollout.", source); }
  let directory: string | undefined;
  let destination: string | undefined;
  let published = false;
  try {
    directory = mkdtempSync(join(snapshotRoot(), "rollout-"));
    destination = join(directory, basename(source, ".zst"));
    if (!sameIdentity(fstatSync(fd), identity)) {
      throw new CodexCompressedRolloutError("Compressed Codex rollout changed before decoding.", source);
    }
    const decoded = spawnSync(process.env.SPENDWATCH_ZSTD_BIN || "zstd", ["-d", "-c", "-M128M"], {
      stdio: [fd, "pipe", "pipe"], timeout: DECODE_TIMEOUT_MS, maxBuffer: Math.min(MAX_DECODED_BYTES, remainingBytes),
    });
    if (decoded.error || decoded.signal || decoded.status !== 0 || !Buffer.isBuffer(decoded.stdout)) {
      throw new CodexCompressedRolloutError("Could not decode compressed Codex rollout with zstd.", source);
    }
    if (!sameIdentity(fstatSync(fd), identity) || !sameIdentity(lstatSync(source), identity)) {
      throw new CodexCompressedRolloutError("Compressed Codex rollout changed while decoding.", source);
    }
    validateJsonl(decoded.stdout, source);
    if (snapshots.size >= MAX_SNAPSHOTS || totalSnapshotBytes + decoded.stdout.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new CodexCompressedRolloutError("Compressed Codex rollout snapshot cache reached its safe limit.", source);
    }
    writeFileSync(destination, decoded.stdout, { mode: 0o400, flag: "wx" });
    const decodedIdentity = identityOf(destination);
    published = true;
    return { path: destination, identity: decodedIdentity };
  } catch (error) {
    if (error instanceof CodexCompressedRolloutError) throw error;
    throw new CodexCompressedRolloutError("Could not decode compressed Codex rollout with zstd.", source);
  } finally {
    closeSync(fd);
    if (!published && directory) rmSync(directory, { recursive: true, force: true });
  }
}

function snapshotIsIntact(snapshot: Snapshot): boolean {
  const stats = safeStat(snapshot.path);
  return !!stats && sameIdentity(stats, snapshot.identity);
}

/** Returns a private `.jsonl` snapshot for `.jsonl.zst`, or a plain path unchanged. */
export function codexRolloutSnapshot(path: string): string {
  if (!path.endsWith(".jsonl.zst")) return path;
  const identity = identityOf(path);
  const key = cacheKey(path, identity);
  const existing = snapshots.get(key);
  if (existing) {
    if (snapshotIsIntact(existing)) return existing.path;
    snapshots.delete(key);
    totalSnapshotBytes -= existing.identity.size;
    rmSync(dirname(existing.path), { recursive: true, force: true });
  }
  if (snapshots.size >= MAX_SNAPSHOTS || totalSnapshotBytes >= MAX_SNAPSHOT_BYTES) {
    throw new CodexCompressedRolloutError("Compressed Codex rollout snapshot cache reached its safe limit.", path);
  }
  const snapshot = createSnapshot(path, identity, MAX_SNAPSHOT_BYTES - totalSnapshotBytes);
  snapshots.set(key, snapshot);
  totalSnapshotBytes += snapshot.identity.size;
  return snapshot.path;
}

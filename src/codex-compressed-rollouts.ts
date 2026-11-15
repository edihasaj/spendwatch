// Checked, persistent decoded copies let the ordinary Codex parser handle .jsonl.zst
// archives without changing duplicate, account, or gateway semantics.
//
// Every reader opens a rollout by path and reads it by offset, so an archive is
// decoded to a plain file. Earlier releases decoded every in-range archive into
// a fresh temp directory on each run and deleted it on exit. On a busy Mac that
// wrote and deleted about 20 GB per Local Qwen month refresh (every 30 minutes),
// which stalled APFS until the logd watchdog panicked the machine. Archives do
// not change once Codex compresses them, so each one is now decoded once, at a
// bounded write rate, into a private cache that later runs reuse without
// writing. See docs/codex-compressed-rollouts.md.
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync, type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

// Native Codex archives include verified sessions around 664 MiB decoded. Keep
// an explicit per-file ceiling while admitting that real retained history.
const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
// Rows that embed screenshots reach 24 MB; a 16 MB cap made one session fail the whole 30-day report.
const MAX_LINE_BYTES = 128 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;
// The recovered corpus has 2,628 files; leave room for new archive moves in a
// long-running watch without silently evicting a still-referenced snapshot.
const MAX_SNAPSHOTS = 10_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024 * 1024;
/** Decoded bytes written per second while filling the cache. Reuse writes nothing. */
const DEFAULT_WRITE_BYTES_PER_SECOND = 48 * 1024 * 1024;
const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
/** An entry no run has used for this long is outside every report window and is removed. */
export const DECODED_ENTRY_TTL_MS = 21 * 24 * 60 * 60 * 1000;
/** Reuse refreshes an entry's last-use time at most this often, so reuse stays metadata-free. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STAGING_PREFIX = ".staging-";
const STAGING_GRACE_MS = 60 * 60 * 1000;
const META_FILE = "entry.json";

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
interface EntryMeta {
  version: 1;
  source: string;
  sourceIdentity: SourceIdentity;
  name: string;
  decoded: SourceIdentity;
}
const snapshots = new Map<string, Snapshot>();
let totalSnapshotBytes = 0;
let maintainedRoot: string | undefined;
let writeWindowStart = 0;
let writeWindowBytes = 0;

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

/** The private decoded-archive cache: `SPENDWATCH_CODEX_DECODED_CACHE`, else `~/.cache/spendwatch/codex-decoded`. */
export function decodedCacheRoot(): string {
  const configured = process.env.SPENDWATCH_CODEX_DECODED_CACHE;
  if (configured) return configured;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "spendwatch", "codex-decoded");
}

function writeLimit(): number {
  const configured = Number(process.env.SPENDWATCH_DECODE_WRITE_BYTES_PER_SECOND);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WRITE_BYTES_PER_SECOND;
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Paces cache fills so a first run on a large history cannot flood the disk. */
function paceWrite(bytes: number): void {
  const limit = writeLimit();
  const now = Date.now();
  if (now - writeWindowStart >= 1000) { writeWindowStart = now; writeWindowBytes = 0; }
  writeWindowBytes += bytes;
  if (writeWindowBytes >= limit) {
    sleepSync(1000 - (Date.now() - writeWindowStart));
    writeWindowStart = Date.now();
    writeWindowBytes = 0;
  }
}

/** A mode-0700 directory owned by this user, never a link; anything else is refused. */
function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
    throw new CodexCompressedRolloutError("Decoded Codex archive cache is not a private directory.", path);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(path, 0o700);
  return path;
}

function entryName(source: string, identity: SourceIdentity): string {
  return createHash("sha256").update(cacheKey(source, identity)).digest("hex").slice(0, 40);
}

function readMeta(directory: string): EntryMeta | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, META_FILE), "utf8")) as EntryMeta;
    return value && value.version === 1 && typeof value.name === "string" ? value : undefined;
  } catch { return undefined; }
}

function sameRecorded(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** The cached decoded file for this exact archive, when its recorded identity still holds. */
function cachedEntry(directory: string, source: string, identity: SourceIdentity): Snapshot | undefined {
  const meta = readMeta(directory);
  if (!meta || meta.source !== source || !sameRecorded(meta.sourceIdentity, identity)) return undefined;
  if (meta.name !== basename(meta.name) || meta.name === META_FILE) return undefined;
  const path = join(directory, meta.name);
  let stats: Stats;
  try { stats = lstatSync(path); } catch { return undefined; }
  if (!sameIdentity(stats, meta.decoded) || (stats.mode & 0o222) !== 0) return undefined;
  return { path, identity: meta.decoded };
}

function touch(directory: string, now: number): void {
  try {
    const stats = statSync(directory);
    if (now - stats.mtimeMs < TOUCH_INTERVAL_MS) return;
    const at = new Date(now);
    utimesSync(directory, at, at);
  } catch { /* A concurrent sweep may have removed it; the next use decodes again. */ }
}

/**
 * Removes cache entries no run has used within `DECODED_ENTRY_TTL_MS` and
 * staging directories whose writer has died. Returns how many were removed.
 */
export function sweepDecodedCache(directory = decodedCacheRoot(), now = Date.now()): number {
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory()) continue;
      let stale: boolean;
      if (name.startsWith(STAGING_PREFIX)) {
        const owner = Number(name.slice(STAGING_PREFIX.length).split("-")[0]);
        const ownerGone = Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid && !processAlive(owner);
        stale = ownerGone || now - stats.mtimeMs > STAGING_GRACE_MS;
      } else {
        stale = now - stats.mtimeMs > DECODED_ENTRY_TTL_MS;
      }
      if (!stale) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch { /* Another run may be removing it; try again next time. */ }
  }
  return removed;
}

function maintainedCacheRoot(): string {
  const root = decodedCacheRoot();
  if (maintainedRoot === root) return root;
  privateDirectory(root);
  sweepStaleSnapshotRoots();
  sweepDecodedCache(root);
  maintainedRoot = root;
  return root;
}

function writePaced(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(WRITE_CHUNK_BYTES, bytes.length - offset);
    paceWrite(length);
    offset += writeSync(fd, bytes, offset, length);
  }
}

const ROOT_PREFIX = "spendwatch-codex-zstd-";
const OWNER_FILE = "owner.pid";
// A root without an owner file is from a release before owner files, or one
// whose owner died between creating it and recording itself.
const UNOWNED_ROOT_GRACE_MS = 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Removes per-run snapshot roots that releases before the persistent cache
 * created in the temp directory, and any left by runs that ended without their exit cleanup: a
 * crash on an uncaught error, or a SIGKILL from a timeout. Each holds whole
 * decoded transcripts (several GiB), so leaked roots fill the disk within a day
 * of scheduled runs. Only this user's roots whose recorded owner is dead (or,
 * without an owner file, that are over an hour old) are removed.
 */
export function sweepStaleSnapshotRoots(directory = tmpdir(), now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const path = join(directory, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) continue;
      let owner: number | undefined;
      try {
        const value = Number(readFileSync(join(path, OWNER_FILE), "utf8").trim());
        if (Number.isSafeInteger(value) && value > 0) owner = value;
      } catch { /* No owner file. */ }
      const stale = owner !== undefined ? owner !== process.pid && !processAlive(owner) : now - stats.mtimeMs > UNOWNED_ROOT_GRACE_MS;
      if (!stale) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch { /* Another run may be removing it; try again next time. */ }
  }
  return removed;
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
  const root = maintainedCacheRoot();
  const final = join(root, entryName(source, identity));
  const existing = cachedEntry(final, source, identity);
  if (existing) {
    touch(final, Date.now());
    return existing;
  }
  let fd: number;
  try { fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new CodexCompressedRolloutError("Could not safely open compressed Codex rollout.", source); }
  const staging = join(root, `${STAGING_PREFIX}${process.pid}-${createHash("sha256").update(`${final}${Math.random()}`).digest("hex").slice(0, 12)}`);
  let published = false;
  try {
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
    mkdirSync(staging, { mode: 0o700 });
    const name = basename(source, ".zst");
    const destination = join(staging, name);
    const out = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writePaced(out, decoded.stdout); } finally { closeSync(out); }
    chmodSync(destination, 0o400);
    const decodedIdentity = identityOf(destination);
    const meta: EntryMeta = { version: 1, source, sourceIdentity: identity, name, decoded: decodedIdentity };
    const metaFd = openSync(join(staging, META_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(metaFd, JSON.stringify(meta)); } finally { closeSync(metaFd); }
    try {
      renameSync(staging, final);
    } catch {
      // Another run published this archive first, or a damaged entry is in the way.
      const winner = cachedEntry(final, source, identity);
      if (winner) return winner;
      rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
    }
    published = true;
    // The rename keeps the file's identity; only the directory moved.
    return { path: join(final, name), identity: decodedIdentity };
  } catch (error) {
    if (error instanceof CodexCompressedRolloutError) throw error;
    throw new CodexCompressedRolloutError("Could not decode compressed Codex rollout with zstd.", source);
  } finally {
    closeSync(fd);
    if (!published) rmSync(staging, { recursive: true, force: true });
  }
}

function snapshotIsIntact(snapshot: Snapshot): boolean {
  const stats = safeStat(snapshot.path);
  return !!stats && sameIdentity(stats, snapshot.identity);
}

/** Forgets this process's memo, as a new run would. Cached files stay on disk. */
export function resetCodexRolloutMemo(): void {
  snapshots.clear();
  totalSnapshotBytes = 0;
  maintainedRoot = undefined;
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
  }
  if (snapshots.size >= MAX_SNAPSHOTS || totalSnapshotBytes >= MAX_SNAPSHOT_BYTES) {
    throw new CodexCompressedRolloutError("Compressed Codex rollout snapshot cache reached its safe limit.", path);
  }
  const snapshot = createSnapshot(path, identity, MAX_SNAPSHOT_BYTES - totalSnapshotBytes);
  snapshots.set(key, snapshot);
  totalSnapshotBytes += snapshot.identity.size;
  return snapshot.path;
}

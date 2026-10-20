import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIMIT = 64;
const ALIAS = /^claude-hg-route-\d+$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;

export interface ClaudeProofRoot {
  path: string;
  account: "Unknown isolated account";
}

function directory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function underHome(home: string, parts: readonly string[]): string | undefined {
  let path = home;
  if (!directory(path)) return undefined;
  for (const part of parts) {
    path = join(path, part);
    if (!directory(path)) return undefined;
  }
  return path;
}

interface Discovery {
  roots: ClaudeProofRoot[];
  unavailable: boolean;
}

function proofRoots(base: string | undefined, tail: readonly string[]): Discovery {
  if (!base || !directory(base)) return { roots: [], unavailable: false };
  const entries: string[] = [];
  let count = 0;
  try {
    const handle = opendirSync(base);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (++count > LIMIT) return { roots: [], unavailable: true };
        entries.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return { roots: [], unavailable: true };
  }
  if (count > LIMIT) return { roots: [], unavailable: true };
  const seen = new Set<string>();
  const roots: ClaudeProofRoot[] = [];
  for (const entry of entries) {
    const proof = join(base, entry);
    if (!directory(proof)) continue;
    let projects = proof;
    let safe = true;
    for (const part of tail) {
      projects = join(projects, part);
      if (!directory(projects)) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    try {
      const canonical = realpathSync(projects);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        roots.push({ path: projects, account: "Unknown isolated account" });
      }
    } catch {}
  }
  return { roots, unavailable: false };
}

export function claudeProofRootDiscovery(home = homedir()): Discovery {
  const native = underHome(home, ["Library", "Application Support", "Claude-3p", "auto-review-prep", "native-proofs"]);
  const aliases = underHome(home, ["Library", "Application Support", "Claude-3p", "alias-trial", "proofs"]);
  const found = [
    proofRoots(native, ["claude-config", "projects"]),
    proofRoots(aliases, ["claude-home", "projects"]),
  ];
  const seen = new Set<string>();
  return {
    unavailable: found.some((entry) => entry.unavailable),
    roots: found.flatMap((entry) => entry.roots).filter((root) => {
      try {
        const canonical = realpathSync(root.path);
        if (seen.has(canonical)) return false;
        seen.add(canonical);
        return true;
      } catch {
        return false;
      }
    }),
  };
}

export function defaultClaudeProofRoots(home = homedir()): ClaudeProofRoot[] {
  return claudeProofRootDiscovery(home).roots;
}

export function claudeModelAliases(home = homedir()): ReadonlyMap<string, string> {
  const configured = process.env.SPENDWATCH_CLAUDE_MODEL_ALIASES;
  let text = configured;
  if (text === undefined) {
    const parent = underHome(home, [".config", "spendwatch"]);
    if (!parent) return new Map();
    const path = join(parent, "claude-model-aliases.json");
    let descriptor: number | undefined;
    try {
      const link = lstatSync(path);
      if (!link.isFile() || link.isSymbolicLink()) return new Map();
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 8 * 1024) return new Map();
      const body = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < body.length) {
        const count = readSync(descriptor, body, offset, body.length - offset, offset);
        if (count <= 0) return new Map();
        offset += count;
      }
      const after = fstatSync(descriptor);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
          || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return new Map();
      text = body.toString("utf8");
    } catch {
      return new Map();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  if (Buffer.byteLength(text) > 8 * 1024) return new Map();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 32) return new Map();
    const aliases = new Map<string, string>();
    for (const [alias, model] of Object.entries(parsed)) {
      if (!ALIAS.test(alias) || typeof model !== "string" || !MODEL.test(model)) return new Map();
      aliases.set(alias, model);
    }
    return aliases;
  } catch {
    return new Map();
  }
}

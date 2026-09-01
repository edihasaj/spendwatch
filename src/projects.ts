// One project name for a working directory, whichever agent recorded it.
//
// Claude stores a session under a directory name with every "/" flattened to
// "-", so "tg/payroll-backend" and "tg-payroll-backend" are indistinguishable
// there. The transcript itself carries the real `cwd`, so that is what we read;
// the flattened name stays only as a fallback.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

const canonical = new Map<string, string>();
const labels = new Map<string, string>();

// macOS filesystems are case-insensitive, so "Projects/dayshape/Dayshape" and
// "Projects/dayshape/dayshape" are one directory typed two ways. realpath
// reports the case actually stored on disk, which settles it.
function realCase(cwd: string): string {
  const hit = canonical.get(cwd);
  if (hit !== undefined) return hit;
  let resolved = cwd;
  try {
    resolved = realpathSync.native(cwd);
  } catch {
    // Path is gone (rotated worktree, deleted checkout): keep it as written.
  }
  canonical.set(cwd, resolved);
  return resolved;
}

// Any user's home, not just this machine's: a report can be rendered somewhere
// other than where it was recorded, and "spendwatch" should stay "spendwatch".
const ANY_HOME = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

function stripHome(abs: string, home: string): { rest: string; inHome: boolean } {
  if (abs === home || abs.startsWith(`${home}/`)) return { rest: abs.slice(home.length), inHome: true };
  const other = ANY_HOME.exec(abs);
  if (other) return { rest: abs.slice(other[0].length), inHome: true };
  return { rest: abs, inHome: false };
}

function label(cwd: string, home: string): string {
  const abs = realCase(cwd);
  const { rest, inHome } = stripHome(abs, home);
  let segments = rest.split("/").filter(Boolean);

  if (inHome && (segments[0] === "Projects" || segments[0] === "Documents")) {
    if (segments.length === 1) return `~/${segments[0]}`;
    segments = segments.slice(1);
  }
  if (!segments.length) return inHome ? "~" : "/";

  const worktree = segments.indexOf("worktrees");
  if (worktree >= 0) {
    // A worktree is a disposable copy of a repo under a generated name. Kept
    // apart, one afternoon of agent work invents a dozen one-off projects.
    segments = segments.slice(0, worktree + 1);
  } else {
    // Tool scratch lives in a hidden directory inside the repo, so the repo is
    // the project — not the report folder something wrote into it.
    const hidden = segments.findIndex((segment, index) => index > 0 && segment.startsWith("."));
    if (hidden > 0) segments = segments.slice(0, hidden);
  }
  return (inHome ? "" : "/") + segments.join("/");
}

export function projectFromCwd(cwd: string, home = homedir()): string {
  if (!cwd) return "?";
  const key = `${home} ${cwd}`;
  const hit = labels.get(key);
  if (hit !== undefined) return hit;
  const value = label(cwd, home);
  labels.set(key, value);
  return value;
}

/**
 * Claude's flattened directory name, used only when a session recorded no cwd.
 * Ambiguous by construction: every "/" in the original path arrives as "-".
 */
export function humanProject(dirName: string): string {
  const m = dirName.match(/-Users-[^-]+-(.+)/);
  if (!m) return dirName;
  const rest = m[1];
  if (rest === "Projects") return "~/Projects";
  return rest.replace(/^(Projects|Documents)-/, "");
}

export interface ProjectRow {
  project: string;
  tokens: number;
  cost: number;
}

/**
 * Folds rows that name the same directory in different case. Paths that no
 * longer exist cannot be settled by realpath, so the spelling that carries the
 * most tokens wins and the rest merge into it.
 */
export function mergeProjectRows(rows: ProjectRow[]): ProjectRow[] {
  const groups = new Map<string, { spellings: Map<string, number>; tokens: number; cost: number }>();
  for (const row of rows) {
    const key = row.project.toLowerCase();
    const group = groups.get(key) ?? { spellings: new Map<string, number>(), tokens: 0, cost: 0 };
    group.spellings.set(row.project, (group.spellings.get(row.project) ?? 0) + row.tokens);
    group.tokens += row.tokens;
    group.cost += row.cost;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      project: [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      tokens: group.tokens,
      cost: group.cost,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

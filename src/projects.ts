// One project name for a working directory, whichever agent recorded it.
//
// Claude stores a session under a directory name with every "/" flattened to
// "-", so "tg/payroll-backend" and "tg-payroll-backend" are indistinguishable
// there. The transcript itself carries the real `cwd`, so that is what we read;
// the flattened name stays only as a fallback.
import { existsSync, realpathSync } from "node:fs";
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

// Scratch outside the workspace: /tmp, /private/tmp, and the per-boot macOS
// $TMPDIR under /var/folders. Every run there invents a fresh directory name,
// so they are one bucket rather than a project each.
const TEMP_ROOT = /^\/(?:private\/)?(?:tmp(?:\/|$)|var\/folders\/[^/]+\/[^/]+\/T(?:\/|$))/;

// A dated directory is a session's own scratch, e.g. ~/Documents/Codex/
// 2026-08-04/<prompt slug>. The parent is the tool; the date below it is not.
const DATE_SEGMENT = /^\d{4}-\d{2}-\d{2}$/;

// Repositories sit one or two deep under the workspace root ("spendwatch",
// "tg/payroll-backend"). Anything below that is a directory inside a repo.
const WORKSPACE_DEPTH = 2;

const repos = new Map<string, boolean>();

function isRepo(path: string): boolean {
  const hit = repos.get(path);
  if (hit !== undefined) return hit;
  let found = false;
  try {
    // A worktree's ".git" is a file, not a directory, so only existence matters.
    found = existsSync(`${path}/.git`);
  } catch {
    // Unreadable directory: treat as "not a repository" and fall back to depth.
  }
  repos.set(path, found);
  return found;
}

/**
 * How deep the repository sits under the workspace root. "~/Projects/spendwatch"
 * is one, "~/Projects/oss/paseo-baseline" is two, and a path alone cannot tell
 * those apart from "~/Projects/spendwatch/src" — but the checkout can.
 */
function repoDepth(root: string, segments: string[]): number | undefined {
  let path = root;
  for (let depth = 0; depth < Math.min(WORKSPACE_DEPTH, segments.length); depth++) {
    path += `/${segments[depth]}`;
    if (isRepo(path)) return depth + 1;
  }
  return undefined;
}

function label(cwd: string, home: string): string {
  const abs = realCase(cwd);
  const { rest, inHome } = stripHome(abs, home);
  // Checked after the home test, because a home that itself sits under a temp
  // root — a container, a test fixture — still holds real projects.
  if (!inHome && TEMP_ROOT.test(abs)) return "/tmp";
  let segments = rest.split("/").filter(Boolean);

  let workspaceRoot: string | undefined;
  if (inHome && (segments[0] === "Projects" || segments[0] === "Documents")) {
    if (segments.length === 1) return `~/${segments[0]}`;
    if (segments[0] === "Projects") workspaceRoot = abs.slice(0, abs.length - rest.length) + "/Projects";
    segments = segments.slice(1);
  }
  if (!segments.length) return inHome ? "~" : "/";

  const dated = segments.findIndex((segment, index) => index > 0 && DATE_SEGMENT.test(segment));
  if (dated > 0) segments = segments.slice(0, dated);

  // Both cuts can apply — a worktree under a hidden directory, say — so take
  // whichever lands first and leaves the outermost real project.
  const cuts: number[] = [];
  const worktree = segments.indexOf("worktrees");
  // A worktree is a disposable copy of a repo under a generated name. Kept
  // apart, one afternoon of agent work invents a dozen one-off projects.
  if (worktree >= 0) cuts.push(worktree + 1);
  // Tool scratch lives in a hidden directory inside the repo, so the repo is
  // the project — not the report folder something wrote into it.
  const hidden = segments.findIndex((segment, index) => index > 0 && segment.startsWith("."));
  if (hidden > 0) cuts.push(hidden);
  if (workspaceRoot) cuts.push(repoDepth(workspaceRoot, segments) ?? WORKSPACE_DEPTH);
  if (cuts.length) segments = segments.slice(0, Math.min(...cuts));

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

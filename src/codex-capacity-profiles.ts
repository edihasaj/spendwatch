// Codex profile homes that hold their own login, independent of session history.
//
// A live quota read needs a credential, not a rollout. History discovery keys a
// profile by its `sessions` directory (see `defaultCodexRoots` in sources.ts), so
// a signed-in profile that has never written a rollout — a freshly created named
// profile, or one whose sessions a worker pruned — is invisible to it, and the
// quota reader inherited that blind spot. This helper is the capacity reader's own
// view of which homes exist and which of them are signed in.
//
// It only inspects the filesystem: it never opens, parses, or writes a token.
// Whether a home is a Codex subscription account, and which account it is, stays
// with `codexClaims` and the native `account/read`.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The default home plus named profiles, in the same scope history discovery uses. */
const CODEX_DEFAULT = ".codex";
const CODEX_PREFIX = ".codex-";

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    // `lstat`, so a link to another home's credential does not make this home signed in.
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Every `$HOME/.codex` / `$HOME/.codex-*` profile home carrying its own regular
 * `auth.json`, default home first, resolved to a real directory and collapsed to
 * one entry per home.
 *
 * The returned path is the profile home, so a caller reads its login as
 * `codexClaims(join(home, "sessions"))` — the `sessions` segment is a synthetic
 * argument that this function neither requires nor creates. A profile with no
 * session directory at all is still a signed-in profile with a real quota.
 */
export function codexCapacityProfileHomes(home = homedir()): string[] {
  const names = safeReaddir(home)
    .filter((name) => name === CODEX_DEFAULT || name.startsWith(CODEX_PREFIX))
    // Deterministic, and the default home keeps priority over a named profile that
    // happens to hold the same account.
    .sort((a, b) => (a === CODEX_DEFAULT ? -1 : b === CODEX_DEFAULT ? 1 : a.localeCompare(b)));
  const seen = new Set<string>();
  const homes: string[] = [];
  for (const name of names) {
    const profileHome = join(home, name);
    // A dangling link, a stray file, or a directory that cannot be resolved is not
    // a profile. The canonical form is what makes two names for one home collapse.
    const canonical = realpathOf(profileHome);
    if (canonical === undefined || !isDirectory(profileHome)) continue;
    // Own login only: `auth.json` must be a regular file of this home, not a link to
    // another home's credential. The home itself may still be a native symlink.
    if (!isRegularFile(join(profileHome, "auth.json"))) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    // The resolved home, so a profile reached through an alias is still started with a
    // real `CODEX_HOME` and cannot be listed twice under two names.
    homes.push(canonical);
  }
  return homes;
}

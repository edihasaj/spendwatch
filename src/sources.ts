// Registry of coding-agent transcript sources. Each knows where its logs live,
// how to find recent files, and which line parser + per-file context to use.
//
// Multi-account: a source can have several "roots" (directories), each tagged
// with an account label. Reports tag by account but sum per agent. Roots come
// from an optional config file (~/.config/spendwatch/config.json or
// $SPENDWATCH_CONFIG); otherwise the default per-agent dir is auto-detected and
// its account label resolved from local credentials (email).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Event } from "./parse";
import { parseLine } from "./parse";
import { newCodexCtx, parseCodexLine } from "./codex";
import { humanProject, walkJsonl } from "./scan";

export interface SourceFile {
  path: string;
  project: string;
  source: string;
  account: string;
  parse: (line: string, ctx: any) => Iterable<Event>;
  ctx: any;
}

export interface SourceStatus {
  id: string;
  present: boolean; // logs directory exists
  parseable: boolean; // we can read token usage from it
  note?: string;
  files: SourceFile[];
}

interface RootCfg {
  agent: string;
  path: string;
  account?: string;
}

const claudeParse = (line: string) => parseLine(line);

function expand(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// ---- config -----------------------------------------------------------------
function loadConfig(): RootCfg[] | null {
  const paths = [process.env.SPENDWATCH_CONFIG, join(homedir(), ".config", "spendwatch", "config.json"), join(homedir(), ".spendwatch.json")].filter(Boolean) as string[];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      const roots = Array.isArray(j) ? j : j.roots;
      if (Array.isArray(roots) && roots.length) return roots.map((r: any) => ({ agent: String(r.agent), path: expand(String(r.path)), account: r.account ? String(r.account) : undefined }));
    } catch {}
  }
  return null;
}

// ---- account detection ------------------------------------------------------
function shortEmail(email?: string): string | undefined {
  if (!email) return undefined;
  return email; // keep full email — it's the user's own, and disambiguates orgs
}

// Claude account: <home>/.claude.json (or <root>/../.claude.json) → oauthAccount.emailAddress
function claudeAccount(projectsDir: string): string {
  const candidates = [join(homedir(), ".claude.json"), join(dirname(dirname(projectsDir)), ".claude.json"), join(dirname(projectsDir) + ".json")];
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      const j = JSON.parse(readFileSync(c, "utf8"));
      const e = shortEmail(j?.oauthAccount?.emailAddress);
      if (e) return e;
    } catch {}
  }
  return "default";
}

// Codex profile label: ~/.codex → "main", ~/.codex-tertiary → "tertiary".
// Two homes can hold the same account, so the profile is what disambiguates them.
function codexProfile(sessionsDir: string): string {
  const home = basename(dirname(sessionsDir));
  if (home === ".codex") return "main";
  return home.startsWith(".codex-") ? home.slice(".codex-".length) : home;
}

// Codex account: <root>/../auth.json → tokens.id_token JWT → email, tagged with
// the profile home it was read from, e.g. "edihasaj@gmail.com (secondary)".
function codexAccount(sessionsDir: string): string {
  const profile = codexProfile(sessionsDir);
  const auth = join(dirname(sessionsDir), "auth.json");
  try {
    if (!existsSync(auth)) return profile;
    const j = JSON.parse(readFileSync(auth, "utf8"));
    const tok = j?.tokens?.id_token;
    if (typeof tok === "string") {
      const part = tok.split(".")[1];
      if (part) {
        const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const e = shortEmail(json?.email);
        if (e) return `${e} (${profile})`;
      }
    }
  } catch {}
  return profile;
}

function mtimeOk(path: string, sinceMs: number): boolean {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}
function safeReaddir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

export function defaultCodexRoots(home = homedir()): RootCfg[] {
  const names = safeReaddir(home)
    .filter((name) => name === ".codex" || name.startsWith(".codex-"))
    .sort((a, b) => (a === ".codex" ? -1 : b === ".codex" ? 1 : a.localeCompare(b)));
  const seen = new Set<string>();
  const roots: RootCfg[] = [];
  for (const name of names) {
    const path = join(home, name, "sessions");
    if (!existsSync(path)) continue;
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push({ agent: "codex", path });
  }
  return roots;
}

// ---- per-agent collectors ---------------------------------------------------
function collectClaude(dir: string, account: string, sinceMs: number, project?: string): SourceFile[] {
  const files: SourceFile[] = [];
  if (!existsSync(dir)) return files;
  const acct = account || claudeAccount(dir);
  for (const proj of safeReaddir(dir)) {
    const projectName = humanProject(proj);
    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) continue;
    for (const f of safeReaddir(join(dir, proj))) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, proj, f);
      if (mtimeOk(path, sinceMs)) files.push({ path, project: projectName, source: "claude", account: acct, parse: claudeParse, ctx: null });
    }
  }
  return files;
}

function collectCodex(dir: string, account: string, sinceMs: number): SourceFile[] {
  const files: SourceFile[] = [];
  if (!existsSync(dir)) return files;
  const acct = account || codexAccount(dir);
  for (const path of walkJsonl(dir)) {
    if (!path.includes("rollout-")) continue;
    if (mtimeOk(path, sinceMs)) files.push({ path, project: "?", source: "codex", account: acct, parse: parseCodexLine, ctx: newCodexCtx() });
  }
  return files;
}

export function discover(opts: { sinceMs: number; project?: string; agents?: Set<string> }): SourceStatus[] {
  const out: SourceStatus[] = [];
  const want = (id: string) => !opts.agents || opts.agents.has(id);
  const cfg = loadConfig();

  // Resolve roots per agent: config overrides defaults.
  const claudeRoots: RootCfg[] = cfg ? cfg.filter((r) => r.agent === "claude") : [{ agent: "claude", path: join(homedir(), ".claude", "projects") }];
  const codexRoots: RootCfg[] = cfg ? cfg.filter((r) => r.agent === "codex") : defaultCodexRoots();

  if (want("claude")) {
    const files = claudeRoots.flatMap((r) => collectClaude(r.path, r.account ?? "", opts.sinceMs, opts.project));
    out.push({ id: "claude", present: claudeRoots.some((r) => existsSync(r.path)), parseable: true, files });
  }

  if (want("codex")) {
    // A profile home can be a copy-on-write clone of another (e.g. ~/.codex cloned
    // from ~/.codex-primary): same rollout under two real paths, so realpath dedupe
    // in defaultCodexRoots cannot catch it. Bill each rollout id only once, and
    // collect named profiles first so a shared rollout is credited to the real
    // account (primary/secondary/tertiary) rather than the ~/.codex playground.
    const seenRollouts = new Set<string>();
    const isPlayground = (root: RootCfg) => basename(dirname(root.path)) === ".codex";
    const ordered = [...codexRoots].sort((a, b) => Number(isPlayground(a)) - Number(isPlayground(b)));
    const files = ordered
      .flatMap((r) => collectCodex(r.path, r.account ?? "", opts.sinceMs))
      .filter((file) => {
        const rollout = basename(file.path);
        if (seenRollouts.has(rollout)) return false;
        seenRollouts.add(rollout);
        return true;
      });
    out.push({ id: "codex", present: codexRoots.some((r) => existsSync(r.path)), parseable: true, files });
  }

  // Copilot CLI — chat sessions are stored in a binary Xodus DB (.xd), not JSONL.
  if (want("copilot")) {
    const present = existsSync(join(homedir(), ".config", "github-copilot")) || existsSync(join(homedir(), ".copilot"));
    out.push({ id: "copilot", present, parseable: false, note: present ? "found, but chat sessions are a binary Xodus DB (.xd) with no token usage — not parseable" : "not installed", files: [] });
  }

  // Gemini CLI — ~/.gemini (logs/telemetry); structure TBD.
  if (want("gemini")) {
    const dir = join(homedir(), ".gemini");
    const present = existsSync(dir);
    out.push({ id: "gemini", present, parseable: present, note: present ? undefined : "not installed", files: present ? [...walkJsonl(dir)].filter((p) => mtimeOk(p, opts.sinceMs)).map((path) => ({ path, project: "?", source: "gemini", account: "default", parse: () => [], ctx: null })) : [] });
  }

  return out;
}

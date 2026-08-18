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
import { grokProjectFromDir, newGrokCtx, parseGrokLine } from "./grok";
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

// Codex auth claims: <root>/../auth.json → tokens.id_token JWT.
function codexClaims(sessionsDir: string): { email?: string; plan?: string } {
  const auth = join(dirname(sessionsDir), "auth.json");
  try {
    if (!existsSync(auth)) return {};
    const j = JSON.parse(readFileSync(auth, "utf8"));
    const tok = j?.tokens?.id_token;
    if (typeof tok !== "string") return {};
    const part = tok.split(".")[1];
    if (!part) return {};
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const plan = json?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return { email: shortEmail(json?.email), plan: typeof plan === "string" ? plan : undefined };
  } catch {
    return {};
  }
}

// A free ChatGPT plan has no subscription spend to report, so its sessions are
// noise in a $ leaderboard. Set SPENDWATCH_INCLUDE_FREE=1 to keep them.
function isFreeCodexHome(sessionsDir: string): boolean {
  if (process.env.SPENDWATCH_INCLUDE_FREE === "1") return false;
  return codexClaims(sessionsDir).plan === "free";
}

// Codex account: email tagged with the profile home it was read from, e.g.
// "edihasaj@gmail.com (secondary)".
function codexAccount(sessionsDir: string): string {
  const profile = codexProfile(sessionsDir);
  const { email } = codexClaims(sessionsDir);
  return email ? `${email} (${profile})` : profile;
}

// Grok profile label: ~/.grok → "main", ~/.grok-work → "work". Mirrors Codex so
// two homes holding the same account stay distinguishable.
function grokProfile(sessionsDir: string): string {
  const home = basename(dirname(sessionsDir));
  if (home === ".grok") return "main";
  return home.startsWith(".grok-") ? home.slice(".grok-".length) : home;
}

// Grok account: <root>/../auth.json is keyed by auth scope; each entry carries a
// plain email. Tagged with the profile home, e.g. "me@example.com (main)".
function grokAccount(sessionsDir: string): string {
  const profile = grokProfile(sessionsDir);
  const auth = join(dirname(sessionsDir), "auth.json");
  try {
    if (!existsSync(auth)) return profile;
    const j = JSON.parse(readFileSync(auth, "utf8"));
    for (const entry of Object.values(j ?? {})) {
      const e = shortEmail((entry as any)?.email);
      if (e) return `${e} (${profile})`;
    }
  } catch {}
  return profile;
}

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
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

// Every "<home>/<dot><suffix>/sessions" profile directory, default home first,
// with symlinked duplicates collapsed to one root.
function profileRoots(home: string, agent: string, dot: string): RootCfg[] {
  const names = safeReaddir(home)
    .filter((name) => name === dot || name.startsWith(`${dot}-`))
    .sort((a, b) => (a === dot ? -1 : b === dot ? 1 : a.localeCompare(b)));
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
    roots.push({ agent, path });
  }
  return roots;
}

export function defaultCodexRoots(home = homedir()): RootCfg[] {
  return profileRoots(home, "codex", ".codex");
}

export function defaultGrokRoots(home = homedir()): RootCfg[] {
  return profileRoots(home, "grok", ".grok");
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

// Grok lays sessions out as <root>/<percent-encoded cwd>/<session id>/updates.jsonl.
// The cwd is in the directory name, so the project is known before parsing.
function collectGrok(dir: string, account: string, sinceMs: number, project?: string): SourceFile[] {
  const files: SourceFile[] = [];
  if (!existsSync(dir)) return files;
  const acct = account || grokAccount(dir);
  for (const encoded of safeReaddir(dir)) {
    const cwdDir = join(dir, encoded);
    if (!statSafe(cwdDir)?.isDirectory()) continue;
    const projectName = grokProjectFromDir(encoded);
    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) continue;
    for (const session of safeReaddir(cwdDir)) {
      const path = join(cwdDir, session, "updates.jsonl");
      if (!existsSync(path) || !mtimeOk(path, sinceMs)) continue;
      files.push({ path, project: projectName, source: "grok", account: acct, parse: parseGrokLine, ctx: newGrokCtx() });
    }
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
  const grokRoots: RootCfg[] = cfg ? cfg.filter((r) => r.agent === "grok") : defaultGrokRoots();

  if (want("claude")) {
    const files = claudeRoots.flatMap((r) => collectClaude(r.path, r.account ?? "", opts.sinceMs, opts.project));
    out.push({ id: "claude", present: claudeRoots.some((r) => existsSync(r.path)), parseable: true, files });
  }

  if (want("codex")) {
    // A profile home can be a copy-on-write clone of another (e.g. ~/.codex cloned
    // from ~/.codex-primary): same rollout under two real paths, so realpath dedupe
    // in defaultCodexRoots cannot catch it. Bill each rollout id only once, and
    // collect named profiles first so a shared rollout is credited to the real
    // account (primary/secondary) rather than the ~/.codex playground.
    const seenRollouts = new Set<string>();
    const isPlayground = (root: RootCfg) => basename(dirname(root.path)) === ".codex";
    const billable = codexRoots.filter((r) => !isFreeCodexHome(r.path));
    const ordered = [...billable].sort((a, b) => Number(isPlayground(a)) - Number(isPlayground(b)));
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

  if (want("grok")) {
    const files = grokRoots.flatMap((r) => collectGrok(r.path, r.account ?? "", opts.sinceMs, opts.project));
    out.push({ id: "grok", present: grokRoots.some((r) => existsSync(r.path)), parseable: true, files });
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

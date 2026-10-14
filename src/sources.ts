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
import { newPiCtx, parsePiLine } from "./pi";
import { humanProject } from "./projects";
import { walkJsonl } from "./scan";
import { collectCopilot, defaultCopilotRoots } from "./copilot";
import { GatewayIndex, type GatewayLedger } from "./gateway";

export interface SourceFile {
  path: string;
  key?: string;
  events?: () => Iterable<Event>;
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
// Exported for the gateway ledger, whose Claude rows belong to the same account.
export function claudeAccount(projectsDir = join(homedir(), ".claude", "projects")): string {
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
// "alex@example.com (secondary)".
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
  // Codex moves a rollout to `archived_sessions` instead of deleting it, so the
  // same basename can sit in both. Listing the live roots first keeps that copy,
  // which the rollout-name dedupe in `discover` then bills exactly once.
  const roots = profileRoots(home, "codex", ".codex");
  const archived = roots
    .map((root) => ({ agent: "codex", path: join(dirname(root.path), "archived_sessions") }))
    .filter((root) => existsSync(root.path));
  return [...roots, ...archived];
}

export function defaultGrokRoots(home = homedir()): RootCfg[] {
  return profileRoots(home, "grok", ".grok");
}

// pi keeps sessions under ~/.pi/agent/sessions (or $PI_CODING_AGENT_DIR/sessions);
// its fork oh-my-pi uses the same layout under ~/.omp.
export function defaultPiRoots(home = homedir()): RootCfg[] {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return [{ agent: "pi", path: dir ? join(expand(dir), "sessions") : join(home, ".pi", "agent", "sessions") }];
}

export function defaultOmpRoots(home = homedir()): RootCfg[] {
  return [{ agent: "omp", path: join(home, ".omp", "agent", "sessions") }];
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

function collectCodex(dir: string, account: string, sinceMs: number, gateway?: GatewayLedger): SourceFile[] {
  const files: SourceFile[] = [];
  if (!existsSync(dir)) return files;
  const acct = account || codexAccount(dir);
  for (const path of walkJsonl(dir)) {
    if (!path.includes("rollout-")) continue;
    if (!mtimeOk(path, sinceMs)) continue;
    const ctx = newCodexCtx(gateway);
    // With a ledger loaded, a gateway-marked response is billed there instead.
    if (gateway) ctx.skipMarked = true;
    files.push({ path, project: "?", source: "codex", account: acct, parse: parseCodexLine, ctx });
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

// pi and oh-my-pi lay sessions out as <root>/<encoded cwd>/<timestamp>_<id>.jsonl.
// The encoding is lossy (every separator becomes "-"), so the project comes
// from the cwd in the session header instead, as with Codex.
function collectPi(dir: string, agent: "pi" | "omp", account: string, sinceMs: number): SourceFile[] {
  const files: SourceFile[] = [];
  if (!existsSync(dir)) return files;
  for (const encoded of safeReaddir(dir)) {
    const cwdDir = join(dir, encoded);
    if (!statSafe(cwdDir)?.isDirectory()) continue;
    for (const f of safeReaddir(cwdDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(cwdDir, f);
      if (mtimeOk(path, sinceMs)) files.push({ path, project: "?", source: agent, account: account || "default", parse: parsePiLine, ctx: newPiCtx() });
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

  // The gateway ledger is one read for the whole run: it answers claims for every
  // rollout and supplies the rows the subscriptions billed on their own.
  // With an explicit config, only a `gateway` root enables it — a config states
  // where logs live, and it may deliberately leave the gateway out.
  const gatewayRoot = cfg?.find((r) => r.agent === "gateway");
  const gatewayOn = process.env.SPENDWATCH_GATEWAY_SOURCE !== "off" && (cfg ? !!gatewayRoot : true);
  const gateway = gatewayOn ? GatewayIndex.load({ sinceMs: opts.sinceMs, stateDir: gatewayRoot?.path }) : undefined;

  if (want("claude")) {
    const files = claudeRoots.flatMap((r) => collectClaude(r.path, r.account ?? "", opts.sinceMs, opts.project));
    const ledger = gateway?.files("claude") ?? [];
    out.push({
      id: "claude",
      present: claudeRoots.some((r) => existsSync(r.path)) || ledger.length > 0,
      parseable: true,
      files: [...files, ...ledger],
    });
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
      .flatMap((r) => collectCodex(r.path, r.account ?? "", opts.sinceMs, gateway))
      .filter((file) => {
        const rollout = basename(file.path);
        if (seenRollouts.has(rollout)) return false;
        seenRollouts.add(rollout);
        return true;
      });
    const codex: SourceStatus = { id: "codex", present: codexRoots.some((r) => existsSync(r.path)), parseable: true, files };
    // Asked after the rollouts have been read, because only the parser knows what
    // a rollout recorded: gateway-routed turns with token_count and no record were
    // deduped against telemetry rows alone.
    if (gateway) Object.defineProperty(codex, "note", {
      get: () => files.some((f) => f.ctx?.modelProvider === "subscription_gateway" && f.ctx?.lastCount !== undefined)
        ? "gateway-routed rollouts recorded token_count without token_usage_record; those calls were matched against the gateway ledger"
        : undefined,
      enumerable: true,
      configurable: true,
    });
    out.push(codex);
  }

  if (want("grok")) {
    const files = grokRoots.flatMap((r) => collectGrok(r.path, r.account ?? "", opts.sinceMs, opts.project));
    out.push({ id: "grok", present: grokRoots.some((r) => existsSync(r.path)), parseable: true, files });
  }

  for (const agent of ["pi", "omp"] as const) {
    if (!want(agent)) continue;
    const roots: RootCfg[] = cfg ? cfg.filter((r) => r.agent === agent) : agent === "pi" ? defaultPiRoots() : defaultOmpRoots();
    const files = roots.flatMap((r) => collectPi(r.path, agent, r.account ?? "", opts.sinceMs));
    const present = roots.some((r) => existsSync(r.path));
    out.push({ id: agent, present, parseable: true, note: present ? undefined : "not installed", files });
  }

  // Current Copilot CLI persists per-request usage and reported charges in SQLite.
  if (want("copilot")) {
    const roots = cfg ? cfg.filter((r) => r.agent === "copilot") : defaultCopilotRoots().map((path) => ({ agent: "copilot", path, account: undefined }));
    const files = roots.flatMap((r) => collectCopilot(r.path, opts.sinceMs, r.account));
    const ledger = gateway?.files("copilot") ?? [];
    const all = [...files, ...ledger];
    const present = roots.some((r) => existsSync(r.path)) || ledger.length > 0;
    out.push({ id: "copilot", present, parseable: all.length > 0, files: all,
      note: present && !all.length ? "no readable per-request usage for this period" : undefined });
  }

  // Gemini CLI — ~/.gemini (logs/telemetry); structure TBD.
  if (want("gemini")) {
    const dir = join(homedir(), ".gemini");
    const present = existsSync(dir);
    out.push({ id: "gemini", present, parseable: present, note: present ? undefined : "not installed", files: present ? [...walkJsonl(dir)].filter((p) => mtimeOk(p, opts.sinceMs)).map((path) => ({ path, project: "?", source: "gemini", account: "default", parse: () => [], ctx: null })) : [] });
  }

  return out;
}

/**
 * Rollouts must be read before the gateway ledger is, so every claim a transcript
 * can make is already taken when its gateway rows are folded. Reader order is
 * untouched; only the polling pass is reordered.
 */
export function pollOrder(statuses: SourceStatus[]): SourceStatus[] {
  return [...statuses].sort((a, b) => Number(a.id !== "codex") - Number(b.id !== "codex"));
}

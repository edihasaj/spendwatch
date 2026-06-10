// Registry of coding-agent transcript sources. Each knows where its logs live,
// how to find recent files, and which line parser + per-file context to use.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Event } from "./parse";
import { parseLine } from "./parse";
import { newCodexCtx, parseCodexLine } from "./codex";
import { humanProject, walkJsonl } from "./scan";

export interface SourceFile {
  path: string;
  project: string;
  source: string;
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

const claudeParse = (line: string) => parseLine(line);

export function discover(opts: { sinceMs: number; project?: string; agents?: Set<string> }): SourceStatus[] {
  const out: SourceStatus[] = [];
  const want = (id: string) => !opts.agents || opts.agents.has(id);

  // Claude Code — ~/.claude/projects/<encoded-cwd>/<session>.jsonl
  if (want("claude")) {
    const dir = join(homedir(), ".claude", "projects");
    const files: SourceFile[] = [];
    if (existsSync(dir)) {
      for (const proj of safeReaddir(dir)) {
        const project = humanProject(proj);
        if (opts.project && !project.toLowerCase().includes(opts.project.toLowerCase())) continue;
        for (const f of safeReaddir(join(dir, proj))) {
          if (!f.endsWith(".jsonl")) continue;
          const path = join(dir, proj, f);
          if (mtimeOk(path, opts.sinceMs)) files.push({ path, project, source: "claude", parse: claudeParse, ctx: null });
        }
      }
    }
    out.push({ id: "claude", present: existsSync(dir), parseable: true, files });
  }

  // Codex CLI — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (project from cwd inside)
  if (want("codex")) {
    const dir = join(homedir(), ".codex", "sessions");
    const files: SourceFile[] = [];
    if (existsSync(dir)) {
      for (const path of walkJsonl(dir)) {
        if (!path.includes("rollout-")) continue;
        if (mtimeOk(path, opts.sinceMs)) files.push({ path, project: "?", source: "codex", parse: parseCodexLine, ctx: newCodexCtx() });
      }
    }
    // project filter for codex happens after parse (cwd is inside the file); keep all, filter in report
    out.push({ id: "codex", present: existsSync(dir), parseable: true, files });
  }

  // Copilot CLI — chat sessions are stored in a binary Xodus DB (.xd), not JSONL.
  if (want("copilot")) {
    const dir = join(homedir(), ".config", "github-copilot");
    const present = existsSync(dir) || existsSync(join(homedir(), ".copilot"));
    out.push({
      id: "copilot",
      present,
      parseable: false,
      note: present ? "found, but chat sessions are a binary Xodus DB (.xd) with no token usage — not parseable" : "not installed",
      files: [],
    });
  }

  // Gemini CLI — ~/.gemini (logs/telemetry); not present here.
  if (want("gemini")) {
    const dir = join(homedir(), ".gemini");
    const present = existsSync(dir);
    out.push({
      id: "gemini",
      present,
      parseable: present, // structure TBD; treat as parseable-if-present once logs appear
      note: present ? undefined : "not installed",
      files: present ? [...walkJsonl(dir)].filter((p) => mtimeOk(p, opts.sinceMs)).map((path) => ({ path, project: "?", source: "gemini", parse: () => [], ctx: null })) : [],
    });
  }

  return out;
}

function safeReaddir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
function mtimeOk(path: string, sinceMs: number): boolean {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

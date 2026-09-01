// Parses Claude Code transcript JSONL lines into spend-relevant events.
import type { Usage } from "./pricing";
import { projectFromCwd } from "./projects";

// {sub, deep} for a shell command, for spreading onto a tooluse event.
export function cmdParts(command: string): { sub: string; deep: string } {
  const { head, deep } = commandPath(command);
  return { sub: head, deep };
}

// A short, human-meaningful "what was actually called" string for a tool, used
// for the drill-down (e.g. the bash command, the file read, the search query).
export function toolDetail(name: string, input: any): string | undefined {
  if (input == null) return undefined;
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (name) {
    case "Bash":
      return s(input.command);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return s(input.file_path) ?? s(input.path) ?? s(input.notebook_path);
    case "Glob":
      return s(input.pattern);
    case "Grep":
      return s(input.pattern) ? `${input.pattern}${input.path ? " · " + input.path : ""}` : undefined;
    case "WebFetch":
      return s(input.url);
    case "WebSearch":
      return s(input.query);
    case "Task":
    case "Agent":
      return s(input.description) ?? s(input.subagent_type);
    default: {
      if (name.startsWith("mcp__")) {
        const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
        return first ? first.slice(0, 120) : undefined;
      }
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first?.slice(0, 120);
    }
  }
}

export type Event =
  | { t: "prompt"; sessionId: string; promptId: string; text: string; sidechain: boolean; ts: number }
  | { t: "api"; sessionId: string; requestId: string; model?: string; usage: Usage; sidechain: boolean; ts: number }
  | { t: "tooluse"; sessionId: string; requestId: string; id: string; name: string; argChars: number; sub?: string; deep?: string; detail?: string; ts: number }
  | { t: "toolresult"; sessionId: string; id: string; chars: number; error?: boolean; exit?: number; ts: number }
  | { t: "meta"; sessionId: string; project?: string; model?: string; ts: number };

// "<command-name>/goal</command-name>...<command-args>x</command-args>..." -> "/goal x"
export function cleanPromptText(text: string): string {
  const name = text.match(/<command-name>(.*?)<\/command-name>/s);
  if (!name) return text;
  const args = text.match(/<command-args>(.*?)<\/command-args>/s);
  return `${name[1]}${args?.[1] ? " " + args[1] : ""}`.trim();
}

// First meaningful executable in a bash command: skips env assignments,
// wrappers (sudo/env/...), and setup segments like `cd X &&` / `export Y=...;`.
const SETUP_HEADS = new Set(["cd", "export", "set", "source", "pushd", "true", "mkdir"]);
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command"]);

function segmentHead(segment: string): string {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]))) i++;
  const tok = tokens[i] ?? "";
  return tok.split("/").pop() || tok;
}

export function bashHead(command: string): string {
  return commandPath(command).head;
}

const SUBCMD = /^[a-z][a-z0-9:_-]*$/; // looks like a subcommand, not a flag/path/file

// Two-level view of a shell command: head (executable) and deep (head + the
// meaningful next token — subcommand, or the remote command for ssh). Lets you
// see e.g. `git push` vs `git status`, `az vm` vs `az group`, or what `ssh` runs.
export function commandPath(command: string): { head: string; deep: string } {
  const segments = command.split(/&&|\|\||;|\n|\|/);
  let firstSeg = "";
  let chosen = "";
  for (const seg of segments) {
    if (!segmentHead(seg)) continue;
    if (!firstSeg) firstSeg = seg;
    if (!SETUP_HEADS.has(segmentHead(seg))) {
      chosen = seg;
      break;
    }
  }
  const seg = chosen || firstSeg;
  const head = segmentHead(seg) || "?";
  const tokens = seg.trim().split(/\s+/);
  let i = tokens.findIndex((t) => segmentHead(seg) && t.split("/").pop() === head);
  i = i < 0 ? 0 : i + 1;

  if (head === "ssh" || head === "scp") {
    // skip flags + option values + the host, then take the remote command head
    const bare = tokens.slice(i).filter((t) => !t.startsWith("-") && !t.includes("="));
    const remote = bare[1]; // bare[0] = host
    return { head, deep: remote && SUBCMD.test(remote) ? `${head} ${remote}` : head };
  }
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.startsWith("-")) continue; // flag (its value, if any, gets skipped next iter only if it also fails SUBCMD)
    if (t.includes("/") || t.includes("=")) break; // path/file/assignment → no subcommand
    if (SUBCMD.test(t)) return { head, deep: `${head} ${t}` };
    break;
  }
  return { head, deep: head };
}

function blockChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const c of content) {
      if (typeof c?.text === "string") n += c.text.length;
      else n += JSON.stringify(c ?? "").length;
    }
    return n;
  }
  return content == null ? 0 : JSON.stringify(content).length;
}

export function* parseLine(line: string): Generator<Event> {
  if (!line || line[0] !== "{") return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const sessionId = d.sessionId ?? "?";
  const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
  const sidechain = d.isSidechain === true;

  // The session directory name has every "/" flattened to "-", so it cannot
  // tell "tg/payroll-backend" from "tg-payroll-backend". The transcript records
  // the real working directory, which can.
  if (typeof d.cwd === "string" && d.cwd) {
    yield { t: "meta", sessionId, project: projectFromCwd(d.cwd), ts };
  }

  if (d.type === "assistant" && d.message) {
    const m = d.message;
    const requestId = d.requestId ?? d.uuid ?? "?";
    if (m.usage) {
      const u = m.usage;
      const cc = u.cache_creation ?? {};
      yield {
        t: "api",
        sessionId,
        requestId,
        model: m.model,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cache5m: cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens != null ? 0 : (u.cache_creation_input_tokens ?? 0)),
          cache1h: cc.ephemeral_1h_input_tokens ?? 0,
        },
        sidechain,
        ts,
      };
    }
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "tool_use") {
          yield {
            t: "tooluse",
            sessionId,
            requestId,
            id: c.id ?? "?",
            name: c.name ?? "?",
            argChars: JSON.stringify(c.input ?? {}).length,
            ...(c.name === "Bash" && typeof c.input?.command === "string" ? cmdParts(c.input.command) : {}),
            detail: toolDetail(c.name ?? "?", c.input),
            ts,
          };
        }
      }
    }
    return;
  }

  if (d.type === "user" && d.message) {
    const content = d.message.content;
    if (typeof content === "string") {
      if (d.promptId && d.promptSource !== "hook") {
        yield { t: "prompt", sessionId, promptId: d.promptId, text: cleanPromptText(content), sidechain, ts };
      }
      return;
    }
    if (Array.isArray(content)) {
      let sawResult = false;
      for (const c of content) {
        if (c?.type === "tool_result") {
          sawResult = true;
          yield { t: "toolresult", sessionId, id: c.tool_use_id ?? "?", chars: blockChars(c.content), error: c.is_error === true, ts };
        }
      }
      if (!sawResult && d.promptId && d.promptSource !== "hook") {
        const text = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join(" ");
        if (text) yield { t: "prompt", sessionId, promptId: d.promptId, text: cleanPromptText(text), sidechain, ts };
      }
    }
  }
}

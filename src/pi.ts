// Parses pi (badlogic/pi-mono) and oh-my-pi (can1357/oh-my-pi) session files:
// ~/.pi/agent/sessions/<encoded cwd>/<timestamp>_<id>.jsonl and the same layout
// under ~/.omp. oh-my-pi is a fork and keeps pi's format, so one parser serves
// both. Emits the same Event model as the Claude, Codex and Grok parsers.
//
// Each line is an entry. The `session` header carries the cwd. Every assistant
// message carries its own `usage` for that one model call, so each becomes one
// api event. Calls made outside the conversation (cache warming, compaction and
// branch summaries, oh-my-pi's `model_usage`) carry usage too and are billed the
// same way. Entries form a tree (branching keeps abandoned paths in the file);
// every call in the file was made and paid for, so all of them count.
import { cmdParts, type Event } from "./parse";
import { projectFromCwd } from "./projects";

export interface PiCtx {
  sid: string;
  project?: string;
  model?: string;
  promptN: number;
  callN: number;
}

let piFallback = 0;
export function newPiCtx(): PiCtx {
  return { sid: `pi-${piFallback++}`, promptN: 0, callN: 0 };
}

// Tools whose arguments hold a shell command, so the bash/deep drill-downs work.
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);

function entryTs(d: any): number {
  const fromEntry = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : Number(d.timestamp);
  if (Number.isFinite(fromEntry) && fromEntry > 0) return fromEntry;
  const fromMessage = Number(d.message?.timestamp);
  return Number.isFinite(fromMessage) ? fromMessage : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content as any[]) {
    if (typeof block?.text === "string") n += block.text.length;
    else n += JSON.stringify(block ?? "").length;
  }
  return n;
}

function parseArgs(args: unknown): any {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

function firstString(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const value of Object.values(input)) if (typeof value === "string" && value) return value.slice(0, 120);
  return undefined;
}

// oh-my-pi records a model as "provider/model"; pi as a bare model id.
function modelName(model: unknown, provider?: unknown): string | undefined {
  if (typeof model !== "string" || !model) return undefined;
  if (typeof provider === "string" && model.startsWith(`${provider}/`)) return model.slice(provider.length + 1);
  return model;
}

function apiEvent(ctx: PiCtx, usage: any, model: string | undefined, requestId: string, ts: number): Event | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return {
    t: "api",
    sessionId: ctx.sid,
    requestId,
    model: model ?? ctx.model,
    usage: { input, output, cacheRead, cache5m: cacheWrite, cache1h: 0 },
    sidechain: false,
    ts,
  };
}

export function* parsePiLine(line: string, ctx: PiCtx): Generator<Event> {
  if (!line || line[0] !== "{") return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const ts = entryTs(d);

  switch (d.type) {
    case "session": {
      if (typeof d.id === "string" && d.id) ctx.sid = d.id;
      if (typeof d.cwd === "string" && d.cwd) ctx.project = projectFromCwd(d.cwd);
      yield { t: "meta", sessionId: ctx.sid, project: ctx.project, model: ctx.model, ts };
      return;
    }
    case "model_change": {
      const model = modelName(d.modelId ?? d.model, d.provider);
      if (model) ctx.model = model;
      return;
    }
    case "usage":
    case "model_usage":
    case "compaction":
    case "branch_summary": {
      const event = apiEvent(ctx, d.usage, modelName(d.model, d.provider), `${d.type}:${d.id ?? ctx.callN++}`, ts);
      if (event) yield event;
      return;
    }
    case "message":
      break;
    default:
      return;
  }

  const m = d.message;
  if (!m || typeof m !== "object") return;
  switch (m.role) {
    case "user": {
      const text = textOf(m.content).trim();
      if (text) yield { t: "prompt", sessionId: ctx.sid, promptId: String(d.id ?? `u${ctx.promptN}`), text, sidechain: false, ts };
      ctx.promptN++;
      return;
    }
    case "assistant": {
      const requestId = String(d.id ?? `a${ctx.callN++}`);
      const model = modelName(m.model, m.provider);
      if (model) ctx.model = model;
      const event = apiEvent(ctx, m.usage, model, requestId, ts);
      if (event) yield event;
      if (!Array.isArray(m.content)) return;
      for (const block of m.content) {
        if (block?.type !== "toolCall") continue;
        const name = String(block.name ?? "?");
        const input = parseArgs(block.arguments);
        const cmd = SHELL_TOOLS.has(name) && typeof input?.command === "string" ? input.command : undefined;
        yield {
          t: "tooluse",
          sessionId: ctx.sid,
          requestId,
          id: String(block.id ?? `${requestId}:${name}`),
          name,
          argChars: JSON.stringify(input ?? {}).length,
          ...(cmd ? cmdParts(cmd) : {}),
          detail: cmd ?? firstString(input),
          ts,
        };
      }
      return;
    }
    case "toolResult": {
      yield {
        t: "toolresult",
        sessionId: ctx.sid,
        id: String(m.toolCallId ?? "?"),
        chars: contentChars(m.content),
        error: m.isError === true,
        ts,
      };
      return;
    }
  }
}

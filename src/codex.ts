// Parses Codex CLI rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl).
// Emits the same Event model as the Claude parser so both feed one Aggregator.
import { cmdParts, type Event } from "./parse";
import { humanCodexProject } from "./scan";

export interface CodexCtx {
  model?: string;
  project?: string;
  sid: string; // per-file session id (from session_meta), for accurate session counts
  promptN: number;
  callN: number;
  callName: Map<string, { name: string; sub?: string; deep?: string }>;
}

let codexFallback = 0;
export function newCodexCtx(): CodexCtx {
  return { sid: `codex-${codexFallback++}`, promptN: 0, callN: 0, callName: new Map() };
}

const SHELL_FNS = new Set(["exec_command", "shell", "local_shell_call", "run_command", "container.exec"]);

export function* parseCodexLine(line: string, ctx: CodexCtx): Generator<Event> {
  if (!line || line[0] !== "{") return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
  const p = d.payload ?? {};
  
  switch (d.type) {
    case "session_meta": {
      if (p.cwd) ctx.project = humanCodexProject(p.cwd);
      if (p.model || p.model_provider) ctx.model = p.model;
      if (p.id) ctx.sid = p.id;
      yield { t: "meta", sessionId: ctx.sid, project: ctx.project, model: ctx.model, ts };
      return;
    }
    case "turn_context": {
      const before = ctx.project;
      if (p.cwd) ctx.project = humanCodexProject(p.cwd);
      if (p.model) ctx.model = p.model;
      yield { t: "meta", sessionId: ctx.sid, project: ctx.project ?? before, model: ctx.model, ts };
      return;
    }
    case "event_msg": {
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
        yield { t: "prompt", sessionId: ctx.sid, promptId: `u${ctx.promptN++}`, text: p.message, sidechain: false, ts };
      } else if (p.type === "token_count") {
        const u = (p.info?.last_token_usage ?? {}) as any;
        const input = u.input_tokens ?? 0;
        const cached = u.cached_input_tokens ?? 0;
        if (input || u.output_tokens) {
          yield {
            t: "api",
            sessionId: ctx.sid,
            requestId: `c${ctx.callN++}`,
            model: ctx.model,
            usage: {
              input: Math.max(0, input - cached),
              output: u.output_tokens ?? 0,
              cacheRead: cached,
              cache5m: 0,
              cache1h: 0,
            },
            sidechain: false,
            ts,
          };
        }
      } else if (p.type === "patch_apply_end") {
        // file edit; size approximated from the patch result if present
        const chars = typeof p.stdout === "string" ? p.stdout.length : 0;
        const id = `patch${ctx.callN}`;
        yield { t: "tooluse", sessionId: ctx.sid, requestId: `c${ctx.callN}`, id, name: "apply_patch", argChars: chars, ts };
      } else if (p.type === "mcp_tool_call_end") {
        const name = `mcp:${p.server ?? "?"}.${p.tool ?? p.invocation?.tool ?? "?"}`;
        const id = `mcp${ctx.callN}`;
        const chars = JSON.stringify(p.result ?? "").length;
        yield { t: "tooluse", sessionId: ctx.sid, requestId: `c${ctx.callN}`, id, name, argChars: 0, ts };
        yield { t: "toolresult", sessionId: ctx.sid, id, chars, ts };
      }
      return;
    }
    case "response_item": {
      if (p.type === "function_call") {
        const name = p.name ?? "?";
        const argChars = (p.arguments ?? "").length;
        const id = p.call_id ?? `fc${ctx.callN++}`;
        let extra: { sub?: string; deep?: string } = {};
        let toolName = name;
        if (SHELL_FNS.has(name)) {
          toolName = "exec_command";
          const cmd = readCmd(p.arguments);
          if (cmd) extra = cmdParts(cmd);
        }
        ctx.callName.set(id, { name: toolName, ...extra });
        yield { t: "tooluse", sessionId: ctx.sid, requestId: "c0", id, name: toolName, argChars, sub: extra.sub, deep: extra.deep, ts };
      } else if (p.type === "function_call_output") {
        const id = p.call_id ?? "?";
        const out = p.output;
        const chars = typeof out === "string" ? out.length : JSON.stringify(out ?? "").length;
        yield { t: "toolresult", sessionId: ctx.sid, id, chars, ts };
      }
      return;
    }
  }
}

function readCmd(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const o = JSON.parse(args);
    if (typeof o.cmd === "string") return o.cmd;
    if (Array.isArray(o.command)) return o.command.join(" ");
    if (typeof o.command === "string") return o.command;
  } catch {}
  return undefined;
}

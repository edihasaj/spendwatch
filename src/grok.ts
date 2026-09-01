// Parses Grok CLI session updates (~/.grok/sessions/<cwd>/<session>/updates.jsonl).
// Emits the same Event model as the Claude and Codex parsers so all three feed
// one Aggregator.
//
// The file is a stream of ACP `session/update` notifications. Grok reports token
// usage once per prompt-turn (`turn_completed`), covering every model call the
// agentic loop made for that prompt — so one "api" event here is a turn, not a
// single HTTP request. The turn's `modelUsage` map splits it per model, and each
// entry becomes its own api event.
import { cmdParts, type Event } from "./parse";
import { projectFromCwd } from "./projects";

export interface GrokCtx {
  model?: string;
  sid: string;
  turnN: number;
  toolN: number;
  pending?: { text: string; ts: number }; // user message chunks not yet flushed
}

let grokFallback = 0;
export function newGrokCtx(): GrokCtx {
  return { sid: `grok-${grokFallback++}`, turnN: 0, toolN: 0 };
}

// "%2FUsers%2Fedi%2FProjects%2Fspendwatch" -> "spendwatch"
export function grokProjectFromDir(dirName: string): string {
  let cwd = dirName;
  try {
    cwd = decodeURIComponent(dirName);
  } catch {}
  return projectFromCwd(cwd);
}

// Tools whose first argument is a shell command, so the bash/deep drill-downs work.
const SHELL_TOOLS = new Set(["run_terminal_command", "run_command", "bash", "shell"]);

function toolText(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    const inner = (block as any)?.content ?? block;
    if (typeof inner?.text === "string") n += inner.text.length;
    else n += JSON.stringify(inner ?? "").length;
  }
  return n;
}

function firstString(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const [key, value] of Object.entries(input)) {
    if (key === "variant" || key === "description") continue;
    if (typeof value === "string" && value) return value.slice(0, 120);
  }
  return undefined;
}

function shellCommand(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.command === "string") return input.command;
  if (Array.isArray(input.command)) return input.command.join(" ");
  return undefined;
}

export function* parseGrokLine(line: string, ctx: GrokCtx): Generator<Event> {
  if (!line || line[0] !== "{") return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const params = d.params ?? {};
  const u = params.update;
  if (!u || typeof u !== "object") return;
  if (typeof params.sessionId === "string") ctx.sid = params.sessionId;
  const ts = Number(d._meta?.agentTimestampMs) || (Number(d.timestamp) || 0) * 1000;
  const kind = u.sessionUpdate;

  // A prompt can stream in as several chunks. Accumulate, then flush the whole
  // text as one event before the first non-user update — usage and tool calls
  // that follow must already see the prompt they belong to.
  if (kind === "user_message_chunk") {
    const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
    const modelId = u._meta?.modelId;
    if (typeof modelId === "string") ctx.model = modelId;
    if (text) ctx.pending = { text: (ctx.pending?.text ?? "") + text, ts: ctx.pending?.ts || ts };
    return;
  }
  if (ctx.pending) {
    const { text, ts: promptTs } = ctx.pending;
    ctx.pending = undefined;
    yield { t: "prompt", sessionId: ctx.sid, promptId: `t${ctx.turnN}`, text, sidechain: false, ts: promptTs };
  }

  switch (kind) {
    case "tool_call": {
      const meta = u._meta?.["x.ai/tool"];
      const name = (typeof meta?.name === "string" && meta.name) || String(u.title ?? "?");
      const input = u.rawInput;
      const id = String(u.toolCallId ?? `g${ctx.toolN++}`);
      const cmd = SHELL_TOOLS.has(name) ? shellCommand(input) : undefined;
      yield {
        t: "tooluse",
        sessionId: ctx.sid,
        requestId: `t${ctx.turnN}`,
        id,
        name,
        argChars: JSON.stringify(input ?? {}).length,
        ...(cmd ? cmdParts(cmd) : {}),
        detail: cmd ?? firstString(input),
        ts,
      };
      return;
    }
    case "tool_call_update": {
      // Grok sends an enrichment update with no status, then a terminal one.
      // Only the terminal update carries the result the model had to read.
      if (typeof u.status !== "string") return;
      const exitRaw = u.rawOutput?.exit_code;
      const exit = typeof exitRaw === "number" ? exitRaw : undefined;
      yield {
        t: "toolresult",
        sessionId: ctx.sid,
        id: String(u.toolCallId ?? "?"),
        chars: toolText(u.content),
        exit,
        error: u.status === "failed" || (exit !== undefined && exit !== 0),
        ts,
      };
      return;
    }
    case "turn_completed": {
      const usage = u.usage;
      if (!usage) return;
      const perModel: Array<[string | undefined, any]> =
        usage.modelUsage && typeof usage.modelUsage === "object" && Object.keys(usage.modelUsage).length
          ? Object.entries(usage.modelUsage)
          : [[ctx.model, usage]];
      for (const [model, mu] of perModel) {
        // cachedRead and cacheCreation are both counted inside inputTokens.
        const total = mu.inputTokens ?? 0;
        const cacheRead = mu.cachedReadTokens ?? 0;
        const cacheWrite = mu.cacheCreationTokens ?? 0;
        const output = mu.outputTokens ?? 0;
        if (!total && !output) continue;
        yield {
          t: "api",
          sessionId: ctx.sid,
          requestId: `t${ctx.turnN}:${model ?? "?"}`,
          model: model ?? ctx.model,
          usage: {
            input: Math.max(0, total - cacheRead - cacheWrite),
            output,
            cacheRead,
            cache5m: cacheWrite,
            cache1h: 0,
          },
          sidechain: false,
          ts,
        };
      }
      ctx.turnN++;
      return;
    }
  }
}

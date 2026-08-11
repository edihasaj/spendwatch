import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { usageCost } from "./pricing";
import type { RoutingEffort, RoutingModel } from "./routing";

export type ExecutionProvider = "codex" | "deepseek";

export interface ExecutionRequest {
  task: string;
  repo: string;
  files: string[];
  model: RoutingModel;
  effort: RoutingEffort;
  readOnly: boolean;
  attempt: number;
  priorFailure?: string;
}

export interface ExecutionResult {
  provider: ExecutionProvider;
  model: string;
  ok: boolean;
  exitCode: number;
  output: string;
  error?: string;
  usage?: Record<string, number>;
  estimatedCost?: number;
}

export interface ModelExecutor {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

function promptFor(request: ExecutionRequest): string {
  const scope = request.files.length ? request.files.join(", ") : "repository evidence";
  const retry = request.priorFailure
    ? `\nA prior attempt failed. Fix only the failed phase and preserve valid work. Evidence:\n${request.priorFailure}`
    : "";
  return `Complete this task in ${request.repo}:\n\n${request.task}\n\nScoped evidence: ${scope}.\n` +
    `${request.readOnly ? "Read-only: do not modify files." : "Implement the change and leave the worktree ready for deterministic verification."}` + retry;
}

export class CodexExecutor implements ModelExecutor {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const binary = process.env.SPENDWATCH_CODEX_BIN || "codex";
    const args = [
      "exec", "--ephemeral", "--json", "--sandbox", request.readOnly ? "read-only" : "workspace-write",
      "--model", request.model, "-c", `model_reasoning_effort=${JSON.stringify(request.effort)}`,
      "-c", "approval_policy=\"never\"", "-C", request.repo, promptFor(request),
    ];
    try {
      const child = Bun.spawn([binary, ...args], { cwd: request.repo, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const parsed = parseCodexJsonl(stdout);
      const cached = parsed.usage?.cached_input_tokens ?? 0;
      const estimatedCost = parsed.usage ? usageCost(request.model, {
        input: Math.max(0, (parsed.usage.input_tokens ?? 0) - cached),
        output: parsed.usage.output_tokens ?? 0,
        cacheRead: cached,
        cache5m: parsed.usage.cache_write_input_tokens ?? 0,
        cache1h: 0,
      }) : undefined;
      return {
        provider: "codex", model: request.model, ok: exitCode === 0, exitCode,
        output: parsed.output || stdout.trim(), error: exitCode === 0 ? undefined : stderr.trim() || "codex exec failed",
        usage: parsed.usage, estimatedCost,
      };
    } catch (error) {
      return {
        provider: "codex", model: request.model, ok: false, exitCode: 127, output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function parseCodexJsonl(stdout: string): { output: string; usage?: Record<string, number> } {
  let output = "";
  let usage: Record<string, number> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        output = String(event.item.text ?? event.item.content ?? "");
      }
      if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") usage = event.usage;
    } catch {}
  }
  return { output, usage };
}

type DeepSeekMessage = Record<string, unknown>;
type ToolCall = { id: string; function: { name: string; arguments: string }; type: "function" };

const DEEPSEEK_TOOLS = [
  { type: "function", function: { name: "list_files", description: "List tracked repository files", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 repository file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "search_text", description: "Search repository text literally", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
];

function safePath(repo: string, input: unknown): string {
  if (typeof input !== "string" || !input) throw new Error("path must be a non-empty string");
  const path = resolve(repo, input);
  const local = relative(repo, path);
  if (!local || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("path escapes repository");
  }
  return path;
}

function deepSeekTool(repo: string, call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { return "Invalid JSON arguments"; }
  if (call.function.name === "list_files") {
    const result = Bun.spawnSync(["git", "-C", repo, "ls-files"], { stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(result.exitCode === 0 ? result.stdout : result.stderr).slice(0, 50_000);
  }
  if (call.function.name === "read_file") {
    try { return readFileSync(safePath(repo, args.path), "utf8").slice(0, 50_000); }
    catch (error) { return `Read failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  if (call.function.name === "search_text") {
    if (typeof args.query !== "string" || !args.query) return "query must be a non-empty string";
    const result = Bun.spawnSync(["rg", "-n", "--fixed-strings", "--max-count", "200", "--", args.query, repo], { stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(result.exitCode <= 1 ? result.stdout : result.stderr).slice(0, 50_000);
  }
  return `Unknown tool: ${call.function.name}`;
}

export class DeepSeekExecutor implements ModelExecutor {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!request.readOnly) return { provider: "deepseek", model: "deepseek-v4-flash", ok: false, exitCode: 64, output: "", error: "DeepSeek execution is restricted to read-only tasks" };
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return { provider: "deepseek", model: "deepseek-v4-flash", ok: false, exitCode: 78, output: "", error: "DEEPSEEK_API_KEY is not set" };
    const endpoint = `${(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`;
    const messages: DeepSeekMessage[] = [{ role: "user", content: promptFor(request) }];
    let usage: Record<string, number> | undefined;
    try {
      for (let turn = 0; turn < 12; turn++) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-v4-flash", messages, tools: DEEPSEEK_TOOLS,
            thinking: { type: "enabled" }, reasoning_effort: request.effort === "xhigh" ? "max" : "high",
          }),
        });
        if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
        const body = await response.json() as any;
        usage = body.usage;
        const message = body.choices?.[0]?.message;
        if (!message) throw new Error("DeepSeek response did not contain a message");
        const calls = message.tool_calls as ToolCall[] | undefined;
        if (!calls?.length) {
          const cached = usage?.prompt_cache_hit_tokens ?? 0;
          const estimatedCost = usage ? usageCost("deepseek-v4-flash", {
            input: usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - cached),
            output: usage.completion_tokens ?? 0, cacheRead: cached, cache5m: 0, cache1h: 0,
          }) : undefined;
          return { provider: "deepseek", model: "deepseek-v4-flash", ok: true, exitCode: 0, output: String(message.content ?? ""), usage, estimatedCost };
        }
        messages.push({ ...message, content: message.content ?? "" });
        for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: deepSeekTool(request.repo, call) });
      }
      throw new Error("DeepSeek exceeded the 12-turn tool budget");
    } catch (error) {
      return { provider: "deepseek", model: "deepseek-v4-flash", ok: false, exitCode: 1, output: "", error: error instanceof Error ? error.message : String(error), usage };
    }
  }
}

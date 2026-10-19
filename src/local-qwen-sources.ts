// Local Qwen uses Codex-format rollout JSONL in a Claude-owned CODEX_HOME.
// These helpers discover that private home and retain only self-hosted Qwen
// turns when a Free ChatGPT profile also contains cloud Codex sessions.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "./parse";
import { parseCodexLine, settleRouted, type CodexCtx } from "./codex";

const CLAUDE_QWEN_WORKER = ["Library", "Application Support", "Claude-3p", "qwen-worker"];

export interface LocalQwenRoot {
  path: string;
  account: "Local Qwen";
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function realpathKey(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function isLocalQwenWorkerRoot(sessionsDir: string): boolean {
  const canonical = realpathKey(sessionsDir) ?? sessionsDir;
  return canonical.includes(`${join(...CLAUDE_QWEN_WORKER, "generations")}/`);
}

export function isLocalQwenModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase().replace(/^(?:codex|claude)\//, "");
  return normalized === "qwen3.8-flash-next" || normalized === "qwen/qwen3.8-flash-next";
}

/**
 * `current` points to a generation during normal use, but retained generations
 * may be the only place older session or archived-session logs still exist.
 */
export function defaultLocalQwenRoots(home: string, sessionDirectory = "sessions"): LocalQwenRoot[] {
  const worker = join(home, ...CLAUDE_QWEN_WORKER);
  const generations = join(worker, "generations");
  const workerHomes = [
    join(worker, "current"),
    ...safeReaddir(generations).sort().map((generation) => join(generations, generation)),
  ];
  const seen = new Set<string>();
  const roots: LocalQwenRoot[] = [];
  for (const workerHome of workerHomes) {
    const path = join(workerHome, sessionDirectory);
    if (!existsSync(path)) continue;
    const canonical = realpathKey(path);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push({ path, account: "Local Qwen" });
  }
  return roots;
}

/**
 * Free ChatGPT accounts have no paid cloud usage to report. A local Qwen route
 * can share that profile, so retain its explicit model aliases only.
 */
export function* parseFreeCodexLocalQwen(line: string, ctx: CodexCtx): Generator<Event> {
  let record: { type?: unknown; payload?: Record<string, unknown> } | undefined;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const payload = record?.payload;
  const meta = record?.type === "session_meta";
  const turn = record?.type === "turn_context";
  if (meta) {
    // Native Codex commonly establishes the child session/provider before its
    // first model selection. Keep that identity even while its cloud prompt
    // events remain suppressed.
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (ctx.ownSession !== undefined && id !== ctx.ownSession) return;
    ctx.ownSession = id;
    if (id) ctx.sid = id;
    if (typeof payload?.model_provider === "string") ctx.modelProvider = payload.model_provider;
  }
  const declaredModel = (meta || turn) && typeof payload?.model === "string" ? payload.model : undefined;
  if (declaredModel !== undefined && !isLocalQwenModel(declaredModel)) {
    // Mirror Codex's own fork protection. A copied parent session_meta must not
    // replace the active Qwen session/model and make its following lines vanish.
    ctx.model = declaredModel;
    return;
  }
  if (declaredModel === undefined && !isLocalQwenModel(ctx.model)) return;
  yield* parseCodexLine(line, ctx);
}

export function settleFreeCodexLocalQwen(ctx: CodexCtx, final: boolean): Event[] {
  return [...settleRouted(ctx, final)].filter((event) => event.t !== "api" || isLocalQwenModel(event.model));
}

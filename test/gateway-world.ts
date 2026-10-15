// A throwaway Codex + gateway world on disk, for tests that run a whole report over it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rollingDays } from "../src/periods";
import { tempDir } from "./tmp";

export const line = (value: unknown) => JSON.stringify(value) + "\n";
export const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One Codex rollout routed through a gateway whose ledger holds three rows:
 *   - a telemetry row (session) that the rollout's unmarked record claims → a Claude row once claimed;
 *   - a billed Copilot row the rollout also recorded, with the gateway's marker → a Copilot row;
 *   - a plain Claude gateway row with no rollout of its own.
 */
export function gatewayWorld(options: { codexAccount?: string; telemetry?: boolean } = {}) {
  const root = tempDir("spendwatch-build-");
  const now = Date.now();
  const sessions = join(root, "codex", "sessions", "2026", "10", "15");
  const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(join(root, "claude"), { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  // Codex writes a record per response and a token_count after it; the count is what the CLI itself observed.
  const record = (id: string, input: number, output: number, at: number) =>
    line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } })
    + line({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output }, total_token_usage: { input_tokens: input, output_tokens: output } } } });
  writeFileSync(join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
    line({ timestamp: iso(now - 90_000), type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway" } })
    + line({ timestamp: iso(now - 90_000), type: "turn_context", payload: { model: "claude-opus-5.5" } })
    + record("resp_unmarked", 1000, 50, now - 60_000)
    + line({ timestamp: iso(now - 50_000), type: "turn_context", payload: { model: "copilot/gpt" } })
    + record("resp_gl_cp", 400, 20, now - 40_000));
  const row = (over: Record<string, unknown>) => JSON.stringify({ v: 1, host: "studio", model: "claude-opus-5.5", inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, ...over }) + "\n";
  const month = iso(now).slice(0, 7);
  writeFileSync(join(state, "usage", `usage-${month}.jsonl`),
    (options.telemetry === false ? "" : row({ at: iso(now - 60_000), requestId: "tel", origin: "telemetry", provider: "claude", responseId: "", session: true }))
    + row({ at: iso(now - 40_000), requestId: "cp", origin: "gateway", providerType: "copilot-subscription", provider: "copilot", responseId: "resp_gl_cp", model: "copilot/gpt", inputTokens: 400, outputTokens: 20, nanoAiu: 1e9, nanoAiuStatus: "complete" })
    + row({ at: iso(now - 20_000), requestId: "cl", origin: "gateway", providerType: "claude-subscription", provider: "claude", responseId: "resp_gl_cl", inputTokens: 200, outputTokens: 10 }));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "claude", path: join(root, "claude") },
    { agent: "codex", path: join(root, "codex", "sessions"), ...(options.codexAccount ? { account: options.codexAccount } : {}) },
    { agent: "copilot", path: join(root, "copilot", "session-store.db") },
    { agent: "gateway", path: state },
  ]));
  return { root, now, config, periods: [rollingDays(now, 30)] };
}


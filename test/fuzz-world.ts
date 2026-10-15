// Shared by the seeded gateway fuzz tests: a repeatable random stream and a ledger row of the kind the gateway writes.
export const iso = (ms: number): string => new Date(ms).toISOString();

/** A deterministic random stream in [0, 1): the same seed always makes the same scenario. */
export function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** One billed Copilot row, as the gateway appends it to `usage-YYYY-MM.jsonl` (the line ends with a newline). */
export function copilotRow(id: string, at: number, input: number): string {
  return JSON.stringify({
    v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, providerType: "copilot-subscription", provider: "copilot",
    model: "copilot/gpt", status: "completed", origin: "gateway", inputTokens: input, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10,
    reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete",
  }) + "\n";
}

/** The transcript line a routed call leaves in a Codex rollout: a marked record, or a bare token_count. */
export function routedLine(mode: "records" | "counts", id: string, at: number, input: number, total: number): string {
  const usage = { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 };
  return JSON.stringify(mode === "records"
    ? { timestamp: iso(at), type: "token_usage_record", payload: { response_id: `resp_gl_${id}`, usage } }
    : { timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { input_tokens: total, output_tokens: 10 } } } });
}

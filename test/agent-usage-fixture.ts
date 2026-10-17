// The two-entry `agent-usage.v1` record both new sources are tested with.
export const ATTEMPT = "attempt_run_5d2f0c6e-1111-4222-8333-444455556666_1";

export function usageRecord(extra: Record<string, unknown> = {}, scale = 1) {
  return {
    usage_version: "agent-usage.v1",
    attempt_id: ATTEMPT,
    entries: [
      { input_tokens: 256239 * scale, cached_input_tokens: 204189 * scale, cache_write_input_tokens: 47170 * scale, output_tokens: 6107 * scale,
        reasoning_output_tokens: 751 * scale, total_tokens: 262346 * scale, cost_usd_micros: null, driver_id: "azure-openai-responses",
        provider_id: "azure-openai", model: "mission-runtime-terra", turns: 40 },
      { input_tokens: 875032 * scale, cached_input_tokens: 272569 * scale, cache_write_input_tokens: 602355 * scale, output_tokens: 43347 * scale,
        reasoning_output_tokens: 20830 * scale, total_tokens: 918379 * scale, cost_usd_micros: 2897613, driver_id: "claude",
        provider_id: "anthropic:main", model: "claude-sonnet-5", turns: 40 },
    ],
    ...extra,
  };
}

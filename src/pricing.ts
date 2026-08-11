// Per-MTok USD prices. Cache multipliers: write 5m 1.25x, write 1h 2x, read 0.1x input price.
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  longContext?: ModelPrice;
  longContextThreshold?: number;
}

const PRICES: Array<[RegExp, ModelPrice]> = [
  // Anthropic (Claude Code)
  [/fable/, { input: 10, output: 50 }],
  [/opus/, { input: 5, output: 25 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }],
  // OpenAI direct API standard pricing. Codex subscription usage remains an
  // estimate, but preserving the model ratios makes comparisons meaningful.
  [/gpt-5\.6-luna/, { input: 0.2, output: 1.2, cachedInput: 0.02, cacheWrite5m: 0.25, longContextThreshold: 272_000, longContext: { input: 0.4, output: 1.8, cachedInput: 0.04, cacheWrite5m: 0.5 } }],
  [/gpt-5\.6-terra/, { input: 2, output: 12, cachedInput: 0.2, cacheWrite5m: 2.5, longContextThreshold: 272_000, longContext: { input: 4, output: 18, cachedInput: 0.4, cacheWrite5m: 5 } }],
  [/gpt-5\.6(?:-sol)?(?:$|[^a-z])/, { input: 5, output: 30, cachedInput: 0.5, cacheWrite5m: 6.25, longContextThreshold: 272_000, longContext: { input: 10, output: 45, cachedInput: 1, cacheWrite5m: 12.5 } }],
  [/gpt-5\.5/, { input: 5, output: 30, cachedInput: 0.5, longContextThreshold: 272_000, longContext: { input: 10, output: 45, cachedInput: 1 } }],
  [/gpt-5\.4-mini/, { input: 0.75, output: 4.5, cachedInput: 0.075 }],
  [/gpt-5\.4-nano/, { input: 0.2, output: 1.25, cachedInput: 0.02 }],
  [/gpt-5\.4/, { input: 2.5, output: 15, cachedInput: 0.25, longContextThreshold: 272_000, longContext: { input: 5, output: 22.5, cachedInput: 0.5 } }],
  [/gpt-5\.3-codex/, { input: 1.75, output: 14, cachedInput: 0.175 }],
  [/gpt-5\.2/, { input: 1.75, output: 14, cachedInput: 0.175 }],
  [/gpt-5\.1/, { input: 1.25, output: 10, cachedInput: 0.125 }],
  [/gpt-5|gpt5|o[34]|codex/, { input: 1.25, output: 10, cachedInput: 0.125 }],
  [/gpt-4|gpt4/, { input: 2.5, output: 10 }],
  // DeepSeek direct API pricing. Routing execution is explicit and opt-in.
  [/deepseek-v4-flash/, { input: 0.14, output: 0.28, cachedInput: 0.0028 }],
  [/deepseek-v4-pro/, { input: 0.435, output: 0.87, cachedInput: 0.003625 }],
  // Google (Gemini), best-effort 2.5-pro tier.
  [/gemini.*pro/, { input: 1.25, output: 10 }],
  [/gemini/, { input: 0.3, output: 2.5 }],
];

export function priceFor(model: string | undefined): ModelPrice {
  if (!model) return { input: 0, output: 0 };
  const m = model.toLowerCase();
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return { input: 0, output: 0 }; // <synthetic>, unknown
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}

export function usageCost(model: string | undefined, u: Usage): number {
  const base = priceFor(model);
  const contextTokens = u.input + u.cacheRead + u.cache5m + u.cache1h;
  const p = base.longContext && base.longContextThreshold && contextTokens > base.longContextThreshold
    ? base.longContext
    : base;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * (p.cachedInput ?? 0.1 * p.input) +
      u.cache5m * (p.cacheWrite5m ?? 1.25 * p.input) +
      u.cache1h * (p.cacheWrite1h ?? 2 * p.input)) /
    1e6
  );
}

// Rough chars→tokens for tool args/results (not billed directly; they enter
// context and are paid via cache write + reads on subsequent calls).
export function estTokens(chars: number): number {
  return Math.round(chars / 4);
}

// Cost a tool result imposes on the rest of the session: one cache write
// (1.25x) plus a 0.1x cache read on each subsequent API call in the session.
export function contextCost(
  tokens: number,
  model: string | undefined,
  subsequentCalls: number,
): number {
  const p = priceFor(model);
  return ((tokens * p.input) / 1e6) * (1.25 + 0.1 * Math.max(0, subsequentCalls));
}

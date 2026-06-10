// Per-MTok USD prices. Cache multipliers: write 5m 1.25x, write 1h 2x, read 0.1x input price.
export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Array<[RegExp, ModelPrice]> = [
  // Anthropic (Claude Code)
  [/fable/, { input: 10, output: 50 }],
  [/opus/, { input: 5, output: 25 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }],
  // OpenAI (Codex). Approximate — Codex is largely subscription/credit-billed,
  // so $ is an estimate for ranking. gpt-5 tier list pricing.
  [/gpt-5|gpt5|o[34]|codex/, { input: 1.25, output: 10 }],
  [/gpt-4|gpt4/, { input: 2.5, output: 10 }],
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
  const p = priceFor(model);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * 0.1 * p.input +
      u.cache5m * 1.25 * p.input +
      u.cache1h * 2 * p.input) /
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

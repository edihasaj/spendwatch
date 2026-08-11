import { describe, expect, test } from "bun:test";
import { priceFor, usageCost } from "../src/pricing";

describe("model pricing", () => {
  test("distinguishes the GPT-5.6 tiers", () => {
    expect(priceFor("gpt-5.6-sol")).toMatchObject({ input: 5, output: 30, cachedInput: 0.5 });
    expect(priceFor("gpt-5.6-terra")).toMatchObject({ input: 2, output: 12, cachedInput: 0.2 });
    expect(priceFor("gpt-5.6-luna")).toMatchObject({ input: 0.2, output: 1.2, cachedInput: 0.02 });
  });

  test("uses long-context rates above 272K input context", () => {
    const short = usageCost("gpt-5.6-terra", { input: 100, output: 10, cacheRead: 271_900, cache5m: 0, cache1h: 0 });
    const long = usageCost("gpt-5.6-terra", { input: 101, output: 10, cacheRead: 271_900, cache5m: 0, cache1h: 0 });
    expect(short).toBeCloseTo((100 * 2 + 10 * 12 + 271_900 * 0.2) / 1e6, 8);
    expect(long).toBeCloseTo((101 * 4 + 10 * 18 + 271_900 * 0.4) / 1e6, 8);
  });

  test("uses DeepSeek cache-hit pricing instead of a generic multiplier", () => {
    const cost = usageCost("deepseek-v4-flash", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cache5m: 0, cache1h: 0 });
    expect(cost).toBeCloseTo(0.14 + 0.28 + 0.0028, 8);
  });
});

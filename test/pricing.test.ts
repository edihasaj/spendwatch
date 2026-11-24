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

  test("prices a gateway ledger model by the model itself, not the subscription it ran on", () => {
    // The gateway ledger labels rows by their alias, with the vendor only in a
    // suffix, so these must keep the rates above rather than a vendor default.
    // Official GPT-6 rates; the ledger records the same model with and without the vendor prefix.
    expect(priceFor("codex/gpt-6.1-sol")).toMatchObject({ input: 2, output: 10, cachedInput: 0.1 });
    expect(priceFor("gpt-6.1-sol")).toMatchObject({ input: 2, output: 10, cachedInput: 0.1 });
    expect(priceFor("gpt-6.1-terra")).toMatchObject({ input: 1, output: 5, cachedInput: 0.05 });
    expect(priceFor("gpt-6-astra")).toMatchObject({ input: 10, output: 50, cachedInput: 1 });
    expect(priceFor("gpt-6-luna")).toMatchObject({ input: 0.1, output: 0.5, cachedInput: 0.01 });
    expect(priceFor("copilot/claude-opus-5.5")).toMatchObject({ input: 5, output: 25 });
    expect(priceFor("claude-opus-5.5 (telemetry backfill)")).toMatchObject({ input: 5, output: 25 });
  });

  test("uses DeepSeek cache-hit pricing instead of a generic multiplier", () => {
    const cost = usageCost("deepseek-v4-flash", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cache5m: 0, cache1h: 0 });
    expect(cost).toBeCloseTo(0.14 + 0.28 + 0.0028, 8);
  });

  test("bills a GPT-6 prompt over 272K input tokens at the long-context rates", () => {
    const small = usageCost("gpt-6.1-sol", { input: 200_000, output: 1_000_000, cacheRead: 0, cache5m: 0, cache1h: 0 });
    expect(small).toBeCloseTo((200_000 * 2 + 1_000_000 * 10) / 1e6, 8);
    const large = usageCost("gpt-6.1-sol", { input: 300_000, output: 1_000_000, cacheRead: 0, cache5m: 0, cache1h: 0 });
    expect(large).toBeCloseTo((300_000 * 4 + 1_000_000 * 15) / 1e6, 8);
  });
});

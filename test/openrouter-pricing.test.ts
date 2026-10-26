import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRouterPriceParseCountForTesting, refreshOpenRouterPrices, type OpenRouterPriceCache } from "../src/openrouter-prices";
import { priceFor, usageCost, usagePriceFor } from "../src/pricing";
import { tempDir } from "./tmp";

const previousPath = process.env.SPENDWATCH_OPENROUTER_PRICES;

afterEach(() => {
  if (previousPath === undefined) delete process.env.SPENDWATCH_OPENROUTER_PRICES;
  else process.env.SPENDWATCH_OPENROUTER_PRICES = previousPath;
});

function cachePath(cache: OpenRouterPriceCache): string {
  const path = join(tempDir("spendwatch-openrouter-pricing-"), "prices.json");
  writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
  process.env.SPENDWATCH_OPENROUTER_PRICES = path;
  return path;
}

const cache: OpenRouterPriceCache = {
  updatedAt: "2026-10-26T12:00:00.000Z",
  models: [
    { id: "deepseek/deepseek-v4.1-flash-1017", input: 0.15, output: 0.6, cachedInput: 0.003,
      overrides: [
        { utcDays: ["saturday", "sunday"], input: 0.15, output: 0.6, cachedInput: 0.003 },
        { utcDays: ["monday", "tuesday", "wednesday", "thursday", "friday"], utcStart: 100, utcEnd: 400,
          input: 0.3, output: 1.2, cachedInput: 0.006 },
        { utcDays: ["monday", "tuesday", "wednesday", "thursday", "friday"], utcStart: 600, utcEnd: 1000,
          input: 0.3, output: 1.2, cachedInput: 0.006 },
      ] },
    { id: "deepseek/deepseek-v4-pro-0813", input: 0.66, output: 1.98, cachedInput: 0.022,
      overrides: [
        { minPromptTokens: 100_000, input: 1.32, output: 3.96, cachedInput: 0.044 },
      ] },
    { id: "z-ai/glm-5.3-flash", input: 0.15, output: 0.5, cachedInput: 0.03 },
    { id: "z-ai/glm-5.3", input: 0.0699, output: 1.4, cachedInput: 0.0689 },
    { id: "z-ai/glm-5.3-prime", input: 2.8, output: 8.8, cachedInput: 0.56 },
  ],
};

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cache5m: 0, cache1h: 0 };

describe("OpenRouter exact pricing", () => {
  test("uses exact provider slugs and the dated catalog rate", () => {
    cachePath(cache);
    expect(priceFor("z-ai/glm-5.3-flash", "openrouter")).toMatchObject({
      input: 0.15, output: 0.5, cachedInput: 0.03,
      estimate: true, priceUpdatedAt: cache.updatedAt,
    });
    expect(priceFor("z-ai/glm-5.3", "openrouter")).toMatchObject({ input: 0.0699, output: 1.4 });
    expect(priceFor("z-ai/glm-5.3-prime", "openrouter")).toMatchObject({ input: 2.8, output: 8.8 });
    expect(usageCost("z-ai/glm-5.3-flash", usage, "openrouter"))
      .toBeCloseTo(0.15 + 0.5 + 0.03, 10);
  });

  test("applies weekday UTC bands and weekend rates by the event time", () => {
    cachePath(cache);
    const mondayPeak = "2026-10-26T02:00:00.000Z";
    const mondayOffPeak = "2026-10-26T05:00:00.000Z";
    const saturday = "2026-10-31T02:00:00.000Z";
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017", "openrouter", mondayPeak))
      .toMatchObject({ input: 0.3, output: 1.2, cachedInput: 0.006 });
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017", "openrouter", mondayOffPeak))
      .toMatchObject({ input: 0.15, output: 0.6, cachedInput: 0.003 });
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017", "openrouter", saturday))
      .toMatchObject({ input: 0.15, output: 0.6 });
  });

  test("requires an event timestamp when the catalog has time-dependent rates", () => {
    cachePath(cache);
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017", "openrouter"))
      .toEqual({ input: 0, output: 0, unknown: true });
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017", "openrouter", "not-a-time"))
      .toEqual({ input: 0, output: 0, unknown: true });
  });

  test("applies long-context token overrides without inventing a direct-provider rate", () => {
    cachePath(cache);
    const short = usageCost("deepseek/deepseek-v4-pro-0813", { ...usage, input: 99_999, cacheRead: 0 }, "openrouter");
    const long = usageCost("deepseek/deepseek-v4-pro-0813", { ...usage, input: 100_000, cacheRead: 0 }, "openrouter");
    expect(short).toBeCloseTo((99_999 * 0.66 + 1_000_000 * 1.98) / 1e6, 10);
    expect(long).toBeCloseTo((100_000 * 1.32 + 1_000_000 * 3.96) / 1e6, 10);
  });

  test("unknown OpenRouter slugs never fall back to direct model regex rates", () => {
    cachePath(cache);
    expect(priceFor("deepseek-v4-pro", "openrouter"))
      .toEqual({ input: 0, output: 0, unknown: true });
    expect(usageCost("deepseek-v4-pro", usage, "openrouter")).toBe(0);
    expect(priceFor("deepseek-v4-pro")).toMatchObject({ input: 0.435, output: 0.87 });
  });

  test("an absent or invalid price cache makes OpenRouter pricing unknown", () => {
    process.env.SPENDWATCH_OPENROUTER_PRICES = join(tempDir("spendwatch-openrouter-empty-"), "missing.json");
    expect(priceFor("z-ai/glm-5.3", "openrouter"))
      .toEqual({ input: 0, output: 0, unknown: true });
    expect(usageCost("z-ai/glm-5.3", usage, "openrouter")).toBe(0);
  });

  test("memoizes the parsed catalog by path, inode, size and mtime", () => {
    const path = cachePath(cache);
    const before = openRouterPriceParseCountForTesting();
    for (let index = 0; index < 600; index++) {
      expect(usageCost("z-ai/glm-5.3-flash", usage, "openrouter")).toBeCloseTo(0.68, 10);
    }
    expect(openRouterPriceParseCountForTesting() - before).toBe(1);

    expect(priceFor("z-ai/glm-5.3-flash", "openrouter")?.input).toBe(0.15);
    expect(openRouterPriceParseCountForTesting() - before).toBe(1);

    const changed: OpenRouterPriceCache = {
      ...cache,
      models: cache.models.map((model) => model.id === "z-ai/glm-5.3-flash"
        ? { ...model, input: 0.25 }
        : model),
    };
    writeFileSync(path, JSON.stringify(changed), { mode: 0o600 });
    expect(priceFor("z-ai/glm-5.3-flash", "openrouter")?.input).toBe(0.25);
    expect(openRouterPriceParseCountForTesting() - before).toBe(2);
  });
  test("explicit public refresh needs no management config and respects the 24-hour cache", async () => {
    const path = join(tempDir("spendwatch-openrouter-refresh-"), "prices.json");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify([{
        id: "z-ai/glm-5.3-flash",
        pricing: { prompt: "0.00000015", completion: "0.0000005", input_cache_read: "0.00000003" },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const missingConfig = join(tempDir("spendwatch-no-management-"), "openrouter.json");

    const first = await refreshOpenRouterPrices({ pricesPath: path, now, fetch: fakeFetch,
      env: { SPENDWATCH_OPENROUTER_CONFIG: missingConfig } });
    expect(first?.updatedAt).toBe("2026-10-26T12:00:00.000Z");
    expect(first?.models).toEqual([expect.objectContaining({ id: "z-ai/glm-5.3-flash", input: 0.15, output: 0.5 })]);
    expect(calls).toBe(1);

    const cached = await refreshOpenRouterPrices({ pricesPath: path, now: now + 24 * 60 * 60_000 - 1,
      fetch: fakeFetch, env: {} });
    expect(cached).toEqual(first);
    expect(calls).toBe(1);

    const staleFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const retained = await refreshOpenRouterPrices({ pricesPath: path, now: now + 24 * 60 * 60_000,
      fetch: staleFetch, env: {} });
    expect(retained?.updatedAt).toBe(first?.updatedAt);
    expect(retained?.models).toEqual(first?.models);
  });

});

test("usage-aware pricing includes cached context and rejects ambiguous thresholds", () => {
  cachePath({ ...cache, models: [{ id: "test/model", input: 1, output: 2, overrides: [
    { minPromptTokens: 100, utcDays: ["monday"], input: 3 },
  ] }] });
  const u = { input: 50, cacheRead: 50, output: 0, cache5m: 0, cache1h: 0 };
  expect(usagePriceFor("test/model", u, "openrouter", "2026-10-26T12:00:00Z").input).toBe(3);
  expect(usagePriceFor("test/model", u, "openrouter", "2026-10-27T12:00:00Z").input).toBe(1);
  cachePath({ ...cache, models: [{ id: "test/model", input: 1, output: 2, overrides: [
    { minPromptTokens: 10, input: 3 }, { minPromptTokens: 20, input: 4 },
  ] }] });
  expect(usagePriceFor("test/model", u, "openrouter").unknown).toBe(true);
});

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectOpenRouterCapacity,
  loadOpenRouterPriceCache,
  mergeOpenRouterActivity,
  normalizeOpenRouterActivity,
  normalizeOpenRouterCredits,
  normalizeOpenRouterModelPrices,
  openRouterHistory,
  openRouterCompletedWindow,
  type OpenRouterPriceCache,
} from "./openrouter";
import { tempDir } from "../test/tmp";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

function fixture() {
  const root = tempDir("spendwatch-openrouter-");
  const configPath = join(root, "openrouter.json");
  const managementKey = join(root, "management.key");
  const usageKey = join(root, "usage.key");
  const cacheDir = join(root, "cache");
  const pricesPath = join(root, "prices.json");
  writeFileSync(configPath, JSON.stringify({
    account: "OpenRouter account",
    apiKeyFile: managementKey,
    usageKeyFile: usageKey,
    cacheDir,
  }), { mode: 0o600 });
  writeFileSync(managementKey, "management-secret\n", { mode: 0o600 });
  writeFileSync(usageKey, "usage-secret\n", { mode: 0o600 });
  for (const path of [configPath, managementKey, usageKey]) chmodSync(path, 0o600);
  return { root, configPath, cacheDir, pricesPath };
}

function row(date: string, overrides: Record<string, unknown> = {}) {
  return {
    date: `${date} 00:00:00`,
    model_permaslug: "deepseek/deepseek-v4.1-flash-20261017",
    endpoint_id: `endpoint-${date}`,
    usage: 0.1,
    byok_usage_inference: 0,
    requests: 2,
    prompt_tokens: 100,
    completion_tokens: 20,
    reasoning_tokens: 5,
    cached_tokens: 10,
    byok_requests: 0,
    model: "deepseek/deepseek-v4.1-flash-1017",
    provider_name: "deepseek",
    ...overrides,
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenRouter collector", () => {
  test("the completed-day window changes exactly at UTC midnight", () => {
    expect(openRouterCompletedWindow(Date.parse("2026-10-26T23:59:59.999Z"))).toEqual({
      from: "2026-09-26T00:00:00.000Z",
      through: "2026-10-25T23:59:59.999Z",
    });
    expect(openRouterCompletedWindow(Date.parse("2026-10-27T00:00:00.000Z"))).toEqual({
      from: "2026-09-27T00:00:00.000Z",
      through: "2026-10-26T23:59:59.999Z",
    });
  });

  test("normalizes credits, activity and per-million prices without adding token subtypes twice", () => {
    expect(normalizeOpenRouterCredits({ data: { total_credits: 5, total_usage: 0.75 } }))
      .toEqual({ totalCreditsUsd: 5, totalUsageUsd: 0.75 });
    const rows = normalizeOpenRouterActivity([row("2026-09-27")]);
    expect(rows[0]).toMatchObject({ date: "2026-09-27", costUsd: 0.1, promptTokens: 100,
      completionTokens: 20, reasoningTokens: 5, cachedTokens: 10 });
    const history = openRouterHistory({ capturedAt: "2026-10-26T12:00:00.000Z",
      fetchedFrom: "2026-09-27T00:00:00.000Z", fetchedThrough: "2026-10-25T00:00:00.000Z", rows });
    expect(history.totals).toEqual({ costUsd: 0.1, requests: 2, promptTokens: 100,
      completionTokens: 20, reasoningTokens: 5, cachedTokens: 10 });
    expect(history.machineAttribution).toBe("unattributed");

    const prices = normalizeOpenRouterModelPrices([{
      id: "deepseek/deepseek-v4.1-flash-1017",
      pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003",
        overrides: [{ utc_days: ["monday"], utc_start: 100, utc_end: 400,
          prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" }] },
    }], "2026-10-26T12:00:00.000Z");
    expect(prices.models[0]).toEqual({
      id: "deepseek/deepseek-v4.1-flash-1017", input: 0.15, output: 0.6, cachedInput: 0.003,
      overrides: [{ utcDays: ["monday"], utcStart: 100, utcEnd: 400,
        input: 0.3, output: 1.2, cachedInput: 0.006 }],
    });
    const files = fixture();
    writeFileSync(files.pricesPath, JSON.stringify(prices), { mode: 0o600 });
    expect(loadOpenRouterPriceCache({ pricesPath: files.pricesPath, now: NOW })?.models[0]?.input).toBe(0.15);
  });

  test("retains older activity exactly once and keeps the last real capture timestamp on failed refresh", async () => {
    const files = fixture();
    let calls = 0;
    let fail = false;
    const fakeFetch = (async (input: string | URL | Request) => {
      calls++;
      const path = new URL(String(input)).pathname;
      if (fail) throw new Error("network includes management-secret and must not escape");
      if (path.endsWith("/credits")) return response({ data: { total_credits: 5, total_usage: 0.75 } });
      if (path.endsWith("/key")) return response({ data: { label: "shared inference", usage: 0.2,
        usage_daily: 0.01, usage_weekly: 0.1, usage_monthly: 0.2, limit: null, limit_remaining: null } });
      if (path.endsWith("/activity")) {
        const date = calls <= 4 ? "2026-09-27" : "2026-09-28";
        return response([row(date), ...(calls <= 4 ? [row(date)] : [])]);
      }
      if (path.endsWith("/models")) return response([{ id: "deepseek/deepseek-v4.1-flash-1017",
        pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" } }]);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const first = await collectOpenRouterCapacity({ configPath: files.configPath, pricesPath: files.pricesPath,
      now: NOW, fetch: fakeFetch, env: {} });
    expect(first?.openrouter.balanceUsd).toBe(4.25);
    expect(first?.openrouter.keyUsage?.allTimeUsd).toBe(0.2);
    expect(first?.openrouter.history?.totals.requests).toBe(2);
    expect(first?.openrouter.history?.days).toHaveLength(1);

    const beforeCache = calls;
    const cached = await collectOpenRouterCapacity({ configPath: files.configPath, pricesPath: files.pricesPath,
      now: NOW + 60_000, fetch: fakeFetch, env: {} });
    expect(calls).toBe(beforeCache);
    expect(cached?.usage.updatedAt).toBe("2026-10-26T12:00:00.000Z");

    const second = await collectOpenRouterCapacity({ configPath: files.configPath, pricesPath: files.pricesPath,
      now: NOW + 60 * 60_000 + 1, fetch: fakeFetch, env: {} });
    expect(second?.openrouter.history?.totals.requests).toBe(4);
    expect(second?.openrouter.history?.days.map((day) => day.date)).toEqual(["2026-09-28", "2026-09-27"]);
    const archive = JSON.parse(readFileSync(join(files.cacheDir, "activity.json"), "utf8"));
    expect(archive.rows).toHaveLength(2);

    fail = true;
    const failed = await collectOpenRouterCapacity({ configPath: files.configPath, pricesPath: files.pricesPath,
      now: NOW + 2 * 60 * 60_000, fetch: fakeFetch, env: {} });
    expect(failed?.openrouter.balanceUsd).toBe(4.25);
    expect(failed?.usage.updatedAt).toBe("2026-10-26T13:00:00.001Z");
    expect(failed?.openrouter.history?.updatedAt).toBe("2026-10-26T13:00:00.001Z");
    expect(existsSync(files.pricesPath)).toBe(true);
  });

  test("an idempotent archive replaces the same endpoint-day row instead of double counting", () => {
    const initial = normalizeOpenRouterActivity([row("2026-09-27")]);
    const updated = normalizeOpenRouterActivity([row("2026-09-27", { usage: 0.2, requests: 3 })]);
    const merged = mergeOpenRouterActivity(initial, updated);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ costUsd: 0.2, requests: 3 });
  });

  test("returns null when no private config is present", async () => {
    expect(await collectOpenRouterCapacity({ configPath: join(tempDir("spendwatch-no-openrouter-"), "missing.json"), env: {} }))
      .toBeNull();
  });
});

test("an unavailable optional inference key does not hide account credits", async () => {
  const files = fixture();
  const config = JSON.parse(readFileSync(files.configPath, "utf8"));
  config.usageKeyFile = join(files.root, "missing.key");
  writeFileSync(files.configPath, JSON.stringify(config), { mode: 0o600 });
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("/credits")) return response({ data: { total_credits: 5, total_usage: 1 } });
    if (path.endsWith("/activity")) return response({ data: [] });
    return response({ data: [{ id: "test/model", pricing: { prompt: "0.000001", completion: "0.000002" } }] });
  }) as typeof fetch;
  const result = await collectOpenRouterCapacity({ configPath: files.configPath, pricesPath: files.pricesPath, now: NOW, fetch: fakeFetch });
  expect(result?.openrouter.balanceUsd).toBe(4);
  expect(result?.openrouter.keyUsage).toBeUndefined();
  expect(calls).not.toContain("/api/v1/key");
});

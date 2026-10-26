import { describe, expect, test } from "bun:test";
import { Aggregator, type Report } from "../src/aggregate";
import { withoutCalls } from "../src/gateway-settle";
import { renderHtml } from "../src/html";
import { renderHistoryHtml } from "../src/history";
import { monthPeriod } from "../src/periods";
import { mergeReports } from "../src/reports";
import { validateProviderUsage } from "../src/provider-usage-report";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { join } from "node:path";
import { tempDir } from "./tmp";

function report(): Report {
  return {
    source: "studio:codex", totalTokens: 150, totalCost: 1.5, apiCalls: 1, sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], models: [{ model: "z-ai/glm", calls: 1, inTok: 100, outTok: 50, cacheReadTok: 0, cacheWriteTok: 0, cost: 1.5 }], projects: [{ project: "demo", tokens: 150, cost: 1.5 }], accounts: [{ account: "Unknown account", tokens: 150, cost: 1.5, calls: 1, sessions: 1 }], sinceTs: Date.parse("2026-10-26T08:00:00Z"),
    providerUsage: [{ provider: "openrouter", timeZone: "UTC", tokens: 150, cost: 1.5, calls: 1, unpricedCalls: 0, rows: [{ day: "2026-10-26", model: "z-ai/glm", tokens: 150, cost: 1.5, calls: 1, unpricedCalls: 0 }] }],
  };
}

describe("OpenRouter provider report evidence", () => {
  test("keeps one machine's exact route calls as a non-additive dimension", () => {
    const aggregate = new Aggregator();
    const write = aggregate.stream("rollout", "demo", "codex", "Unknown account");
    write({ t: "api", sessionId: "s", requestId: "r", model: "z-ai/glm", modelProvider: "openrouter", usage: { input: 100, output: 50, cacheRead: 0, cache5m: 0, cache1h: 0 }, costUsd: 1.5, sidechain: false, ts: Date.parse("2026-10-26T08:00:00Z") });
    const output = aggregate.report();
    expect(output).toMatchObject({ totalTokens: 150, totalCost: 1.5, apiCalls: 1, providerUsage: [{ provider: "openrouter", tokens: 150, cost: 1.5, calls: 1, unpricedCalls: 0 }] });
    expect(output.providerUsage?.[0]?.rows).toEqual([{ day: "2026-10-26", model: "z-ai/glm", tokens: 150, cost: 1.5, calls: 1, unpricedCalls: 0 }]);
  });

  test("marks a missing catalog rate unavailable rather than presenting $0 as a price", () => {
    const aggregate = new Aggregator();
    const write = aggregate.stream("rollout", "demo", "codex");
    write({ t: "api", sessionId: "s", requestId: "r", model: "unknown/provider-model", modelProvider: "openrouter", usage: { input: 100, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 }, sidechain: false, ts: Date.parse("2026-10-26T08:00:00Z") });
    const output = aggregate.report();
    expect(output.providerUsage?.[0]).toMatchObject({ calls: 1, unpricedCalls: 1, cost: 0 });
    expect(renderHtml([output], { generatedAt: 1, days: 1 })).toContain("unavailable");
  });

  test("rejects malformed nested evidence and only merges validated provider detail", () => {
    const bad = { ...report(), providerUsage: [{ provider: "openrouter", timeZone: "UTC", tokens: 1, cost: 0, calls: 1, unpricedCalls: 0, rows: [] }] };
    expect(validateProviderUsage(bad.providerUsage, bad)).toBeUndefined();
    const second = { ...report(), source: "macbook:codex" };
    const merged = mergeReports([report(), second]);
    expect(merged.providerUsage?.[0]).toMatchObject({ tokens: 300, cost: 3, calls: 2, unpricedCalls: 0 });
    expect(merged.totalTokens).toBe(300); // metadata did not become additional calls
  });

  test("settlement removes an unconfirmed OpenRouter call from both global and provider evidence", () => {
    const input = {
      ...report(), gatewayUnconfirmed: [{ id: "route", ts: Date.parse("2026-10-26T08:00:00Z"), model: "z-ai/glm", account: "Unknown account", project: "demo", tokens: 150, inTok: 100, outTok: 50, cacheReadTok: 0, cacheWriteTok: 0, cost: 1.5, provider: "openrouter" }],
    };
    const settled = withoutCalls(input, input.gatewayUnconfirmed!);
    expect(settled).toMatchObject({ totalTokens: 0, totalCost: 0, apiCalls: 0 });
    expect(settled.providerUsage).toBeUndefined();
  });

  test("retains machine/day/model route detail in monthly history", () => {
    const path = join(tempDir("spendwatch-openrouter-history-"), "history.db");
    const monthly = { ...report(), period: monthPeriod("2026-10"), observedCalls: 1 };
    writeMonthlySpend(path, [monthly], { generatedAt: 1 });
    const [month] = loadMonthlySpend(path);
    expect(month?.providerUsage).toEqual([{ provider: "openrouter", source: "studio:codex", day: "2026-10-26", model: "z-ai/glm", tokens: 150, cost: 1.5, calls: 1, unpricedCalls: 0 }]);
    const html = renderHistoryHtml({ generatedAt: 1, sampleCount: 0, series: [] }, { months: [month!] });
    expect(html).toContain("OpenRouter route usage");
    expect(html).toContain("Daily route detail (UTC)");
  });
});

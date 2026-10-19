import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { importCapacityHistory, writeCapacitySnapshot } from "../src/capacity-db";
import { normalizeAuthenticationRequirements } from "../src/capacity-dashboard";
import { buildUtilizationPlans } from "../src/capacity-planner";
import { normalizeCodexLimits, renderLimitsHtml, renderLimitsText } from "../src/limits";
import { tempDir } from "./tmp";

const qwen = (device: string, updatedAt: string, recentTokens: number, monthTokens: number, ready?: boolean) => ({
  provider: "qwen",
  account: "Local Qwen",
  usage: { accountEmail: "Local Qwen", loginMethod: "self-hosted", updatedAt },
  local: {
    unlimited: true,
    model: "qwen3.8-flash-next",
    ...(ready === undefined ? {} : { ready }),
    detail: "Spark route",
  },
  sourceDevice: device,
  spend: {
    // These must never become a paid-provider estimate.
    recentUsd: 999,
    recentTokens,
    recentHours: 24,
    monthUsd: 999,
    monthTokens,
    monthDays: 30,
  },
});

describe("local Qwen capacity", () => {
  test("keeps only the newest snapshot per caller and sums callers", () => {
    const accounts = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:00:00Z", 100, 200, true),
      qwen("studio", "2026-10-19T10:05:00Z", 300, 400, true),
      qwen("macbook", "2026-10-19T10:04:00Z", 500, 600, true),
    ]);
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account.provider).toBe("qwen");
    expect(account.email).toBe("Local Qwen");
    expect(account.devices).toEqual(["macbook", "studio"]);
    expect(account.spend).toMatchObject({
      recentTokens: 800,
      monthTokens: 1000,
      recentUsd: 0,
      monthUsd: 0,
    });
    expect(account.updatedAt).toBe("2026-10-19T10:05:00Z");
    expect(account.local).toMatchObject({ unlimited: true, ready: true, model: "qwen3.8-flash-next" });
  });

  test("does not call partial or missing readiness available", () => {
    const unknown = normalizeCodexLimits([qwen("studio", "2026-10-19T10:05:00Z", 3, 4)]);
    expect(unknown[0]!.local?.ready).toBeUndefined();
    const unavailable = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:05:00Z", 3, 4, true),
      qwen("macbook", "2026-10-19T10:06:00Z", 5, 6, false),
    ]);
    expect(unavailable[0]!.local?.ready).toBe(false);
  });

  test("renders a dedicated unlimited card with client token totals and no quota", () => {
    const account = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:05:00Z", 12_345, 67_890),
    ])[0]!;
    const html = renderLimitsHtml([account], {
      generatedAt: Date.parse("2026-10-19T10:06:00Z"),
    });
    const card = html.slice(html.indexOf('data-account-key="qwen:local qwen"'));
    const qwenCard = card.slice(0, card.indexOf("</article>"));
    expect(qwenCard).toContain("Local capacity");
    expect(qwenCard).toContain("Unlimited");
    expect(qwenCard).toContain("qwen3.8-flash-next");
    expect(qwenCard).toContain("Availability unknown");
    expect(qwenCard).toContain("12.3K tokens");
    expect(qwenCard).toContain("67.9K tokens");
    expect(qwenCard).toContain("$0 provider fee");
    expect(qwenCard).toContain("studio");
    expect(qwenCard).not.toContain("% left");
    expect(qwenCard).not.toContain("progressbar");
    expect(qwenCard).not.toContain("Reset time");
    expect(renderLimitsText([account])).toContain(
      "Qwen · Local Qwen\tunlimited self-hosted\tqwen3.8-flash-next\tavailability unknown\ttoken coverage: studio\t24h 12.3K tokens\t30d 67.9K tokens\t$0 provider fee",
    );
  });

  test("marks missing client reports as partial instead of turning them into zero usage", () => {
    const { spend: _missing, ...missingReport } = qwen("macbook", "2026-10-19T10:06:00Z", 999, 999, true);
    const account = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:05:00Z", 12, 34, true),
      missingReport,
    ])[0]!;
    expect(account.spend).toMatchObject({ recentTokens: 12, monthTokens: 34 });
    expect(account.local?.measuredDevices).toEqual(["studio"]);
    expect(account.local?.unmeasuredDevices).toEqual(["macbook"]);

    const html = renderLimitsHtml([account], { generatedAt: Date.parse("2026-10-19T10:07:00Z") });
    expect(html).toContain("Partial client reports");
    expect(html).toContain("missing macbook");

    const unavailable = normalizeCodexLimits([missingReport])[0]!;
    expect(unavailable.spend).toBeUndefined();
    expect(renderLimitsHtml([unavailable], { generatedAt: Date.parse("2026-10-19T10:07:00Z") }))
      .toContain("Awaiting a successful client report");
  });

  test("rejects malformed token totals instead of coercing them to measured zero", () => {
    for (const malformed of [null, false, "", "   "]) {
      const input = qwen("studio", "2026-10-19T10:05:00Z", 12, 34, true);
      input.spend.recentTokens = malformed as never;
      input.spend.monthTokens = malformed as never;
      const account = normalizeCodexLimits([input])[0]!;
      expect(account.spend).toBeUndefined();
      expect(account.local?.measuredDevices).toEqual([]);
      expect(account.local?.unmeasuredDevices).toEqual(["studio"]);
    }
  });

  test("requires the explicit self-hosted unlimited declaration", () => {
    const invalid = qwen("studio", "2026-10-19T10:05:00Z", 1, 2, true);
    invalid.local.unlimited = false;
    expect(normalizeCodexLimits([invalid])).toEqual([]);
  });

  test("does not change the paid-capacity planner or recommendation set", () => {
    const account = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:05:00Z", 1, 2, true),
    ])[0]!;
    expect(buildUtilizationPlans([account], Date.parse("2026-10-19T10:06:00Z"))).toEqual([]);
  });

  test("never creates a quota history stream for unlimited local capacity", () => {
    const account = normalizeCodexLimits([
      qwen("studio", "2026-10-19T10:05:00Z", 1, 2, true),
    ])[0]!;
    const directory = tempDir("spendwatch-local-qwen-");
    const database = join(directory, "capacity.db");
    const history = join(directory, "capacity.jsonl");
    expect(writeCapacitySnapshot(database, [account], { collectedAt: Date.parse("2026-10-19T10:06:00Z") }).rows).toBe(0);
    writeFileSync(history, JSON.stringify({
      provider: "qwen",
      account: "Local Qwen",
      device: "studio",
      sampledAt: "2026-10-19T10:05:00Z",
      windows: [{ kind: "weekly", usedPercent: 10, windowMinutes: 10_080 }],
    }));
    expect(importCapacityHistory(database, [history])).toEqual({ inserted: 0, accepted: 0 });
  });

  test("never asks for OAuth to use the self-hosted route", () => {
    expect(normalizeAuthenticationRequirements([{
      kind: "authentication-required",
      provider: "qwen",
      device: "studio",
    }])).toEqual([]);
  });
});

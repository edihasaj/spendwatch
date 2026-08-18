import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCapacityFromUsage, discoverClaudeProfiles } from "../src/claude-capacity";
import { staleAfterMs, windowFreshness } from "../src/capacity-freshness";

const usage = {
  five_hour: { utilization: 100, resets_at: "2026-08-18T16:09:59.773984+00:00" },
  seven_day: { utilization: 85, resets_at: "2026-08-19T09:59:59.774013+00:00" },
  seven_day_opus: null,
};

describe("Claude capacity", () => {
  test("maps the OAuth usage payload onto capacity windows", () => {
    const now = Date.parse("2026-08-18T15:30:00Z");
    const result = claudeCapacityFromUsage(usage, { email: "user@example.com", organization: "Personal", plan: "max" }, now);
    expect(result?.provider).toBe("claude");
    expect(result?.usage.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: "2026-08-18T16:09:59.773Z",
    });
    expect(result?.usage.secondary?.windowMinutes).toBe(10080);
    expect(result?.usage.secondary?.usedPercent).toBe(85);
    expect(result?.usage.tertiary).toBeNull();
    expect(result?.usage.updatedAt).toBe("2026-08-18T15:30:00.000Z");
    expect(result?.pace?.primary?.willLastToReset).toBe(false);
  });

  test("refuses payloads without a usable window or account", () => {
    expect(claudeCapacityFromUsage(usage, { email: "not-an-email" })).toBeUndefined();
    expect(claudeCapacityFromUsage({ five_hour: null, seven_day: null }, { email: "user@example.com" })).toBeUndefined();
    expect(claudeCapacityFromUsage(null, { email: "user@example.com" })).toBeUndefined();
  });

  test("discovers the default profile and named profiles", () => {
    const base = mkdtempSync(join(tmpdir(), "spendwatch-claude-"));
    const write = (home: string, metadata: string, email: string, plan: string) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: `token-${email}`, subscriptionType: plan },
      }));
      writeFileSync(metadata, JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "Personal" } }));
    };
    write(join(base, ".claude"), join(base, ".claude.json"), "default@example.com", "max");
    write(join(base, ".claude-work"), join(base, ".claude-work.json"), "work@example.com", "pro");
    mkdirSync(join(base, ".claude-empty"), { recursive: true });

    const profiles = discoverClaudeProfiles(base);
    expect(profiles.map((profile) => profile.identity.email)).toEqual(["default@example.com", "work@example.com"]);
    expect(profiles[1].token).toBe("token-work@example.com");
    expect(profiles[1].identity.plan).toBe("pro");
  });
});

describe("capacity freshness", () => {
  const now = Date.parse("2026-08-18T15:30:00Z");

  test("bounds the staleness budget to 5-60 minutes", () => {
    expect(staleAfterMs(300)).toBe(15 * 60_000);
    expect(staleAfterMs(60)).toBe(5 * 60_000);
    expect(staleAfterMs(10080)).toBe(60 * 60_000);
  });

  test("separates live, stale, and expired samples", () => {
    const session = { usedPercent: 14, windowMinutes: 300, resetsAt: "2026-08-18T18:00:00Z" };
    expect(windowFreshness(session, "2026-08-18T15:29:00Z", now)).toBe("live");
    expect(windowFreshness(session, "2026-08-18T15:00:00Z", now)).toBe("stale");
    expect(windowFreshness(session, undefined, now)).toBe("stale");
    expect(windowFreshness({ ...session, resetsAt: "2026-08-18T15:29:59Z" }, "2026-08-18T15:29:00Z", now)).toBe("expired");
  });
});

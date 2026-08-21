import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReadFailure,
  claudeCapacityFromUsage,
  discoverClaudeProfiles,
  needsRefresh,
  persistClaudeCredentials,
  preferUsableCredentials,
  refreshedCredentialsFrom,
} from "../src/claude-capacity";
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
      resetsAt: "2026-08-18T16:10:00.000Z",
    });
    expect(result?.usage.secondary?.windowMinutes).toBe(10080);
    expect(result?.usage.secondary?.usedPercent).toBe(85);
    // Sub-second drift between reads must not look like a new cycle.
    const later = claudeCapacityFromUsage(
      { ...usage, five_hour: { utilization: 100, resets_at: "2026-08-18T16:10:00.412773+00:00" } },
      { email: "user@example.com" },
      now,
    );
    expect(later?.usage.primary?.resetsAt).toBe(result?.usage.primary?.resetsAt);
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

describe("Claude token refresh", () => {
  const now = Date.parse("2026-08-21T07:00:00Z");

  test("refreshes before expiry rather than spending a 401 to find out", () => {
    const eightHours = now + 8 * 3_600_000;
    expect(needsRefresh(eightHours, now)).toBe(false);
    // Inside the skew window, so a slow collect cannot race the deadline.
    expect(needsRefresh(now + 4 * 60_000, now)).toBe(true);
    expect(needsRefresh(now - 1, now)).toBe(true);
    // An absent deadline is the exact shape that went stale unnoticed, so treat
    // unknown as due: one refresh writes a real deadline and settles it.
    expect(needsRefresh(undefined, now)).toBe(true);
    expect(needsRefresh(0, now)).toBe(true);
  });

  test("maps the token response, converting lifetimes to absolute deadlines", () => {
    const refreshed = refreshedCredentialsFrom({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 28_800,
      refresh_token_expires_in: 2_294_040,
      scope: "user:inference user:profile",
    }, now);
    expect(refreshed?.accessToken).toBe("new-access");
    expect(refreshed?.refreshToken).toBe("rotated-refresh");
    expect(refreshed?.expiresAt).toBe(now + 28_800_000);
    expect(refreshed?.scopes).toEqual(["user:inference", "user:profile"]);
  });

  test("refuses a response missing the rotated refresh token", () => {
    // Persisting an access token without its refresh token would strand the
    // account at the next expiry with no way back except a human login.
    expect(refreshedCredentialsFrom({ access_token: "a", expires_in: 100 }, now)).toBeUndefined();
    expect(refreshedCredentialsFrom({ refresh_token: "r", expires_in: 100 }, now)).toBeUndefined();
    expect(refreshedCredentialsFrom({ access_token: "a", refresh_token: "r" }, now)).toBeUndefined();
    expect(refreshedCredentialsFrom(undefined, now)).toBeUndefined();
  });

  test("writes credentials back without discarding unrelated fields", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-creds-"));
    const path = join(home, ".credentials.json");
    writeFileSync(path, JSON.stringify({
      claudeAiOauth: { accessToken: "old", refreshToken: "old-r", expiresAt: 1, subscriptionType: "max", rateLimitTier: "tier-x" },
      somethingElse: { keep: true },
    }));
    persistClaudeCredentials(path, {
      accessToken: "new", refreshToken: "new-r", expiresAt: 42, refreshTokenExpiresAt: 99, scopes: ["a"],
    });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.claudeAiOauth.accessToken).toBe("new");
    expect(written.claudeAiOauth.refreshToken).toBe("new-r");
    expect(written.claudeAiOauth.expiresAt).toBe(42);
    expect(written.claudeAiOauth.refreshTokenExpiresAt).toBe(99);
    // Claude Code owns these; clobbering them would break its own session.
    expect(written.claudeAiOauth.subscriptionType).toBe("max");
    expect(written.claudeAiOauth.rateLimitTier).toBe("tier-x");
    expect(written.somethingElse).toEqual({ keep: true });
  });
});

describe("Claude read failures", () => {
  test("separates re-authentication from backing off", () => {
    // These three were indistinguishable as an empty array, which is how an
    // expired token spent nine hours looking exactly like a rate limit.
    expect(classifyReadFailure(401)).toBe("unauthenticated");
    expect(classifyReadFailure(403)).toBe("unauthenticated");
    expect(classifyReadFailure(429)).toBe("rate-limited");
    expect(classifyReadFailure(500)).toBe("unavailable");
    expect(classifyReadFailure(503)).toBe("unavailable");
  });
});

describe("Claude credential source", () => {
  const keychain = { accessToken: "from-keychain", subscriptionType: "max" };

  test("falls back to the Keychain when the file is a blank husk", () => {
    // Claude Code leaves this behind after moving the secret to the Keychain.
    const husk = { accessToken: "", refreshToken: "", expiresAt: 0, subscriptionType: "max" };
    expect(preferUsableCredentials(husk, () => keychain)).toBe(keychain);
    expect(preferUsableCredentials(undefined, () => keychain)).toBe(keychain);
  });

  test("keeps a usable file token instead of touching the Keychain", () => {
    const file = { accessToken: "from-file" };
    let consulted = false;
    expect(preferUsableCredentials(file, () => { consulted = true; return keychain; })).toBe(file);
    expect(consulted).toBe(false);
  });

  test("keeps the husk when the Keychain yields nothing, so the caller still rejects it", () => {
    const husk = { accessToken: "" };
    expect(preferUsableCredentials(husk, () => undefined)).toBe(husk);
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

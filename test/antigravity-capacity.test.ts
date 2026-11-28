// GateFox's Gemini provider signs in through Antigravity CLI (`agy`), so the Gemini card is read from that sign-in.
// These tests run the whole read against a local fake of Code Assist and a fake `agy`, and check the two properties
// that matter: the gateway's sign-in file is never written, and the disposable home `agy` refreshes in is removed.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentGeminiCapacity, type GeminiReadFailure } from "../src/gemini-capacity";
import { antigravityUserAgent } from "../src/antigravity-capacity";
import { scanGeminiHomes } from "../src/gemini-credential";
import { geminiQuotaFromAntigravityModels, geminiQuotaFromRows } from "../src/gemini-quota";
import { normalizeCodexLimits, renderLimitsHtml } from "../src/limits";
import { geminiLimits } from "../src/gemini-capacity-card";
import { tempDir } from "./tmp";

const NOW = Date.parse("2026-11-28T01:00:00Z");
const STORED_ACCESS = "stored-antigravity-access";
const STORED_REFRESH = "stored-antigravity-refresh";
const REFRESHED_ACCESS = "refreshed-antigravity-access";

const MODELS = {
  "gemini-4-hydrogen-sonar": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-28T05:35:54Z" } },
  "gemini-3-flash": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-28T05:35:54Z" } },
  "gemini-3.1-flash-lite": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-28T05:35:54Z" } },
  "gemini-3.1-flash-image": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-28T05:35:54Z" } },
  "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 1, resetTime: "2026-11-28T06:10:58Z" } },
  "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 1, resetTime: "2026-11-28T06:10:58Z" } },
  tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
};

function signIn(access: string, expiry: string, email = "user@example.com"): string {
  return JSON.stringify({
    token: { access_token: access, token_type: "Bearer", refresh_token: STORED_REFRESH, expiry, expires_in: 3599 },
    auth_method: "consumer",
    ...(email ? { id_token_email: email } : {}),
  });
}

function antigravityHome(expiry = "2099-01-01T00:00:00Z", email = "user@example.com"): string {
  const home = tempDir("antigravity-home-");
  const directory = join(home, ".gemini", "antigravity-cli");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "antigravity-oauth-token"), signIn(STORED_ACCESS, expiry, email), { mode: 0o600 });
  writeFileSync(join(directory, "installation_id"), "install-id\n");
  return home;
}

/** A fake `agy` that refreshes (or, with `refresh` false, leaves) the sign-in in its HOME and logs that HOME. */
function fakeAgy(refresh = true): { command: string; log: string } {
  const folder = tempDir("fake-agy-");
  const log = join(folder, "homes.log");
  const command = join(folder, "agy");
  const write = refresh
    ? `printf '%s' '${signIn(REFRESHED_ACCESS, "2099-01-01T00:00:00Z")}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"`
    : "true";
  writeFileSync(command, `#!/bin/sh\necho "$HOME $1" >> '${log}'\n${write}\n`);
  chmodSync(command, 0o755);
  return { command, log };
}

interface Call { path: string; body: unknown; auth: string; agent: string }
const servers: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => { for (const server of servers) server.stop(true); });

function fakeCodeAssist(acceptOnly?: string): { url: string; calls: Call[] } {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const auth = request.headers.get("authorization") ?? "";
      calls.push({ path, body: await request.json().catch(() => undefined), auth, agent: request.headers.get("user-agent") ?? "" });
      if (acceptOnly && auth !== `Bearer ${acceptOnly}`) return Response.json({ error: {} }, { status: 401 });
      if (path.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: "gentle-river-abc12",
          currentTier: { id: "free-tier", name: "Antigravity" },
          paidTier: { id: "g1-ultra-lite-tier", name: "Google AI Ultra" },
        });
      }
      if (path.endsWith(":fetchAvailableModels")) return Response.json({ models: MODELS, defaultAgentModelId: "x" });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls };
}

async function read(home: string, url: string, command: string, failures: GeminiReadFailure[] = []) {
  process.env.SPENDWATCH_CAPACITY_CACHE = join(tempDir("antigravity-poll-"), "capacity-poll.db");
  return currentGeminiCapacity(NOW, (failure) => failures.push(failure), {
    homes: [home], codeAssistBaseUrl: url, antigravityCommand: command, coordinator: "",
  });
}

describe("Antigravity quota pools", () => {
  test("folds every Gemini model into one pool and leaves out Claude, GPT and internal models", () => {
    const quota = geminiQuotaFromAntigravityModels(MODELS, NOW)!;
    expect(quota.rows.map((row) => [row.label, row.usedPercent, row.windowMinutes, row.models.length]))
      .toEqual([["Gemini models", 20, 300, 4]]);
    expect(quota.headline?.family).toBe("antigravity-gemini");
    expect(quota.primary).toEqual({ usedPercent: 20, windowMinutes: 300, resetsAt: "2026-11-28T05:35:54.000Z" });
    expect(quota.secondary).toBeNull();
    // A cached snapshot of these rows survives the dashboard's re-validation.
    expect(geminiQuotaFromRows(quota.rows)?.rows.map((row) => row.label)).toEqual(["Gemini models"]);
  });

  test("a pool reads at its tightest model, and bad figures are dropped", () => {
    const quota = geminiQuotaFromAntigravityModels({
      "gemini-a": { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-28T05:00:00Z" } },
      "gemini-b": { quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-28T05:00:00Z" } },
      "gemini-c": { quotaInfo: { remainingFraction: "nope", resetTime: "2026-11-28T05:00:00Z" } },
      "claude-x": { quotaInfo: { remainingFraction: 2, resetTime: "2026-11-28T05:00:00Z" } },
    }, NOW)!;
    expect(quota.rows.map((row) => [row.label, row.usedPercent, row.models])).toEqual([["Gemini models", 60, ["gemini-a", "gemini-b"]]]);
    expect(geminiQuotaFromAntigravityModels([], NOW)).toBeUndefined();
  });
});

describe("Antigravity card", () => {
  test("an untouched pool says its timer has not started, and the row repeats no percentage", () => {
    const untouched = geminiQuotaFromAntigravityModels({
      "gemini-3-flash": { quotaInfo: { remainingFraction: 1, resetTime: "2026-11-28T06:00:00Z" } },
    }, NOW)!;
    const card = geminiLimits({ gemini: untouched, updatedAt: new Date(NOW).toISOString() }, NOW);
    expect(card).toContain("100% left");
    expect(card).toContain("Timer starts on first use");
    expect(card).not.toContain("data-reset=");
    // A cached two-row snapshot still renders rows, each without a repeated percentage or a lone heading.
    const two = geminiQuotaFromRows([
      { label: "x", family: "antigravity-gemini", models: ["gemini-3-flash"], usedPercent: 30, windowMinutes: 300, resetsAt: "2026-11-28T05:00:00Z" },
      { label: "x", family: "antigravity-partner", models: ["claude-opus-5-5-high"], usedPercent: 0, windowMinutes: 300, resetsAt: "2026-11-28T06:00:00Z" },
    ])!;
    const rows = geminiLimits({ gemini: two, updatedAt: new Date(NOW).toISOString() }, NOW);
    expect(rows).not.toContain("gemini-group-label");
    expect(rows).toContain("<strong>70% left</strong><span></span>");
  });
});

describe("Antigravity sign-in", () => {
  test("is read with its own account label, ahead of an older Gemini CLI login", () => {
    const home = antigravityHome();
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), JSON.stringify({ access_token: "old", expiry_date: 1 }), { mode: 0o600 });
    writeFileSync(join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active: "user@example.com" }));
    const { accounts, refusals } = scanGeminiHomes([home]);
    expect(refusals).toEqual([]);
    expect(accounts.map((account) => [account.email, account.signIn, account.credential.expiresAt]))
      .toEqual([["user@example.com", "antigravity", Date.parse("2099-01-01T00:00:00Z")]]);
  });

  test("an unnamed or readable-by-others sign-in is refused by class", () => {
    const unnamed = antigravityHome("2099-01-01T00:00:00Z", "");
    const open = antigravityHome();
    chmodSync(join(open, ".gemini", "antigravity-cli", "antigravity-oauth-token"), 0o644);
    expect(scanGeminiHomes([unnamed, open]).refusals.map((refusal) => refusal.reason)).toEqual(["unnamed-account", "not-private"]);
  });
});

describe("Antigravity collect", () => {
  test("a live token reads the Gemini pool without running agy", async () => {
    const home = antigravityHome();
    const google = fakeCodeAssist(STORED_ACCESS);
    const agy = fakeAgy();
    const results = await read(home, google.url, agy.command);
    expect(existsSync(agy.log)).toBe(false);
    expect(google.calls.map((call) => call.path)).toEqual(["/v1internal:loadCodeAssist", "/v1internal:fetchAvailableModels"]);
    expect(google.calls[0]!.body).toEqual({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });
    expect(google.calls[1]!.body).toEqual({ project: "gentle-river-abc12" });
    expect(google.calls.every((call) => call.agent === antigravityUserAgent())).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("user@example.com");
    expect(results[0]!.usage.loginMethod).toBe("Google AI Ultra");
    expect(results[0]!.usage.buckets.map((row) => row.label)).toEqual(["Gemini models"]);

    const html = renderLimitsHtml(normalizeCodexLimits([results[0]!]), { generatedAt: NOW, nowMs: NOW });
    expect(html).toContain("Gemini models");
    expect(html).toContain("80% left");
    expect(html).toContain("4 models");
    // One allowance is the headline alone: no group heading, no repeated row, no Claude & GPT pool.
    expect(html).not.toContain('class="gemini-group"');
    expect(html).not.toContain("Claude &amp; GPT");
    expect(html).toContain('data-reset="2026-11-28T05:35:54.000Z"');
    for (const secret of [STORED_ACCESS, STORED_REFRESH]) expect(html).not.toContain(secret);
  });

  test("an expired token is refreshed by agy in a disposable home that is then removed", async () => {
    const home = antigravityHome("2026-11-27T18:53:37.228307+01:00");
    const tokenPath = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const before = readFileSync(tokenPath, "utf8");
    const google = fakeCodeAssist(REFRESHED_ACCESS);
    const agy = fakeAgy();
    const results = await read(home, google.url, agy.command);
    expect(results[0]?.usage.buckets).toHaveLength(1);
    expect(google.calls.every((call) => call.auth === `Bearer ${REFRESHED_ACCESS}`)).toBe(true);
    const [scratch, argument] = readFileSync(agy.log, "utf8").trim().split(" ");
    expect(argument).toBe("models");
    expect(scratch!.startsWith("/tmp/spendwatch-agy-")).toBe(true);
    expect(existsSync(scratch!)).toBe(false);
    // The gateway's sign-in is untouched: Spendwatch never writes it.
    expect(readFileSync(tokenPath, "utf8")).toBe(before);
    expect(JSON.stringify(results)).not.toContain(REFRESHED_ACCESS);
  });

  test("a sign-in agy cannot refresh is reported as needing sign-in", async () => {
    const home = antigravityHome("2026-11-27T00:00:00Z");
    const google = fakeCodeAssist(REFRESHED_ACCESS);
    const failures: GeminiReadFailure[] = [];
    const results = await read(home, google.url, fakeAgy(false).command, failures);
    expect(results).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(failures.map((failure) => [failure.email, failure.reason, failure.status])).toEqual([["user@example.com", "unauthenticated", 401]]);
  });

  test("a 401 on a token that looked live is retried once after a refresh", async () => {
    const home = antigravityHome();
    const google = fakeCodeAssist(REFRESHED_ACCESS);
    const agy = fakeAgy();
    const results = await read(home, google.url, agy.command);
    expect(results).toHaveLength(1);
    expect(google.calls.map((call) => call.auth)).toEqual([`Bearer ${STORED_ACCESS}`, `Bearer ${REFRESHED_ACCESS}`, `Bearer ${REFRESHED_ACCESS}`]);
    expect(readFileSync(agy.log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

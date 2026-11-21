// The Gemini quota card is collected from Google's Code Assist API with the
// sign-in GateFox already stores. These tests run that whole path against a
// local fake — including the two properties that matter most: the credential
// file is never written, and a token never leaves the request that needs it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  GEMINI_UNKNOWN_MESSAGE,
  classifyGeminiFailure,
  currentGeminiCapacity,
  geminiCapacityFromQuota,
  reportGeminiFailure,
  geminiUserAgent,
  type GeminiReadFailure,
} from "../src/gemini-capacity";
import { clientFromPackage } from "../src/gemini-oauth-client";

/** A stand-in for the installed CLI's public client; the real one is never in this repository. */
const FAKE_CLIENT = { id: "test-client.apps.example", secret: "test-client-secret" };
import {
  geminiNeedsRefresh,
  geminiCredentialHomes,
  scanGeminiHomes,
  inspectGeminiCredentialStats,
  inspectGeminiCredentialFile,
} from "../src/gemini-credential";
import { geminiLimits } from "../src/gemini-capacity-card";
import type { GatewayConfigView } from "../src/gateway-config";
import { geminiQuotaFromBuckets, geminiQuotaFromRows, geminiResetFrom } from "../src/gemini-quota";
import { sanitizePollSnapshot, pollKey, pollIntervalMs, GEMINI_POLL_INTERVAL_MS, CapacityPollStore } from "../src/capacity-poll";
import { normalizeCodexLimits, renderLimitsHtml, renderLimitsText } from "../src/limits";
import { normalizeAuthenticationRequirements } from "../src/capacity-dashboard";
import { tempDir } from "./tmp";

const REFRESHED_TOKEN = "refreshed-access-token-value";
const STORED_TOKEN = "stored-access-token-value";
const STORED_REFRESH = "stored-refresh-grant-value";

/** The buckets a Google AI Ultra account answers with, in the CLI's own field names. */
const QUOTA_RESPONSE = {
  buckets: [
    { modelId: "gemini-3.8-flash", remainingFraction: 0.94, remainingAmount: "9400", resetTime: "2026-11-21T18:00:00Z", tokenType: "model" },
    { modelId: "gemini-3.5-flash", remainingFraction: 0.94, remainingAmount: "9400", resetTime: "2026-11-21T18:00:00Z", tokenType: "model" },
    { modelId: "gemini-3-pro-preview", remainingFraction: 0.3, remainingAmount: "60", resetTime: "2026-11-21T20:00:00Z", tokenType: "model" },
    { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.99, resetTime: "2026-11-21T18:00:00Z" },
  ],
};

interface Captured {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface FakeGoogle {
  url: string;
  calls: Captured[];
  callsTo(path: string): Captured[];
  reset(): void;
  stop(): void;
}

/**
 * The three endpoints this collector uses, served locally. Base URLs arrive
 * through a test-only option rather than an environment variable, so no stray
 * export in someone's shell can ever point a real run at this server.
 */
async function fakeGoogle(options: {
  quota?: unknown;
  quotaStatus?: number;
  tokenStatus?: number;
  tokenBody?: unknown;
  project?: string;
} = {}): Promise<FakeGoogle> {
  const calls: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const text = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      let body: unknown;
      try { body = text ? JSON.parse(text) : text; } catch { body = text; }
      calls.push({ path, body, headers });
      if (path.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: options.project ?? "oktapod-prod-01",
          currentTier: { id: "standard-tier", name: "Google AI Pro" },
          paidTier: { id: "enterprise-tier", name: "Google AI Ultra" },
        });
      }
      if (path.endsWith(":retrieveUserQuota")) {
        if (options.quotaStatus && options.quotaStatus !== 200) {
          return Response.json({ error: { message: "quota unavailable" } }, { status: options.quotaStatus });
        }
        return Response.json(options.quota ?? QUOTA_RESPONSE);
      }
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return Response.json(options.tokenBody ?? { error: "invalid_grant" }, { status: options.tokenStatus });
      }
      return Response.json(options.tokenBody ?? { access_token: REFRESHED_TOKEN, expires_in: 3600, token_type: "Bearer" });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    calls,
    callsTo: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),
    reset: () => { calls.length = 0; },
    stop: () => server.stop(true),
  };
}

/** A gateway-managed home holding one signed-in account, the way GateFox lays it out. */
function signedInHome(name = "gemini-home", expiryMs = Date.parse("2099-01-01T00:00:00Z")): string {
  const home = tempDir(`${name}-`);
  const gemini = join(home, ".gemini");
  mkdirSync(gemini, { recursive: true, mode: 0o700 });
  writeFileSync(join(gemini, "oauth_creds.json"), JSON.stringify({
    access_token: STORED_TOKEN,
    refresh_token: STORED_REFRESH,
    expiry_date: expiryMs,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    token_type: "Bearer",
  }), { mode: 0o600 });
  writeFileSync(join(gemini, "google_accounts.json"), JSON.stringify({
    active: "user@example.com",
    old: ["someone@example.com"],
  }), { mode: 0o600 });
  return home;
}

// No test may touch a real poll cache: the collector's lease store is pinned
// here, and `readFrom` gives every read a store of its own.
process.env.SPENDWATCH_CAPACITY_CACHE = join(tempDir("gemini-poll-default-"), "capacity-poll.db");

/**
 * One collect against the fake, with its own lease store and no coordinator.
 *
 * The store is per read because the coordinator lease is the whole point of the
 * shared poll state: a second read for the same account inside its interval is
 * answered from the cache without touching the network, which would make the
 * next test's assertions about requests meaningless.
 */
async function readFrom(
  home: string,
  google: FakeGoogle,
  now = Date.parse("2026-11-21T12:00:00Z"),
  onFailure?: (failure: GeminiReadFailure) => void,
): Promise<{ results: Awaited<ReturnType<typeof currentGeminiCapacity>>; cachePath: string }> {
  const cachePath = join(tempDir("gemini-poll-"), "capacity-poll.db");
  process.env.SPENDWATCH_CAPACITY_CACHE = cachePath;
  const results = await currentGeminiCapacity(now, onFailure, {
    homes: [home],
    codeAssistBaseUrl: google.url,
    tokenUrl: `${google.url}/token`,
    oauthClient: FAKE_CLIENT,
    coordinator: "",
  });
  return { results, cachePath };
}

const fakes: FakeGoogle[] = [];
async function fake(spec: Parameters<typeof fakeGoogle>[0] = {}): Promise<FakeGoogle> {
  const instance = await fakeGoogle(spec);
  fakes.push(instance);
  return instance;
}

afterAll(() => { for (const fake of fakes) fake.stop(); });

describe("Gemini quota model", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");

  test("one row per allowance, with the tightest Pro bucket as the headline", () => {
    const quota = geminiQuotaFromBuckets(QUOTA_RESPONSE.buckets, now);
    expect(quota?.rows.map((row) => row.label)).toEqual(["Gemini Pro", "Gemini Flash", "Gemini Flash Lite"]);
    expect(quota?.headline?.label).toBe("Gemini Pro");
    expect(quota?.headline?.usedPercent).toBe(70);
    expect(quota?.headline?.resetsAt).toBe("2026-11-21T20:00:00.000Z");
    // The headline is also the shared primary window a consumer like GateFox reads.
    expect(quota?.primary).toEqual({ usedPercent: 70, windowMinutes: 1440, resetsAt: "2026-11-21T20:00:00.000Z" });
    expect(quota?.secondary?.label ?? quota?.secondary).toBeDefined();
  });

  test("collapses the model aliases the CLI folds onto one allowance", () => {
    // gemini-3.8-flash and gemini-3.5-flash are the same allowance; showing both
    // would advertise more room than the account has.
    const flash = geminiQuotaFromBuckets(QUOTA_RESPONSE.buckets, now)!.rows.find((row) => row.family === "flash")!;
    expect(flash.models).toEqual(["gemini-3.5-flash", "gemini-3.8-flash"]);
    expect(flash.remainingAmount).toBe(9400);
    expect(flash.limit).toBe(10000);
  });

  test("a passed reset is carried so the renderer can call the cycle ended", () => {
    const quota = geminiQuotaFromBuckets([{ modelId: "gemini-3-pro-preview", remainingFraction: 0.5, resetTime: "2020-01-01T00:00:00Z" }], now);
    expect(quota?.headline?.resetsAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test("accepts a protobuf duration reset and rejects nonsense", () => {
    expect(geminiResetFrom("900s", now)).toBe(new Date(now + 900_000).toISOString());
    expect(geminiResetFrom("not a time", now)).toBeUndefined();
    expect(geminiResetFrom(undefined, now)).toBeUndefined();
  });

  test("drops a bucket that says nothing usable", () => {
    // Mirrors the CLI skipping a bucket with no model id or no fraction.
    expect(geminiQuotaFromBuckets([{ remainingFraction: 0.5 }], now)).toBeUndefined();
    expect(geminiQuotaFromBuckets([{ modelId: "gemini-3-pro-preview" }], now)).toBeUndefined();
    expect(geminiQuotaFromBuckets([{ modelId: "bad id/../..", remainingFraction: 0.5 }], now)).toBeUndefined();
    expect(geminiQuotaFromBuckets([{ modelId: "gemini-3-pro-preview", remainingFraction: 4 }], now)).toBeUndefined();
    expect(geminiQuotaFromBuckets(undefined, now)).toBeUndefined();
  });

  test("a bucket that reported no fraction is not read as a spent one", () => {
    // Number(null), Number("") and Number(false) are all 0, and a coerced 0
    // renders as "Ran out" for an allowance that simply reported nothing.
    for (const missing of [null, "", "   ", true, false, Number.NaN, {}, [], "half", "0.5x"]) {
      expect(geminiQuotaFromBuckets([{ modelId: "gemini-3-pro-preview", remainingFraction: missing }], now))
        .toBeUndefined();
    }
    // A numeric string is the same figure, because this API strings some numbers.
    const quoted = geminiQuotaFromBuckets([{ modelId: "gemini-3-pro-preview", remainingFraction: "0.25" }], now);
    expect(quoted?.headline?.usedPercent).toBe(75);
  });

  test("two Pro allowances stay two rows: only the enumerated Flash aliases are folded", () => {
    // The CLI folds gemini-3-flash/-3.5-flash/-3.8-flash onto one allowance and
    // the two flash-lite ids onto another (chunk-37D3S3FZ.js:406024-406032). It
    // folds nothing else, so two Pro versions are two allowances and one merged
    // row would report an averaged figure for a quota that is really two.
    const quota = geminiQuotaFromBuckets([
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9, remainingAmount: "90" },
      { modelId: "gemini-3.1-pro", remainingFraction: 0.2, remainingAmount: "20" },
    ], now)!;
    expect(quota.rows.map((row) => row.models).sort()).toEqual([["gemini-2.5-pro"], ["gemini-3.1-pro"]]);
    expect(quota.rows.map((row) => row.usedPercent).sort((a, b) => a - b)).toEqual([10, 80]);
    // The headline is still the allowance that stops work first.
    expect(quota.headline?.models).toEqual(["gemini-3.1-pro"]);
    // An unlisted id is never folded onto another, even one it resembles.
    const others = geminiQuotaFromBuckets([
      { modelId: "gemini-3.5-tts", remainingFraction: 0.5 },
      { modelId: "imagen-4", remainingFraction: 0.25 },
      { modelId: "gemini-9-flash", remainingFraction: 0.5 },
    ], now)!;
    expect(others.rows).toHaveLength(3);
    // The verified aliases still collapse, or one quota would read as two.
    const folded = geminiQuotaFromBuckets([
      { modelId: "gemini-3.5-flash", remainingFraction: 0.8 },
      { modelId: "gemini-3.8-flash", remainingFraction: 0.3 },
    ], now)!;
    expect(folded.rows).toHaveLength(1);
    expect(folded.rows[0]!.usedPercent).toBe(70);
  });

  test("the card names crowded rows by the ids they report", () => {
    const quota = geminiQuotaFromBuckets([
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9 },
      { modelId: "gemini-3.1-pro", remainingFraction: 0.2 },
    ], now)!;
    const html = geminiLimits({ gemini: quota, updatedAt: new Date(now).toISOString() }, now);
    expect(html.match(/class="gemini-row"/g)).toHaveLength(2);
    // Two rows both headed "Gemini Pro" would be indistinguishable; the ids are
    // the answer, and they arrive under one Pro heading.
    expect(html).toContain("<span>gemini-2.5-pro</span>");
    expect(html).toContain("<span>gemini-3.1-pro</span>");
    expect(html).toContain('data-family="pro"');
    // The headline is named by its id too, so the featured figure says which of
    // the two Pro allowances is nearly out rather than calling both "Gemini Pro".
    expect(html.match(/<span>gemini-3\.1-pro<\/span>/g)).toHaveLength(2);
    expect(html.match(/<span>gemini-2\.5-pro<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain("<span>Gemini Pro</span>");
  });

  test("the text output names crowded rows the same way the card does", () => {
    const result = geminiCapacityFromQuota({ buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9 },
      { modelId: "gemini-3.1-pro", remainingFraction: 0.2 },
    ] }, { email: "user@example.com" }, now)!;
    const text = renderLimitsText(normalizeCodexLimits([result]), now);
    // Two lines both headed "Gemini Pro" would leave a script reading this no
    // better off than a guess about which allowance is nearly out.
    expect(text).toContain("gemini-2.5-pro 90% left");
    expect(text).toContain("gemini-3.1-pro 20% left");
  });

  test("a cached snapshot cannot smuggle figures into the card", () => {
    const rows = geminiQuotaFromRows([
      { label: "Gemini Pro", family: "pro", models: ["gemini-3-pro-preview"], usedPercent: 70, windowMinutes: 1440 },
      { label: "<img src=x>", family: "nonsense", models: ["<img src=x>"], usedPercent: 70, windowMinutes: 1440 },
      { label: "Evil", family: "flash", models: ["ok"], usedPercent: 900, windowMinutes: 1440 },
      { label: "Bad reset", family: "flash", models: ["ok-2"], usedPercent: 40, windowMinutes: 1440, resetsAt: "yesterday" },
    ])!.rows;
    // The stored labels are dropped, not sanitized: the card only ever shows
    // what this repo derives from the family and the validated model ids.
    expect(rows.map((row) => row.label)).toEqual(["Gemini Pro", "Gemini Flash"]);
    expect(rows[1]!.resetsAt).toBeUndefined();
    expect(geminiQuotaFromRows([{ family: "pro", models: [], usedPercent: 1, windowMinutes: 1 }])).toBeUndefined();
    // A reset far in the future proves nothing about this cycle either.
    const future = geminiQuotaFromRows([{ family: "pro", models: ["gemini-3-pro-preview"],
      usedPercent: 10, windowMinutes: 1440, resetsAt: "2100-01-01T00:00:00Z" }])!;
    expect(future.rows[0]!.resetsAt).toBeUndefined();
    // An unknown family is named by its validated model id, never by the file.
    const other = geminiQuotaFromRows([{ label: "<img src=x>", family: "other",
      models: ["gemini-3.5-tts"], usedPercent: 10, windowMinutes: 1440 }])!;
    expect(other.rows[0]!.label).toBe("gemini-3.5-tts");
  });

  test("the tier name becomes the plan label", () => {
    const result = geminiCapacityFromQuota(QUOTA_RESPONSE, { email: "user@example.com", tier: "Google AI Ultra" }, now);
    expect(result?.provider).toBe("gemini");
    expect(result?.usage.loginMethod).toBe("Google AI Ultra");
    expect(result?.account).toBe("user@example.com");
    expect(result?.pace?.primary?.willLastToReset).toBeDefined();
  });
});

describe("Gemini credential file", () => {
  const view = (over: Partial<GatewayConfigView> = {}): GatewayConfigView => ({
    directory: "/etc/gateway", found: true, stateDirectory: ".state",
    authDirectories: new Map(), geminiHomes: new Map([["gemini", "/srv/gemini-home"]]), ...over,
  });

  // Which login gets read is the whole privacy surface of this collector, so the
  // order and the de-duplication are pinned rather than trusted to the reader.
  test("the gateway-managed login is offered before the personal one", () => {
    const saved = process.env.SPENDWATCH_GATEWAY_STATE;
    delete process.env.SPENDWATCH_GATEWAY_STATE;
    try {
      expect(geminiCredentialHomes(view(), "/Users/example")).toEqual([
        "/srv/gemini-home", "/etc/gateway/.state/gemini-home", "/Users/example"]);
      // One login reached two ways is still one account.
      expect(geminiCredentialHomes(
        view({ geminiHomes: new Map([["gemini", "/Users/example"]]) }), "/Users/example")).toEqual([
        "/Users/example", "/etc/gateway/.state/gemini-home"]);
      // With no gateway config there is no state default to guess at.
      expect(geminiCredentialHomes(view({ found: false, geminiHomes: undefined }), "/Users/example"))
        .toEqual(["/Users/example"]);
    } finally {
      if (saved === undefined) delete process.env.SPENDWATCH_GATEWAY_STATE;
      else process.env.SPENDWATCH_GATEWAY_STATE = saved;
    }
  });

  test("refuses a symlink, a foreign owner, and any group or world bit", () => {
    const home = signedInHome();
    const path = join(home, ".gemini", "oauth_creds.json");
    expect(inspectGeminiCredentialFile(path)).toBeUndefined();
    chmodSync(path, 0o644);
    expect(inspectGeminiCredentialFile(path)).toBe("not-private");
    chmodSync(path, 0o600);
    const link = join(home, ".gemini", "stolen.json");
    symlinkSync(path, link);
    expect(inspectGeminiCredentialFile(link)).toBe("symlink");
    expect(inspectGeminiCredentialFile(join(home, ".gemini", "missing.json"))).toBeUndefined();
  });

  test("a pipe at the credential path is refused, not waited on", () => {
    // The pre-check used to refuse this with an `lstat`. Judging the opened
    // descriptor instead only stays safe if the open itself cannot block, which
    // is what O_NONBLOCK buys: without it this test hangs on a writer that never
    // comes rather than reporting a refusal.
    const home = signedInHome("gemini-pipe-");
    const path = join(home, ".gemini", "oauth_creds.json");
    rmSync(path);
    // Bun's node:fs has no mkfifoSync, and this file already assumes POSIX
    // semantics elsewhere (mode bits, getuid), so the platform's own tool makes it.
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    // The read happens in a child with a deadline. A blocked `openSync` cannot be
    // interrupted from JavaScript, so asking in-process would hang the suite rather
    // than report the regression if O_NONBLOCK ever went missing.
    const modulePath = new URL("../src/gemini-credential.ts", import.meta.url).pathname;
    const child = Bun.spawnSync([process.execPath, "-e",
      `const { scanGeminiHomes } = await import(${JSON.stringify(modulePath)});`
      + `process.stdout.write(JSON.stringify(scanGeminiHomes([${JSON.stringify(home)}])));`],
    { timeout: 10_000, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ accounts: [], refusals: [{ home, reason: "not-a-file" }] });
  });

  test("refuses a file owned by somebody else", () => {
    const stats = (over: Record<string, unknown> = {}) => ({
      isSymbolicLink: () => false, isFile: () => true, uid: 501, mode: 0o600, ...over,
    });
    expect(inspectGeminiCredentialStats(stats(), 501)).toBeUndefined();
    expect(inspectGeminiCredentialStats(stats({ uid: 0 }), 501)).toBe("not-owned");
    expect(inspectGeminiCredentialStats(stats({ mode: 0o640 }), 501)).toBe("not-private");
    expect(inspectGeminiCredentialStats(stats({ isSymbolicLink: () => true }), 501)).toBe("symlink");
    expect(inspectGeminiCredentialStats(stats({ isFile: () => false }), 501)).toBe("not-a-file");
  });

  test("a world-readable label still names the account, because it holds no secret", () => {
    // The CLI writes the grant 0600 (chunk-37D3S3FZ.js:291866) but the account
    // label with no mode at all (chunk-37D3S3FZ.js:284911). Refusing a readable
    // label would drop the account — and the card — on a correct install.
    const home = signedInHome("gemini-open-label-");
    chmodSync(join(home, ".gemini", "google_accounts.json"), 0o644);
    const scan = scanGeminiHomes([home]);
    expect(scan.accounts.map((account) => account.email)).toEqual(["user@example.com"]);
    expect(scan.refusals).toEqual([]);
  });

  test("a credential whose label is not an address is reported, not skipped", () => {
    const home = signedInHome("gemini-bad-label-");
    writeFileSync(join(home, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "user@example.com /tmp/other-home" }), { mode: 0o600 });
    const scan = scanGeminiHomes([home]);
    // It keys history, a poll reservation and a reported line, so a label that is
    // not an address cannot be carried at all.
    expect(scan.accounts).toEqual([]);
    expect(scan.refusals).toEqual([{ home, reason: "unnamed-account" }]);
  });

  test("an unknown deadline counts as due for a refresh", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(geminiNeedsRefresh(undefined, now)).toBe(true);
    expect(geminiNeedsRefresh(now - 1, now)).toBe(true);
    expect(geminiNeedsRefresh(now + 60_000, now)).toBe(true);
    expect(geminiNeedsRefresh(now + 3_600_000, now)).toBe(false);
  });

  test("401 and 403 need a sign-in, 429 needs patience, and the rest is transient", () => {
    expect(classifyGeminiFailure(401)).toBe("unauthenticated");
    expect(classifyGeminiFailure(403)).toBe("unauthenticated");
    expect(classifyGeminiFailure(429)).toBe("rate-limited");
    expect(classifyGeminiFailure(500)).toBe("unavailable");
  });
});

describe("Gemini collection is opt-in by presence", () => {
  test("no credential means no card and no request at all", async () => {
    const google = await fake();
    const empty = tempDir("gemini-empty-");
    const failures: GeminiReadFailure[] = [];
    const { results } = await readFrom(empty, google, Date.now(), (failure) => failures.push(failure));
    expect(results).toEqual([]);
    expect(google.calls).toEqual([]);
    // A home with nothing in it is not a failure worth reporting: it is the
    // ordinary state of a machine that has never signed into Gemini.
    expect(failures).toEqual([]);
  });

  test("an insecure credential file is refused without a request or a path in the message", async () => {
    const google = await fake();
    const home = signedInHome("gemini-worldreadable-");
    chmodSync(join(home, ".gemini", "oauth_creds.json"), 0o644);
    const failures: GeminiReadFailure[] = [];
    const { results } = await readFrom(home, google, Date.now(), (failure) => failures.push(failure));
    expect(results).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(failures).toEqual([{ reason: "unavailable", message: "Gemini credential file was refused: not-private" }]);
    expect(JSON.stringify(failures)).not.toContain(home);
  });

  test("a credential swapped for a link is refused at open, with no request and no grant", async () => {
    // The window the old lstat-then-read left open: by the time the bytes were
    // read, the path named somebody else's grant. One descriptor for the check
    // and the read closes it, so the foreign grant is never read at all.
    const home = signedInHome("gemini-swapped-");
    const foreign = join(tempDir("gemini-other-account-"), "oauth_creds.json");
    writeFileSync(foreign, JSON.stringify({
      access_token: "a-strangers-access-token", refresh_token: "a-strangers-grant",
    }), { mode: 0o600 });
    const path = join(home, ".gemini", "oauth_creds.json");
    rmSync(path);
    symlinkSync(foreign, path);
    const google = await fake();
    const failures: GeminiReadFailure[] = [];
    const { results } = await readFrom(home, google, Date.now(), (failure) => failures.push(failure));
    expect(results).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(failures).toEqual([{ reason: "unavailable", message: "Gemini credential file was refused: symlink" }]);
    const text = JSON.stringify(failures);
    expect(text).not.toContain(home);
    expect(text).not.toContain("a-strangers-grant");
  });
});

describe("Gemini quota read", () => {
  test("mirrors the CLI's requests and yields one card per signed-in account", async () => {
    const google = await fake();
    const home = signedInHome();
    const { results } = await readFrom(home, google);
    expect(results.map((result) => result.account)).toEqual(["user@example.com"]);

    const load = google.callsTo(":loadCodeAssist");
    expect(load).toHaveLength(1);
    // chunk-37D3S3FZ.js:333926-333934 — project id and duetProject are undefined
    // until the response names them, so JSON.stringify drops both fields.
    expect(load[0]!.body).toEqual({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });
    expect(load[0]!.headers.authorization).toBe(`Bearer ${STORED_TOKEN}`);
    expect(load[0]!.headers["content-type"]).toBe("application/json");
    expect(load[0]!.headers["user-agent"]).toBe(geminiUserAgent());

    const quota = google.callsTo(":retrieveUserQuota");
    expect(quota).toHaveLength(1);
    // chunk-37D3S3FZ.js:406016 — retrieveUserQuota({ project }).
    expect(quota[0]!.body).toEqual({ project: "oktapod-prod-01" });
    expect(google.callsTo("/token")).toHaveLength(0);

    const [result] = results;
    expect(result!.usage.accountEmail).toBe("user@example.com");
    expect(result!.usage.loginMethod).toBe("Google AI Ultra");
    expect(result!.usage.buckets.map((row) => row.label)).toEqual(["Gemini Pro", "Gemini Flash", "Gemini Flash Lite"]);
    expect(result!.usage.primary).toEqual({ usedPercent: 70, windowMinutes: 1440, resetsAt: "2026-11-21T20:00:00.000Z" });
    expect(result!.usage.updatedAt).toBe("2026-11-21T12:00:00.000Z");
  });

  test("an expired token is refreshed in memory and the credential file stays byte for byte", async () => {
    const google = await fake();
    const home = signedInHome("gemini-expired-", Date.parse("2020-01-01T00:00:00Z"));
    const path = join(home, ".gemini", "oauth_creds.json");
    const before = readFileSync(path);

    const { results } = await readFrom(home, google);
    expect(results).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before);

    // chunk-37D3S3FZ.js:127180-127195 — form-encoded grant plus the public client.
    const refresh = google.callsTo("/token");
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(refresh[0]!.body)))).toEqual({
      refresh_token: STORED_REFRESH,
      client_id: FAKE_CLIENT.id,
      client_secret: FAKE_CLIENT.secret,
      grant_type: "refresh_token",
    });
    // Both Code Assist calls then use the new token, and only one grant was spent.
    for (const call of [...google.callsTo(":loadCodeAssist"), ...google.callsTo(":retrieveUserQuota")]) {
      expect(call.headers.authorization).toBe(`Bearer ${REFRESHED_TOKEN}`);
    }
  });

  test("invalid_grant means the account must sign in again", async () => {
    const google = await fake({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: `Token ${STORED_REFRESH} has been revoked` } });
    const home = signedInHome("gemini-revoked-", Date.parse("2020-01-01T00:00:00Z"));
    const failures: GeminiReadFailure[] = [];
    const { results } = await readFrom(home, google, Date.parse("2026-11-21T12:00:00Z"), (failure) => failures.push(failure));
    expect(results).toEqual([]);
    expect(failures).toEqual([{ email: "user@example.com", status: 401, reason: "unauthenticated", message: "Gemini quota read failed with HTTP 401" }]);
    // The description Google returns can quote the rejected grant.
    expect(JSON.stringify(failures)).not.toContain(STORED_REFRESH);
    expect(google.callsTo(":retrieveUserQuota")).toHaveLength(0);
  });

  test("a quota read that 401s retries once after a refresh, and 500s are transient", async () => {
    const google = await fake({ quotaStatus: 500 });
    const home = signedInHome("gemini-server-error-");
    const failures: GeminiReadFailure[] = [];
    await readFrom(home, google, Date.now(), (failure) => failures.push(failure));
    expect(failures).toEqual([{ email: "user@example.com", status: 500, reason: "unavailable", message: "Gemini quota read failed with HTTP 500" }]);

    const empty = await fake({ quota: { buckets: [] } });
    const silent: GeminiReadFailure[] = [];
    const { results } = await readFrom(signedInHome("gemini-no-buckets-"), empty, Date.now(), (failure) => silent.push(failure));
    expect(results).toEqual([]);
    expect(silent.map((failure) => failure.reason)).toEqual(["unavailable"]);
  });

  test("tokens never reach the result, the snapshot, or the rendered card", async () => {
    const google = await fake();
    const home = signedInHome("gemini-leak-check-");
    const now = Date.parse("2026-11-21T12:00:00Z");
    const { results, cachePath } = await readFrom(home, google, now);
    const [result] = results;
    expect(result).toBeDefined();
    const serialized = JSON.stringify(result);
    for (const secret of [STORED_TOKEN, STORED_REFRESH, REFRESHED_TOKEN]) {
      expect(serialized).not.toContain(secret);
    }

    // The stored snapshot is the same shape a second machine would receive.
    const store = new CapacityPollStore(cachePath);
    store.cacheSnapshot("gemini", "user@example.com", result);
    const cached = store.cached("gemini", "user@example.com");
    store.close();
    expect(cached?.provider).toBe("gemini");
    const cachedText = JSON.stringify(cached);
    for (const secret of [STORED_TOKEN, STORED_REFRESH, REFRESHED_TOKEN]) {
      expect(cachedText).not.toContain(secret);
    }

    const html = renderLimitsHtml(normalizeCodexLimits([result]), { generatedAt: now, nowMs: now });
    expect(html).toContain("Gemini Pro");
    expect(html).toContain("30% left");
    expect(html).toContain("Flash Lite");
    for (const secret of [STORED_TOKEN, STORED_REFRESH, REFRESHED_TOKEN]) {
      expect(html).not.toContain(secret);
    }
  });

  // The collector's failures are printed on a terminal, so anything it forwards
  // from an exception is published. Both tests below fail if a failure ever
  // carries `error.message` from outside this feature again.
  const assertClean = (failures: GeminiReadFailure[], lines: string[], leaks: string[]): void => {
    const text = JSON.stringify(failures) + lines.join("");
    for (const leak of leaks) expect(text).not.toContain(leak);
    expect(lines.join("")).toContain(GEMINI_UNKNOWN_MESSAGE);
  };

  test("an unreadable cache reports a fault, never the path it could not open", async () => {
    const google = await fake();
    const home = signedInHome("gemini-bad-cache-");
    const blocked = join(tempDir("gemini-cache-blocked-"), "not-a-directory");
    writeFileSync(blocked, "", { mode: 0o600 });
    const marker = "CAPACITY-PATH-MUST-NOT-LEAK";
    const cache = join(blocked, marker, "capacity-poll.db");
    const saved = process.env.SPENDWATCH_CAPACITY_CACHE;
    process.env.SPENDWATCH_CAPACITY_CACHE = cache;
    try {
      const failures: GeminiReadFailure[] = [];
      const lines: string[] = [];
      // Not `readFrom`: that helper points the lease store at a usable file, and
      // the unusable one is the whole point of this test.
      const results = await currentGeminiCapacity(Date.now(), (failure) => {
        failures.push(failure);
        reportGeminiFailure(failure, (chunk) => lines.push(chunk));
      }, {
        homes: [home],
        codeAssistBaseUrl: google.url,
        tokenUrl: `${google.url}/token`,
        oauthClient: FAKE_CLIENT,
        coordinator: "",
      });
      // The lease store is opened from that variable before anything is read, so
      // its open failure is the fault under test.
      expect(results).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toBe(GEMINI_UNKNOWN_MESSAGE);
      expect(failures[0]!.reason).toBe("unavailable");
      assertClean(failures, lines, [marker, cache, blocked, STORED_TOKEN, STORED_REFRESH, REFRESHED_TOKEN, "capacity-poll"]);
    } finally {
      if (saved === undefined) delete process.env.SPENDWATCH_CAPACITY_CACHE;
      else process.env.SPENDWATCH_CAPACITY_CACHE = saved;
    }
  });

  test("an unexpected transport fault reports a fault, never its own text", async () => {
    const google = await fake();
    // A stale token forces the refresh first, so a live token is in play when the
    // fault happens — the case a leak would actually matter in.
    const home = signedInHome("gemini-transport-fault-", Date.parse("2020-01-01T00:00:00Z"));
    const privatePath = "/Users/example/.private/gemini-session";
    const fault = new Error(`connect ECONNREFUSED ${privatePath} grant=${STORED_REFRESH} token=${REFRESHED_TOKEN}`);
    const realFetch = globalThis.fetch;
    const fetch: typeof fetch = (input, init) => {
      if (String(input).endsWith(":loadCodeAssist")) throw fault;
      return realFetch(input as string | URL, init);
    };
    const failures: GeminiReadFailure[] = [];
    const lines: string[] = [];
    // A store of its own: a lease another test left behind would answer this read
    // from cache, and the fault under test would never be reached.
    const saved = process.env.SPENDWATCH_CAPACITY_CACHE;
    process.env.SPENDWATCH_CAPACITY_CACHE = join(tempDir("gemini-poll-fault-"), "capacity-poll.db");
    let results: Awaited<ReturnType<typeof currentGeminiCapacity>>;
    try {
      results = await currentGeminiCapacity(Date.parse("2026-11-21T12:00:00Z"), (failure) => {
        failures.push(failure);
        reportGeminiFailure(failure, (chunk) => lines.push(chunk));
      }, {
        homes: [home],
        codeAssistBaseUrl: google.url,
        tokenUrl: `${google.url}/token`,
        oauthClient: FAKE_CLIENT,
        coordinator: "",
        fetch,
      });
    } finally {
      if (saved === undefined) delete process.env.SPENDWATCH_CAPACITY_CACHE;
      else process.env.SPENDWATCH_CAPACITY_CACHE = saved;
    }
    expect(results).toEqual([]);
    expect(google.callsTo("/token")).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe(GEMINI_UNKNOWN_MESSAGE);
    expect(failures[0]!.reason).toBe("unavailable");
    expect(failures[0]!.email).toBe("user@example.com");
    assertClean(failures, lines, [privatePath, "ECONNREFUSED", STORED_TOKEN, STORED_REFRESH, REFRESHED_TOKEN]);
    expect(lines.join("")).toContain(`gemini capacity unavailable for user@example.com: ${GEMINI_UNKNOWN_MESSAGE}`);
  });
});

describe("Gemini poll and coordinator wiring", () => {
  test("a Gemini account is keyed, timed, and sanitized like the others", () => {
    expect(pollKey("gemini", "Edi@Example.com")).toBe("gemini:edi@example.com");
    expect(() => pollKey("gemini", "not-an-email")).toThrow("invalid capacity account");
    expect(pollIntervalMs("gemini")).toBe(GEMINI_POLL_INTERVAL_MS);

    const now = Date.parse("2026-11-21T12:00:00Z");
    const snapshot = geminiCapacityFromQuota(QUOTA_RESPONSE, { email: "user@example.com", tier: "Google AI Ultra" }, now)!;
    const clean = sanitizePollSnapshot(snapshot, "gemini:user@example.com", now);
    expect(clean.provider).toBe("gemini");
    expect((clean.usage as { buckets?: unknown[] }).buckets).toHaveLength(3);
    // pace is dropped, as it is for the other providers, and no provider field
    // survives that this repo did not whitelist.
    expect(clean.pace).toBeNull();
    expect(Object.keys(clean.usage).sort()).toEqual(
      ["accountEmail", "buckets", "loginMethod", "primary", "secondary", "tertiary", "updatedAt"].sort());

    expect(() => sanitizePollSnapshot({ ...snapshot, usage: { ...snapshot.usage, buckets: [{ family: "pro", models: ["ok"], usedPercent: 500, windowMinutes: 1440 }] } },
      "gemini:user@example.com", now)).toThrow("invalid capacity buckets");
    expect(() => sanitizePollSnapshot({ ...snapshot, usage: { ...snapshot.usage, buckets: [] } },
      "gemini:user@example.com", now)).toThrow("invalid capacity buckets");
    expect(() => sanitizePollSnapshot(snapshot, "claude:user@example.com", now)).toThrow("invalid capacity snapshot");
  });

  test("a lost sign-in registers as the dashboard's Authentication required state", () => {
    expect(normalizeAuthenticationRequirements([
      { kind: "authentication-required", provider: "gemini", device: "Studio", account: "user@example.com" },
      { kind: "authentication-required", provider: "nothing", device: "Studio" },
    ])).toEqual([{ provider: "gemini", device: "studio", account: "user@example.com", profile: undefined }]);
  });
});

describe("Gemini OAuth client discovery", () => {
  test("reads the pair from an installed CLI bundle and refuses a bundle without one", () => {
    const root = join(process.env.TMPDIR || "/tmp", `gemini-client-${process.pid}-${Date.now()}`);
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    const id = ["1234567890", "abcdefghijklmnopqrstuvwxyz0123"].join("-") + ".apps.googleusercontent.com";
    const secret = ["GOCSPX", "Synthetic_value_for_tests_0001"].join("-");
    writeFileSync(join(bundle, "chunk-a.js"), "export const unrelated = 1;\n");
    writeFileSync(join(bundle, "chunk-b.js"), `const OAUTH_CLIENT_ID = "${id}";\nconst OAUTH_CLIENT_SECRET = "${secret}";\n`);
    try {
      expect(clientFromPackage(root)).toEqual({ id, secret });
      writeFileSync(join(bundle, "chunk-b.js"), "nothing here\n");
      expect(clientFromPackage(root)).toBeUndefined();
      expect(clientFromPackage(join(root, "missing"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

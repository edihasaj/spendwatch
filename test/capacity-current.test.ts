import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capacityResultFromAppServer, codexBinary, paceFor } from "../src/capacity-current";

const HOUR = 3_600_000;

test("prefers the Homebrew Codex CLI over the home-local shim", () => {
  expect(codexBinary("", "/Users/dev", (path) => ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Users/dev/.local/bin/codex"].includes(path)))
    .toBe("/opt/homebrew/bin/codex");
});

test("prefers the Intel macOS Codex CLI over the home-local shim", () => {
  expect(codexBinary("", "/Users/dev", (path) => path === "/usr/local/bin/codex" || path === "/Users/dev/.local/bin/codex"))
    .toBe("/usr/local/bin/codex");
});

test("uses the home-local Codex CLI when no native installation exists", () => {
  expect(codexBinary("", "/Users/dev", (path) => path === "/Users/dev/.local/bin/codex"))
    .toBe("/Users/dev/.local/bin/codex");
});

test("falls back to Codex on PATH when no candidate exists", () => {
  expect(codexBinary("", "/Users/dev", () => false)).toBe("codex");
});

test("uses an explicit Codex binary override", () => {
  expect(codexBinary("/custom/codex", "/Users/dev", () => false)).toBe("/custom/codex");
});

test("uses the generic Codex pool without stitching in model-specific windows", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "alex@example.com", planType: "pro" },
    {
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: now / 1000 + 4 * 24 * 3600 } },
        codex_bengalfox: {
          primary: { usedPercent: 99, windowDurationMins: 300 },
          secondary: { usedPercent: 0, windowDurationMins: 10080 },
        },
      },
    },
    now,
  );
  expect(result?.account).toBe("alex@example.com");
  expect(result?.usage.primary?.usedPercent).toBe(12);
  expect(result?.usage.primary?.windowMinutes).toBe(10080);
  expect(result?.usage.secondary).toBeNull();
  expect(result?.usage.quotaPool).toBe("codex");
  expect(result?.usage.updatedAt).toBe("2026-08-16T10:00:00.000Z");
});

test("chooses one deterministic model-specific Codex pool only when generic and legacy pools are absent", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "dev@example.com", planType: "pro" },
    {
      rateLimitsByLimitId: {
        codex_zebra: { primary: { usedPercent: 90, windowDurationMins: 300 } },
        codex_albatross: {
          primary: { usedPercent: 12, windowDurationMins: 10080 },
          secondary: { usedPercent: 24, windowDurationMins: 300 },
        },
      },
    },
    now,
  );
  expect(result?.usage.quotaPool).toBe("codex_albatross");
  expect(result?.usage.primary).toEqual({ usedPercent: 12, windowMinutes: 10080, resetsAt: undefined });
  expect(result?.usage.secondary).toEqual({ usedPercent: 24, windowMinutes: 300, resetsAt: undefined });
});

test("uses legacy windows as one coherent pool before any model-specific pool", () => {
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "dev@example.com", planType: "pro" },
    {
      rateLimits: { primary: { usedPercent: 33, windowDurationMins: 10080 } },
      rateLimitsByLimitId: { codex_bengalfox: { primary: { usedPercent: 99, windowDurationMins: 10080 } } },
    },
    Date.parse("2026-08-16T10:00:00Z"),
  );
  expect(result?.usage.quotaPool).toBe("legacy");
  expect(result?.usage.primary?.usedPercent).toBe(33);
});

test("keeps a returned five-hour Codex window alongside the weekly window", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "dev@example.com", planType: "pro" },
    {
      rateLimitsByLimitId: {
        codex: {
          // Codex currently returns the weekly window as primary. If the
          // five-hour window is enabled, it arrives as secondary.
          primary: { usedPercent: 12, windowDurationMins: 10080 },
          secondary: { usedPercent: 24, windowDurationMins: 300 },
        },
      },
    },
    now,
  );
  expect(result?.usage.primary?.windowMinutes).toBe(10080);
  expect(result?.usage.secondary?.windowMinutes).toBe(300);
  expect(result?.usage.secondary?.usedPercent).toBe(24);
});

test("does not treat API-key auth or missing windows as subscription capacity", () => {
  expect(capacityResultFromAppServer({ type: "apiKey" }, { rateLimits: {} })).toBeUndefined();
  expect(capacityResultFromAppServer(
    { type: "chatgpt", email: "dev@example.com", planType: "pro" },
    { rateLimits: {} },
  )).toBeUndefined();
});

test("halfway through a window, usage at 50% is exactly on pace", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  const pace = paceFor(
    { usedPercent: 50, windowMinutes: 7 * 24 * 60, resetsAt: new Date(now + 84 * HOUR).toISOString() },
    now,
  )!;
  expect(pace.expectedUsedPercent).toBeCloseTo(50, 5);
  expect(pace.deltaPercent).toBeCloseTo(0, 5);
  expect(pace.willLastToReset).toBe(true);
});

test("a reset further away than the window itself is rejected as inconsistent", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  expect(paceFor({ usedPercent: 10, windowMinutes: 60, resetsAt: new Date(now + 5 * HOUR).toISOString() }, now)).toBeNull();
});

test("purchased credits ride along with the rate-limit snapshot", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const read = (credits: unknown) => capacityResultFromAppServer(
    { type: "chatgpt", email: "alex@example.com", planType: "pro" },
    { rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 10080 }, credits } } },
    now,
  )?.usage.credits;

  // The balance stays a string so a large purchase never loses precision.
  expect(read({ hasCredits: true, unlimited: false, balance: "2000" })).toEqual({ balance: "2000", unlimited: false });
  expect(read({ hasCredits: false, unlimited: true, balance: "0" })).toEqual({ balance: "0", unlimited: true });
  // An empty balance is not worth a card of its own.
  expect(read({ hasCredits: false, unlimited: false, balance: "0" })).toBeNull();
  expect(read(undefined)).toBeNull();
});

test("duplicate Codex homes and repeated CLI calls perform one quota read", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-poll-cli-"));
  const claims = Buffer.from(JSON.stringify({
    email: "same@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
  })).toString("base64url");
  for (const profile of [".codex", ".codex-primary", ".codex-copy"]) {
    mkdirSync(join(home, profile, "sessions"), { recursive: true });
    writeFileSync(join(home, profile, "auth.json"), JSON.stringify({ tokens: { id_token: `test.${claims}.test` } }));
  }
  const binary = join(home, "fake-codex");
  writeFileSync(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result = {};
  if (message.method === "account/read") result = {account:{type:"chatgpt",email:"same@example.com",planType:"pro"}};
  if (message.method === "account/rateLimits/read") {
    appendFileSync(process.env.HOME + "/requests", "quota\\n");
    result = {rateLimits:{primary:{usedPercent:12,windowDurationMins:10080}}};
  }
  console.log(JSON.stringify({id:message.id,result}));
}
`);
  chmodSync(binary, 0o755);
  const run = async () => {
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "capacity-current"], {
      env: { ...process.env, HOME: home, SPENDWATCH_CODEX_BIN: binary,
        SPENDWATCH_CAPACITY_COORDINATOR: "", SPENDWATCH_CAPACITY_CACHE: join(home, "poll.db") },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return JSON.parse(stdout);
  };
  const first = await run();
  const cached = await run();
  expect(first).toHaveLength(1);
  expect(cached[0].usage.updatedAt).toBe(first[0].usage.updatedAt);
  expect(readFileSync(join(home, "requests"), "utf8")).toBe("quota\n");
});

test("CLI reports an unavailable shared coordinator without attempting a provider read", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-coordinator-unavailable-"));
  const claims = Buffer.from(JSON.stringify({
    email: "coordinator@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
  })).toString("base64url");
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: `test.${claims}.test` } }));
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "capacity-current"], {
    env: {
      ...process.env,
      HOME: home,
      SPENDWATCH_CAPACITY_COORDINATOR: "https://spendwatch.example/",
      SPENDWATCH_CAPACITY_CACHE: join(home, "poll.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual([]);
  expect(stderr).toBe(
    "codex capacity unavailable for coordinator@example.com: capacity coordinator unavailable\n",
  );
});

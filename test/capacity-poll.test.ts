import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatorAccessHeaders } from "../src/capacity-coordinator-client";
import {
  CapacityPollStore, CLAUDE_POLL_INTERVAL_MS, CODEX_POLL_INTERVAL_MS, coordinatedCapacity, coordinatorRequest, handleCapacityPoll,
  MAX_FUTURE_SNAPSHOT_SKEW_MS, POLL_INTERVAL_MS, pollIntervalMs, retryAfterMs, sanitizePollSnapshot,
} from "../src/capacity-poll";
import type { CapacityResult } from "../src/capacity-current";

const snapshot: CapacityResult = {
  provider: "codex", account: "dev@example.com", pace: null,
  usage: { accountEmail: "dev@example.com", primary: { usedPercent: 12, windowMinutes: 300 },
    secondary: null, tertiary: null, updatedAt: "2026-10-14T10:00:00Z" },
};

function accessConfig(value: object): string {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-access-")), "cloudflare-access.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test("three machines and duplicate profiles share one reserved attempt per account", () => {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-poll-")), "poll.db");
  const machines = Array.from({ length: 3 }, () => new CapacityPollStore(path));
  try {
    const claims = machines.map((store) => store.claim("codex", "DEV@example.com", 1000));
    expect(claims.filter((claim) => claim.lease)).toHaveLength(1);
    expect(machines[0].claim("claude", "dev@example.com", 1000).lease).toBeDefined();
    expect(machines[1].claim("codex", "other@example.com", 1000).lease).toBeDefined();
    expect(machines[2].claim("codex", "dev@example.com", 1000 + CODEX_POLL_INTERVAL_MS - 1).lease).toBeUndefined();
    expect(machines[2].claim("codex", "dev@example.com", 1000 + CODEX_POLL_INTERVAL_MS).lease).toBeDefined();
  } finally { machines.forEach((store) => store.close()); }
});

test("Codex and Claude retain account-specific collection cadences", () => {
  const store = new CapacityPollStore(":memory:");
  try {
    expect(pollIntervalMs("codex")).toBe(CODEX_POLL_INTERVAL_MS);
    expect(pollIntervalMs("claude")).toBe(CLAUDE_POLL_INTERVAL_MS);
    store.claim("codex", "codex@example.com", 0);
    store.claim("claude", "claude@example.com", 0);
    expect(store.claim("codex", "codex@example.com", CODEX_POLL_INTERVAL_MS).lease).toBeDefined();
    expect(store.claim("claude", "claude@example.com", CODEX_POLL_INTERVAL_MS).lease).toBeUndefined();
  } finally { store.close(); }
});

test("several collectors share one Claude attempt every two minutes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-claude-cadence-")), "poll.db");
  const stores = [new CapacityPollStore(path), new CapacityPollStore(path), new CapacityPollStore(path)];
  const value = { ...snapshot, provider: "claude" as const };
  let reads = 0;
  const options = (store: CapacityPollStore, now: number) => ({ store, coordinator: "", now: () => now });
  const read = async () => { reads++; return value; };
  try {
    await Promise.all(stores.map(store => coordinatedCapacity("claude", value.account, read, options(store, 0))));
    expect(reads).toBe(1);
    const cached = await coordinatedCapacity("claude", value.account, read, options(stores[1], 119_999));
    expect(reads).toBe(1);
    expect(cached?.usage.updatedAt).toBe(value.usage.updatedAt);
    await coordinatedCapacity("claude", value.account, read, options(stores[2], 120_000));
    expect(reads).toBe(2);
  } finally { stores.forEach(store => store.close()); }
});

test("faster Claude cadence retains existing reservations, failure backoff and 429 cooldown", () => {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-claude-backoff-")), "poll.db");
  const first = new CapacityPollStore(path);
  const account = "dev@example.com";
  const key = "claude:" + account;
  const value = { ...snapshot, provider: "claude" as const };
  const old = first.claim("claude", account, 0);
  first.complete("claude", account, old.lease!, { snapshot: value }, 0);
  // Simulate a reservation from the previous five-minute deployment.
  first.db.query("UPDATE capacity_poll SET next_at=? WHERE account_key=?").run(300_000, key);
  first.close();
  const restarted = new CapacityPollStore(path);
  try {
    expect(restarted.claim("claude", account, 120_000).lease).toBeUndefined();
    const attempt = restarted.claim("claude", account, 300_000);
    restarted.complete("claude", account, attempt.lease!, { status: 503 }, 300_000);
    const failed = restarted.claim("claude", account, 420_000);
    expect(failed.lease).toBeUndefined();
    expect(failed.nextAt).toBe(600_000);
    expect(failed.snapshot?.usage.updatedAt).toBe(value.usage.updatedAt);
    const limited = restarted.claim("claude", account, 600_000);
    restarted.complete("claude", account, limited.lease!, { status: 429, retryAfterMs: 3 * 60 * 60_000 }, 600_000);
    expect(restarted.claim("claude", account, 720_000).lease).toBeUndefined();
    expect(restarted.claim("claude", account, 720_000).nextAt).toBe(600_000 + 3 * 60 * 60_000);
  } finally { restarted.close(); }
});

test("a shared 429 cooldown survives restarts and retains the original sample time", () => {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-poll-")), "poll.db");
  let store = new CapacityPollStore(path);
  const success = store.claim("codex", snapshot.account, 0);
  store.complete("codex", snapshot.account, success.lease!, { snapshot }, 1);
  const failed = store.claim("codex", snapshot.account, POLL_INTERVAL_MS);
  store.complete("codex", snapshot.account, failed.lease!, { status: 429, retryAfterMs: 90 * 60_000 }, POLL_INTERVAL_MS);
  store.close();
  store = new CapacityPollStore(path);
  try {
    const denied = store.claim("codex", snapshot.account, POLL_INTERVAL_MS * 2);
    expect(denied.lease).toBeUndefined();
    expect(denied.nextAt).toBe(POLL_INTERVAL_MS + 90 * 60_000);
    expect(denied.snapshot?.usage.updatedAt).toBe(snapshot.usage.updatedAt);
    expect(store.claim("codex", snapshot.account, denied.nextAt).lease).toBeDefined();
  } finally { store.close(); }
});

test("a crashed collector cannot release a newer lease or bypass the attempt interval", () => {
  const store = new CapacityPollStore(":memory:");
  try {
    const old = store.claim("codex", snapshot.account, 0);
    expect(store.claim("codex", snapshot.account, 1).lease).toBeUndefined();
    const next = store.claim("codex", snapshot.account, POLL_INTERVAL_MS);
    expect(store.complete("codex", snapshot.account, old.lease!, { snapshot }, POLL_INTERVAL_MS + 1)).toBe(false);
    expect(store.complete("codex", snapshot.account, next.lease!, { snapshot }, POLL_INTERVAL_MS + 1)).toBe(true);
    expect(store.complete("codex", snapshot.account, next.lease!, { snapshot }, POLL_INTERVAL_MS + 2)).toBe(false);
  } finally { store.close(); }
});

test("cache hits make no provider request and coordinator outages fail closed", async () => {
  const store = new CapacityPollStore(":memory:");
  let reads = 0;
  try {
    const read = async () => { reads++; return snapshot; };
    await coordinatedCapacity("codex", snapshot.account, read, { store, coordinator: "", now: () => 0 });
    const cached = await coordinatedCapacity("codex", snapshot.account, read, { store, coordinator: "", now: () => 1 });
    expect(cached?.usage.updatedAt).toBe(snapshot.usage.updatedAt);
    await coordinatedCapacity("codex", snapshot.account, read, { store, coordinator: "http://127.0.0.1:1", now: () => POLL_INTERVAL_MS + 1 });
    expect(reads).toBe(1);
  } finally { store.close(); }
});

test("coordinator service credentials are pinned to its exact HTTPS origin", () => {
  const path = accessConfig({
    origin: "https://spendwatch.example/",
    client_id: "client-id",
    client_secret: "client-secret",
  });
  expect(coordinatorAccessHeaders("https://spendwatch.example/", path)).toEqual({
    "CF-Access-Client-Id": "client-id",
    "CF-Access-Client-Secret": "client-secret",
  });
  expect(() => coordinatorAccessHeaders("https://other.example/", path)).toThrow(
    "capacity coordinator origin is not trusted",
  );
  expect(() => coordinatorAccessHeaders("http://spendwatch.example/", path)).toThrow(
    "invalid capacity coordinator",
  );
  expect(() => coordinatorAccessHeaders("https://*.example/", path)).toThrow(
    "invalid capacity coordinator",
  );
  expect(() => coordinatorAccessHeaders("https://spendwatch.example/not-an-origin", path)).toThrow(
    "invalid capacity coordinator",
  );
});

test("coordinator request sends Access headers and refuses redirects", async () => {
  const path = accessConfig({
    origin: "https://spendwatch.example/",
    client_id: "client-id",
    client_secret: "client-secret",
  });
  let seen: { url?: URL; init?: RequestInit } = {};
  const request: typeof fetch = async (input, init) => {
    seen = { url: new URL(String(input)), init };
    if (init?.redirect !== "error") throw new Error("redirect policy missing");
    throw new TypeError("unexpected redirect");
  };
  await expect(coordinatorRequest("https://spendwatch.example/", "claim", {}, {
    accessConfigPath: path, fetch: request,
  })).rejects.toThrow("unexpected redirect");
  expect(seen.url?.origin).toBe("https://spendwatch.example");
  expect(seen.init?.redirect).toBe("error");
  expect(new Headers(seen.init?.headers).get("CF-Access-Client-Id")).toBe("client-id");
  expect(new Headers(seen.init?.headers).get("CF-Access-Client-Secret")).toBe("client-secret");
});

test("bad coordinator responses fail visibly without a cache or a local lease", async () => {
  const store = new CapacityPollStore(":memory:");
  const path = accessConfig({
    origin: "https://spendwatch.example/",
    client_id: "client-id",
    client_secret: "client-secret",
  });
  let reads = 0;
  try {
    await expect(coordinatedCapacity("codex", snapshot.account, async () => {
      reads++;
      return snapshot;
    }, {
      store,
      coordinator: "https://spendwatch.example/",
      accessConfigPath: path,
      fetch: async () => new Response("not json"),
      now: () => 0,
    })).rejects.toThrow("capacity coordinator unavailable");
    expect(reads).toBe(0);
    expect(store.claim("codex", snapshot.account, 0).lease).toBeDefined();
  } finally { store.close(); }
});

test("coordinator outage returns only a read-only local cache", async () => {
  const store = new CapacityPollStore(":memory:");
  const path = accessConfig({
    origin: "https://spendwatch.example/",
    client_id: "client-id",
    client_secret: "client-secret",
  });
  let reads = 0;
  try {
    const localClaim = store.claim("codex", snapshot.account, 0);
    store.complete("codex", snapshot.account, localClaim.lease!, { snapshot }, 0);
    const cached = await coordinatedCapacity("codex", snapshot.account, async () => {
      reads++;
      return snapshot;
    }, {
      store,
      coordinator: "https://spendwatch.example/",
      accessConfigPath: path,
      fetch: async () => { throw new TypeError("network down"); },
      now: () => POLL_INTERVAL_MS + 1,
    });
    expect(cached?.usage.updatedAt).toBe(snapshot.usage.updatedAt);
    expect(reads).toBe(0);
    // A fallback read must not reserve/replace a lease that has become due.
    expect(store.claim("codex", snapshot.account, POLL_INTERVAL_MS + 1).lease).toBeDefined();
  } finally { store.close(); }
});

test("a coordinator result is cached without replacing a local lease or attempting outage reads", async () => {
  const store = new CapacityPollStore(":memory:");
  const path = accessConfig({
    origin: "https://spendwatch.example/",
    client_id: "client-id",
    client_secret: "client-secret",
  });
  const now = Date.parse("2026-10-14T10:00:00Z");
  const fresh = { ...snapshot, usage: { ...snapshot.usage, updatedAt: new Date(now).toISOString() } };
  const local = store.claim("codex", snapshot.account, now);
  let providerReads = 0;
  let action = "";
  const fetch: typeof globalThis.fetch = async (input) => {
    action = new URL(String(input)).pathname.split("/").at(-1)!;
    return Response.json(action === "claim"
      ? { lease: "remote-lease", nextAt: now + CODEX_POLL_INTERVAL_MS }
      : { ok: true });
  };
  try {
    await coordinatedCapacity("codex", snapshot.account, async () => {
      providerReads++;
      return fresh;
    }, {
      store, coordinator: "https://spendwatch.example/", accessConfigPath: path, fetch, now: () => now,
    });
    expect(providerReads).toBe(1);
    expect(action).toBe("complete");
    // A local lease due later remains owned by its original caller.
    expect(store.complete("codex", snapshot.account, local.lease!, { snapshot: fresh }, now)).toBe(true);

    const cached = await coordinatedCapacity("codex", snapshot.account, async () => {
      providerReads++;
      return fresh;
    }, {
      store, coordinator: "https://spendwatch.example/", accessConfigPath: path,
      fetch: async () => { throw new TypeError("network down"); }, now: () => now + 1,
    });
    expect(cached?.usage.updatedAt).toBe(fresh.usage.updatedAt);
    expect(providerReads).toBe(1);
  } finally { store.close(); }
});

test("rejects materially future snapshots while allowing bounded clock skew", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");
  const nearFuture = {
    ...snapshot,
    usage: { ...snapshot.usage, updatedAt: new Date(now + MAX_FUTURE_SNAPSHOT_SKEW_MS).toISOString(), quotaPool: "codex_bengalfox" },
  };
  expect(sanitizePollSnapshot(nearFuture, "codex:dev@example.com", now).usage.quotaPool).toBe("codex_bengalfox");
  const future = {
    ...nearFuture,
    usage: { ...nearFuture.usage, updatedAt: new Date(now + MAX_FUTURE_SNAPSHOT_SKEW_MS + 1).toISOString() },
  };
  expect(() => sanitizePollSnapshot(future, "codex:dev@example.com", now)).toThrow("invalid capacity snapshot");
});

test("keeps valid Claude credit blocks and drops malformed ones without losing windows", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");
  const claude = {
    provider: "claude",
    account: "claude@example.com",
    pace: null,
    usage: {
      accountEmail: "claude@example.com",
      primary: { usedPercent: 12, windowMinutes: 300 },
      secondary: null,
      tertiary: null,
      updatedAt: new Date(now).toISOString(),
      cloudCredits: { limitUsd: 300, remainingUsd: 215, expiresAt: "2026-11-01T00:00:00.000Z" },
      extraUsage: { usedAmount: 12.34, limitAmount: 50, currency: "USD" },
    },
  };
  const valid = sanitizePollSnapshot(claude, "claude:claude@example.com", now);
  expect(valid.usage).toMatchObject({
    primary: { usedPercent: 12, windowMinutes: 300 },
    cloudCredits: { limitUsd: 300, remainingUsd: 215 },
    extraUsage: { usedAmount: 12.34, limitAmount: 50, currency: "USD" },
  });

  const malformed = sanitizePollSnapshot({
    ...claude,
    usage: {
      ...claude.usage,
      cloudCredits: { limitUsd: "300", remainingUsd: 215, expiresAt: "not-a-date" },
      extraUsage: { usedAmount: -1, limitAmount: 50, currency: "USD" },
    },
  }, "claude:claude@example.com", now);
  expect(malformed.usage.primary).toEqual({ usedPercent: 12, windowMinutes: 300, resetsAt: undefined });
  expect(malformed.usage).not.toHaveProperty("cloudCredits");
  expect(malformed.usage).not.toHaveProperty("extraUsage");

  const zeroLimit = sanitizePollSnapshot({
    ...claude,
    usage: { ...claude.usage, cloudCredits: { limitUsd: 0, remainingUsd: 0 } },
  }, "claude:claude@example.com", now);
  expect(zeroLimit.usage.primary).not.toBeNull();
  expect(zeroLimit.usage).not.toHaveProperty("cloudCredits");

  const invalidExpiryAndCurrency = sanitizePollSnapshot({
    ...claude,
    usage: {
      ...claude.usage,
      cloudCredits: { limitUsd: 300, remainingUsd: 215, expiresAt: "not-a-date" },
      extraUsage: { usedAmount: 12.34, limitAmount: 50, currency: "US" },
    },
  }, "claude:claude@example.com", now);
  expect(invalidExpiryAndCurrency.usage).toMatchObject({
    cloudCredits: { limitUsd: 300, remainingUsd: 215 },
  });
  expect(invalidExpiryAndCurrency.usage.cloudCredits).not.toHaveProperty("expiresAt");
  expect(invalidExpiryAndCurrency.usage).not.toHaveProperty("extraUsage");
});

test("three HTTP clients receive one grant, share the result, and do not store credentials", async () => {
  const store = new CapacityPollStore(":memory:");
  const server = Bun.serve({ port: 0, fetch: (request) => handleCapacityPoll(request, store) });
  const request = async (action: string, body: unknown) => {
    const response = await fetch(new URL(`/api/capacity/poll/${action}`, server.url), {
      method: "POST", body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { lease?: string; snapshot?: CapacityResult } };
  };
  try {
    const identity = { provider: snapshot.provider, account: snapshot.account };
    const clients = await Promise.all(Array.from({ length: 3 }, () => request("claim", identity)));
    expect(clients.filter((client) => client.body.lease)).toHaveLength(1);
    const lease = clients.find((client) => client.body.lease)!.body.lease;
    expect((await request("complete", { ...identity, lease, snapshot: { ...snapshot, token: "must-not-persist" } })).status).toBe(200);
    const cached = await request("claim", identity);
    expect(cached.body.snapshot?.usage.primary?.usedPercent).toBe(12);
    expect(JSON.stringify(cached.body)).not.toContain("must-not-persist");
    expect((await request("complete", { ...identity, lease, snapshot: { ...snapshot, account: "other@example.com" } })).status).toBe(400);
  } finally { server.stop(true); store.close(); }
});

test("Retry-After accepts seconds and HTTP dates", () => {
  expect(retryAfterMs("3600", 0)).toBe(3_600_000);
  expect(retryAfterMs("Thu, 01 Jan 1970 01:00:00 GMT", 0)).toBe(3_600_000);
  expect(retryAfterMs("garbage", 0)).toBeUndefined();
});

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapacityPollStore, coordinatedCapacity, handleCapacityPoll, POLL_INTERVAL_MS, retryAfterMs } from "../src/capacity-poll";
import type { CapacityResult } from "../src/capacity-current";

const snapshot: CapacityResult = {
  provider: "codex", account: "edi@example.com", pace: null,
  usage: { accountEmail: "edi@example.com", primary: { usedPercent: 12, windowMinutes: 300 },
    secondary: null, tertiary: null, updatedAt: "2026-10-14T10:00:00Z" },
};

test("three machines and duplicate profiles share one reserved attempt per account", () => {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-poll-")), "poll.db");
  const machines = Array.from({ length: 3 }, () => new CapacityPollStore(path));
  try {
    const claims = machines.map((store) => store.claim("codex", "EDI@example.com", 1000));
    expect(claims.filter((claim) => claim.lease)).toHaveLength(1);
    expect(machines[0].claim("claude", "edi@example.com", 1000).lease).toBeDefined();
    expect(machines[1].claim("codex", "other@example.com", 1000).lease).toBeDefined();
    expect(machines[2].claim("codex", "edi@example.com", 1000 + POLL_INTERVAL_MS - 1).lease).toBeUndefined();
    expect(machines[2].claim("codex", "edi@example.com", 1000 + POLL_INTERVAL_MS).lease).toBeDefined();
  } finally { machines.forEach((store) => store.close()); }
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

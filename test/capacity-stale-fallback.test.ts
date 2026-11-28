import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapacityPollStore, coordinatedCapacity, STALE_SNAPSHOT_MS } from "../src/capacity-poll";
import { firstReadableHome, type CapacityResult } from "../src/capacity-current";

// The snapshot allowlist checks the real clock, so the fixtures follow it.
const now = Date.now();
const at = (ms: number): CapacityResult => ({
  provider: "codex", account: "dev@example.com", pace: null,
  usage: { accountEmail: "dev@example.com", primary: { usedPercent: 12, windowMinutes: 300 },
    secondary: null, tertiary: null, updatedAt: new Date(ms).toISOString() },
});

function accessConfig(): string {
  const path = join(mkdtempSync(join(tmpdir(), "capacity-stale-")), "cloudflare-access.json");
  writeFileSync(path, JSON.stringify({ origin: "https://spendwatch.example/", client_id: "id", client_secret: "secret" }), { mode: 0o600 });
  return path;
}

// A coordinator stuck in backoff: never a lease, always the same old snapshot.
function frozen(snapshot: CapacityResult) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(new URL(String(input)).pathname.split("/").at(-1)!);
    return Response.json({ nextAt: now + 3_600_000, snapshot });
  };
  return { calls, fetch };
}

test("a fresh shared snapshot without a lease is returned without a direct read", async () => {
  const store = new CapacityPollStore(":memory:");
  const { fetch } = frozen(at(now - STALE_SNAPSHOT_MS + 1));
  let reads = 0;
  try {
    const value = await coordinatedCapacity("codex", "dev@example.com", async () => { reads++; return at(now); },
      { store, coordinator: "https://spendwatch.example/", accessConfigPath: accessConfig(), fetch, now: () => now });
    expect(reads).toBe(0);
    expect(value?.usage.updatedAt).toBe(new Date(now - STALE_SNAPSHOT_MS + 1).toISOString());
  } finally { store.close(); }
});

test("a stale shared snapshot is read directly once per window and the newer reading is kept", async () => {
  const store = new CapacityPollStore(":memory:");
  const old = at(now - 20 * 3_600_000);
  const { calls, fetch } = frozen(old);
  const options = (time: number) => ({ store, coordinator: "https://spendwatch.example/", accessConfigPath: accessConfig(), fetch, now: () => time });
  let reads = 0;
  const read = async () => { reads++; return at(now); };
  try {
    const first = await coordinatedCapacity("codex", "dev@example.com", read, options(now));
    expect(reads).toBe(1);
    expect(first?.usage.updatedAt).toBe(new Date(now).toISOString());
    // The shared lease is never completed by a direct read.
    expect(calls).toEqual(["claim"]);
    // The stale shared snapshot must not overwrite the newer local reading.
    const again = await coordinatedCapacity("codex", "dev@example.com", read, options(now + 60_000));
    expect(reads).toBe(1);
    expect(again?.usage.updatedAt).toBe(new Date(now).toISOString());
    expect(store.cached("codex", "dev@example.com")?.usage.updatedAt).toBe(new Date(now).toISOString());
  } finally { store.close(); }
});

test("a failed direct read keeps the shared snapshot and a rate limit defers the next one", async () => {
  const store = new CapacityPollStore(":memory:");
  const old = at(now - 20 * 3_600_000);
  const { fetch } = frozen(old);
  const options = (time: number) => ({ store, coordinator: "https://spendwatch.example/", accessConfigPath: accessConfig(), fetch, now: () => time });
  let reads = 0;
  const limited = async (): Promise<CapacityResult> => { reads++; throw Object.assign(new Error("rate limited"), { status: 429 }); };
  try {
    expect((await coordinatedCapacity("codex", "dev@example.com", limited, options(now)))?.usage.updatedAt)
      .toBe(old.usage.updatedAt);
    // Past the normal window but inside the rate-limit cooldown: no new read.
    await coordinatedCapacity("codex", "dev@example.com", limited, options(now + STALE_SNAPSHOT_MS + 1));
    expect(reads).toBe(1);
  } finally { store.close(); }
});

test("a home that fails falls back to another home signed in to the same email", async () => {
  const tried: string[] = [];
  const value = await firstReadableHome(["/h/.codex", "/h/.codex-primary"], async (home) => {
    tried.push(home);
    if (home === "/h/.codex") throw new Error("refresh token revoked");
    return at(now);
  });
  expect(tried).toEqual(["/h/.codex", "/h/.codex-primary"]);
  expect(value?.usage.updatedAt).toBe(new Date(now).toISOString());
});

test("a healthy first home costs one read and a rate limit stops the fallback", async () => {
  let reads = 0;
  await firstReadableHome(["/a", "/b"], async () => { reads++; return at(now); });
  expect(reads).toBe(1);
  reads = 0;
  await expect(firstReadableHome(["/a", "/b"], async () => {
    reads++; throw Object.assign(new Error("slow down"), { status: 429 });
  })).rejects.toMatchObject({ status: 429 });
  expect(reads).toBe(1);
});

test("opening the shared poll store creates no direct-read table", () => {
  const store = new CapacityPollStore(":memory:");
  const tables = () => store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  try {
    expect(tables()).not.toContain("capacity_direct");
    expect(store.claimDirect("codex", "dev@example.com", 0)).toBe(true);
    expect(tables()).toContain("capacity_direct");
  } finally { store.close(); }
});

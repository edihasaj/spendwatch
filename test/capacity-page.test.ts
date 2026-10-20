import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCapacitySnapshot } from "../src/capacity-db";
import { createCapacityPageRenderer } from "../src/capacity-page";
import { CapacityPollStore } from "../src/capacity-poll";
import { tempDir } from "./tmp";

function providerSnapshot(provider: "codex" | "claude", email: string, usedPercent: number, updatedAt: number) {
  return {
    provider, account: email, pace: null,
    usage: {
      accountEmail: email, loginMethod: provider === "codex" ? "pro" : "max",
      primary: { usedPercent, windowMinutes: 300, resetsAt: new Date(updatedAt + 4 * 60 * 60_000).toISOString() },
      secondary: { usedPercent, windowMinutes: 10080, resetsAt: new Date(updatedAt + 6 * 24 * 60 * 60_000).toISOString() },
      tertiary: null, updatedAt: new Date(updatedAt).toISOString(),
    },
    devices: ["studio"],
  };
}

function localQwen(updatedAt: number) {
  return {
    provider: "qwen", account: "Local Qwen", sourceDevice: "studio",
    usage: { accountEmail: "Local Qwen", loginMethod: "self-hosted", updatedAt: new Date(updatedAt).toISOString() },
    local: { unlimited: true, model: "qwen3.8-flash-next", detail: "Spark route" },
    spend: { recentUsd: 0, recentTokens: 12, recentHours: 24, monthUsd: 0, monthTokens: 34, monthDays: 30 },
  };
}

function storeSnapshot(store: CapacityPollStore, snapshot: ReturnType<typeof providerSnapshot>, now: number) {
  const claim = store.claim(snapshot.provider, snapshot.account, now);
  store.complete(snapshot.provider, snapshot.account, claim.lease!, { snapshot }, now);
}

test("a stored page ages out without collection, and a new snapshot restores it", () => {
  const dir = tempDir("spendwatch-page-");
  const input = join(dir, "limits.json");
  const database = join(dir, "capacity.db");
  const sampledAt = Date.parse("2026-10-12T10:51:00Z");
  const account = {
    provider: "claude",
    account: "work@example.com",
    usage: {
      accountEmail: "work@example.com",
      loginMethod: "max",
      updatedAt: new Date(sampledAt).toISOString(),
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: "2026-10-12T12:10:00Z" },
      secondary: { usedPercent: 67, windowMinutes: 10080, resetsAt: "2026-10-14T10:00:00Z" },
    },
  };
  writeFileSync(input, JSON.stringify([account]));
  writeCapacitySnapshot(database, [], { collectedAt: sampledAt });
  const render = createCapacityPageRenderer(input, database);
  const snapshotTime = new Date(statSync(input).mtimeMs).toISOString();
  const live = render(sampledAt);
  expect(live).toContain("<strong>23% used</strong>");
  expect(live).toContain('aria-label="5-hour window utilization"');
  expect(live).not.toContain("Best now");

  const stale = render(sampledAt + 16 * 60_000);
  expect(stale).toContain("<strong>Not current</strong>");
  expect(stale).not.toContain("<strong>23% used</strong>");

  const expired = render(Date.parse("2026-10-12T15:30:00Z"));
  expect(expired).toContain("<strong>Cycle ended</strong>");
  expect(expired).toContain("Last read 77% left");
  expect(expired).toContain("<strong>Not current</strong>");
  expect(expired).toContain("Collector has not refreshed this account");
  expect(expired).not.toContain("Lasts until reset");
  expect(expired).not.toContain("session quotas left");
  expect(expired).toContain(`data-generated="${snapshotTime}"`);
  expect(expired).toContain("view sync 15s; collection is separate");

  account.usage.updatedAt = "2026-10-12T15:30:00Z";
  account.usage.primary.usedPercent = 100;
  account.usage.primary.resetsAt = "2026-10-12T17:10:00Z";
  writeFileSync(input, JSON.stringify([account]));
  const current = render(Date.parse(account.usage.updatedAt));
  expect(current).toContain("<strong>100% used</strong>");
  expect(current).not.toContain("<strong>Cycle ended</strong>");
  expect(current).not.toContain("<strong>Not current</strong>");
});

test("HTTP capacity requests never serve the frozen static export", async () => {
  const dir = tempDir("spendwatch-page-http-");
  const input = join(dir, "limits.json");
  const database = join(dir, "capacity.db");
  const publicDir = join(dir, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), "<strong>77% left</strong>");
  writeFileSync(join(publicDir, "history.html"), "stored history");
  writeFileSync(input, JSON.stringify([{
    provider: "claude",
    account: "work@example.com",
    usage: {
      accountEmail: "work@example.com",
      loginMethod: "max",
      updatedAt: "2026-08-01T10:00:00Z",
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: "2026-08-01T12:00:00Z" },
    },
  }]));
  writeCapacitySnapshot(database, [], { collectedAt: Date.now() });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, "src/cli.ts", "server", "--input", input,
    "--sqlite", database, "--public-dir", publicDir, "--host", "127.0.0.1",
    "--port", String(port), "--vapid-subject", "mailto:operator@example.com"], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore",
    env: { ...process.env, SPENDWATCH_SENTRY_DSN: "" },
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${origin}/api/push/config`)).ok;
        if (ready) break;
      } catch {}
      await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<strong>Cycle ended</strong>");
      expect(html).not.toContain("<strong>77% left</strong>");
    }
    const head = await fetch(origin, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(await (await fetch(`${origin}/history.html`)).text()).toBe("stored history");
    expect((await fetch(origin, { method: "POST" })).status).toBe(405);
    // A damaged snapshot must not silently fall back to the misleading export.
    writeFileSync(input, "{");
    expect((await fetch(origin)).status).toBe(500);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("a newer authenticated coordinator snapshot overlays an existing account without changing the source file", () => {
  const dir = tempDir("spendwatch-page-poll-");
  const input = join(dir, "limits.json");
  const database = join(dir, "capacity.db");
  const now = Date.now();
  const fileRows = [
    providerSnapshot("codex", "alpha@example.com", 20, now - 60_000),
    providerSnapshot("codex", "work@example.com", 10, now - 60_000),
    localQwen(now - 60_000),
  ];
  writeFileSync(input, JSON.stringify(fileRows));
  writeCapacitySnapshot(database, [], { collectedAt: now });
  const store = new CapacityPollStore(database);
  try {
    storeSnapshot(store, providerSnapshot("codex", "work@example.com", 30, now), now);
  } finally { store.close(); }

  const html = createCapacityPageRenderer(input, database)(now);

  expect(html).toContain("<strong>30% used</strong>");
  expect(html).not.toContain("<strong>10% used</strong>");
  expect(html).toContain("Codex Secondary");
  expect(html).toContain("Local Qwen");
  expect(JSON.parse(readFileSync(input, "utf8"))).toEqual(fileRows);
});

test("old, future, invalid, and unknown coordinator rows never replace or create cards", () => {
  const dir = tempDir("spendwatch-page-poll-invalid-");
  const input = join(dir, "limits.json");
  const database = join(dir, "capacity.db");
  const now = Date.now();
  const fileRows = [
    providerSnapshot("codex", "old@example.com", 10, now - 60_000),
    providerSnapshot("claude", "future@example.com", 15, now - 60_000),
    localQwen(now - 60_000),
  ];
  writeFileSync(input, JSON.stringify(fileRows));
  writeCapacitySnapshot(database, [], { collectedAt: now });
  const store = new CapacityPollStore(database);
  try {
    storeSnapshot(store, providerSnapshot("codex", "old@example.com", 90, now - 120_000), now);
    storeSnapshot(store, providerSnapshot("claude", "future@example.com", 99, now + 60_000), now);
    storeSnapshot(store, providerSnapshot("codex", "unknown@example.com", 80, now), now);
    store.db.query(`INSERT INTO capacity_poll(account_key,next_at,lease,failures,snapshot) VALUES(?,?, '',0,?)`)
      .run("codex:invalid@example.com", 0, "not-json");
  } finally { store.close(); }

  const html = createCapacityPageRenderer(input, database)(now);

  expect(html).toContain("<strong>10% used</strong>");
  expect(html).toContain("<strong>15% used</strong>");
  expect(html).not.toContain("<strong>90% used</strong>");
  expect(html).not.toContain("<strong>99% used</strong>");
  expect(html).not.toContain("unknown@example.com");
  expect(html).toContain("Local Qwen");
});

test("a valid newer coordinator row repairs an existing account with no source timestamp", () => {
  const dir = tempDir("spendwatch-page-poll-missing-time-");
  const input = join(dir, "limits.json");
  const database = join(dir, "capacity.db");
  const now = Date.now();
  const source = providerSnapshot("codex", "work@example.com", 10, now - 60_000);
  delete (source.usage as { updatedAt?: string }).updatedAt;
  writeFileSync(input, JSON.stringify([source]));
  writeCapacitySnapshot(database, [], { collectedAt: now });
  const store = new CapacityPollStore(database);
  try {
    storeSnapshot(store, providerSnapshot("codex", "work@example.com", 30, now), now);
  } finally { store.close(); }

  const html = createCapacityPageRenderer(input, database)(now);

  expect(html).toContain("<strong>30% used</strong>");
});

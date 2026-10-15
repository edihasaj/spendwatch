import { expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCapacitySnapshot } from "../src/capacity-db";
import { createCapacityPageRenderer } from "../src/capacity-page";
import { tempDir } from "./tmp";

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
  expect(render(sampledAt)).toContain("<strong>77% left</strong>");

  const stale = render(sampledAt + 16 * 60_000);
  expect(stale).toContain("<strong>Not current</strong>");
  expect(stale).not.toContain("<strong>77% left</strong>");

  const expired = render(Date.parse("2026-10-12T15:30:00Z"));
  expect(expired).toContain("<strong>Cycle ended</strong>");
  expect(expired).toContain("Last read 77% left");
  expect(expired).toContain("<strong>Not current</strong>");
  expect(expired).toContain("Reading is not current");
  expect(expired).not.toContain("Lasts until reset");
  expect(expired).not.toContain("session quotas left");
  expect(expired).toContain(`data-generated="${snapshotTime}"`);
  expect(expired).toContain("view sync 15s; collection is separate");

  account.usage.updatedAt = "2026-10-12T15:30:00Z";
  account.usage.primary.usedPercent = 100;
  account.usage.primary.resetsAt = "2026-10-12T17:10:00Z";
  writeFileSync(input, JSON.stringify([account]));
  const current = render(Date.parse(account.usage.updatedAt));
  expect(current).toContain("<strong>0% left</strong>");
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

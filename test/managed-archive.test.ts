import { describe, expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { Database } from "../src/database";
import { writeCapacitySnapshot, loadCapacityHistory } from "../src/capacity-db";
import { archiveCapacityHistory, restoreCapacityArchive } from "../src/capacity-archive";
import { archiveFingerprints } from "../src/managed/archive-snapshot";

const adminPath = process.env.SPENDWATCH_TEST_PG_CONFIG;
const suite = adminPath ? describe : describe.skip;
const now = Date.parse("2026-10-16T00:00:00Z"), cutoff = Date.parse("2026-06-01T00:00:00Z");
async function fixture(run: (path: string, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-managed-archive-"));
  const options = JSON.parse(readFileSync(adminPath!, "utf8")) as Record<string, string>;
  if (options.host !== "127.0.0.1" || options.port !== "15487" || options.dbname !== "postgres") {
    throw new Error("Archive tests require the isolated loopback fixture");
  }
  const name = "spendwatch_test_" + randomBytes(8).toString("hex");
  const admin = new PgConnection(options);
  try { admin.query("CREATE DATABASE " + quoteIdentifier(name)); } finally { admin.close(); }
  const path = join(root, "remote.db"), config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ path, connection: { ...options, dbname: name }, localFixture: true }), { mode: 0o600 });
  const keys = ["SPENDWATCH_MANAGED_DATABASE_CONFIG", "SPENDWATCH_ARCHIVE_COMMIT_URL", "SPENDWATCH_ARCHIVE_COMMIT_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = config;
  delete process.env.SPENDWATCH_ARCHIVE_COMMIT_URL;
  delete process.env.SPENDWATCH_ARCHIVE_COMMIT_TOKEN;
  try {
    for (const at of ["2025-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]) {
      writeCapacitySnapshot(path, [{
        provider: "codex", email: "fixture@example.test", plan: "Pro", devices: ["fixture"],
        updatedAt: at,
        session: { usedPercent: 25.125, windowMinutes: 300 },
        weekly: { usedPercent: 30.25, windowMinutes: 10080 },
      }], { collectedAt: Date.parse(at) });
    }
    await run(path, root);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    });
  }
}
suite("managed history archives", () => {
  test("requires a durable independent copy before deleting any live rows", async () => {
    await fixture(async (database, root) => {
      await expect(archiveCapacityHistory({ database, archiveDir: join(root, "archives"),
        force: true, before: cutoff, now })).rejects.toThrow("durable archive transport");
      expect(loadCapacityHistory(database, now).sampleCount).toBe(6);
    });
  });

  test("verifies compressed bytes and row fingerprints, then restores idempotently", async () => {
    await fixture(async (database, root) => {
      let persisted = false;
      const token = "fixture-archive-capability-".repeat(3);
      const supervisor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer " + token);
        const body = new Uint8Array(await request.arrayBuffer());
        const sha256 = createHash("sha256").update(body).digest("hex");
        expect(sha256).toBe(request.headers.get("X-Spendwatch-SHA256"));
        const independent = join(root, "independently-restored.db");
        writeFileSync(independent, Bun.gunzipSync(body));
        expect([...archiveFingerprints(independent).values()].map((proof) => proof.rowCount)).toEqual([2, 1]);
        persisted = true;
        return Response.json({ durable: true, bytes: body.byteLength, sha256 });
      } });
      process.env.SPENDWATCH_ARCHIVE_COMMIT_URL = String(supervisor.url);
      process.env.SPENDWATCH_ARCHIVE_COMMIT_TOKEN = token;
      try {
        const result = await archiveCapacityHistory({ database, archiveDir: join(root, "archives"),
          force: true, before: cutoff, now });
        expect(persisted).toBe(true);
        expect(result.deleted).toEqual({ windows: 2, accounts: 1 });
        expect(loadCapacityHistory(database, now).sampleCount).toBe(3);
        expect(await restoreCapacityArchive(database, result.archive!)).toEqual({
          archive: result.archive!, windows: 2, accounts: 1,
        });
        expect(await restoreCapacityArchive(database, result.archive!)).toEqual({
          archive: result.archive!, windows: 0, accounts: 0,
        });
        expect(loadCapacityHistory(database, now).sampleCount).toBe(6);
      } finally { supervisor.stop(true); }
    });
  });

  test("rolls pruning back if an archived value changes after the snapshot", async () => {
    await fixture(async (database, root) => {
      const supervisor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = new Uint8Array(await request.arrayBuffer());
        const db = new Database(database);
        try { db.run("UPDATE capacity_history SET used_percent=77 WHERE sampled_at_ms < ?", cutoff); }
        finally { db.close(); }
        return Response.json({ durable: true, bytes: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex") });
      } });
      process.env.SPENDWATCH_ARCHIVE_COMMIT_URL = String(supervisor.url);
      process.env.SPENDWATCH_ARCHIVE_COMMIT_TOKEN = "fixture-archive-capability-".repeat(3);
      try {
        await expect(archiveCapacityHistory({ database, archiveDir: join(root, "archives"),
          force: true, before: cutoff, now })).rejects.toThrow("pruning was rolled back");
        expect(loadCapacityHistory(database, now).sampleCount).toBe(6);
      } finally { supervisor.stop(true); }
    });
  });
});

/** Run against the isolated loopback database and a real offsite supervisor. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { writeCapacitySnapshot, loadCapacityHistory } from "../src/capacity-db";
import { archiveCapacityHistory, restoreCapacityArchive } from "../src/capacity-archive";

const options = JSON.parse(readFileSync(process.env.SPENDWATCH_TEST_PG_CONFIG!, "utf8"));
const supervisor = new URL(process.env.SPENDWATCH_ARCHIVE_COMMIT_URL!);
if (options.host !== "127.0.0.1" || options.port !== "15487" || options.dbname !== "postgres"
  || supervisor.hostname !== "127.0.0.1" || supervisor.protocol !== "http:") {
  throw new Error("Qualification requires the isolated loopback database and supervisor");
}
const root = mkdtempSync(join(tmpdir(), "spendwatch-offsite-archive-"));
const name = "spendwatch_test_r2_" + randomBytes(8).toString("hex");
const admin = new PgConnection(options);
try { admin.query("CREATE DATABASE " + quoteIdentifier(name)); } finally { admin.close(); }
const database = join(root, "managed.db"), config = join(root, "database.json");
writeFileSync(config, JSON.stringify({
  path: database, connection: { ...options, dbname: name }, localFixture: true,
}), { mode: 0o600 });
process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = config;
for (const at of ["2025-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]) {
  writeCapacitySnapshot(database, [{
    provider: "codex", email: "fixture@example.test", plan: "Pro", devices: ["fixture"],
    updatedAt: at, session: { usedPercent: 25.125, windowMinutes: 300 },
    weekly: { usedPercent: 30.25, windowMinutes: 10080 },
  }], { collectedAt: Date.parse(at) });
}
const now = Date.parse("2026-10-16T00:00:00Z");
const archived = await archiveCapacityHistory({
  database, archiveDir: join(root, "archives"), force: true,
  before: Date.parse("2026-06-01T00:00:00Z"), now,
});
if (archived.deleted.windows !== 2 || archived.deleted.accounts !== 1
  || loadCapacityHistory(database, now).sampleCount !== 3) throw new Error("Archive pruning differs");
// The supervisor returns the independently downloaded R2 object, rather than
// using the local file that was just uploaded.
const returned = process.env.SPENDWATCH_RETURNED_ARCHIVE!;
const restored = await restoreCapacityArchive(database, returned);
const duplicate = await restoreCapacityArchive(database, returned);
if (restored.windows !== 2 || restored.accounts !== 1 || duplicate.windows !== 0
  || duplicate.accounts !== 0 || loadCapacityHistory(database, now).sampleCount !== 6) {
  throw new Error("Actual offsite archive did not restore idempotently");
}
console.log(JSON.stringify({
  database: name, rows_before: 6, pruned: archived.deleted,
  restored_from_actual_r2_bytes: true, second_restore_writes: 0, rows_after: 6,
}));

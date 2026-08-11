import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCapacityHistory, restoreCapacityArchive } from "../src/capacity-archive";
import { importCapacityHistory, writeCapacitySnapshot } from "../src/capacity-db";
import { parseCapacityArgs } from "../src/capacity-cli";
import type { CodexLimitAccount } from "../src/limits";

function account(at: string, used: number): CodexLimitAccount {
  return {
    provider: "codex", email: "archive@example.com", plan: "Pro", devices: ["studio"], updatedAt: at,
    session: { usedPercent: used, windowMinutes: 300 },
    weekly: { usedPercent: used + 10, windowMinutes: 10080 },
  };
}

function counts(path: string): { windows: number; accounts: number } {
  const db = new Database(path, { readonly: true });
  try {
    return {
      windows: Number((db.query("SELECT COUNT(*) AS count FROM capacity_history").get() as { count: number }).count),
      accounts: Number((db.query("SELECT COUNT(*) AS count FROM capacity_account_history").get() as { count: number }).count),
    };
  } finally { db.close(); }
}

describe("capacity archive", () => {
  test("previews, restore-verifies, compacts, and restores idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-archive-"));
    const database = join(dir, "spendwatch.db");
    const archives = join(dir, "archives");
    const now = Date.parse("2026-08-12T00:00:00Z");
    writeCapacitySnapshot(database, [account("2025-01-10T00:00:00Z", 10)], { collectedAt: now });
    writeCapacitySnapshot(database, [account("2026-08-10T00:00:00Z", 20)], { collectedAt: now });
    expect(counts(database)).toEqual({ windows: 4, accounts: 2 });

    const preview = await archiveCapacityHistory({ database, archiveDir: archives, keepDays: 365, now });
    expect(preview).toMatchObject({ dryRun: true, eligible: { windows: 2, accounts: 1 }, deleted: { windows: 0, accounts: 0 } });
    expect(existsSync(archives)).toBe(false);
    expect(counts(database)).toEqual({ windows: 4, accounts: 2 });

    const archived = await archiveCapacityHistory({ database, archiveDir: archives, keepDays: 365, now, force: true });
    expect(archived).toMatchObject({ dryRun: false, deleted: { windows: 2, accounts: 1 } });
    expect(archived.archive && existsSync(archived.archive)).toBe(true);
    expect(statSync(archived.archive!).mode & 0o777).toBe(0o600);
    expect(counts(database)).toEqual({ windows: 2, accounts: 1 });

    const historical = join(dir, "historical.jsonl");
    writeFileSync(historical, JSON.stringify({
      provider: "codex", account: "archive@example.com", device: "studio", source: "codex-session-log",
      sampledAt: "2025-02-10T00:00:00Z", plan: "pro",
      windows: [{ kind: "session", usedPercent: 12, windowMinutes: 300 }],
    }));
    expect(importCapacityHistory(database, [historical])).toEqual({ inserted: 0, accepted: 0 });
    expect(counts(database)).toEqual({ windows: 2, accounts: 1 });

    expect(await restoreCapacityArchive(database, archived.archive!)).toMatchObject({ windows: 2, accounts: 1 });
    expect(await restoreCapacityArchive(database, archived.archive!)).toMatchObject({ windows: 0, accounts: 0 });
    expect(counts(database)).toEqual({ windows: 4, accounts: 2 });
  });

  test("requires explicit force for cleanup", () => {
    expect(parseCapacityArgs(["capacity", "archive", "--sqlite", "history.db"])).toMatchObject({ force: false, keepDays: 365 });
    expect(() => parseCapacityArgs(["capacity", "archive", "--sqlite", "history.db", "--force", "--dry-run"])).toThrow("cannot be combined");
    expect(() => parseCapacityArgs(["capacity", "restore", "--sqlite", "history.db"])).toThrow("ARCHIVE is required");
  });
});

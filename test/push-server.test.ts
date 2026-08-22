import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorFailureDecision } from "../src/push-server";
import { PushStore } from "../src/push-store";

describe("capacity monitor failure policy", () => {
  test("defers transient SQLite contention and escalates once when persistent", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-monitor-lock-"));
    const path = join(dir, "spendwatch.db");
    const store = new PushStore(path);
    store.db.exec("PRAGMA busy_timeout = 1;");
    const blocker = new Database(path);
    blocker.exec("PRAGMA journal_mode = WAL;");
    blocker.exec("BEGIN IMMEDIATE;");

    let lockError: unknown;
    try {
      store.observe(
        [
          {
            provider: "codex",
            email: "work@example.com",
            plan: "Pro",
            devices: ["studio"],
            weekly: {
              usedPercent: 20,
              windowMinutes: 10_080,
              resetsAt: "2026-08-30T00:00:00Z",
            },
          },
        ],
        Date.parse("2026-08-22T00:00:00Z"),
      );
    } catch (error) {
      lockError = error;
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
      store.close();
    }

    expect(lockError).toBeInstanceOf(Error);
    expect(String(lockError)).toContain("database is locked");
    expect(monitorFailureDecision(lockError, 0)).toEqual({
      report: false,
      consecutiveSqliteBusy: 1,
    });
    expect(monitorFailureDecision(lockError, 2)).toEqual({
      report: false,
      consecutiveSqliteBusy: 3,
    });
    expect(monitorFailureDecision(lockError, 3)).toEqual({
      report: true,
      consecutiveSqliteBusy: 4,
    });
    expect(monitorFailureDecision(lockError, 4)).toEqual({
      report: false,
      consecutiveSqliteBusy: 4,
    });
    expect(monitorFailureDecision(new Error("unexpected"), 3)).toEqual({
      report: true,
      consecutiveSqliteBusy: 0,
    });
  });
});

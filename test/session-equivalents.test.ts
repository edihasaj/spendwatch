import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCapacityDatabase, writeCapacitySnapshot } from "../src/capacity-db";
import type { CodexLimitAccount } from "../src/limits";
import { loadSessionEquivalentForecasts } from "../src/session-equivalents";

describe("paired session history selection", () => {
  test("newer unmatched windows cannot evict older paired cycles", () => {
    const directory = mkdtempSync(join(tmpdir(), "spendwatch-paired-history-"));
    const path = join(directory, "history.db");
    const start = Date.parse("2026-08-10T00:00:00Z");
    const weeklyReset = "2026-08-30T00:00:00Z";
    try {
      for (let index = 0; index < 4; index++) {
        const sampledAt = start + index * 5 * 3_600_000;
        writeCapacitySnapshot(path, [{
          provider: "codex", email: "LEARNED@example.invalid", devices: ["fixture"],
          updatedAt: new Date(sampledAt).toISOString(),
          session: { usedPercent: 1, windowMinutes: 300, resetsAt: new Date(sampledAt + 5 * 3_600_000).toISOString() },
          weekly: { usedPercent: 10 + index * 10, windowMinutes: 10080, resetsAt: weeklyReset },
        }], { collectedAt: sampledAt });
      }
      const database = openCapacityDatabase(path);
      const insert = database.prepare(`INSERT INTO capacity_history
        (sample_key,provider,account,window_kind,sampled_at_ms,observed_at,used_percent,
         resets_at_ms,window_minutes,source,devices)
        VALUES(?1,'codex','learned@example.invalid',?2,?3,'fixture',1,?4,300,'fixture','[]')`);
      database.transaction(() => {
        for (let index = 0; index < 6000; index++) {
          const timestamp = start + 24 * 3_600_000 + index * 60_000;
          insert.run(`session-only-${index}`, "session", timestamp, timestamp + 5 * 3_600_000);
          insert.run(`weekly-only-${index}`, "weekly", timestamp + 30_000, Date.parse(weeklyReset));
        }
      })();
      const count = database.query<{ count: number }, []>("SELECT count(*) AS count FROM capacity_history").get()!.count;
      database.close();
      const account: CodexLimitAccount = {
        provider: "codex", email: "learned@example.invalid", devices: ["fixture"],
        updatedAt: "2026-08-16T00:00:00Z",
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: weeklyReset },
      };
      const result = loadSessionEquivalentForecasts(path, [account], Date.parse(account.updatedAt!));
      expect(result.get("codex:learned@example.invalid")).toMatchObject({
        sampleCount: 3, medianWeeklyBurn: 10, estimatedQuotasLeft: 6,
      });
      const after = openCapacityDatabase(path);
      expect(after.query<{ count: number }, []>("SELECT count(*) AS count FROM capacity_history").get()!.count).toBe(count);
      after.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

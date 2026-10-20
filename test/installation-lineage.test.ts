import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { installationRowKey, restoredInstallationLineage, restoredMonthlySuppression } from "../src/installation-lineage";
import { monthPeriod } from "../src/periods";
import { loadArchivedReports } from "../src/spend-report-archive";
import { archivedCoverage } from "../src/gateway-settle";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { tokenSummary } from "../src/token-summary";
import { tempDir } from "./tmp";

function row(
  archiveSource: string,
  installationId: string,
  calls: number,
  restoredFromInstallationId?: string,
  source = "studio:codex",
) {
  const report: Report = {
    period: monthPeriod("2026-10"),
    source,
    installationId,
    ...(restoredFromInstallationId ? { restoredFromInstallationId } : {}),
    totalTokens: calls * 10,
    totalCost: 0,
    apiCalls: calls,
    observedCalls: calls,
    sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [],
    models: [{ model: "gpt-5.5", calls, inTok: calls * 10, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, cost: 0 }],
    projects: [], accounts: [],
    sinceTs: 1,
  };
  return { month: "2026-10", archiveSource, report, storedTokens: calls * 10 };
}

describe("restored installation lineage", () => {
  test("uses the fuller restored snapshot once", () => {
    const old = row("studio:codex", "old", 100);
    const restored = row("studio (installation 2):codex", "new", 150, "old");
    const result = restoredMonthlySuppression([old, restored]);
    expect(result.suppressed).toEqual(new Set([installationRowKey(old.month, old.archiveSource)]));
    expect(result.lineage.winners).toEqual(new Set([installationRowKey(restored.month, restored.archiveSource)]));
  });

  test("keeps independent installations and an older fuller snapshot", () => {
    const old = row("studio:codex", "old", 100);
    const independent = row("studio (installation 2):codex", "other", 50);
    expect(restoredInstallationLineage([old, independent]).suppressed).toEqual(new Set());

    const partial = row("studio (installation 3):codex", "partial", 50, "old");
    const result = restoredMonthlySuppression([old, partial]);
    expect(result.suppressed).toEqual(new Set([installationRowKey(partial.month, partial.archiveSource)]));
  });

  test("keeps an entire restored component visible when any stored monthly total disagrees with report detail", () => {
    const old = row("studio:codex", "old", 100);
    old.report.totalTokens = 100;
    old.storedTokens = 1_000;
    const restored = row("studio (installation 2):codex", "new", 150, "old");
    const result = restoredMonthlySuppression([old, restored]);
    expect(result.suppressed).toEqual(new Set());
    expect(result.uncertain).toEqual(new Set([
      installationRowKey(old.month, old.archiveSource),
      installationRowKey(restored.month, restored.archiveSource),
    ]));
  });

  test("fails closed for an unlinked source, malformed lineage, and cycles", () => {
    const old = row("studio:codex", "old", 100);
    const otherSource = row("studio:claude", "new", 150, "old", "studio:claude");
    expect(restoredInstallationLineage([old, otherSource]).suppressed).toEqual(new Set());

    const missing = row("studio (installation 2):codex", "new", 150, "missing");
    expect(restoredInstallationLineage([old, missing]).suppressed).toEqual(new Set());

    const a = row("studio:codex", "a", 100, "b");
    const b = row("studio (installation 2):codex", "b", 150, "a");
    expect(restoredInstallationLineage([a, b]).suppressed).toEqual(new Set());
  });

  test("uses the representative consistently in archived reports, monthly spend, and token summary", () => {
    const path = join(tempDir("spendwatch-installation-lineage-"), "history.db");
    const old = row("studio:codex", "old", 100);
    const restored = row("studio (installation 2):codex", "new", 150, "old");
    writeMonthlySpend(path, [old.report, restored.report], { generatedAt: Date.parse("2026-10-20T12:00:00Z") });

    expect(loadArchivedReports(path)).toMatchObject([{ totalTokens: 1_500 }]);
    expect(loadMonthlySpend(path)).toMatchObject([{ tokens: 1_500, lineageNotes: [
      "Restored installation snapshots overlap; fullest retained snapshot shown. Exact historical overlap unavailable.",
    ] }]);
    expect(tokenSummary(path, { now: Date.parse("2026-10-20T12:00:00Z"), timeZone: "UTC" })
      .periods.month.counts?.total).toBe(1_500);
  });

  test("does not let a shadowed gateway billing row settle a visible report", () => {
    const path = join(tempDir("spendwatch-installation-lineage-"), "history.db");
    const old = { ...row("studio:codex", "old", 100).report, gatewayBilled: ["old-billed"] };
    const restored = row("studio (installation 2):codex", "new", 150, "old").report;
    writeMonthlySpend(path, [old, restored], { generatedAt: Date.parse("2026-10-20T12:00:00Z") });
    const db = new Database(path, { readonly: true, create: false });
    try {
      expect(archivedCoverage(db, new Set([installationRowKey("2026-10", "studio:codex")]))).toEqual(new Map());
    } finally {
      db.close();
    }
  });

  test("does not suppress a mismatched stored archive row in any read view", () => {
    const path = join(tempDir("spendwatch-installation-lineage-"), "history.db");
    const old = row("studio:codex", "old", 100);
    const restored = row("studio (installation 2):codex", "new", 150, "old");
    writeMonthlySpend(path, [old.report, restored.report], { generatedAt: Date.parse("2026-10-20T12:00:00Z") });
    const db = new Database(path);
    db.prepare("UPDATE spend_month SET tokens = ? WHERE month = ? AND source = ?")
      .run(10_000, "2026-10", "studio:codex");
    db.close();

    expect(loadArchivedReports(path)).toMatchObject([{
      totalTokens: 2_500,
      lineageWarning: "Restored installation snapshots overlap, but stored totals disagree with report detail; both remain visible. Exact historical overlap unavailable.",
    }]);
    expect(loadMonthlySpend(path)).toMatchObject([{
      tokens: 11_500,
      lineageNotes: ["Restored installation snapshots overlap, but stored totals disagree with report detail; both remain visible. Exact historical overlap unavailable."],
    }]);
    const summary = tokenSummary(path, { now: Date.parse("2026-10-20T12:00:00Z"), timeZone: "UTC" });
    expect(summary.periods.month.counts?.total).toBe(11_500);
    expect(summary.notes).toContain("Restored installation snapshots overlap, but stored totals disagree with report detail; both remain visible. Exact historical overlap unavailable.");
  });

  test("uses global lineage visibility before January gateway settlement", () => {
    const path = join(tempDir("spendwatch-installation-lineage-"), "history.db");
    const old = { ...row("studio:codex", "old", 100).report, period: monthPeriod("2025-12"), gatewayBilled: ["december-bill"] };
    const restored = { ...row("studio (installation 2):codex", "new", 150, "old").report, period: monthPeriod("2025-12") };
    const client = {
      ...row("client:codex", "client", 1, undefined, "client:codex").report,
      period: monthPeriod("2026-01"),
      gatewayUnconfirmed: [{
        id: "december-bill", ts: Date.parse("2026-01-10T10:00:00Z"), model: "gpt-5.5",
        account: "account", project: "project", tokens: 10, inTok: 10, outTok: 0,
        cacheReadTok: 0, cacheWriteTok: 0, cost: 0,
      }],
    };
    writeMonthlySpend(path, [old, restored, client], { generatedAt: Date.parse("2026-01-10T12:00:00Z") });

    expect(tokenSummary(path, { now: Date.parse("2026-01-10T12:00:00Z"), timeZone: "UTC" })
      .periods.month.counts?.total).toBe(10);
  });
});

import { statSync } from "node:fs";
import { attachBurnForecasts } from "./capacity-burn";
import { loadCapacityDashboard, type CapacityDashboard } from "./capacity-dashboard";
import { renderLimitsHtml } from "./limits";
import { attachSessionEquivalentForecasts } from "./session-equivalents";
import { Database, isManagedDatabase } from "./database";

/**
 * Re-evaluate stored capacity on each page request, without contacting providers
 * or recording another sample. A static export otherwise stays "live" forever
 * when collection is on demand, even though browser refreshes keep succeeding.
 */
export function createCapacityPageRenderer(capacityPath: string, databasePath: string): (nowMs?: number) => string {
  let cached: { signature: string; generatedAt: number; dashboard: CapacityDashboard } | undefined;
  let reader: { db: Database; openedAt: number } | undefined;
  const managedReader = isManagedDatabase(databasePath) ? () => {
    const at = performance.now();
    if (reader && at - reader.openedAt >= 300_000) {
      reader.db.close(); reader = undefined;
    }
    return (reader ??= { db: new Database(databasePath, { readonly: true }), openedAt: at }).db;
  } : undefined;
  return (nowMs = Date.now()) => {
    const snapshot = statSync(capacityPath);
    const signature = `${snapshot.ino}:${snapshot.size}:${snapshot.mtimeMs}:${snapshot.ctimeMs}`;
    if (!cached || cached.signature !== signature) {
      const dashboard = loadCapacityDashboard([capacityPath]);
      attachSessionEquivalentForecasts(databasePath, dashboard.accounts, nowMs);
      cached = { signature, generatedAt: snapshot.mtimeMs, dashboard };
    }
    // Burn is time-sensitive even when the input has not changed.
    try {
      attachBurnForecasts(databasePath, cached.dashboard.accounts, nowMs, managedReader);
    } catch (error) {
      // A failed read is reported, never replayed. Only the next request may
      // reconnect; do not retain a broken native socket.
      reader?.db.close(); reader = undefined;
      throw error;
    }
    return renderLimitsHtml(cached.dashboard.accounts, {
      generatedAt: cached.generatedAt,
      nowMs,
      sources: cached.dashboard.sources,
      authentication: cached.dashboard.authentication,
    });
  };
}

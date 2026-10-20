import { statSync } from "node:fs";
import { attachBurnForecasts } from "./capacity-burn";
import { loadCapacityDashboard, type CapacityDashboard } from "./capacity-dashboard";
import { normalizeCodexLimits, renderLimitsHtml, type CodexLimitAccount } from "./limits";
import { attachSessionEquivalentForecasts } from "./session-equivalents";
import { Database } from "./database";
import { pollKey, sanitizePollSnapshot } from "./capacity-poll";

interface PollSnapshotRow { snapshot: string | null }

function missingPollTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*capacity_poll|relation ["']?capacity_poll["']? does not exist|42P01/iu.test(message);
}

function freshPollSnapshots(db: Database, nowMs: number): unknown[] {
  let rows: PollSnapshotRow[];
  try {
    rows = db.query<PollSnapshotRow, []>("SELECT snapshot FROM capacity_poll WHERE snapshot IS NOT NULL").all();
  } catch (error) {
    if (missingPollTable(error)) return [];
    throw error;
  }
  return rows.flatMap(({ snapshot }) => {
    try {
      const value = JSON.parse(snapshot ?? "");
      if (!value || typeof value !== "object") return [];
      const item = value as { provider?: unknown; account?: unknown; usage?: { updatedAt?: unknown } };
      const sanitized = sanitizePollSnapshot(value, pollKey(item.provider, item.account), nowMs);
      const updatedAt = Date.parse(sanitized.usage.updatedAt);
      return Number.isFinite(updatedAt) && updatedAt <= nowMs ? [sanitized] : [];
    } catch { return []; }
  });
}

function overlayFreshPollSnapshots(accounts: CodexLimitAccount[], db: Database, nowMs: number): boolean {
  const positions = new Map(accounts.map((account, index) => [
    `${account.provider}:${account.email.toLowerCase()}`, index,
  ]));
  let changed = false;
  for (const snapshot of freshPollSnapshots(db, nowMs)) {
    for (const incoming of normalizeCodexLimits([snapshot])) {
      if (incoming.provider !== "codex" && incoming.provider !== "claude") continue;
      const index = positions.get(`${incoming.provider}:${incoming.email.toLowerCase()}`);
      if (index === undefined) continue;
      const current = accounts[index]!;
      const currentAt = Date.parse(current.updatedAt ?? "");
      const incomingAt = Date.parse(incoming.updatedAt ?? "");
      if (!Number.isFinite(incomingAt) || (Number.isFinite(currentAt) && incomingAt <= currentAt)) continue;
      accounts[index] = {
        ...incoming,
        name: current.name,
        organization: incoming.organization ?? current.organization,
        devices: [...current.devices],
      };
      changed = true;
    }
  }
  return changed;
}

/**
 * Re-evaluate stored capacity on each page request, without contacting providers
 * or recording another sample. A static export otherwise stays "live" forever
 * when collection is on demand, even though browser refreshes keep succeeding.
 */
export function createCapacityPageRenderer(capacityPath: string, databasePath: string): (nowMs?: number) => string {
  let cached: { signature: string; generatedAt: number; dashboard: CapacityDashboard } | undefined;
  let reader: { db: Database; openedAt: number } | undefined;
  const pageReader = () => {
    const at = performance.now();
    if (reader && at - reader.openedAt >= 300_000) {
      reader.db.close(); reader = undefined;
    }
    return (reader ??= { db: new Database(databasePath, { readonly: true }), openedAt: at }).db;
  };
  return (nowMs = Date.now()) => {
    try {
      const snapshot = statSync(capacityPath);
      const signature = `${snapshot.ino}:${snapshot.size}:${snapshot.mtimeMs}:${snapshot.ctimeMs}`;
      if (!cached || cached.signature !== signature) {
        const dashboard = loadCapacityDashboard([capacityPath]);
        attachSessionEquivalentForecasts(databasePath, dashboard.accounts, nowMs, pageReader);
        cached = { signature, generatedAt: snapshot.mtimeMs, dashboard };
      }
      // The immutable source snapshot remains the fallback. A newer coordinator
      // row is already authenticated and durable, so it can bridge import delay
      // without fabricating an account or changing the cached base dashboard.
      const accounts = structuredClone(cached.dashboard.accounts);
      if (overlayFreshPollSnapshots(accounts, pageReader(), nowMs)) {
        attachSessionEquivalentForecasts(databasePath, accounts, nowMs, pageReader);
      }
      // Burn is time-sensitive even when the input has not changed.
      attachBurnForecasts(databasePath, accounts, nowMs, pageReader);
      return renderLimitsHtml(accounts, {
        generatedAt: cached.generatedAt,
        nowMs,
        sources: cached.dashboard.sources,
        authentication: cached.dashboard.authentication,
      });
    } catch (error) {
      // A failed read is reported, never replayed. Only the next request may
      // reconnect; do not retain a broken native socket.
      reader?.db.close(); reader = undefined;
      throw error;
    }
  };
}

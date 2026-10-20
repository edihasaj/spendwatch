import type { Report } from "./aggregate";

export interface ArchivedInstallationReport {
  month: string;
  archiveSource: string;
  report: Report;
  /** The separately archived monthly total, when a reader is using it. */
  storedTokens?: number;
}

export interface LineageShadow {
  key: string;
  winner: string;
  reason: string;
}

export interface InstallationLineage {
  suppressed: Set<string>;
  winners: Set<string>;
  shadows: LineageShadow[];
}

export const installationRowKey = (month: string, archiveSource: string): string =>
  JSON.stringify([month, archiveSource]);

/**
 * A verified restore declaration permits one representative snapshot for a
 * lineage. It is deliberately a read-time choice: all archive rows stay
 * recoverable. The fullest snapshot avoids known duplication, but cannot
 * prove an exact historical union. Invalid declarations hide nothing.
 */
export function restoredInstallationLineage(rows: ArchivedInstallationReport[]): InstallationLineage {
  const suppressed = new Set<string>();
  const winners = new Set<string>();
  const shadows: LineageShadow[] = [];
  const groups = new Map<string, ArchivedInstallationReport[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.month, row.report.source]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const decision = groupLineage(group);
    for (const row of decision.suppressed) suppressed.add(installationRowKey(row.month, row.archiveSource));
    for (const row of decision.winners) winners.add(installationRowKey(row.month, row.archiveSource));
    shadows.push(...decision.shadows);
  }
  return { suppressed, winners, shadows };
}

/**
 * A monthly row can be older and fuller than its linked report JSON. In that
 * case the report cannot certify which installation is the representative, so
 * preserve both rows rather than hiding a possible unique remainder.
 */
export function restoredMonthlySuppression(rows: ArchivedInstallationReport[]): {
  lineage: InstallationLineage;
  suppressed: Set<string>;
  uncertain: Set<string>;
} {
  const lineage = restoredInstallationLineage(rows);
  const byKey = new Map(rows.map((row) => [installationRowKey(row.month, row.archiveSource), row]));
  const suppressed = new Set<string>();
  const uncertain = new Set<string>();
  const components = new Map<string, string[]>();
  for (const shadow of lineage.shadows) {
    const component = components.get(shadow.winner) ?? [];
    component.push(shadow.key);
    components.set(shadow.winner, component);
  }
  for (const [winnerKey, shadows] of components) {
    const keys = [winnerKey, ...shadows];
    const complete = keys.every((key) => {
      const row = byKey.get(key);
      return row && Number.isSafeInteger(row.storedTokens) && row.storedTokens === row.report.totalTokens;
    });
    if (complete) {
      for (const shadow of shadows) suppressed.add(shadow);
    } else {
      for (const key of keys) uncertain.add(key);
    }
  }
  return { lineage, suppressed, uncertain };
}

function groupLineage(rows: ArchivedInstallationReport[]): {
  suppressed: ArchivedInstallationReport[];
  winners: ArchivedInstallationReport[];
  shadows: LineageShadow[];
} {
  const restores = rows.filter((row) => row.report.restoredFromInstallationId !== undefined);
  if (!restores.length) return { suppressed: [], winners: [], shadows: [] };
  const byId = new Map<string, ArchivedInstallationReport>();
  let invalid = false;
  for (const row of rows) {
    const id = validId(row.report.installationId);
    if (!id || byId.has(id)) {
      invalid = true;
      continue;
    }
    byId.set(id, row);
  }
  const parent = new Map<ArchivedInstallationReport, ArchivedInstallationReport>();
  const children = new Map<ArchivedInstallationReport, ArchivedInstallationReport[]>();
  for (const row of restores) {
    const id = validId(row.report.installationId);
    const restored = validId(row.report.restoredFromInstallationId);
    if (!id || !restored || id === restored || !/:(?:codex|claude|grok)$/.test(row.report.source) ||
        row.report.period?.key !== row.month) {
      invalid = true;
      continue;
    }
    const older = byId.get(restored);
    if (!older || older.report.source !== row.report.source || older.month !== row.month ||
        parent.has(row)) {
      invalid = true;
      continue;
    }
    parent.set(row, older);
    const descendants = children.get(older) ?? [];
    descendants.push(row);
    children.set(older, descendants);
    if (descendants.length > 1) invalid = true;
  }
  if (invalid || hasCycle(parent)) return { suppressed: [], winners: [], shadows: [] };

  const visited = new Set<ArchivedInstallationReport>();
  const suppressed: ArchivedInstallationReport[] = [];
  const winners: ArchivedInstallationReport[] = [];
  const shadows: LineageShadow[] = [];
  for (const start of rows) {
    if (visited.has(start) || (!parent.has(start) && !children.has(start))) continue;
    const component: Array<{ row: ArchivedInstallationReport; depth: number }> = [];
    const queue: Array<{ row: ArchivedInstallationReport; depth: number }> = [{ row: start, depth: 0 }];
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next.row)) continue;
      visited.add(next.row);
      component.push(next);
      for (const child of children.get(next.row) ?? []) queue.push({ row: child, depth: next.depth + 1 });
      const older = parent.get(next.row);
      if (older) queue.push({ row: older, depth: next.depth - 1 });
    }
    const winner = [...component].sort((a, b) =>
      observed(b.row.report) - observed(a.row.report) || b.depth - a.depth ||
      a.row.archiveSource.localeCompare(b.row.archiveSource))[0]!;
    winners.push(winner.row);
    for (const candidate of component) {
      if (candidate.row === winner.row) continue;
      suppressed.push(candidate.row);
      shadows.push({
        key: installationRowKey(candidate.row.month, candidate.row.archiveSource),
        winner: installationRowKey(winner.row.month, winner.row.archiveSource),
        reason: observed(candidate.row.report) < observed(winner.row.report)
          ? "restored installation has a fuller report"
          : "equivalent restored installation is represented once",
      });
    }
  }
  return { suppressed, winners, shadows };
}

function validId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function observed(report: Report): number {
  const value = report.observedCalls ?? report.apiCalls;
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function hasCycle(parent: Map<ArchivedInstallationReport, ArchivedInstallationReport>): boolean {
  for (const start of parent.keys()) {
    const seen = new Set<ArchivedInstallationReport>();
    let current: ArchivedInstallationReport | undefined = start;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parent.get(current);
    }
  }
  return false;
}

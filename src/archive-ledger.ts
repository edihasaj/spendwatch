// The month a gateway ledger takes over. A read with this Mac's ledger moves the routed turns out of the Codex
// report and into the Claude or Copilot report of the same Mac and month. Sources are archived one by one, each
// keeping its fullest read, so a month first archived without the ledger could end up half moved: Codex
// accepting the new read while Claude keeps the old one (its transcripts rotated) loses the routed turns, and
// the opposite counts them twice. So the first time any of those sources takes a read with routed turns, they
// take it together or not at all.
import type { Database } from "bun:sqlite";
import type { Report } from "./aggregate";
import { storedArchiveSource } from "./spend-report-archive";

/** The sources a routed turn moves between. */
const ROUTED_SOURCES = ["codex", "claude", "copilot"] as const;
type RoutedSource = (typeof ROUTED_SOURCES)[number];

export type Verdict = "accept" | "reject";

interface StoredRead {
  observed: number;
  routed: number;
  ledger: boolean;
}

interface Member {
  source: RoutedSource;
  /** The fullest read of this source offered in this run. */
  incoming?: Report;
  /** Other offers of the same month and installation in this run, which the fullest one speaks for. */
  rest: Report[];
  /** What the archive holds for it, in either table. */
  stored: StoredRead[];
}

const observedOf = (report: Report): number => report.observedCalls ?? report.apiCalls;
const routedOf = (report?: Report): number => report?.routedCalls ?? 0;

function split(source: string): { machine: string; agent: string } {
  const at = source.lastIndexOf(":");
  return at > 0 ? { machine: source.slice(0, at), agent: source.slice(at + 1) } : { machine: "", agent: source };
}

function storedRead(db: Database, table: "spend_report" | "spend_month", month: string, source: string): StoredRead | undefined {
  const row = db.query<{ observed: number; routed: number; ledger: number }, [string, string]>(`
    SELECT COALESCE(observed_calls, calls) AS observed, COALESCE(routed_calls, 0) AS routed, COALESCE(ledger, 0) AS ledger
    FROM ${table} WHERE month = ? AND source = ?
  `).get(month, source);
  return row ? { observed: row.observed, routed: row.routed, ledger: row.ledger === 1 } : undefined;
}

/** The per-source rule (see `fullerRead`), checked here before anything is written. */
const fuller = (report: Report, stored: StoredRead): boolean =>
  observedOf(report) >= stored.observed && routedOf(report) >= stored.routed;

/**
 * Decides, before anything is written, the reports that must be archived together with their month's other
 * routed sources: "accept" writes each of them whatever is stored, "reject" writes none of them. A report this
 * returns nothing for is archived on its own, as before.
 */
export function planLedgerMonths(db: Database, reports: Report[]): Map<Report, Verdict> {
  const groups = new Map<string, { month: string; machine: string; installationId?: string; incoming: Map<RoutedSource, Report[]> }>();
  for (const report of reports) {
    if (!report.period?.month || observedOf(report) <= 0) continue;
    const { machine, agent } = split(report.source);
    if (!(ROUTED_SOURCES as readonly string[]).includes(agent)) continue;
    const key = JSON.stringify([report.period.key, machine, report.installationId ?? ""]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { month: report.period.key, machine, installationId: report.installationId, incoming: new Map() }));
    const list = group.incoming.get(agent as RoutedSource) ?? [];
    list.push(report);
    group.incoming.set(agent as RoutedSource, list);
  }

  const verdicts = new Map<Report, Verdict>();
  for (const group of groups.values()) {
    const members = ROUTED_SOURCES.map((source): Member => {
      const label = group.machine ? `${group.machine}:${source}` : source;
      const archived = storedArchiveSource(db, label, group.installationId);
      const stored = archived
        ? [storedRead(db, "spend_report", group.month, archived), storedRead(db, "spend_month", group.month, archived)].filter((row): row is StoredRead => !!row)
        : [];
      // One installation's month offered twice in one run: the fullest offer speaks for it.
      const offers = [...(group.incoming.get(source) ?? [])].sort((a, b) => observedOf(b) - observedOf(a));
      return { source, incoming: offers[0], rest: offers.slice(1), stored };
    });
    // Codex is where routed turns leave from. Claude and Copilot matter when routed turns reach them, or when this
    // run did not read them, so nothing says whether they do; a read of one that routed nothing is its own affair.
    const involved = members.filter((m) => m.source === "codex" || routedOf(m.incoming) > 0
      || m.stored.some((row) => row.routed > 0) || (!m.incoming && m.stored.length > 0));
    const takesOver = involved.some((m) => routedOf(m.incoming) > 0) && involved.some((m) => m.stored.some((row) => !row.ledger));
    if (!takesOver) continue;
    // Every source that holds a read of this month has to offer a fuller one, or none of them changes.
    const together = involved.every((m) => m.incoming ? m.stored.every((row) => fuller(m.incoming!, row)) : !m.stored.length);
    for (const m of involved) {
      if (m.incoming) verdicts.set(m.incoming, together ? "accept" : "reject");
      for (const extra of m.rest) verdicts.set(extra, "reject");
    }
  }
  return verdicts;
}

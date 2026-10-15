// Reads the discovered sources into reports: the pass `report` and `watch` share, apart from the CLI.
import { Aggregator, type Report } from "./aggregate";
import { MonthlyAggregator } from "./monthly";
import type { Period } from "./periods";
import { primaryPeriod } from "./report-window";
import { IncrementalReader } from "./scan";
import { discover, pollOrder, type SourceStatus } from "./sources";

/** The part of the command line that decides what is read and what is kept. */
export interface BuildOptions {
  agents?: Set<string>;
  project?: string;
  account?: string;
  top: number;
}

type Sink = Aggregator | MonthlyAggregator;

export interface Built {
  statuses: SourceStatus[];
  readers: Map<string, { reader: IncrementalReader; sink: Sink; status: SourceStatus }>;
  periods: Period[];
}

export function matchesProject(project: string, filter?: string): boolean {
  return !filter || project.toLowerCase().includes(filter.toLowerCase());
}

export function build(a: BuildOptions, periods: Period[]): Built {
  const sinceMs = Math.min(...periods.map((period) => period.from));
  // Codex project lives inside the file, so don't pre-filter codex by project name.
  const statuses = discover({ sinceMs, agents: a.agents, project: undefined });
  const readers = new Map<string, { reader: IncrementalReader; sink: Sink; status: SourceStatus }>();
  for (const st of statuses) {
    const sink: Sink = periods.length === 1 && !periods[0]!.month
      ? new Aggregator(periods[0])
      : new MonthlyAggregator(periods);
    readers.set(st.id, { reader: new IncrementalReader(sink), sink, status: st });
  }
  // A rollout a filter leaves out of the Codex report still has to claim what it shares with the ledger,
  // or the Claude and Copilot rows it vouches for would depend on which account was asked about.
  const claims = new IncrementalReader(new Aggregator());
  // Rollouts are read first: a gateway row can only be dropped or backfilled
  // after the transcript it duplicates has already claimed it.
  for (const st of pollOrder(statuses)) {
    const slot = readers.get(st.id)!;
    for (const f of st.files) {
      // Claude and Grok can pre-filter by project (it's in the dir name).
      if ((st.id === "claude" || st.id === "grok") && !matchesProject(f.project, a.project)) continue;
      if (a.account && !f.account.toLowerCase().includes(a.account.toLowerCase())) {
        if (st.id === "codex" && st.ledger) { claims.poll(f); claims.flush(f); }
        continue;
      }
      slot.reader.poll(f);
      slot.reader.flush(f);
    }
  }
  return { statuses, readers, periods };
}

export function applyFilters(r: Report, a: BuildOptions): Report {
  // Post-filter projects for codex/gemini (project known only after parse).
  if (a.project) {
    r.prompts = r.prompts.filter((p) => matchesProject(p.project, a.project));
    r.projects = r.projects.filter((p) => matchesProject(p.project, a.project));
  }
  if (a.account) r.accounts = r.accounts.filter((ac) => ac.account.toLowerCase().includes(a.account!.toLowerCase()));
  return r;
}

/** One entry per period, in the order the periods were resolved (oldest first). */
export function reportsByPeriod(built: Built, a: BuildOptions): Map<string, Report[]> {
  const out = new Map<string, Report[]>(built.periods.map((period) => [period.key, []]));
  for (const { sink, status } of built.readers.values()) {
    if (!status.parseable) continue;
    // A source read only so its rollouts could claim ledger rows reports nothing of its own.
    if (status.claimOnly) continue;
    // A report remembers that the ledger was read, so the archive can refuse to undo it later.
    const tag = (report: Report): Report => applyFilters(status.ledger ? { ...report, ledger: true } : report, a);
    if (sink instanceof MonthlyAggregator) {
      for (const [key, report] of sink.reports(a.top)) out.get(key)?.push(tag(report));
    } else {
      out.get(built.periods[0]!.key)?.push(tag(sink.report(a.top)));
    }
  }
  return out;
}

export function reportsFrom(built: Built, a: BuildOptions): Report[] {
  return reportsByPeriod(built, a).get(primaryPeriod(built.periods).key) ?? [];
}

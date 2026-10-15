// Reads the discovered sources into reports: the pass `report` and `watch` share, apart from the CLI.
import { Aggregator, type Report } from "./aggregate";
import { MonthlyAggregator } from "./monthly";
import { rollingDays, type Period } from "./periods";
import { primaryPeriod } from "./report-window";
import { IncrementalReader } from "./scan";
import { discover, pollOrder, type SourceFile, type SourceStatus } from "./sources";

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
  /** Reads the rollouts a filter leaves out, for their gateway claims only; it reports nothing. */
  claims: IncrementalReader;
  periods: Period[];
}

/**
 * The window `watch` reads: the last `days` days, and everything written while it runs. A window that ended when
 * the command started would drop every line the agents write afterwards, which is all `watch` is for.
 */
export function watchPeriod(nowMs: number, days: number): Period {
  return { ...rollingDays(nowMs, days), to: Number.POSITIVE_INFINITY };
}

export function matchesProject(project: string, filter?: string): boolean {
  return !filter || project.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Where a discovered file is read: into its source's report, only for its gateway claims, or not at all. The
 * first read and every `watch` tick ask the same question, so a filter holds for as long as the command runs.
 */
export function readerFor(st: SourceStatus, f: SourceFile, a: BuildOptions): "report" | "claims" | undefined {
  // Claude and Grok can pre-filter by project (it's in the dir name). A gateway ledger file is not a project's
  // transcript: its rows carry the project "gateway", and Copilot and Codex post-filter only their project lists.
  if ((st.id === "claude" || st.id === "grok") && !f.key?.startsWith("gateway:") && !matchesProject(f.project, a.project)) return undefined;
  // A rollout a filter leaves out of the Codex report still has to claim what it shares with the ledger,
  // or the Claude and Copilot rows it vouches for would depend on which account was asked about.
  if (a.account && !f.account.toLowerCase().includes(a.account.toLowerCase())) return st.id === "codex" && st.ledger ? "claims" : undefined;
  return "report";
}

/**
 * Reads every discovered file once. `watching` is for `watch`'s first read: its later ticks reload the ledger, so a
 * routed call younger than the claim window is left waiting for its row instead of being billed from its rollout.
 * A report has no later tick, so it settles every call at the end of its read.
 */
export function build(a: BuildOptions, periods: Period[], { watching = false }: { watching?: boolean } = {}): Built {
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
  const claims = new IncrementalReader(new Aggregator());
  // Rollouts are read first: a gateway row can only be dropped or backfilled
  // after the transcript it duplicates has already claimed it.
  for (const st of pollOrder(statuses)) {
    const slot = readers.get(st.id)!;
    for (const f of st.files) {
      const target = readerFor(st, f, a);
      const reader = target === "report" ? slot.reader : target === "claims" ? claims : undefined;
      if (!reader) continue;
      reader.poll(f);
      reader.flush(f, !watching);
    }
  }
  return { statuses, readers, claims, periods };
}

/**
 * One watch tick: re-read what each newly discovered file appended since the last tick, into the reader the
 * first read chose for it, with the same filters. Every reader keeps its parsers' state between ticks.
 * Returns the bytes (or ledger events) consumed.
 */
export function pollWatched(built: Built, statuses: SourceStatus[], a: BuildOptions): number {
  let changed = 0;
  for (const st of pollOrder(statuses)) {
    const slot = built.readers.get(st.id);
    if (!slot) continue;
    for (const f of st.files) {
      const target = readerFor(st, f, a);
      const reader = target === "report" ? slot.reader : target === "claims" ? built.claims : undefined;
      if (reader) changed += reader.poll(f);
    }
  }
  return changed;
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
    // A report remembers that this Mac's ledger was read, so the archive can tell the month the ledger takes over.
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

// Splits one pass over the transcripts into per-calendar-month reports.
//
// Reading the logs is the expensive part, so every month is folded from the
// same byte stream: each event is routed to the aggregator for the month it
// actually happened in, rather than the month the file was last written.
import { Aggregator, type Report } from "./aggregate";
import type { Event } from "./parse";
import type { AccountAttributionBasis, CodexAccountAttributor } from "./codex-account-attribution";
import { monthKeyOf, type Period } from "./periods";

export interface EventSink {
  stream(fileKey: string, project: string, source?: string, account?: string, accountBasis?: AccountAttributionBasis, codexAttributor?: CodexAccountAttributor): (event: Event) => void;
  /** Forgets what a file's stream folded, so the next fold of that file starts afresh. */
  reset(fileKey: string): void;
}

interface StreamRouter {
  fold: (event: Event) => void;
  renew: (source: string, account: string, accountBasis: AccountAttributionBasis, codexAttributor?: CodexAccountAttributor) => void;
}

export class MonthlyAggregator implements EventSink {
  private readonly months: Map<string, { period: Period; agg: Aggregator }>;
  private routers = new Map<string, StreamRouter>();

  constructor(periods: Period[]) {
    this.months = new Map(periods.map((period) => [period.key, { period, agg: new Aggregator(period, false) }]));
  }

  reset(fileKey: string): void {
    this.routers.delete(fileKey);
    for (const { agg } of this.months.values()) agg.reset(fileKey);
  }

  stream(fileKey: string, project: string, source = "claude", account = "default", accountBasis: AccountAttributionBasis = "profile", codexAttributor?: CodexAccountAttributor): (event: Event) => void {
    const existing = this.routers.get(fileKey);
    if (existing) {
      existing.renew(source, account, accountBasis, codexAttributor);
      return existing.fold;
    }

    // A month only opens a stream for this file once the file has activity in
    // it, otherwise every quiet month would inherit the session count of every
    // file that merely mentions a project.
    const folds = new Map<string, (event: Event) => void>();
    const toolMonth = new Map<string, string>();
    let lastMeta: Event | undefined;
    let lastKey: string | undefined;

    const foldFor = (key: string): ((event: Event) => void) | undefined => {
      const open = folds.get(key);
      if (open) return open;
      const month = this.months.get(key);
      if (!month) return undefined;
      const fold = month.agg.stream(fileKey, project, source, account, accountBasis, codexAttributor);
      folds.set(key, fold);
      if (lastMeta) fold(lastMeta);
      return fold;
    };

    const fold = (event: Event) => {
      if (event.t === "meta") {
        lastMeta = event;
        for (const open of folds.values()) open(event);
        return;
      }
      let key = event.ts ? monthKeyOf(event.ts) : lastKey;
      // Codex writes a tool result with its own timestamp; a call that started
      // on the last evening of a month must stay with the call it answers.
      if (event.t === "toolresult") key = toolMonth.get(event.id) ?? key;
      if (!key) return;
      if (event.t === "tooluse") toolMonth.set(event.id, key);
      lastKey = key;
      foldFor(key)?.(event);
    };

    // Watch discovers a fresh ledger index on every tick. The opened month
    // aggregators must receive it even when no new month router is created.
    const renew = (nextSource: string, nextAccount: string, nextBasis: AccountAttributionBasis, nextAttributor?: CodexAccountAttributor) => {
      for (const key of folds.keys()) this.months.get(key)?.agg.stream(fileKey, project, nextSource, nextAccount, nextBasis, nextAttributor);
    };
    this.routers.set(fileKey, { fold, renew });
    return fold;
  }

  /** Per-month reports keyed by month, oldest first. Months with no traffic are kept. */
  reports(topN = 15, accountFilter?: string): Map<string, Report> {
    const out = new Map<string, Report>();
    for (const [key, { agg }] of this.months) out.set(key, agg.report(topN, accountFilter));
    return out;
  }

  periods(): Period[] {
    return [...this.months.values()].map((month) => month.period);
  }
}

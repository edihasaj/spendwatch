// Chooses the window a report covers and files already-measured reports into
// the month their machine recorded them under.
import type { Report } from "./aggregate";
import { monthPeriod, recentMonths, rollingDays, unbounded, type Period } from "./periods";

export interface PeriodArgs {
  month?: string;
  days: number;
  daysExplicit: boolean;
  months: number;
}

/**
 * Which windows this run measures. Spend resets with the calendar month by
 * default — a rolling 30 days never lets a month close, so a heavy August keeps
 * inflating September until it falls out one day at a time.
 */
export function resolvePeriods(a: PeriodArgs, nowMs: number): Period[] {
  if (a.month) return [monthPeriod(a.month)];
  // No usable clock (some sandboxes refuse Date.now) means no calendar and no
  // trailing window to anchor, so report everything rather than an empty range.
  if (!nowMs) return [unbounded()];
  if (a.daysExplicit) return [rollingDays(nowMs, a.days)];
  return recentMonths(nowMs, a.months);
}

export function primaryPeriod(periods: Period[]): Period {
  return periods[periods.length - 1]!;
}

/** The latest month among imported reports that actually holds traffic. */
export function newestPopulated(byPeriod: Map<string, Report[]>, fallback: string): string {
  const populated = [...byPeriod.entries()]
    .filter(([, rows]) => rows.some((row) => row.apiCalls > 0))
    .map(([key]) => key)
    .sort();
  return populated[populated.length - 1] ?? fallback;
}

/** Buckets imported reports by the period each machine recorded them under. */
export function groupImported(reports: Report[], primary: Period): Map<string, Report[]> {
  const out = new Map<string, Report[]>();
  for (const report of reports) {
    const key = report.period?.key ?? primary.key;
    const rows = out.get(key) ?? [];
    rows.push(report);
    out.set(key, rows);
  }
  if (!out.has(primary.key)) out.set(primary.key, []);
  return out;
}

// Calendar-month and rolling-window bookkeeping for spend reports.
//
// Months are local-time boundaries, matching the month picker on the history
// dashboard: a "September" total should mean the month the user lived through,
// not the month UTC happened to be in when they worked late.
export interface Period {
  /** Stable identity: "2026-09" for a month, "30d" for a rolling window. */
  key: string;
  /** Human label, ready to drop into a sentence: "September 2026", "the last 30 days". */
  label: string;
  /** Inclusive start in epoch ms. */
  from: number;
  /** Exclusive end in epoch ms. */
  to: number;
  month: boolean;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

export function monthKeyOf(ts: number): string {
  const at = new Date(ts);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key: string): string {
  const bounds = monthPeriod(key);
  return new Date(bounds.from).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export function monthPeriod(key: string): Period {
  const parts = MONTH_KEY.exec(key);
  if (!parts) throw new Error(`month must look like YYYY-MM, got: ${key}`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  if (month < 1 || month > 12) throw new Error(`month must be 01-12, got: ${key}`);
  const from = new Date(year, month - 1, 1).getTime();
  const to = new Date(year, month, 1).getTime();
  return {
    key,
    label: new Date(from).toLocaleString("en-US", { month: "long", year: "numeric" }),
    from,
    to,
    month: true,
  };
}

/** The `count` most recent calendar months, oldest first, ending with `nowMs`. */
export function recentMonths(nowMs: number, count: number): Period[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("--months must be a positive integer");
  const now = new Date(nowMs);
  const periods: Period[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const at = new Date(now.getFullYear(), now.getMonth() - back, 1);
    periods.push(monthPeriod(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`));
  }
  return periods;
}

export function rollingDays(nowMs: number, days: number): Period {
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  return {
    key: `${days}d`,
    label: `the last ${days} ${days === 1 ? "day" : "days"}`,
    from: nowMs - days * 86_400_000,
    to: nowMs,
    month: false,
  };
}

/**
 * Everything the transcripts hold. Used when there is no usable clock to build
 * a calendar against — some sandboxes refuse `Date.now` — where reporting all
 * of it beats reporting a window computed from a fake epoch.
 */
export function unbounded(): Period {
  return { key: "all", label: "every recorded session", from: 0, to: Number.MAX_SAFE_INTEGER, month: false };
}

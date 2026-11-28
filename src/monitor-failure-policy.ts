/**
 * Failure cadence and privacy-safe classification for the dashboard's capacity monitor.
 *
 * The monitor runs on a timer for the life of the server, so one persistent failure used to
 * produce a `spendwatch.monitor.failure` report and a stderr line on every tick: at the
 * 15-second default, roughly 5,700 reports a day for a single fault. Only native SQLite
 * contention was ever throttled, and it throttled to permanent silence.
 *
 * The policy here is per episode — the run of failing ticks between two known successful
 * ticks — and per stage: the first failure of a stage earns one report, repeats of that
 * stage stay quiet, and the still-failing episode says so once per `reminderMs`. Nothing is
 * ever permanently silenced while it is actually failing, and a successful tick resets the
 * whole thing.
 *
 * It owns no database and retries nothing: the server keeps issuing the same statements on
 * the next tick, a failed statement is still never replayed, and the managed store still
 * reopens on its next call (`ReconnectingPushStore`).
 *
 * Raw error text never leaves this module. Messages name file paths, endpoints and bound
 * values, so classification matches them against fixed patterns and discards them; what is
 * reported is a stage, a category from a closed list, and an optional exact SQLSTATE or
 * errno name.
 */
import { ManagedDatabaseError, ManagedWriterDeferredError } from "./managed/libpq";

/** The fixed stages of one monitor tick. A failure is attributed to exactly one. */
export type MonitorStage = "load-capacity" | "observe" | "pending-deliveries";

/** Closed vocabulary. Nothing outside this set can be reported or logged. */
export type MonitorFailureCategory =
  | "sqlite-busy"
  | "sqlite-corrupt"
  | "sqlite-schema"
  | "sqlite-error"
  | "managed-transport"
  | "managed-timeout"
  | "managed-lock-contention"
  | "managed-writer-deferred"
  | "managed-server"
  | "parse"
  | "filesystem"
  | "error";

/** Consecutive contended polls before the condition is treated as sustained. */
export const CONTENTION_ESCALATION_THRESHOLD = 4;
/** One reminder per episode per this interval, for as long as the episode lasts. */
export const MONITOR_REMINDER_MS = 30 * 60_000;

/** PostgreSQL's `lock_not_available`: the statement gave up on a lock instead of waiting. */
export const LOCK_CONTENTION_SQLSTATE = "55P03";
/** Statement cancelled by a bounded wait, rather than lost with the socket. */
const TIMEOUT_SQLSTATE = "57014";
/** The codes the managed transport raises when the socket itself is the problem. */
const TRANSPORT_SQLSTATES = new Set(["08001", "08003", "08006"]);
/** Exact SQLSTATE shape, so a driver's free text can never become a reported code. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Fixed errno names only: an unrecognized `code` property reports as plain `error`. */
const ERRNO_NAMES = new Set([
  "ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EMFILE", "ENOSPC", "EROFS", "EBADF", "ELOOP",
]);

function exact(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return allowed.has(upper) ? upper : undefined;
}

/**
 * An exact five-character SQLSTATE, compared in its canonical uppercase form so a driver
 * that reports `55p03` still classifies. Anything that is not exactly that shape is not a
 * code we are willing to print or report.
 */
export function normalizeSqlstate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return SQLSTATE.test(upper) ? upper : undefined;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && error.name === "SQLiteError" &&
    /(?:database is locked|database is busy)/iu.test(error.message);
}

/**
 * A declined writer try-lock is known before BEGIN. A PostgreSQL 55P03 raised by a
 * statement carries no such attribution, so keep its category distinct.
 */

export interface ClassifiedMonitorError {
  category: MonitorFailureCategory;
  /** Exact SQLSTATE for a managed failure, errno name for a filesystem one. */
  code?: string;
  /** Another writer holds the database: expected, gated, not reported on the first poll. */
  contention: boolean;
}

/**
 * Maps an error onto the closed vocabulary. `error.message` is read for these fixed patterns
 * only and is never returned, stored, printed or reported.
 */
export function classifyMonitorError(error: unknown): ClassifiedMonitorError {
  if (error instanceof ManagedDatabaseError) {
    const code = normalizeSqlstate(error.code);
    if (error instanceof ManagedWriterDeferredError) {
      return { category: "managed-writer-deferred", code, contention: true };
    }
    if (code === LOCK_CONTENTION_SQLSTATE) return { category: "managed-lock-contention", code, contention: true };
    if (code === TIMEOUT_SQLSTATE) return { category: "managed-timeout", code, contention: false };
    if (error.transport || (code !== undefined && TRANSPORT_SQLSTATES.has(code))) {
      return { category: "managed-transport", code, contention: false };
    }
    return { category: "managed-server", code, contention: false };
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "SQLiteError") {
    if (isSqliteBusy(error)) return { category: "sqlite-busy", contention: true };
    if (/file is not a database|file is encrypted/iu.test(message)) {
      return { category: "sqlite-corrupt", contention: false };
    }
    if (/no such (?:table|column|view)|has no column named/iu.test(message)) {
      return { category: "sqlite-schema", contention: false };
    }
    return { category: "sqlite-error", contention: false };
  }
  if (name === "SyntaxError") return { category: "parse", contention: false };
  const errno = exact((error as { code?: unknown } | undefined)?.code, ERRNO_NAMES);
  if (errno) return { category: "filesystem", code: errno, contention: false };
  return { category: "error", contention: false };
}

export interface MonitorFailureDecision {
  stage: MonitorStage;
  category: MonitorFailureCategory;
  code?: string;
  contention: boolean;
  /** Send one telemetry event. */
  report: boolean;
  /** Write the privacy-safe line: a first failure, a sustained escalation, or a reminder. */
  log: boolean;
  /** This report is the periodic reminder for an already-reported stage. */
  reminder: boolean;
  /** This contention run just crossed `CONTENTION_ESCALATION_THRESHOLD` polls. */
  escalated: boolean;
  /** Ticks this stage has failed in during the episode. */
  attempts: number;
  consecutiveContention: number;
  episodeFailures: number;
  episodeReports: number;
}

export interface MonitorFailurePolicyOptions {
  now?: () => number;
  reminderMs?: number;
}

interface StageState {
  attempts: number;
  reported: boolean;
  /** Per stage: a run of contended polls in this stage, clamped at the threshold. */
  consecutiveContention: number;
}

/**
 * Bounded by construction: one record per stage (three, always), counters, and one timestamp
 * — no signature table and no eviction. A successful tick clears all of it.
 */
export class MonitorFailurePolicy {
  private readonly now: () => number;
  private readonly reminderMs: number;
  private readonly stages = new Map<MonitorStage, StageState>();
  private startedAtMs?: number;
  private lastReminderAtMs?: number;
  private episodeFailures = 0;
  private episodeReports = 0;

  constructor(options: MonitorFailurePolicyOptions = {}) {
    this.now = options.now ?? Date.now;
    this.reminderMs = options.reminderMs ?? MONITOR_REMINDER_MS;
  }

  /** Records a failing tick in `stage` and says what is worth surfacing this time. */
  note(stage: MonitorStage, error: unknown): MonitorFailureDecision {
    const classified = classifyMonitorError(error);
    const now = this.now();
    if (this.startedAtMs === undefined) {
      this.startedAtMs = now;
      this.lastReminderAtMs = now;
    }
    this.episodeFailures++;

    // One gate for every "another writer has it" class: native SQLite's locked/busy and the
    // managed backend's 55P03. Any other failure breaks the run, as the old rule did.
    const state = this.stages.get(stage) ?? { attempts: 0, reported: false, consecutiveContention: 0 };
    state.attempts++;
    this.stages.set(stage, state);

    // The contention run belongs to the stage: a later stage must still get its own first
    // report rather than inherit a count another stage already saturated.
    let escalated = false;
    if (classified.contention) {
      const previous = state.consecutiveContention;
      const consecutive = Math.min(previous + 1, CONTENTION_ESCALATION_THRESHOLD);
      // Once, on the crossing — a run that stays locked must not report every later poll.
      escalated = consecutive === CONTENTION_ESCALATION_THRESHOLD && previous !== CONTENTION_ESCALATION_THRESHOLD;
      state.consecutiveContention = consecutive;
    } else {
      state.consecutiveContention = 0; // mixed errors cannot be added up towards the fourth
    }

    // The first failure of a stage reports; contention waits for the fourth consecutive
    // poll, exactly as SQLite's `database is locked` always has.
    const first = !state.reported && (!classified.contention || escalated);
    const reminder = !first && state.reported && now - (this.lastReminderAtMs ?? 0) >= this.reminderMs;
    const report = first || reminder;
    // The first contended poll says so in the log only: an operator sees the writer lock
    // arrive before the fourth poll decides whether it is sustained.
    const announce = classified.contention && state.attempts === 1 && !escalated;
    if (report) {
      state.reported = true;
      this.episodeReports++;
      if (reminder) this.lastReminderAtMs = now;
    }

    return {
      stage,
      category: classified.category,
      ...(classified.code ? { code: classified.code } : {}),
      contention: classified.contention,
      report,
      log: report || escalated || announce,
      reminder,
      escalated,
      attempts: state.attempts,
      consecutiveContention: state.consecutiveContention,
      episodeFailures: this.episodeFailures,
      episodeReports: this.episodeReports,
    };
  }

  /** A tick that completed its own work ends the episode and restores every report. */
  succeeded(): void {
    this.stages.clear();
    this.startedAtMs = undefined;
    this.lastReminderAtMs = undefined;
    this.episodeFailures = 0;
    this.episodeReports = 0;
  }

  snapshot(): { episodeFailures: number; episodeReports: number } {
    return { episodeFailures: this.episodeFailures, episodeReports: this.episodeReports };
  }
}

/**
 * The operator-facing line for a decision, built only from its bounded fields — the raw
 * error, its paths, endpoints and values, cannot reach the log through here.
 */
export function monitorFailureLine(decision: MonitorFailureDecision): string {
  const identity = `${decision.category}${decision.code ? ` ${decision.code}` : ""}`;
  const parts = [`push monitor: capacity check failed at ${decision.stage} (${identity})`];
  if (decision.attempts > 1) parts.push(`attempt ${String(decision.attempts)}`);
  if (decision.contention) {
    parts.push(`contention ${String(decision.consecutiveContention)}/${String(CONTENTION_ESCALATION_THRESHOLD)}`);
  }
  parts.push(`${String(decision.episodeFailures)} failure(s) this episode`);
  parts.push(decision.reminder ? "still failing" : "retrying next poll");
  return parts.join("; ");
}

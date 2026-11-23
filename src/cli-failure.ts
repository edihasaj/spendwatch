// The CLI turns an ordinary exception into an operational incident: the entrypoint
// reports every uncaught error as `spendwatch.cli.failure` and then rethrows a raw
// crash. That is right for a code fault, but wrong for the managed archive being briefly
// unreachable. The managed layer proves exactly that condition when it can — a bounded
// connect or query wait that elapsed, a send or consume that died on an established,
// authenticated connection, or a connect that libpq's own diagnostic reports as
// refused or reset — and marks the error `transient`. At this boundary that is an
// expected condition the next scheduled run retries, so it must not page as a crash.
//
// Everything the classification cannot affirm stays on the existing path: authentication,
// certificate, SSL-policy and other configuration faults are reported and rethrown,
// because silently exiting retry-later on a bad credential would hide a real outage.
// Ordinary SQL errors (constraint violations, bad input) were never transport-flagged
// and native SQLite never produces these errors at all, so both are unchanged.
import { ManagedDatabaseError } from "./managed/libpq";
import type { TelemetryOptions } from "./telemetry";

/** EX_UNAVAILABLE: the archive was unreachable; a later scheduled run should retry. */
export const TEMPORARY_DATABASE_FAILURE_EXIT_CODE = 69;

/**
 * The event for a temporarily unreachable archive. It is reported at `warning` under its
 * own name so a routine reconnect stays visible to the operator without joining, or
 * being mistaken for, the `spendwatch.cli.failure` issue that means a real defect.
 */
export const ARCHIVE_UNAVAILABLE_EVENT = "spendwatch.cli.archive-unavailable";

/**
 * True only when the managed layer affirmed a brief archive outage. `transport` alone is
 * not enough: it also covers the connect-phase failures a wrong credential or a refused
 * SSL policy produces, and those are configuration errors that must keep paging.
 */
export function isTemporaryDatabaseFailure(error: unknown): error is ManagedDatabaseError {
  return error instanceof ManagedDatabaseError && error.transient;
}

/** A five-character SQLSTATE is the only part of the error we are willing to print. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The line the CLI writes for a temporary database failure, and its exit code. Only the
 * SQLSTATE constant the managed layer chose is echoed; the driver's own text, which names
 * the host and can quote the user, never reaches the terminal.
 */
export function temporaryDatabaseFailure(error: ManagedDatabaseError): { message: string; exitCode: number } {
  const state = SQLSTATE.test(error.code) ? ` (${error.code})` : "";
  return {
    message: `spendwatch: archive database temporarily unavailable${state}; retry later`,
    exitCode: TEMPORARY_DATABASE_FAILURE_EXIT_CODE,
  };
}

/** The side effects the entrypoint owns, injected so the boundary is testable without a live database. */
export interface CliFailureSink {
  report: (
    event: string,
    error: unknown,
    tags: Record<string, string | undefined>,
    options?: TelemetryOptions,
  ) => Promise<unknown>;
  writeStderr: (line: string) => void;
}

/**
 * The entrypoint's one failure decision. An affirmed temporary failure writes a single
 * sanitized line and a bounded warning, then yields the retryable exit code; every other
 * error is reported under `spendwatch.cli.failure` and left for the caller to rethrow,
 * exactly as before. Returns undefined when the caller should rethrow.
 */
export async function handleCliFailure(
  error: unknown,
  argv: string[],
  sink: CliFailureSink,
): Promise<number | undefined> {
  const command = argv[0] ?? "report";
  if (isTemporaryDatabaseFailure(error)) {
    const { message, exitCode } = temporaryDatabaseFailure(error);
    sink.writeStderr(message + "\n");
    // One warning per failed command. The launch supervisor already bounds how often the
    // writer is retried, and the reporter groups this event into a single issue, so a
    // prolonged outage keeps reporting instead of going quiet.
    await sink.report(ARCHIVE_UNAVAILABLE_EVENT, error, {
      command, component: "managed-archive", status: "unavailable",
    }, { level: "warning" });
    return exitCode;
  }
  await sink.report("spendwatch.cli.failure", error, { command });
  return undefined;
}

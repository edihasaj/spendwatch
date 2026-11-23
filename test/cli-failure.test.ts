import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ManagedDatabaseError, PgConnection, isRefusalDiagnostic } from "../src/managed/libpq";
import { isDeadConnectionError } from "../src/push-store";
import { monthPeriod } from "../src/periods";
import {
  ARCHIVE_UNAVAILABLE_EVENT,
  handleCliFailure,
  isTemporaryDatabaseFailure,
  temporaryDatabaseFailure,
  TEMPORARY_DATABASE_FAILURE_EXIT_CODE,
} from "../src/cli-failure";
import { tempDir } from "./tmp";

// SPENDWATCH-3 (GlitchTip #587): the CLI entrypoint reported every uncaught error as
// `spendwatch.cli.failure` and rethrew a raw crash, so a managed archive that was briefly
// unreachable paged as a production defect. These tests pin the boundary in both
// directions: an affirmed outage is a sanitized retry, and anything the classification
// cannot affirm — above all a wrong credential — is still reported and rethrown.

const ROOT = join(import.meta.dir, "..");
const LIBPQ = process.env.SPENDWATCH_LIBPQ_PATH ??
  (process.platform === "darwin" ? "/opt/homebrew/opt/libpq/lib/libpq.5.dylib" : "libpq.so.5");
// The managed suites' isolated fixture owns this port; every live case below needs it.
const FIXTURE_PORT = "15487";
const LOCATION = `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed:`;
const REFUSED = `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: Connection refused\n`
  + "\tIs the server running on that host and accepting TCP/IP connections?";

function sinks() {
  const reports: Array<{ event: string; error: unknown; tags: Record<string, string | undefined>;
    options?: Record<string, unknown> }> = [];
  const stderr: string[] = [];
  return {
    reports,
    stderr,
    sink: {
      report: (event: string, error: unknown, tags: Record<string, string | undefined>,
        options?: Record<string, unknown>) => {
        reports.push({ event, error, tags, ...(options ? { options } : {}) });
        return Promise.resolve(true);
      },
      writeStderr: (line: string) => { stderr.push(line); },
    },
  };
}

describe("CLI failure boundary", () => {
  test("an affirmed archive outage is a sanitized retry and never a crash report", async () => {
    const { reports, stderr, sink } = sinks();
    const exit = await handleCliFailure(new ManagedDatabaseError("08006", true, true),
      ["report", "--sqlite", "/data/spendwatch.db"], sink);
    expect(exit).toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
    expect(reports.map((entry) => entry.event)).toEqual([ARCHIVE_UNAVAILABLE_EVENT]);
    // Visible to the operator as a warning, not as a defect.
    expect(reports[0]!.options).toEqual({ level: "warning" });
    expect(reports[0]!.tags).toEqual({ command: "report", component: "managed-archive", status: "unavailable" });
    // One plain line carrying only the SQLSTATE: never the driver's text, host or stack.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("archive database temporarily unavailable (08006)");
    expect(stderr[0]).toContain("retry later");
    expect(stderr[0]).not.toContain("Managed database operation failed");
  });

  test("only a SQLSTATE we typed is ever echoed", () => {
    const message = temporaryDatabaseFailure(new ManagedDatabaseError("server text", true, true)).message;
    expect(message).not.toContain("server text");
    expect(message).not.toMatch(/\(/);
  });

  test("everything the classification cannot affirm is still reported and rethrown", async () => {
    for (const error of [
      new ManagedDatabaseError("23505"),          // ordinary SQL error (constraint)
      new ManagedDatabaseError("08001", true),    // wrong credential, refused SSL policy, bad host
      new Error("bad input"),
    ]) {
      const { reports, stderr, sink } = sinks();
      expect(await handleCliFailure(error, ["report"], sink)).toBeUndefined();
      expect(reports.map((entry) => entry.event)).toEqual(["spendwatch.cli.failure"]);
      expect(reports[0]!.tags).toEqual({ command: "report" });
      expect(reports[0]!.options).toBeUndefined();
      expect(stderr).toEqual([]);
    }
  });

  test("classification needs the affirmative flag and leaves reconnect semantics alone", () => {
    expect(isTemporaryDatabaseFailure(new ManagedDatabaseError("57014", true, true))).toBe(true);
    expect(isTemporaryDatabaseFailure(new ManagedDatabaseError("08006", true, true))).toBe(true);
    expect(isTemporaryDatabaseFailure(new ManagedDatabaseError("08001", true))).toBe(false);
    expect(isTemporaryDatabaseFailure(new ManagedDatabaseError("23505"))).toBe(false);
    expect(isTemporaryDatabaseFailure(new Error("database is locked"))).toBe(false);
    expect(isTemporaryDatabaseFailure(undefined)).toBe(false);
    // `transport` still decides reconnection for both kinds, so a misconfigured
    // connection is discarded rather than replayed on the next call.
    expect(isDeadConnectionError(new ManagedDatabaseError("08001", true))).toBe(true);
    expect(isDeadConnectionError(new ManagedDatabaseError("08006", true, true))).toBe(true);
    expect(isDeadConnectionError(new ManagedDatabaseError("23505"))).toBe(false);
  });
});

describe("connect diagnostic classification", () => {
  test("admits only a socket-level refusal or reset against the pinned endpoint", () => {
    expect(isRefusalDiagnostic(REFUSED, LOCATION)).toBe(true);
    expect(isRefusalDiagnostic(`connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: `
      + "Connection reset by peer", LOCATION)).toBe(true);
    // Observed against the live fixture: when the listener disappears mid-handshake —
    // a restarting or dying archive — libpq reports the errno from the read instead.
    expect(isRefusalDiagnostic(`connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: `
      + "could not receive data from server: Connection refused", LOCATION)).toBe(true);
    expect(isRefusalDiagnostic(`connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: `
      + "could not connect to server: Connection refused", LOCATION)).toBe(true);
  });

  test("rejects the diagnostics a misconfiguration produces", () => {
    for (const diagnostic of [
      `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: FATAL:  password `
        + 'authentication failed for user "spendwatch"',
      `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: fe_sendauth: `
        + "no password supplied",
      `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: server does not `
        + "support SSL, but SSL was required",
      `connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: certificate verify failed`,
      'could not translate host name "db.internal" to address: nodename nor servname provided',
      "server closed the connection unexpectedly",
      "timeout expired",
      "connection to server at \"127.0.0.1\", port 15487 failed: could not receive data from server: "
        + "Host is down",
      "",
    ]) expect(isRefusalDiagnostic(diagnostic, LOCATION)).toBe(false);
  });

  test("rejects another endpoint, a mixed diagnostic and an oversized one", () => {
    expect(isRefusalDiagnostic(REFUSED, 'connection to server at "127.0.0.1", port 6543 failed:')).toBe(false);
    expect(isRefusalDiagnostic(REFUSED.replace('"127.0.0.1"', '"10.9.8.7"'), LOCATION)).toBe(false);
    // A second, different explanation line means the driver reported more than one thing.
    expect(isRefusalDiagnostic(REFUSED + "\n\tand the certificate expired", LOCATION)).toBe(false);
    expect(isRefusalDiagnostic(REFUSED + "\n\tIs the server running on that host and accepting TCP/IP connections?",
      LOCATION)).toBe(false);
    expect(isRefusalDiagnostic("x".repeat(513) + REFUSED, LOCATION)).toBe(false);
    // A refusal mixed with a real rejection is ambiguous and must stay a reported failure,
    // in either order, so a credential fault can never hide behind a transport line.
    expect(isRefusalDiagnostic(REFUSED
      + '\n\tFATAL:  password authentication failed for user "spendwatch"', LOCATION)).toBe(false);
    expect(isRefusalDiagnostic(`connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: `
      + 'FATAL:  password authentication failed for user "spendwatch"\n\tConnection refused',
      LOCATION)).toBe(false);
    expect(isRefusalDiagnostic(`connection to server at "127.0.0.1", port ${FIXTURE_PORT} failed: `
      + "Connection refused after FATAL: too many connections", LOCATION)).toBe(false);
  });
});

// ---- live transport cases: real libpq against loopback fixtures only ----

interface Captured { message: string; level: string; tags: Record<string, string> }

/**
 * An HTTPS collector on loopback, because the production reporter admits only an `https`
 * DSN. Its leaf chains to a throwaway root the child is told about through
 * NODE_EXTRA_CA_CERTS alone: verification stays on and nothing is loosened in the reporter.
 */
function collector(): { dsn: string; events: Captured[]; caFile: string; stop: () => void } | undefined {
  const root = tempDir("spendwatch-telemetry-ca-");
  const run = (args: string[]) => Bun.spawnSync(["openssl", ...args], { cwd: root });
  const made = run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key",
    "-out", "root.pem", "-days", "2", "-subj", "/CN=Spendwatch test root"]).exitCode === 0
    && run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr",
      "-subj", "/CN=localhost"]).exitCode === 0
    && (() => {
      writeFileSync(join(root, "leaf.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n"
        + "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
      return run(["x509", "-req", "-in", "leaf.csr", "-CA", "root.pem", "-CAkey", "root.key",
        "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext"]).exitCode === 0;
    })();
  if (!made) return undefined;
  const events: Captured[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(join(root, "leaf.key")), cert: Bun.file(join(root, "leaf.pem")) },
    fetch: async (request) => {
      const body = await request.json().catch(() => undefined) as Captured | undefined;
      if (body?.message) events.push({ message: body.message, level: body.level, tags: body.tags ?? {} });
      return new Response(null, { status: 200 });
    },
  });
  return {
    dsn: `https://pk@127.0.0.1:${server.port}/99999999`,
    events,
    caFile: join(root, "root.pem"),
    stop: () => server.stop(true),
  };
}

function managedConfig(root: string, connection: Record<string, string>, databasePath: string): string {
  const configPath = join(root, "managed.json");
  writeFileSync(configPath, JSON.stringify({ path: databasePath, connection, localFixture: true }), { mode: 0o600 });
  return configPath;
}

function archivedReport(root: string): string {
  const period = monthPeriod("2026-08");
  const report = {
    period, source: "studio:codex", totalTokens: 100, totalCost: 1, apiCalls: 1, observedCalls: 1,
    sessions: 1, tools: [], bash: [], deep: [], targets: [], prompts: [], projects: [],
    accounts: [], models: [], sinceTs: period.from,
  };
  const inputPath = join(root, "report.json");
  writeFileSync(inputPath, JSON.stringify([report]));
  return inputPath;
}

/**
 * Async on purpose: the collector above is served from this test process, and a
 * synchronous spawn would park the event loop so the child's report could never land.
 */
async function runCli(args: string[], env: Record<string, string | undefined>) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of ["SPENDWATCH_SENTRY_DSN", "SPENDWATCH_CAPTURE_GUARDS", "SPENDWATCH_TEST_PG_CONFIG"]) {
    if (!(key in env)) delete childEnv[key];
  }
  const child = Bun.spawn([process.execPath, join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT, env: childEnv, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Claims the isolated fixture port so a case below can own it; undefined when it is busy. */
function claimFixturePort(onData?: (socket: { write: (bytes: Uint8Array) => void }) => void) {
  try {
    return Bun.listen({ hostname: "127.0.0.1", port: Number(FIXTURE_PORT), socket: { data: onData ?? (() => {}) } });
  } catch { return undefined; }
}

const hasTransport = existsSync(LIBPQ);

// The archive is unreachable: nothing answers on the isolated loopback port. When the
// managed suites' real fixture owns that port these cases cannot hold, so they skip.
const offline = hasTransport && !process.env.SPENDWATCH_TEST_PG_CONFIG ? describe : describe.skip;
offline("report CLI against an unreachable managed archive", () => {
  test("a refused archive retries later instead of reporting an incident", async () => {
    const claimed = claimFixturePort();
    expect(claimed).toBeDefined();
    claimed!.stop(true); // now the port has no listener at all
    const root = tempDir("spendwatch-cli-refused-");
    const databasePath = join(root, "remote.db");
    const configPath = managedConfig(root, {
      host: "127.0.0.1", port: FIXTURE_PORT, dbname: "spendwatch_test_absent", user: "spendwatch",
    }, databasePath);
    const inputPath = archivedReport(root);
    const captured = collector();
    expect(captured).toBeDefined();
    try {
      const out = await runCli(["report", "--input", inputPath, "--sqlite", databasePath], {
        SPENDWATCH_MANAGED_DATABASE_CONFIG: configPath,
        SPENDWATCH_SENTRY_DSN: captured!.dsn,
        NODE_EXTRA_CA_CERTS: captured!.caFile,
      });
      expect(out.exitCode).toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
      expect(out.stderr.trim().split("\n")).toHaveLength(1);
      expect(out.stderr).toContain("archive database temporarily unavailable");
      expect(out.stderr).toContain("retry later");
      // Sanitized: no host, no driver text, no crash.
      expect(out.stderr).not.toContain("127.0.0.1");
      expect(out.stderr).not.toContain("spendwatch_test_absent");
      expect(out.stderr).not.toContain("Connection refused");
      expect(out.stderr).not.toContain("Managed database operation failed");
      // Exactly one warning, and never an incident report.
      expect(captured!.events).toEqual([{
        message: ARCHIVE_UNAVAILABLE_EVENT, level: "warning",
        tags: { service: "spendwatch", error_type: "ManagedDatabaseError",
          command: "report", component: "managed-archive", status: "unavailable" },
      }]);
    } finally { captured!.stop(); }
  }, 30_000);

  test("a half-open archive that never answers hits the bounded wait and retries", async () => {
    // Accepts the TCP socket and stays silent, so the handshake cannot complete.
    const claimed = claimFixturePort();
    expect(claimed).toBeDefined();
    const root = tempDir("spendwatch-cli-stalled-");
    const databasePath = join(root, "remote.db");
    const configPath = managedConfig(root, {
      host: "127.0.0.1", port: FIXTURE_PORT, dbname: "spendwatch_test_absent", user: "spendwatch",
    }, databasePath);
    const inputPath = archivedReport(root);
    try {
      const out = await runCli(["report", "--input", inputPath, "--sqlite", databasePath], {
        SPENDWATCH_MANAGED_DATABASE_CONFIG: configPath,
      });
      expect(out.exitCode).toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
      expect(out.stderr).toContain("archive database temporarily unavailable (57014)");
    } finally { claimed!.stop(true); }
  }, 60_000);

  test("the warning is really delivered over verified TLS, not assumed", async () => {
    const claimed = claimFixturePort();
    expect(claimed).toBeDefined();
    claimed!.stop(true);
    const root = tempDir("spendwatch-cli-noca-");
    const databasePath = join(root, "remote.db");
    const configPath = managedConfig(root, {
      host: "127.0.0.1", port: FIXTURE_PORT, dbname: "spendwatch_test_absent", user: "spendwatch",
    }, databasePath);
    const inputPath = archivedReport(root);
    const captured = collector();
    expect(captured).toBeDefined();
    try {
      // Same run without the test root: the child must refuse the certificate, so a
      // captured event above is a delivered report rather than an unverified connection.
      const out = await runCli(["report", "--input", inputPath, "--sqlite", databasePath], {
        SPENDWATCH_MANAGED_DATABASE_CONFIG: configPath,
        SPENDWATCH_SENTRY_DSN: captured!.dsn,
      });
      expect(out.exitCode).toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
      expect(captured!.events).toEqual([]);
    } finally { captured!.stop(); }
  }, 30_000);
});

// The isolated loopback PostgreSQL fixture (see docs/managed-database.md). Ordinary
// `bun test` skips this suite; with the fixture configured it must run, because it is
// the case that proves the retry path was not widened over a misconfiguration.
const fixture = process.env.SPENDWATCH_TEST_PG_CONFIG;
const live = hasTransport && fixture ? describe : describe.skip;
live("report CLI against a managed archive that rejects the credential", () => {
  test("a wrong password stays a reported failure instead of a silent retry", async () => {
    const admin = JSON.parse(readFileSync(fixture!, "utf8")) as Record<string, string>;
    const root = tempDir("spendwatch-cli-auth-");
    const databasePath = join(root, "remote.db");
    const connection = {
      host: "127.0.0.1", port: FIXTURE_PORT, dbname: "postgres",
      user: admin.user ?? "spendwatch", password: "wrong-on-purpose",
    };
    // Guard against a trust-auth fixture, which cannot prove the negative: if the wrong
    // password connects, the case is skipped rather than asserted either way.
    // If the fixture accepted the wrong password the case could not prove anything, so it
    // fails loudly here instead of asserting a behaviour the fixture cannot exhibit.
    let accepted = false;
    try { new PgConnection(connection, 5_000).close(); accepted = true; } catch { /* rejected, as intended */ }
    expect(accepted).toBe(false);

    const configPath = managedConfig(root, connection, databasePath);
    const inputPath = archivedReport(root);
    const captured = collector();
    expect(captured).toBeDefined();
    try {
      const out = await runCli(["report", "--input", inputPath, "--sqlite", databasePath], {
        SPENDWATCH_MANAGED_DATABASE_CONFIG: configPath,
        SPENDWATCH_SENTRY_DSN: captured!.dsn,
        NODE_EXTRA_CA_CERTS: captured!.caFile,
      });
      // The operator still gets the incident: not exit 69, reported as a failure at error.
      expect(out.exitCode).not.toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
      expect(out.stderr).not.toContain("temporarily unavailable");
      expect(captured!.events.map((event) => [event.message, event.level]))
        .toEqual([["spendwatch.cli.failure", "error"]]);
    } finally { captured!.stop(); }
  }, 30_000);
});

describe("report CLI reports an unexpected failure", () => {
  test("a malformed input still pages as an error-level incident", async () => {
    const root = tempDir("spendwatch-cli-crash-");
    const inputPath = join(root, "broken.json");
    writeFileSync(inputPath, "{ not json");
    const captured = collector();
    expect(captured).toBeDefined();
    try {
      const out = await runCli(["report", "--input", inputPath, "--sqlite", join(root, "remote.db")], {
        SPENDWATCH_SENTRY_DSN: captured!.dsn,
        NODE_EXTRA_CA_CERTS: captured!.caFile,
      });
      expect(out.exitCode).not.toBe(TEMPORARY_DATABASE_FAILURE_EXIT_CODE);
      expect(captured!.events.map((event) => [event.message, event.level]))
        .toEqual([["spendwatch.cli.failure", "error"]]);
    } finally { captured!.stop(); }
  }, 30_000);
});

// Starts a disposable PostgreSQL 18 for the managed contention and libpq regressions, runs them, and takes the
// fixture down again. The tests stay honest: they read SPENDWATCH_TEST_PG_CONFIG and refuse any endpoint that is
// not the owned loopback fixture on 15487, so this script cannot point them at a serving database. Nothing here
// reads a real credential, a managed database config or a provider endpoint: the password is generated per run
// and handed to Docker through the child's environment, the cluster lives on a tmpfs, and cleanup removes only
// the container and scratch this run named.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PgConnection } from "../src/managed/libpq";

const IMAGE = "postgres:18-alpine";
const HOST = "127.0.0.1";
const PORT = "15487";
const USER = "postgres";
/** PostgreSQL 18 keeps its cluster below this directory; the older images mounted the cluster path itself. */
const PGDATA_PARENT = "/var/lib/postgresql";
const READY_MS = 60_000;
const READY_POLL_MS = 500;
const DOCKER_MS = 120_000;
const PULL_MS = 600_000;
const TESTS_MS = 900_000;
const TESTS = ["test/managed-libpq.test.ts", "test/managed-push-contention.test.ts"];
/** Machine state a managed session must never inherit into a fixture run. */
const STRIPPED_ENV = [
  "SPENDWATCH_MANAGED_DATABASE_CONFIG", "SPENDWATCH_ARCHIVE_COMMIT_URL", "SPENDWATCH_ARCHIVE_COMMIT_TOKEN",
];

/** Raised for anything that means the proof could not be produced: reported as a failure, never a skip. */
class FixtureUnavailable extends Error {}
/** Set by a signal; it stops the work in flight, and cleanup then runs once from the `finally`. */
class Interrupted extends Error {}

/**
 * The child this run is waiting on. A signal terminates that one child instead of starting a second cleanup
 * that would race a container the main flow is still creating, so teardown happens exactly once, below.
 */
let current: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: string | undefined;

function terminate(child: ReturnType<typeof Bun.spawn>): void {
  child.kill(15);
  setTimeout(() => child.kill(9), 3_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interrupted ??= signal;
    if (current) terminate(current);
  });
}

/**
 * Runs `command` to completion, bounded: the deadline escalates to SIGKILL so a hung `docker` call can neither
 * wedge this run nor keep the fixture alive, and a signal terminates the same child the flow is awaiting.
 * `environment` carries the run's synthetic password, which then never appears in the argument vector that
 * `ps` shows to every local user. A `critical` command is teardown: it is never terminated by the interrupt
 * latch and never becomes the signal handler's target, because killing teardown is what leaves a fixture behind.
 */
async function run(
  command: string[], timeoutMs: number, environment?: Record<string, string>, critical = false,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, {
    stdout: "pipe", stderr: "pipe", ...(environment ? { env: { ...process.env, ...environment } } : {}),
  });
  if (!critical) current = child;
  const deadline = setTimeout(() => terminate(child), timeoutMs);
  if (interrupted && !critical) terminate(child);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  clearTimeout(deadline);
  if (!critical) current = undefined;
  return { code, output: (stdout + stderr).trim() };
}

function tail(output: string, lines = 3): string {
  return output.split("\n").filter(Boolean).slice(-lines).join(" | ");
}

/** The container must answer a real libpq query before a test is allowed to open it. */
async function waitForServer(name: string, config: Record<string, string>): Promise<void> {
  const deadline = Date.now() + READY_MS;
  let last = "no readiness probe completed";
  while (Date.now() < deadline) {
    if (interrupted) throw new Interrupted(interrupted);
    const ready = await run(["docker", "exec", name, "pg_isready", "-q", "-h", "127.0.0.1", "-U", USER], 15_000);
    if (ready.code === 0) {
      // `pg_isready` answers as soon as the postmaster accepts; the driver must finish a query.
      try {
        const probe = new PgConnection(config, 5_000);
        try { if (probe.query("SELECT current_database() AS name").rows[0]?.name === config.dbname) return; }
        finally { probe.close(); }
        last = "the fixture answered with an unexpected result";
      } catch (error) { last = (error as Error).name + ": " + (error as Error).message; }
    } else {
      const state = await run(["docker", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name], 15_000);
      if (state.code === 0 && !state.output.startsWith("running")) last = `container ${state.output}`;
    }
    await Bun.sleep(READY_POLL_MS);
  }
  throw new FixtureUnavailable(`no ready server on ${HOST}:${PORT} within ${READY_MS / 1000}s (${last})`);
}

const token = randomBytes(6).toString("hex");
const name = `spendwatch-managed-fixture-${token}`;
const database = `spendwatch_fixture_${token}`;
const password = "spw-fixture-" + randomBytes(18).toString("base64url");
const scratch = mkdtempSync("/tmp/spendwatch-managed-fixture-");
const cidFile = join(scratch, "container.id");

/**
 * The single teardown, called once from the `finally` after every awaited command has settled. It removes only
 * what this run created: the name is random per run, so it can never name someone else's container, and it is
 * attempted even when `docker run` reported failure, because a container exists before the command returns.
 */
async function cleanup(): Promise<void> {
  let id = "";
  try { id = readFileSync(cidFile, "utf8").trim(); } catch {}
  current = undefined;
  if (id) await run(["docker", "rm", "-f", id], 30_000, undefined, true);
  await run(["docker", "rm", "-f", name], 30_000, undefined, true);
  rmSync(scratch, { recursive: true, force: true });
}

try {
  const docker = await run(["docker", "version", "--format", "{{.Server.Version}}"], 30_000);
  if (docker.code !== 0) throw new FixtureUnavailable("the Docker daemon is not reachable: " + tail(docker.output));

  const present = await run(["docker", "image", "inspect", IMAGE], 30_000);
  if (present.code !== 0) {
    console.log(`Pulling ${IMAGE} ...`);
    const pulled = await run(["docker", "pull", IMAGE], PULL_MS);
    if (pulled.code !== 0) throw new FixtureUnavailable(`could not pull ${IMAGE}: ${tail(pulled.output)}`);
  }

  const config = { host: HOST, port: PORT, dbname: database, user: USER, password, sslmode: "prefer" };
  const configPath = join(scratch, "fixture.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

  // Ephemeral by construction: the cluster lives on a tmpfs, there is no volume, and the port is loopback-only.
  // Docker refuses the published bind when another container holds 15487, and a server this run does not own
  // cannot complete the readiness probe below, because it does not know the password generated for this run.
  const up = await run([
    "docker", "run", "-d", "--name", name, "--cidfile", cidFile,
    "--label", "com.spendwatch.fixture=managed-contention",
    "--label", `com.spendwatch.run=${token}`,
    "--tmpfs", PGDATA_PARENT,
    "-p", `${HOST}:${PORT}:5432`,
    "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB",
    IMAGE,
  ], DOCKER_MS, { POSTGRES_PASSWORD: password, POSTGRES_DB: database });
  if (interrupted) throw new Interrupted(interrupted);
  if (up.code !== 0) throw new FixtureUnavailable(`could not start the fixture: ${tail(up.output)}`);

  await waitForServer(name, config);
  console.log(`Managed fixture ready on ${HOST}:${PORT} (${IMAGE})`);

  // The tests' own temporary trees stay inside this run's scratch, which cleanup removes.
  const testTmp = join(scratch, "tmp");
  mkdirSync(testTmp);
  const env: Record<string, string | undefined> = {
    ...process.env, SPENDWATCH_TEST_PG_CONFIG: configPath, TMPDIR: testTmp,
  };
  for (const key of STRIPPED_ENV) delete env[key];
  const tests = Bun.spawn(["bun", "test", ...TESTS], {
    cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit", env,
  });
  current = tests;
  const testDeadline = setTimeout(() => terminate(tests), TESTS_MS);
  if (interrupted) terminate(tests);
  const code = await tests.exited;
  clearTimeout(testDeadline);
  current = undefined;
  if (interrupted) throw new Interrupted(interrupted);
  if (code !== 0) {
    console.error(`Managed fixture tests failed (exit ${code ?? "signalled"}).`);
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof Interrupted) {
    console.error(`Managed fixture interrupted by ${error.message}; tearing the fixture down.`);
    process.exitCode = 130;
  } else if (error instanceof FixtureUnavailable) {
    console.error(`Managed fixture unavailable: ${error.message}`);
    console.error("The managed contention and libpq proof did not run; this is a failure, not a skip.");
    process.exitCode = 2;
  } else throw error;
} finally {
  await cleanup();
}

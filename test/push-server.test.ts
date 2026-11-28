import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENTION_ESCALATION_THRESHOLD,
  LOCK_CONTENTION_SQLSTATE,
  MonitorFailurePolicy,
  classifyMonitorError,
  monitorFailureLine,
  type MonitorFailureDecision,
} from "../src/monitor-failure-policy";
import { ManagedDatabaseError, ManagedWriterDeferredError } from "../src/managed/libpq";
import { createCapacityMonitor } from "../src/push-server";
import { PushStore, ReconnectingPushStore } from "../src/push-store";
import { reportOperationalError } from "../src/telemetry";
import { tempDir } from "./tmp";

/** One weekly window, so `observe` writes alert state and can meet a real write lock. */
const capacityRecord = {
  provider: "codex",
  account: "work@example.com",
  usage: {
    accountEmail: "work@example.com",
    loginMethod: "pro",
    updatedAt: "2026-08-22T00:00:00Z",
    primary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: "2026-08-30T00:00:00Z" },
  },
};
const VALID_CAPACITY = JSON.stringify([capacityRecord]);

function file(name: string): string {
  return join(tempDir(`spendwatch-monitor-${name}-`), name);
}

/** Bun's driver tags its own failures this way; a fake has to say the same thing. */
function sqliteError(message: string): Error {
  return Object.assign(new Error(message), { name: "SQLiteError" });
}

interface Drive {
  tick: () => Promise<void>;
  reports: MonitorFailureDecision[];
  lines: string[];
  snapshot: () => ReturnType<MonitorFailurePolicy["snapshot"]>;
  advance: (ms: number) => void;
}

/** Drives real `createCapacityMonitor` ticks with the clock, reports and log observed. */
function drive(options: {
  capacityPath: string;
  store: Pick<ReconnectingPushStore, "use">;
  reminderMs?: number;
}): Drive {
  let clock = Date.parse("2026-08-22T00:00:00Z");
  const reports: MonitorFailureDecision[] = [];
  const lines: string[] = [];
  const monitor = createCapacityMonitor({
    capacityPath: options.capacityPath,
    store: options.store,
    policy: new MonitorFailurePolicy({ now: () => clock, reminderMs: options.reminderMs }),
    reportFailure: (_error, decision) => { reports.push(decision); },
    log: (line) => { lines.push(line); },
  });
  return {
    tick: () => monitor.tick(),
    reports,
    lines,
    snapshot: () => monitor.policy.snapshot(),
    advance: (ms) => { clock += ms; },
  };
}

function fakeStore(fail: { observe?: () => unknown; pending?: () => unknown } = {}): Pick<ReconnectingPushStore, "use"> {
  return {
    use<T>(run: (store: PushStore) => T): T {
      const store = {
        observe: () => { fail.observe?.(); return 0; },
        pendingDeliveries: () => (fail.pending?.() ?? []) as never,
      } as unknown as PushStore;
      return run(store);
    },
  };
}

async function tick(h: Drive, times: number): Promise<void> {
  for (let index = 0; index < times; index++) await h.tick();
}

describe("capacity monitor real ticks", () => {
  test("a good tick against a temp SQLite reports and logs nothing", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const pushes = new ReconnectingPushStore(file("push.db"));
    const h = drive({ capacityPath, store: pushes });

    await tick(h, 3);

    expect(h.reports).toEqual([]);
    expect(h.lines).toEqual([]);
    expect(h.snapshot()).toEqual({ episodeFailures: 0, episodeReports: 0 });
    expect(pushes.use((store) => store.db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM push_account_state",
    ).get())?.n).toBe(1);
    pushes.close();
  });

  test("one malformed capacity file reports once, reminds, and starts a new episode after a good tick", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, "{ not json");
    const pushes = new ReconnectingPushStore(file("push.db"));
    const h = drive({ capacityPath, store: pushes, reminderMs: 30 * 60_000 });

    await tick(h, 30);

    // The old code produced 30 events and 30 log lines here.
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "load-capacity", category: "parse", contention: false, report: true, reminder: false,
    });
    expect(h.lines).toHaveLength(1);

    h.advance(29 * 60_000);
    await h.tick();
    expect(h.reports).toHaveLength(1); // the reminder is rate bound, not per poll
    h.advance(2 * 60_000);
    await h.tick();
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]).toMatchObject({ stage: "load-capacity", category: "parse", reminder: true });
    await tick(h, 10);
    expect(h.reports).toHaveLength(2); // and repeats stay quiet again

    writeFileSync(capacityPath, VALID_CAPACITY);
    await h.tick();
    expect(h.snapshot()).toEqual({ episodeFailures: 0, episodeReports: 0 });

    writeFileSync(capacityPath, "{ still not json");
    await h.tick();
    expect(h.reports).toHaveLength(3);
    expect(h.reports[2]).toMatchObject({ reminder: false, escalated: false });
    pushes.close();
  });

  test("a missing capacity file names the errno but never the path or the message", async () => {
    const capacityPath = join(tempDir("spendwatch-monitor-absent-"), "absent.json");
    const pushes = new ReconnectingPushStore(file("push.db"));
    const h = drive({ capacityPath, store: pushes });

    await tick(h, 5);

    expect(h.reports.map((decision) => [decision.stage, decision.category, decision.code]))
      .toEqual([["load-capacity", "filesystem", "ENOENT"]]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("filesystem ENOENT");
    expect(h.lines[0]).not.toContain(capacityPath);
    expect(h.lines[0]).not.toContain("no such file or directory");
    pushes.close();
  });

  test("a file that is not a database reports once at the observation step", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const corrupt = file("corrupt.db");
    writeFileSync(corrupt, "this is not a sqlite database file at all");
    const pushes = new ReconnectingPushStore(corrupt);
    const h = drive({ capacityPath, store: pushes });

    await tick(h, 8);

    expect(h.reports.map((decision) => [decision.stage, decision.category]))
      .toEqual([["observe", "sqlite-corrupt"]]);
    expect(h.lines).toHaveLength(1);
    pushes.close();
  });

  test("a damaged push schema reports once at the delivery step", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const pushes = new ReconnectingPushStore(file("push.db"));
    pushes.use((store) => store.db.exec("DROP TABLE push_deliveries"));
    const h = drive({ capacityPath, store: pushes });

    await tick(h, 8);

    expect(h.reports.map((decision) => [decision.stage, decision.category, decision.code]))
      .toEqual([["pending-deliveries", "sqlite-schema", undefined]]);
    expect(h.lines).toHaveLength(1);
    pushes.close();
  });

  test("a real write lock keeps the fourth-poll throttle and resets on a good tick", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const databasePath = file("push.db");
    const pushes = new ReconnectingPushStore(databasePath, (path) => {
      const store = new PushStore(path);
      store.db.exec("PRAGMA busy_timeout = 1;");
      return store;
    });
    pushes.use((store) => store.db.query<{ ok: number }, []>("SELECT 1 AS ok").get());
    const blocker = new Database(databasePath);
    blocker.exec("PRAGMA journal_mode = WAL;");
    blocker.exec("BEGIN IMMEDIATE;");
    const h = drive({ capacityPath, store: pushes, reminderMs: 30 * 60_000 });

    await tick(h, CONTENTION_ESCALATION_THRESHOLD - 1);
    expect(h.reports).toEqual([]);          // the pre-existing first-three-polls silence
    expect(h.lines).toHaveLength(1);         // one quiet line, not one per poll

    await h.tick();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "observe", category: "sqlite-busy", contention: true, escalated: true,
      consecutiveContention: CONTENTION_ESCALATION_THRESHOLD,
    });
    await tick(h, 20);
    expect(h.reports).toHaveLength(1);       // sustained contention never reports per poll
    expect(h.lines).toHaveLength(2);

    blocker.exec("ROLLBACK;");
    blocker.close();
    await h.tick();                          // a known successful tick ends the episode
    expect(h.snapshot()).toEqual({ episodeFailures: 0, episodeReports: 0 });

    const second = new Database(databasePath);
    second.exec("BEGIN IMMEDIATE;");
    await tick(h, CONTENTION_ESCALATION_THRESHOLD);
    expect(h.reports).toHaveLength(2);       // the next episode earns its own escalation
    second.exec("ROLLBACK;");
    second.close();
    pushes.close();
  });
});

describe("capacity monitor managed failure classes", () => {
  test("a declined managed writer lock is reported separately with the same cadence", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    let contended = true;
    const store = fakeStore({
      observe: () => { if (contended) throw new ManagedWriterDeferredError(); },
    });
    const h = drive({ capacityPath, store, reminderMs: 30 * 60_000 });

    await tick(h, CONTENTION_ESCALATION_THRESHOLD - 1);
    expect(h.reports).toEqual([]);
    expect(h.lines).toHaveLength(1);

    await h.tick();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "observe", category: "managed-writer-deferred", code: "55P03",
      contention: true, escalated: true,
    });
    await tick(h, 20);
    expect(h.reports).toHaveLength(1);

    h.advance(30 * 60_000);
    await h.tick();                          // a long episode keeps reminding, rate bound
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]).toMatchObject({ category: "managed-writer-deferred", reminder: true });
    h.advance(10 * 60_000);
    await tick(h, 5);
    expect(h.reports).toHaveLength(2);

    contended = false;
    await h.tick();
    expect(h.snapshot().episodeFailures).toBe(0);
    contended = true;
    await tick(h, CONTENTION_ESCALATION_THRESHOLD);
    expect(h.reports).toHaveLength(3);
  });

  test("an ordinary managed failure is not contention and reports at once with its SQLSTATE", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const h = drive({
      capacityPath,
      store: fakeStore({ observe: () => { throw new ManagedDatabaseError("42P01"); } }),
    });

    await tick(h, 6);

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      stage: "observe", category: "managed-server", code: "42P01", contention: false, escalated: false,
    });
    expect(monitorFailureLine(h.reports[0]!)).toContain("managed-server 42P01");
  });

  test("a dead managed connection reopens on the next tick without replaying the statement", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    const probes: { observeCalls: number; pendingCalls: number; closed: number }[] = [];
    const pushes = new ReconnectingPushStore(file("push.db"), (path) => {
      const probe = { observeCalls: 0, pendingCalls: 0, closed: 0 };
      probes.push(probe);
      const dead = probes.length === 1;
      void path;
      return {
        observe: () => {
          probe.observeCalls++;
          if (dead) throw new ManagedDatabaseError("08006", true);
        },
        pendingDeliveries: () => { probe.pendingCalls++; return []; },
        close: () => { probe.closed++; },
      } as unknown as PushStore;
    });
    const h = drive({ capacityPath, store: pushes });

    await h.tick();
    expect(h.reports.map((decision) => [decision.stage, decision.category, decision.code]))
      .toEqual([["observe", "managed-transport", "08006"]]);
    expect(probes[0]!.observeCalls).toBe(1); // never replayed on the connection that died
    expect(probes[0]!.closed).toBe(1);

    await h.tick();                          // the holder recognized the death and reopened
    expect(probes).toHaveLength(2);
    expect(probes[1]!.observeCalls).toBe(1);
    expect(h.reports).toHaveLength(1);       // recovery adds no event
    expect(h.snapshot()).toEqual({ episodeFailures: 0, episodeReports: 0 });
    pushes.close();
  });

  test("only an exact SQLSTATE becomes a code", () => {
    expect(classifyMonitorError(new ManagedDatabaseError("not a code!")))
      .toEqual({ category: "managed-server", contention: false });
    expect(classifyMonitorError(new ManagedDatabaseError("55p03")))
      .toEqual({ category: "managed-lock-contention", code: "55P03", contention: true });
    expect(classifyMonitorError(new ManagedDatabaseError("08001", true)))
      .toEqual({ category: "managed-transport", code: "08001", contention: false });
    expect(classifyMonitorError(new ManagedDatabaseError("57014", true, true)))
      .toEqual({ category: "managed-timeout", code: "57014", contention: false });
  });
});

describe("capacity monitor episode bounds", () => {
  test("a saturated contention run in one stage never costs another stage its first report", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    let blocked: "observe" | "pending" = "observe";
    const store = fakeStore({
      observe: () => { if (blocked === "observe") throw sqliteError("database is locked"); },
      pending: () => { if (blocked === "pending") throw sqliteError("database is busy"); },
    });
    const h = drive({ capacityPath, store });

    await tick(h, CONTENTION_ESCALATION_THRESHOLD);
    expect(h.reports.map((decision) => [decision.stage, decision.consecutiveContention]))
      .toEqual([["observe", CONTENTION_ESCALATION_THRESHOLD]]);

    blocked = "pending";
    await tick(h, CONTENTION_ESCALATION_THRESHOLD); // its own fourth poll still reports
    expect(h.reports.map((decision) => decision.stage))
      .toEqual(["observe", "pending-deliveries"]);
    expect(h.reports[1]).toMatchObject({ category: "sqlite-busy", escalated: true, reminder: false });

    await tick(h, 10);
    expect(h.reports).toHaveLength(2);
  });

  test("each stage earns one first report and repeats add nothing", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, "{ nope");
    let mode: "observe" | "pending" | "ok" = "ok";
    const store = fakeStore({
      observe: () => { if (mode === "observe") throw new ManagedDatabaseError("42P01"); },
      pending: () => { if (mode === "pending") throw sqliteError("no such table: push_deliveries"); },
    });
    const h = drive({ capacityPath, store, reminderMs: 30 * 60_000 });

    await h.tick();
    writeFileSync(capacityPath, VALID_CAPACITY);
    mode = "observe";
    await h.tick();
    mode = "pending";
    await h.tick();
    expect(h.reports.map((decision) => decision.stage))
      .toEqual(["load-capacity", "observe", "pending-deliveries"]);
    expect(h.reports.map((decision) => decision.category))
      .toEqual(["parse", "managed-server", "sqlite-schema"]);

    // Alternating the repeats across every stage still adds no event and no log line.
    for (let index = 0; index < 12; index++) {
      mode = index % 2 === 0 ? "pending" : "observe";
      await h.tick();
    }
    expect(h.reports).toHaveLength(3);
    expect(h.lines).toHaveLength(3);
    expect(h.snapshot().episodeFailures).toBe(15);
  });

  test("contention must be consecutive to escalate", async () => {
    const capacityPath = file("capacity.json");
    writeFileSync(capacityPath, VALID_CAPACITY);
    let busy = true;
    const store = fakeStore({
      observe: () => {
        if (busy) throw sqliteError("database is locked");
        throw new ManagedDatabaseError("42P01");
      },
    });
    const h = drive({ capacityPath, store });

    await tick(h, 3);                        // three contended polls, threshold not reached
    busy = false;
    await h.tick();                          // a different class breaks the run
    busy = true;
    await tick(h, CONTENTION_ESCALATION_THRESHOLD - 1);
    expect(h.reports.map((decision) => decision.category)).toEqual(["managed-server"]);
    busy = false;
    await h.tick();
    expect(h.reports).toHaveLength(1);       // the contended polls never became a report
  });
});

describe("capacity monitor telemetry fields", () => {
  test("the bounded failure identity survives the tag allowlist and no message does", async () => {
    let body: Record<string, { tags?: Record<string, string> }> | undefined;
    const sent = await reportOperationalError(
      "spendwatch.monitor.failure",
      new Error(`Managed database operation failed (${LOCK_CONTENTION_SQLSTATE}) for /Users/ops/private.db`),
      {
        component: "capacity", stage: "observe", category: "managed-lock-contention",
        code: "55P03", operation: "capacity.observe.managed-lock-contention",
        error_code: "55P03", path: "/Users/ops/private.db",
      },
      {
        dsn: "https://public-key@errors.example/35",
        transport: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(sent).toBe(true);
    expect(body!.tags).toEqual({
      service: "spendwatch",
      error_type: "Error",
      component: "capacity",
      stage: "observe",
      category: "managed-lock-contention",
      code: "55P03",
      operation: "capacity.observe.managed-lock-contention",
      error_code: "55P03",
    });
    expect(JSON.stringify(body)).not.toContain("private.db");
    expect(JSON.stringify(body)).not.toContain("ops");
  });
});

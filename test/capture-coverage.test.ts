import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Report } from "../src/aggregate";
import { Database } from "../src/database";
import { PgConnection } from "../src/managed/libpq";
import { quoteIdentifier } from "../src/managed/sql-tokens";
import { monthPeriod } from "../src/periods";
import { renderHtml } from "../src/html";
import { renderHistoryHtml } from "../src/history";
import {
  loadCaptureGuards,
  publishCaptureArtifacts,
  sha256Hex,
  COVERAGE_WARNING,
  COVERAGE_GUARD_REASON,
  type CaptureGuard,
} from "../src/report-coverage";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { loadArchivedReports } from "../src/spend-report-archive";
import { loadReportEvidence } from "../src/reports";
import { tokenSummary } from "../src/token-summary";
import { tempDir } from "./tmp";

// A historical-coverage guard protects the exact stored month of a source whose raw corpus can no longer be
// reproduced. This file is about every way that promise could leak: a bigger newer count, a forced takeover,
// a stale or corrupt guards file, and the artifacts and pages that must tell the truth about both captures.

const ROOT = join(import.meta.dir, "..");
const MONTH = "2026-08";

function read(source: string, calls: number, extra: Partial<Report> = {}, month = MONTH): Report {
  const period = monthPeriod(month);
  const tokens = calls * 100;
  return {
    period,
    totalTokens: tokens,
    totalCost: calls / 100,
    apiCalls: calls,
    observedCalls: calls,
    sessions: 1,
    tools: [], bash: [], deep: [], targets: [], prompts: [], projects: [], accounts: [],
    models: [{ model: "gpt-6.1-sol", calls, inTok: tokens, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, cost: 0 }],
    source,
    sinceTs: period.from,
    tokenDays: {
      timeZone: "UTC",
      measuredAt: period.from + 3_600_000,
      rows: [{ day: `${month}-02`, model: "gpt-6.1-sol", tokens }],
    },
    ...extra,
  };
}

const baseline = () => read("studio:codex", 100, {
  installationId: "install-1",
  projects: [{ project: "manager", tokens: 10_000, cost: 10 }],
});
const baselineHash = () => sha256Hex(JSON.stringify(baseline()));

function guard(overrides: Partial<CaptureGuard> = {}): CaptureGuard {
  return {
    source: "studio:codex",
    month: MONTH,
    installationId: "install-1",
    timeZone: "UTC",
    baselineSha256: baselineHash(),
    reason: COVERAGE_GUARD_REASON,
    ...overrides,
  };
}

/** The baseline hash of the month exactly as the archive stores it (the guard protects those bytes). */
const storedHashOf = (path: string, month: string, source: string): string =>
  sha256Hex(storedReport(path, month, source)!);

const guardsFile = (guards: CaptureGuard[] | unknown[]): string => {
  const path = join(tempDir("capture-guards-"), "guards.json");
  writeFileSync(path, JSON.stringify({ version: 1, guards }));
  return path;
};

const dbPath = () => join(tempDir("capture-archive-"), "spendwatch.db");

function storedReport(path: string, month: string, source: string): string | undefined {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return db.query<{ report_json: string }, [string, string]>(
      "SELECT report_json FROM spend_report WHERE month = ? AND source = ?",
    ).get(month, source)?.report_json;
  } finally {
    db.close();
  }
}

function dayTotals(path: string): Array<{ day: string; tokens: number }> {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return db.query<{ day: string; tokens: number }, []>("SELECT day, tokens FROM spend_token_day ORDER BY day, source").all();
  } finally {
    db.close();
  }
}

function projectTotals(path: string): Array<{ project: string; tokens: number }> {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return db.query<{ project: string; tokens: number }, []>("SELECT project, tokens FROM spend_month_project ORDER BY project").all();
  } finally {
    db.close();
  }
}

function monthSource(path: string, source: string) {
  return loadMonthlySpend(path).flatMap((month) => month.sources).find((row) => row.source === source);
}

const withEnv = async <T,>(values: Record<string, string | undefined>, run: () => T): Promise<T> => {
  const prior = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of prior) if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const spawnCli = (args: string[], env: Record<string, string | undefined>) =>
  Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, SPENDWATCH_GATEWAY_CONFIG: undefined, SPENDWATCH_CAPTURE_GUARDS: undefined, SPENDWATCH_CAPTURE_DIR: undefined, ...env },
  });

describe("capture guard configuration", () => {
  test("no environment means no guards", () => {
    expect(loadCaptureGuards({})).toBeUndefined();
  });

  test("a configured file parses with its scopes and baseline hashes", () => {
    const guards = loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([guard()]) })!;
    expect(guards).toEqual([guard()]);
  });

  test("a corrupt, version-skewed, or duplicated file fails closed", () => {
    const dir = tempDir("capture-guards-bad-");
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{not json");
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: junk })).toThrow(/not readable JSON/);
    const wrongVersion = join(dir, "version.json");
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, guards: [] }));
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: wrongVersion })).toThrow(/version/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([guard(), guard()]) })).toThrow(/duplicates/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([guard(), guard({ installationId: "another" })]) })).toThrow(/duplicates/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([{ ...guard(), baselineSha256: "nope" }]) })).toThrow(/baselineSha256/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([{ ...guard(), timeZone: "Mars/Olympus" }]) })).toThrow(/timeZone/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: guardsFile([{ ...guard(), reason: "because" }]) })).toThrow(/reason/);
    expect(() => loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: join(dir, "missing.json") })).toThrow(/not readable JSON/);
  });
});

describe("the guarded archive write", () => {
  test("a guarded installation alias stays pinned while the original installation advances", () => {
    const path = dbPath();
    const first = baseline();
    const second = { ...read("studio:codex", 40), installationId: "install-2" };
    writeMonthlySpend(path, [first, second], { generatedAt: 1 });
    const alias = "studio (installation 2):codex";
    const retained = storedReport(path, MONTH, alias)!;
    const pinned = guard({ installationId: "install-2", baselineSha256: sha256Hex(retained) });
    writeMonthlySpend(path, [
      { ...read("studio:codex", 200), installationId: "install-1" },
      { ...read("studio:codex", 300), installationId: "install-2" },
    ], { generatedAt: 2, guards: [pinned] });
    expect(storedReport(path, MONTH, alias)).toBe(retained);
    expect(JSON.parse(storedReport(path, MONTH, "studio:codex")!).totalTokens).toBe(20_000);
    expect(tokenSummary(path, { timeZone: "UTC", guards: [pinned] }).notes).toContain(COVERAGE_WARNING);
  });
  test("preserves the stored month, projects, and days against a larger newer read", () => {
    const path = dbPath();
    writeMonthlySpend(path, [baseline()], { generatedAt: 1 });
    const before = {
      report: storedReport(path, MONTH, "studio:codex")!,
      days: dayTotals(path),
      projects: projectTotals(path),
      month: monthSource(path, "studio:codex"),
    };
    // A newer scan that observed MORE calls (rotated-index recovery found extra files) must still not rewrite it.
    const newer = read("studio:codex", 300, { projects: [{ project: "manager", tokens: 30_000, cost: 30 }] }, MONTH);
    writeMonthlySpend(path, [{ ...newer, installationId: "install-1" }],
      { generatedAt: 2, guards: [guard({ baselineSha256: storedHashOf(path, MONTH, "studio:codex") })] });
    expect({
      report: storedReport(path, MONTH, "studio:codex")!,
      days: dayTotals(path),
      projects: projectTotals(path),
      month: monthSource(path, "studio:codex"),
    }).toEqual(before);
    expect(loadMonthlySpend(path)[0]!.tokens).toBe(10_000);
    // Without the guard the same read would have replaced the month: the test guards the guard.
    const control = dbPath();
    writeMonthlySpend(control, [baseline()], { generatedAt: 1 });
    writeMonthlySpend(control, [{ ...newer, installationId: "install-1" }], { generatedAt: 2 });
    expect(storedReport(control, MONTH, "studio:codex")).toBe(JSON.stringify({ ...newer, installationId: "install-1" }));
  });

  test("a hash, timezone, or installation mismatch fails closed and writes nothing", () => {
    const path = dbPath();
    writeMonthlySpend(path, [baseline()], { generatedAt: 1 });
    const before = storedReport(path, MONTH, "studio:codex");
    const newer = read("studio:codex", 200);
    // Retry with the correct guard: preservation is stable, the stored bytes never moved.
    writeMonthlySpend(path, [{ ...newer, installationId: "install-1" }],
      { generatedAt: 2, guards: [guard({ baselineSha256: storedHashOf(path, MONTH, "studio:codex") })] });
    expect(storedReport(path, MONTH, "studio:codex")).toBe(before);
    for (const bad of [
      guard({ baselineSha256: sha256Hex("someone overwrote the stored month") }),
      guard({ timeZone: "Europe/Berlin" }),
      guard({ installationId: "a-different-installation" }),
    ]) {
      expect(() => writeMonthlySpend(path, [{ ...newer, installationId: "install-1" }], { generatedAt: 3, guards: [bad] })).toThrow();
      expect(storedReport(path, MONTH, "studio:codex")).toBe(before);
    }
  });

  test("an unrelated installation, source, or month is unaffected", () => {
    const path = dbPath();
    writeMonthlySpend(path, [
      baseline(),
      read("studio:codex", 40, { installationId: "install-2" }),
      read("spark:codex", 60, { installationId: "install-9" }),
      baseline().source === "studio:codex" ? read("studio:codex", 70, {}, "2026-07") : baseline(),
    ], { generatedAt: 1 });
    const secondBefore = storedReport(path, MONTH, "studio (installation 2):codex");
    const sparkBefore = storedReport(path, MONTH, "spark:codex");
    const julyBefore = storedReport(path, "2026-07", "studio:codex");
    writeMonthlySpend(path, [
      { ...read("studio:codex", 300, {}, MONTH), installationId: "install-1" }, // guarded: preserved
      { ...read("studio:codex", 300, {}, MONTH), installationId: "install-2" }, // different installation
      read("spark:codex", 300, {}, MONTH), // different source
      read("studio:codex", 300, {}, "2026-07"), // different month
    ], { generatedAt: 2, guards: [guard({ baselineSha256: storedHashOf(path, MONTH, "studio:codex") })] });
    expect(storedReport(path, MONTH, "studio:codex")).toBe(JSON.stringify(baseline()));
    expect(storedReport(path, MONTH, "studio (installation 2):codex")).toBe(JSON.stringify({ ...read("studio:codex", 300), installationId: "install-2" }));
    expect(secondBefore).toBe(JSON.stringify({ ...read("studio:codex", 40), installationId: "install-2" }));
    expect(storedReport(path, MONTH, "spark:codex")).toBe(JSON.stringify(read("spark:codex", 300)));
    expect(storedReport(path, "2026-07", "studio:codex")).toBe(JSON.stringify(read("studio:codex", 300, {}, "2026-07")));
    expect(julyBefore).toBeTruthy();
    expect(sparkBefore).toBeTruthy();
  });

  test("a gateway takeover with a guarded member moves no source, guarded or not", () => {
    // The month archived without the ledger; a takeover would normally force BOTH sources at once.
    const takeOver = (month = MONTH) => [
      read("studio:codex", 90, { observedCalls: 100, ledger: true, routedCalls: 10 }, month),
      read("studio:claude", 40, { observedCalls: 50, ledger: true, routedCalls: 10 }, month),
    ];
    const withGuard = dbPath();
    writeMonthlySpend(withGuard, [read("studio:codex", 100), read("studio:claude", 50)], { generatedAt: 1 });
    const guarded = guard({ installationId: undefined, baselineSha256: storedHashOf(withGuard, MONTH, "studio:codex") });
    writeMonthlySpend(withGuard, takeOver(), { generatedAt: 2, guards: [guarded] });
    expect(monthSource(withGuard, "studio:codex")!.calls).toBe(100);
    expect(monthSource(withGuard, "studio:claude")!.calls).toBe(50);
    expect(storedReport(withGuard, MONTH, "studio:codex")).toBe(JSON.stringify(read("studio:codex", 100)));
    // Same offers without a guard: the takeover is allowed and both sources move together.
    const withoutGuard = dbPath();
    writeMonthlySpend(withoutGuard, [read("studio:codex", 100), read("studio:claude", 50)], { generatedAt: 1 });
    writeMonthlySpend(withoutGuard, takeOver(), { generatedAt: 2 });
    expect(monthSource(withoutGuard, "studio:codex")!.calls).toBe(90);
    expect(monthSource(withoutGuard, "studio:claude")!.calls).toBe(40);
  });
});

describe("capture artifacts", () => {
  const artifactRender = (report: Report, fileName: string) => renderHtml([report], {
    generatedAt: 1, days: 31, coverage: {
      version: 1, status: "latest-scan", display: "retained-archive", reason: COVERAGE_GUARD_REASON,
      scope: { source: report.source, month: report.period?.key ?? "", timeZone: "UTC" },
      retained: { capturedAt: null, tokens: report.totalTokens, observedCalls: report.apiCalls, reportSha256: sha256Hex(JSON.stringify(report)) },
    },
    artifactFileName: fileName.replace(/\.html$/, ""),
  });

  test("publish exact parsed bytes with deterministic names, and stay immutable on retry", () => {
    const root = tempDir("capture-artifacts-");
    const dir = join(root, "captures");
    const reports = [baseline(), read("studio:claude", 30)];
    const refs = publishCaptureArtifacts(dir, reports, artifactRender);
    expect(refs.map((ref) => ref.reportSha256)).toEqual(reports.map((report) => sha256Hex(JSON.stringify(report))));
    for (const [index, ref] of refs.entries()) {
      expect(readFileSync(join(dir, `${ref.fileName}.json`), "utf8")).toBe(JSON.stringify(reports[index]));
      expect(ref.jsonHref).toBe(`captures/${sha256Hex(JSON.stringify(reports))}-${index}.json`);
      expect(ref.htmlHref).toBe(`captures/${sha256Hex(JSON.stringify(reports))}-${index}.html`);
      expect(existsSync(join(dir, `${ref.fileName}.html`))).toBe(true);
      // Names never carry the source-controlled input path, only hash and index.
      expect(ref.fileName).not.toContain("/");
    }
    const again = publishCaptureArtifacts(dir, reports, artifactRender); // Stable references on retry.
    expect(again).toEqual(refs);
    const originalHtml = readFileSync(join(dir, `${refs[0]!.fileName}.html`), "utf8");
    expect(publishCaptureArtifacts(dir, reports, () => "<html>new renderer</html>")).toEqual(refs);
    expect(readFileSync(join(dir, `${refs[0]!.fileName}.html`), "utf8")).toBe(originalHtml);
    // Same name, different bytes: immutable, so the run stops instead of clobbering a published page.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${refs[0]!.fileName}.json`), "{\"mutated\":true}");
    expect(() => publishCaptureArtifacts(dir, reports, artifactRender)).toThrow(/immutable/);
    expect(() => publishCaptureArtifacts(join(root, "elsewhere"), reports, artifactRender)).toThrow(/named captures/);
  });

  test("input payload identity and element positions survive normalization and grouping", () => {
    const root = tempDir("capture-provenance-");
    const path = join(root, "input.json");
    const raw: Array<Partial<Report>> = [baseline(), read("studio:claude", 30)];
    delete raw[0]!.totalTokens;
    const payload = JSON.stringify(raw, null, 2) + "\n";
    writeFileSync(path, payload);
    const evidence = loadReportEvidence([path]);
    const refs = publishCaptureArtifacts(join(root, "captures"), evidence.map((entry) => entry.report), artifactRender, evidence);
    expect(refs[0]!.fileName).toBe(`${sha256Hex(payload)}-0`);
    expect(refs[1]!.fileName).toBe(`${sha256Hex(payload)}-1`);
    expect(evidence[0]!.report.totalTokens).toBe(10_000);
    expect(readFileSync(join(root, "captures", `${refs[0]!.fileName}.json`), "utf8")).toBe(JSON.stringify(raw[0]));
    expect(JSON.parse(readFileSync(join(root, "captures", `${refs[0]!.fileName}.json`), "utf8")).totalTokens).toBeUndefined();
    expect(refs[0]!.reportSha256).toBe(sha256Hex(JSON.stringify(raw[0])));
  });

  test("the latest-scan page states its exact model, account, and day counts and escapes its input", () => {
    const hostile = read("<script>evil</script>", 2, { accounts: [
      { account: '"><script>alert(1)</script>', tokens: 200, cost: 0.02, calls: 2, sessions: 1 },
    ] });
    const html = artifactRender(hostile, "abc-0.html");
    expect(html).toContain("Latest scan");
    expect(html).toContain("1 model row");
    expect(html).toContain("1 account");
    expect(html).toContain("1 day");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;evil&lt;/script&gt;");
    expect(html).toContain("never be added");
  });

  test("the retained view links artifacts without blending the two captures", () => {
    const retained = baseline();
    const html = renderHtml([{
      ...retained,
      captureCoverage: {
        version: 1, status: "unreconciled", display: "retained-archive", reason: COVERAGE_GUARD_REASON,
        scope: { source: "studio:codex", month: MONTH, installationId: "install-1", timeZone: "UTC" },
        retained: { capturedAt: "2026-08-02T01:00:00.000Z", tokens: 10_000, observedCalls: 100, reportSha256: baselineHash() },
        latest: { capturedAt: "2026-10-19T01:00:00.000Z", tokens: 30_000, observedCalls: 300, reportSha256: sha256Hex(JSON.stringify(retained)), jsonHref: "captures/aaa.json", htmlHref: "captures/aaa.html" },
      },
    }], { generatedAt: 1, days: 31 });
    expect(html).toContain("Preserved archive shown");
    expect(html).toContain(COVERAGE_WARNING.replace("These captures are not added together.", "").trim());
    expect(html).toContain('href="captures/aaa.html"');
    expect(html).toContain("View latest scan");
    expect(html).toContain("Download latest recorded data");
    // The numbers on the page stay the retained archive's, never the latest scan's.
    expect(html).toContain("10,000 recorded");
    expect(html).not.toContain("40,000 recorded");
  });

  test("an unsafe artifact href is rendered as text, never followed as a URL", () => {
    const html = renderHtml([{
      ...baseline(),
      captureCoverage: {
        version: 1, status: "unreconciled", display: "retained-archive", reason: COVERAGE_GUARD_REASON,
        scope: { source: "studio:codex", month: MONTH, timeZone: "UTC" },
        retained: { capturedAt: null, tokens: 10_000, observedCalls: 100, reportSha256: baselineHash() },
        latest: { capturedAt: null, tokens: 300, observedCalls: 3, reportSha256: "f".repeat(64), jsonHref: "javascript:alert(1)", htmlHref: 'data:text/html,<script>alert(1)</script>' },
      },
    }], { generatedAt: 1, days: 31 });
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain("javascript:alert(1)"); // present only as escaped text
  });
});

describe("guarded views", () => {
  test("history warns on the guarded month without changing any figure", () => {
    const html = renderHistoryHtml({ generatedAt: 1, sampleCount: 0, series: [] }, {
      months: [
        { month: MONTH, label: "August 2026", tokens: 10_000, cost: 1, calls: 100, sessions: 1, updatedAt: 1, sources: [{ source: "studio:codex", tokens: 10_000, cost: 1, calls: 100, sessions: 1 }], projects: [] },
        { month: "2026-07", label: "July 2026", tokens: 5_000, cost: 0.5, calls: 50, sessions: 1, updatedAt: 1, sources: [{ source: "studio:codex", tokens: 5_000, cost: 0.5, calls: 50, sessions: 1 }], projects: [] },
      ],
      coverage: { scopes: [{ month: MONTH, source: "studio:codex" }] },
    });
    expect(html.match(/class="month-coverage"/g)?.length).toBe(1);
    expect(html).toContain("Preserved archive shown");
    expect(html).toContain("<b>10.0k</b> tokens");
    expect(html).toContain("100 calls"); // the card's figures stay the retained month's own
  });

  test("token-summary adds a fixed note only, with identical counts", async () => {
    const path = dbPath();
    writeMonthlySpend(path, [baseline()], { generatedAt: 1 });
    const guards = [guard({ baselineSha256: storedHashOf(path, MONTH, "studio:codex") })];
    const plain = tokenSummary(path, { now: Date.parse("2026-08-02T12:00:00Z"), timeZone: "UTC" });
    const guarded = await withEnv({ SPENDWATCH_CAPTURE_GUARDS: guardsFile(guards) }, () =>
      tokenSummary(path, { now: Date.parse("2026-08-02T12:00:00Z"), timeZone: "UTC", guards: loadCaptureGuards() }));
    expect(plain.periods).toEqual(guarded.periods);
    expect(guarded.notes.some((note) => note.includes("Preserved archive shown"))).toBe(true);
    expect(plain.notes.some((note) => note.includes("Preserved archive shown"))).toBe(false);
  });
});

describe("report --input with guards and captures", () => {
  const world = () => {
    const root = tempDir("capture-cli-");
    const publicDir = join(root, "public");
    mkdirSync(join(publicDir, "captures"), { recursive: true });
    return { root, publicDir, sqlite: join(root, "spendwatch.db"), html: join(publicDir, "spend.html") };
  };

  const input = (root: string, name: string, reports: Report[]) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(reports));
    return path;
  };

  test("the archived month is preserved and the latest scan is published beside it", () => {
    const w = world();
    expect(spawnCli(["report", "--input", input(w.root, "first.json", [baseline()]), "--sqlite", w.sqlite, "--html", w.html], {}).exitCode).toBe(0);
    const baselineJson = readFileSync(w.html, "utf8");
    expect(baselineJson).not.toContain("Preserved archive shown");

    const newer = read("studio:codex", 300);
    const guards = guardsFile([guard({ installationId: undefined, baselineSha256: storedHashOf(w.sqlite, MONTH, "studio:codex") })]);
    expect(spawnCli(["report", "--input", input(w.root, "second.json", [newer]), "--sqlite", w.sqlite, "--html", w.html],
      { SPENDWATCH_CAPTURE_GUARDS: guards, SPENDWATCH_CAPTURE_DIR: join(w.publicDir, "captures") }).exitCode).toBe(0);

    const html = readFileSync(w.html, "utf8");
    expect(html).toContain("Preserved archive shown");
    const hash = sha256Hex(JSON.stringify([newer]));
    expect(readFileSync(join(w.publicDir, "captures", `${hash}-0.json`), "utf8")).toBe(JSON.stringify(newer));
    expect(existsSync(join(w.publicDir, "captures", `${hash}-0.html`))).toBe(true);
    expect(html).toContain(`href="captures/${hash}-0.html"`);
    expect(html).toContain(`href="captures/${hash}-0.json"`);
    // The retained archive still shows the original month: same stored JSON, same totals.
    expect(storedReport(w.sqlite, MONTH, "studio:codex")).toBe(JSON.stringify(baseline()));
    expect(html).toContain("10,000 recorded");
    // The coverage metadata is render-only: it never reaches the archive.
    expect(storedReport(w.sqlite, MONTH, "studio:codex")).not.toContain("captureCoverage");
    // The latest page declares its own capture time, not this run's clock.
    const artifactHtml = readFileSync(join(w.publicDir, "captures", `${hash}-0.html`), "utf8");
    expect(artifactHtml).toContain(new Date(newer.tokenDays!.measuredAt).toISOString().replace("T", " ").slice(0, 16) + " UTC");
    expect(artifactHtml).toContain("Latest scan");
  });

  test("a publication failure preserves the previously published page", () => {
    const w = world();
    spawnCli(["report", "--input", input(w.root, "first.json", [baseline()]), "--sqlite", w.sqlite, "--html", w.html], {});
    const published = readFileSync(w.html, "utf8");
    // A capture directory that cannot carry the sibling links fails the run before anything is written.
    const wrong = join(w.root, "not-captures");
    mkdirSync(wrong, { recursive: true });
    const failed = spawnCli(["report", "--input", input(w.root, "second.json", [read("studio:codex", 300)]), "--sqlite", w.sqlite, "--html", w.html],
      { SPENDWATCH_CAPTURE_DIR: wrong });
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(w.html, "utf8")).toBe(published);
    expect(existsSync(wrong)).toBe(true);
    expect(existsSync(join(wrong, "0000000000000000000000000000000000000000000000000000000000000000-0.json"))).toBe(false);
    // And an unusable path under the right name fails the same way.
    const blocked = join(w.publicDir, "captures.json");
    writeFileSync(blocked, "not a directory");
    expect(spawnCli(["report", "--input", input(w.root, "third.json", [read("studio:codex", 300)]), "--sqlite", w.sqlite, "--html", w.html],
      { SPENDWATCH_CAPTURE_DIR: blocked }).exitCode).not.toBe(0);
    expect(readFileSync(w.html, "utf8")).toBe(published);
  });

  test("legacy normalization keeps the downloaded element hash on the standalone HTML page", () => {
    const w = world();
    const raw: Partial<Report> = read("studio:codex", 300);
    delete raw.totalTokens;
    const payload = JSON.stringify([raw]);
    const file = join(w.root, "legacy.json");
    writeFileSync(file, payload);
    const result = spawnCli(["report", "--input", file, "--html", w.html],
      { SPENDWATCH_CAPTURE_DIR: join(w.publicDir, "captures") });
    expect(result.exitCode).toBe(0);
    const name = `${sha256Hex(payload)}-0`;
    const bytes = readFileSync(join(w.publicDir, "captures", `${name}.json`), "utf8");
    expect(bytes).toBe(JSON.stringify(raw));
    const html = readFileSync(join(w.publicDir, "captures", `${name}.html`), "utf8");
    expect(html).toContain(sha256Hex(bytes));
    expect(html).toContain("30,000 recorded");
  });

  test("a corrupt guards file fails the run without touching archive or page", () => {
    const w = world();
    spawnCli(["report", "--input", input(w.root, "first.json", [baseline()]), "--sqlite", w.sqlite, "--html", w.html], {});
    const published = readFileSync(w.html, "utf8");
    const before = storedReport(w.sqlite, MONTH, "studio:codex");
    const junk = join(w.root, "guards.json");
    writeFileSync(junk, "{ broken");
    const failed = spawnCli(["report", "--input", input(w.root, "second.json", [read("studio:codex", 300)]), "--sqlite", w.sqlite, "--html", w.html],
      { SPENDWATCH_CAPTURE_GUARDS: junk });
    expect(failed.exitCode).not.toBe(0);
    expect(storedReport(w.sqlite, MONTH, "studio:codex")).toBe(before);
    expect(readFileSync(w.html, "utf8")).toBe(published);
  });

  test("the bare CLI without the capture environment stays as it was", () => {
    const w = world();
    spawnCli(["report", "--input", input(w.root, "first.json", [baseline()]), "--sqlite", w.sqlite, "--html", w.html], {});
    expect(spawnCli(["report", "--input", input(w.root, "second.json", [read("studio:codex", 300)]), "--sqlite", w.sqlite, "--html", w.html], {}).exitCode).toBe(0);
    expect(storedReport(w.sqlite, MONTH, "studio:codex")).toBe(JSON.stringify(read("studio:codex", 300)));
    expect(readFileSync(w.html, "utf8")).not.toContain("Preserved archive shown");
    expect(existsSync(join(w.publicDir, "captures", "anything"))).toBe(false);
  });
});

// PostgreSQL parity: the same guarded archive rules must hold against the managed archive. The loopback
// fixture is usually stopped, so this describes the identical body the SQLite run above executes.
const pgConfig = process.env.SPENDWATCH_TEST_PG_CONFIG;
const pgSuite = pgConfig ? describe : describe.skip;

pgSuite("guarded archive on PostgreSQL", () => {
  test("preserves the guarded month identically to native SQLite", () => {
    const root = tempDir("capture-pg-parity-");
    const connection = JSON.parse(readFileSync(pgConfig!, "utf8")) as Record<string, string>;
    if (connection.host !== "127.0.0.1" || connection.port !== "15487" || connection.dbname !== "postgres") {
      throw new Error("Capture tests require the owned loopback fixture");
    }
    const name = "spendwatch_test_" + randomBytes(8).toString("hex");
    const admin = new PgConnection(connection);
    try { admin.query("CREATE DATABASE " + quoteIdentifier(name)); } finally { admin.close(); }
    const path = join(root, "remote.db"), configuration = join(root, "managed.json");
    writeFileSync(configuration, JSON.stringify({ path, connection: { ...connection, dbname: name }, localFixture: true }), { mode: 0o600 });
    const prior = process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
    process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = configuration;
    try {
      writeMonthlySpend(path, [baseline()], { generatedAt: 1 });
      writeMonthlySpend(path, [{ ...read("studio:codex", 300), installationId: "install-1" }],
        { generatedAt: 2, guards: [guard({ baselineSha256: storedHashOf(path, MONTH, "studio:codex") })] });
      expect(storedReport(path, MONTH, "studio:codex")).toBe(JSON.stringify(baseline()));
      expect(monthSource(path, "studio:codex")!.calls).toBe(100);
      expect(dayTotals(path)).toEqual([{ day: `${MONTH}-02`, tokens: 10_000 }]);
    } finally {
      if (prior === undefined) delete process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
      else process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG = prior;
      const drop = new PgConnection(connection);
      try { drop.query("DROP DATABASE IF EXISTS " + quoteIdentifier(name)); } finally { drop.close(); }
    }
  });
});

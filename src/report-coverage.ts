// Historical coverage guards and their render-only metadata.
//
// Some archived months were measured from a fuller read than any later scan can reproduce. A guard records that
// divergence: the exact SHA-256 of the stored `spend_report` JSON, its month, source, installation and timezone.
// While a guard is configured, that stored month is preserved — never replaced, even by a newer read that
// observed more calls or by a forced gateway takeover — and the latest scan is published beside it as its own
// immutable artifact. The two are never added, maxed, or subtracted together; the pages only say that the
// archive is retained and the latest scan differs. There is no schema change: everything beyond the guard file
// lives in the report JSON the archive already keeps.
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Report } from "./aggregate";
import type { ReportEvidence } from "./reports";
import { Database } from "./database";
import { storedArchiveSource, storedReportRows } from "./spend-report-archive";

/** The reason every guard exists; anything else is not a coverage guard. */
export const COVERAGE_GUARD_REASON = "historical-coverage-divergence";

/** The sentence the retained views show while a guard is unresolved. */
export const COVERAGE_WARNING =
  "Preserved archive shown. The latest scan differs; historical coverage remains unresolved. These captures are not added together.";

/** The sentence the separately published latest-scan page shows about itself. */
export const COVERAGE_ARTIFACT_WARNING =
  "This page is a separate latest scan. Its source scan had incomplete historical coverage, so its counts must never be added to, or blended with, the preserved archive.";

export interface CaptureGuard {
  source: string;
  month: string;
  installationId?: string;
  /** Null pins a legacy baseline that did not record any timezone. */
  timeZone: string | null;
  baselineSha256: string;
  reason: typeof COVERAGE_GUARD_REASON;
}

/** One side of a guarded month: the retained archive row, or the latest published scan. Never a union. */
export interface CaptureReference {
  /** The source's own recorded capture time, ISO; null when it never recorded one. */
  capturedAt: string | null;
  tokens: number;
  observedCalls: number;
  reportSha256: string;
  jsonHref?: string;
  htmlHref?: string;
}

/**
 * Render-only metadata (never archived): what the archive retains for a guarded month, and — when it was
 * published — the individual artifact of the latest scan that differs from it.
 */
export interface CaptureCoverage {
  version: 1;
  /** "unreconciled" on the retained view; "latest-scan" on a standalone published artifact page. */
  status: "unreconciled" | "latest-scan";
  display: "retained-archive";
  reason: typeof COVERAGE_GUARD_REASON;
  scope: { source: string; month: string; installationId?: string; timeZone: string | null };
  retained: CaptureReference;
  latest?: CaptureReference;
}

/** A published individual capture artifact, keyed to the exact JSON bytes it holds. */
export interface CaptureArtifactRef {
  fileName: string;
  jsonHref: string;
  htmlHref: string;
  reportSha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,31})?$/;
const INSTALLATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// The archive display merges installations under one logical source. Until it
// can show several independent references, admit one guarded baseline per card.
const guardScope = (guard: CaptureGuard) => JSON.stringify([guard.source, guard.month]);

function validTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseGuard(value: unknown, index: number): CaptureGuard {
  if (!value || typeof value !== "object") throw new Error(`capture guards: entry ${index} is not an object`);
  const item = value as Partial<CaptureGuard> & Record<string, unknown>;
  if (Object.keys(item).some((key) => !["source", "month", "installationId", "timeZone", "baselineSha256", "reason"].includes(key))) {
    throw new Error("capture guards: unknown entry field");
  }
  if (typeof item.source !== "string" || !SOURCE.test(item.source)) throw new Error(`capture guards: entry ${index} has no valid source`);
  if (typeof item.month !== "string" || !MONTH_KEY.test(item.month)) throw new Error(`capture guards: entry ${index} month must look like YYYY-MM`);
  if (item.installationId !== undefined && (typeof item.installationId !== "string" || !INSTALLATION.test(item.installationId))) {
    throw new Error(`capture guards: entry ${index} installationId must be a non-empty string`);
  }
  if (item.timeZone !== null && !validTimeZone(item.timeZone)) throw new Error(`capture guards: entry ${index} has an invalid timeZone`);
  if (typeof item.baselineSha256 !== "string" || !HASH.test(item.baselineSha256)) {
    throw new Error(`capture guards: entry ${index} baselineSha256 must be 64 lowercase hex digits`);
  }
  if (item.reason !== COVERAGE_GUARD_REASON) throw new Error(`capture guards: entry ${index} reason must be ${COVERAGE_GUARD_REASON}`);
  return {
    source: item.source,
    month: item.month,
    ...(item.installationId !== undefined ? { installationId: item.installationId } : {}),
    timeZone: item.timeZone,
    baselineSha256: item.baselineSha256,
    reason: COVERAGE_GUARD_REASON,
  };
}

/**
 * Reads the trusted guards file named by `SPENDWATCH_CAPTURE_GUARDS`. No environment means no guards; a
 * configured file that is unreadable, malformed, or duplicated is an error, so generation fails closed rather
 * than archive a guarded month without its guard.
 */
export function loadCaptureGuards(env: Record<string, string | undefined> = process.env): CaptureGuard[] | undefined {
  const path = env.SPENDWATCH_CAPTURE_GUARDS;
  if (!path) return undefined;
  let parsed: unknown;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("guards file is not a bounded regular file");
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error("guards file is oversized");
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`capture guards: ${path} is not readable JSON (${String(error)})`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("capture guards: expected an object");
  const config = parsed as { version?: unknown; guards?: unknown };
  if (Object.keys(config).some((key) => key !== "version" && key !== "guards")) throw new Error("capture guards: unknown configuration field");
  if (config.version !== 1) throw new Error("capture guards: version must be 1");
  if (!Array.isArray(config.guards) || config.guards.length > 64) throw new Error("capture guards: guards must be a bounded array");
  const guards = config.guards.map(parseGuard);
  const scopes = new Set<string>();
  guards.forEach((guard, index) => {
    const scope = guardScope(guard);
    if (scopes.has(scope)) throw new Error(`capture guards: entry ${index} duplicates a source/month/installation scope`);
    scopes.add(scope);
  });
  return guards;
}

/** What the archive's stored row says about a guard, checked against its scope and bytes. */
export function guardStoredStatus(
  guard: CaptureGuard,
  stored: { reportJson: string; installationId?: string; timeZone?: string } | undefined,
): "match" | "absent" {
  if (!stored) return "absent";
  if (guard.installationId !== undefined && guard.installationId !== stored.installationId) {
    throw new Error(`capture guards: ${guard.source} ${guard.month} is stored under installation ${stored.installationId}, not ${guard.installationId}`);
  }
  if (guard.timeZone === null ? stored.timeZone !== undefined : stored.timeZone !== guard.timeZone) {
    throw new Error(`capture guards: ${guard.source} ${guard.month} is stored in timezone ${stored.timeZone}, not ${guard.timeZone}`);
  }
  if (sha256Hex(stored.reportJson) !== guard.baselineSha256) {
    throw new Error(`capture guards: ${guard.source} ${guard.month} no longer matches its baseline hash`);
  }
  return "match";
}

function storedShape(reportJson: string): { reportJson: string; installationId?: string; timeZone?: string } {
  let report: Report;
  try {
    report = JSON.parse(reportJson) as Report;
  } catch {
    throw new Error("capture guards: the stored report JSON is unreadable");
  }
  return {
    reportJson,
    ...(report.installationId !== undefined ? { installationId: report.installationId } : {}),
    ...(report.tokenDays?.timeZone !== undefined ? { timeZone: report.tokenDays.timeZone } : {}),
  };
}

/** The guard that protects an incoming report's scope, if any. */
export function guardForReport(guards: CaptureGuard[] | undefined, report: Report): CaptureGuard | undefined {
  if (!guards?.length || !report.period?.month) return undefined;
  return guards.find((guard) =>
    guard.source === report.source && guard.month === report.period!.key &&
    (guard.installationId === undefined || guard.installationId === report.installationId));
}

/**
 * The guard protecting a stored row, verifying every row the table holds for the scope. A guard whose rows
 * disagree with it — wrong installation, wrong timezone, or a hash that is not the stored bytes — fails closed.
 */
export function guardForStoredRows(
  guards: CaptureGuard[] | undefined,
  month: string,
  archiveLabel: string,
  rows: string[],
): CaptureGuard | undefined {
  for (const reportJson of rows) {
    const report = JSON.parse(reportJson) as Report;
    const guard = guards?.find((item) => item.source === report.source && item.month === month &&
      (item.installationId === undefined || item.installationId === report.installationId));
    if (guard) {
      guardStoredStatus(guard, storedShape(reportJson));
      return guard;
    }
  }
  return undefined;
}

/** Resolve one configured logical installation to its exact retained storage row. */
export function verifiedGuardBaseline(db: Database, guard: CaptureGuard): {
  archiveLabel: string; report: Report; reportJson: string;
} {
  const archiveLabel = storedArchiveSource(db, guard.source, guard.installationId);
  if (!archiveLabel) throw new Error("capture guards: no stored installation matches configured baseline");
  const rows = storedReportRows(db, guard.month, archiveLabel);
  if (rows.length !== 1) throw new Error("capture guards: exact stored baseline is missing");
  const reportJson = rows[0]!;
  const report = JSON.parse(reportJson) as Report;
  if (report.source !== guard.source || report.period?.key !== guard.month) throw new Error("capture guards: stored source/month differs");
  guardStoredStatus(guard, storedShape(reportJson));
  return { archiveLabel, report, reportJson };
}

/** The report's captured-at instant, only when the source actually recorded one. Never the render clock. */
export function captureTimestampIso(report: Report): string | null {
  const measured = report.tokenDays?.measuredAt;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0) return null;
  return new Date(measured).toISOString();
}

export interface CaptureReferenceOptions {
  tokens?: number;
  jsonHref?: string;
  htmlHref?: string;
}

export function captureReference(
  report: Report,
  reportSha256: string,
  options: CaptureReferenceOptions | CaptureArtifactRef = {},
): CaptureReference {
  return {
    capturedAt: captureTimestampIso(report),
    tokens: "tokens" in options && Number.isSafeInteger(options.tokens) ? options.tokens! : report.totalTokens,
    observedCalls: report.observedCalls ?? report.apiCalls,
    reportSha256,
    ...(options.jsonHref !== undefined ? { jsonHref: options.jsonHref } : {}),
    ...(options.htmlHref !== undefined ? { htmlHref: options.htmlHref } : {}),
  };
}

/**
 * Publishes each incoming report as its own immutable JSON and HTML artifact under the trusted runtime
 * directory, named only by payload hash and report index — never by a source-controlled path, so nothing about
 * where the input came from leaks into the public directory. A name that already exists must hold
 * byte-identical content: artifacts are immutable, and a different payload under the same name stops the run
 * rather than overwriting what was already linked.
 */
export function publishCaptureArtifacts(
  dir: string,
  reports: Report[],
  render: (report: Report, fileName: string, reportSha256: string) => string,
  evidence?: ReportEvidence[],
): CaptureArtifactRef[] {
  const root = resolve(dir);
  if (basename(root) !== "captures") {
    throw new Error(`capture artifacts: the runtime directory must be named captures, got ${root}`);
  }
  try {
    const info = lstatSync(root, { throwIfNoEntry: false });
    if (info && !info.isDirectory()) throw new Error("a non-directory occupies the capture path");
    if (!info) mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`capture artifacts: ${root} is not usable (${String(error)})`);
  }
  if (evidence && evidence.length !== reports.length) throw new Error("capture artifacts: incomplete import provenance");
  const fallbackPayloadHash = sha256Hex(JSON.stringify(reports));
  return reports.map((report, index) => {
    const input = evidence?.[index];
    if (input && (input.report !== report || !HASH.test(input.payloadSha256) || !Number.isSafeInteger(input.index) || input.index < 0)) {
      throw new Error("capture artifacts: mismatched import provenance");
    }
    const bytes = input?.rawJson ?? JSON.stringify(report);
    const reportSha256 = sha256Hex(bytes);
    const name = `${input?.payloadSha256 ?? fallbackPayloadHash}-${input?.index ?? index}`;
    const jsonPath = join(root, `${name}.json`);
    const htmlPath = join(root, `${name}.html`);
    publishImmutable(jsonPath, bytes);
    // HTML is an immutable rendering of the already-verified source JSON. A
    // later UI release must not replace it or reject the same retained input.
    publishImmutable(htmlPath, render(report, `${name}.html`, reportSha256), true);
    return { fileName: name, jsonHref: `captures/${name}.json`, htmlHref: `captures/${name}.html`, reportSha256 };
  });
}

function publishImmutable(path: string, contents: string, keepExisting = false): void {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("capture artifacts: existing artifact is not a regular file");
    if (keepExisting && info.size > 0) return;
    if (readFileSync(path, "utf8") === contents) return; // Same payload on retry: the artifact already stands.
    throw new Error(`capture artifacts: ${path} already holds different bytes; artifacts are immutable`);
  }
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || !(keepExisting && info.size > 0) && readFileSync(path, "utf8") !== contents) throw error;
    }
  } catch (error) {
    throw new Error(`capture artifacts: publishing ${path} failed (${String(error)})`);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

/**
 * Attaches render-only coverage metadata to archived reports about to be shown, for every guard whose latest
 * scan still differs from the retained row. Runs strictly after the archive write, so `captureCoverage` never
 * reaches `spend_report`/`spend_month` — it is a display fact, not stored state. Main numeric totals stay the
 * retained archive's; the references only describe the two captures side by side.
 */
export function attachCaptureCoverage(options: {
  path: string;
  guards: CaptureGuard[];
  reports: Report[];
  latest: Report[];
  artifacts: (CaptureArtifactRef | undefined)[];
}): Report[] {
  const { path, guards, reports, latest, artifacts } = options;
  if (!guards.length || !reports.length) return reports;
  const db = new Database(path, { readonly: true, create: false });
  try {
    return reports.map((display) => {
      if (!display.period?.month) return display;
      const guard = guards.find((item) => item.month === display.period!.key && item.source === display.source &&
        (!display.installationId || item.installationId === undefined || display.installationId === item.installationId));
      if (!guard) return display;
      const baseline = verifiedGuardBaseline(db, guard);
      const retained = baseline.report;
      const scan = latest.find((report) => report.period?.key === guard.month && report.source === guard.source &&
        (guard.installationId === undefined || report.installationId === guard.installationId));
      const index = scan ? latest.indexOf(scan) : -1;
      const artifact = index >= 0 ? artifacts[index] : undefined;
      const latestHash = artifact?.reportSha256 ?? (scan ? sha256Hex(JSON.stringify(scan)) : undefined);
      return {
        ...display,
        captureCoverage: {
          version: 1,
          status: "unreconciled",
          display: "retained-archive",
          reason: COVERAGE_GUARD_REASON,
          scope: {
            source: guard.source,
            month: guard.month,
            ...(guard.installationId !== undefined ? { installationId: guard.installationId } : {}),
            timeZone: guard.timeZone,
          },
          retained: captureReference(retained, sha256Hex(baseline.reportJson)),
          ...(scan && latestHash ? { latest: captureReference(scan, latestHash, artifact) } : {}),
        },
      };
    });
  } finally {
    db.close();
  }
}

/**
 * The guard's stored baseline, verified against every row the archive keeps for its month under any label
 * (failing closed on a scope or hash mismatch). Undefined when no stored row carries the guard: an absent
 * month is not a baseline to publish against.
 */
export function storedReportRowsForGuard(path: string, guard: CaptureGuard):
  { baselineSha256: string; installationId?: string } | undefined {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const baseline = verifiedGuardBaseline(db, guard);
    return { baselineSha256: guard.baselineSha256, installationId: baseline.report.installationId };
  } finally {
    db.close();
  }
}

import { basename, dirname, join, resolve } from "node:path";
import type { Report } from "./aggregate";
import type { ReportEvidence } from "./reports";
import { renderHtml } from "./html";
import { COVERAGE_GUARD_REASON, captureReference, loadCaptureGuards, publishCaptureArtifacts,
  sha256Hex, storedReportRowsForGuard, type CaptureArtifactRef, type CaptureGuard } from "./report-coverage";

/**
 * The trusted capture directory from `SPENDWATCH_CAPTURE_DIR`. The published pages link it as the sibling
 * `captures/` of their own directory (the runtime layout is `/data/public/captures`); a configured directory
 * that cannot carry those links fails the run rather than rendering links to files that are not there.
 */
export function configuredCaptureDir(htmlOut: string | undefined): string | undefined {
  const raw = process.env.SPENDWATCH_CAPTURE_DIR;
  if (!raw) return undefined;
  const dir = resolve(raw);
  if (basename(dir) !== "captures") throw new Error(`--html capture directory must be named captures, got ${dir}`);
  if (htmlOut) {
    const expected = join(dirname(resolve(htmlOut)), "captures");
    if (dir !== expected) throw new Error(`capture directory ${dir} is not the sibling captures/ of ${dirname(resolve(htmlOut))}`);
  }
  return dir;
}

/** The guards the archive's monthly table still holds, for the History page's month warnings. */
export function historyCoverageOptions(path: string): { scopes: Array<{ month: string; source: string }> } | undefined {
  const guards = loadCaptureGuards();
  if (!guards?.length) return undefined;
  const scopes = guards
    .filter((guard) => storedReportRowsForGuard(path, guard) !== undefined)
    .map((guard) => ({ month: guard.month, source: guard.source }));
  return scopes.length ? { scopes } : undefined;
}

/** Renders one incoming report as its standalone latest-scan page: same local renderer, separate-capture banner. */
function renderCaptureArtifact(report: Report, fileName: string, reportSha256: string): string {
  return renderHtml([report], {
    generatedAt: report.tokenDays?.measuredAt ?? 0,
    days: 31,
    ...(report.period && report.period.month ? { period: report.period } : {}),
    coverage: {
      version: 1,
      status: "latest-scan",
      display: "retained-archive",
      reason: COVERAGE_GUARD_REASON,
      scope: {
        source: report.source,
        month: report.period?.key ?? "",
        ...(report.installationId !== undefined ? { installationId: report.installationId } : {}),
        timeZone: report.tokenDays?.timeZone ?? "UTC",
      },
      retained: captureReference(report, reportSha256),
    },
    artifactFileName: fileName.replace(/\.html$/, ""),
  });
}

/** Publishes each imported report as an immutable individual artifact; runs before the main page is written. */
export function publishCaptures(dir: string, reports: Report[], evidence: ReportEvidence[]): CaptureArtifactRef[] {
  return publishCaptureArtifacts(dir, reports, renderCaptureArtifact, evidence);
}

/** The artifact references of the latest scans that guard the shown month, keyed by displayed source. */
export function captureRefsForReports(databasePath: string | undefined, reports: Report[], guards: CaptureGuard[], incoming: Report[], artifacts: CaptureArtifactRef[]): Record<string, { json: string; html: string }> {
  if (!guards.length || !artifacts.length) return {};
  const refs: Record<string, { json: string; html: string }> = {};
  for (const report of reports) {
    if (!report.period?.month) continue;
    const guard = guards.find((item) => item.month === report.period!.key && item.source === report.source &&
      (!report.installationId || item.installationId === undefined || item.installationId === report.installationId));
    if (!guard) continue;
    const scanIndex = incoming.findIndex((candidate) => candidate.period?.key === guard.month &&
      candidate.source === guard.source &&
      (guard.installationId === undefined || candidate.installationId === guard.installationId));
    if (scanIndex < 0) continue;
    const artifact = artifacts[scanIndex];
    if (!artifact) continue;
    // Link only a scan that really differs from the retained baseline the guard verified.
    if (sha256Hex(JSON.stringify(incoming[scanIndex]!)) === guard.baselineSha256) continue;
    if (!databasePath) throw new Error("Capture links require an archive database");
    if (storedReportRowsForGuard(databasePath, guard)?.baselineSha256 !== guard.baselineSha256) continue;
    refs[report.source] = { json: artifact.jsonHref, html: artifact.htmlHref };
  }
  return refs;
}


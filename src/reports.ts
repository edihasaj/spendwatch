import { readFileSync } from "node:fs";
import type { Report } from "./aggregate";

function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<Report>;
  return (
    typeof report.source === "string" &&
    typeof report.totalCost === "number" &&
    typeof report.apiCalls === "number" &&
    typeof report.sessions === "number" &&
    Array.isArray(report.tools) &&
    Array.isArray(report.bash) &&
    Array.isArray(report.deep) &&
    Array.isArray(report.targets) &&
    Array.isArray(report.prompts) &&
    Array.isArray(report.models) &&
    Array.isArray(report.projects) &&
    Array.isArray(report.accounts)
  );
}

export function loadReports(paths: string[]): Report[] {
  return paths.flatMap((path) => {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (!values.every(isReport)) throw new Error(`invalid spendwatch report: ${path}`);
    return values;
  });
}

export function labelReports(reports: Report[], label?: string): Report[] {
  if (!label) return reports;
  const clean = label.trim().replace(/[:\n\r]/g, "-");
  if (!clean) return reports;
  return reports.map((report) => ({ ...report, source: `${clean}:${report.source}` }));
}

export function sourceLabel(source: string): string {
  const split = source.lastIndexOf(":");
  const machine = split > 0 ? source.slice(0, split) : "";
  const agent = split > 0 ? source.slice(split + 1) : source;
  const known: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    copilot: "Copilot",
    gemini: "Gemini",
  };
  const agentLabel = known[agent] ?? agent;
  return machine ? `${machine} · ${agentLabel}` : agentLabel;
}

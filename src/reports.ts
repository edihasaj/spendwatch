import { readFileSync } from "node:fs";
import type { AccountRow, ModelRow, PromptRow, Report, SampleRow, TargetRow, ToolRow } from "./aggregate";

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

function normalizeTokenTotals(report: Report): Report {
  const modelsTotal = report.models.reduce(
    (sum, model) => sum + model.inTok + model.outTok + model.cacheReadTok + model.cacheWriteTok,
    0,
  );
  return {
    ...report,
    totalTokens: typeof report.totalTokens === "number" ? report.totalTokens : modelsTotal,
    accounts: report.accounts.map((row) => ({ ...row, tokens: typeof row.tokens === "number" ? row.tokens : 0 })),
    prompts: report.prompts.map((row) => ({ ...row, tokens: typeof row.tokens === "number" ? row.tokens : row.outTok })),
    projects: report.projects.map((row) => ({ ...row, tokens: typeof row.tokens === "number" ? row.tokens : 0 })),
  };
}

export function loadReports(paths: string[]): Report[] {
  return paths.flatMap((path) => {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (!values.every(isReport)) throw new Error(`invalid spendwatch report: ${path}`);
    return values.map(normalizeTokenTotals);
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
    all: "All machines",
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok",
    copilot: "Copilot",
    gemini: "Gemini",
  };
  const agentLabel = known[agent] ?? agent;
  return machine ? `${machine} · ${agentLabel}` : agentLabel;
}

export interface SpendBreakdown {
  label: string;
  tokens: number;
  cost: number;
  calls: number;
  sessions: number;
}

export type AccountGrouping = "service" | "email";

function sourceParts(source: string): { machine: string; agent: string } {
  const split = source.lastIndexOf(":");
  return split > 0
    ? { machine: source.slice(0, split), agent: source.slice(split + 1) }
    : { machine: "local", agent: source };
}

function accountLabel(source: string, account: string, grouping: AccountGrouping): string {
  // Codex accounts carry a profile tag, e.g. "me@example.com (secondary)". Email
  // grouping is meant to merge one person across agents, so drop the tag there.
  if (grouping === "email") return account.replace(/\s+\([^()]*\)$/, "");
  return `${sourceLabel(sourceParts(source).agent)} · ${account}`;
}

function breakdown(
  reports: Report[],
  key: (report: Report) => string,
): SpendBreakdown[] {
  const rows = new Map<string, SpendBreakdown>();
  for (const report of reports) {
    const label = key(report);
    const row = rows.get(label) ?? { label, tokens: 0, cost: 0, calls: 0, sessions: 0 };
    row.tokens += report.totalTokens;
    row.cost += report.totalCost;
    row.calls += report.apiCalls;
    row.sessions += report.sessions;
    rows.set(label, row);
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens);
}

export function reportBreakdowns(reports: Report[], accountGrouping: AccountGrouping = "service"): {
  machines: SpendBreakdown[];
  agents: SpendBreakdown[];
  accounts: SpendBreakdown[];
} {
  const accounts = new Map<string, SpendBreakdown>();
  for (const report of reports) {
    for (const account of report.accounts) {
      const label = accountLabel(report.source, account.account, accountGrouping);
      const row = accounts.get(label) ?? {
        label,
        tokens: 0,
        cost: 0,
        calls: 0,
        sessions: 0,
      };
      row.tokens += account.tokens;
      row.cost += account.cost;
      row.calls += account.calls;
      row.sessions += account.sessions;
      accounts.set(label, row);
    }
  }
  return {
    machines: breakdown(reports, (report) => sourceParts(report.source).machine),
    agents: breakdown(reports, (report) => sourceLabel(sourceParts(report.source).agent)),
    accounts: [...accounts.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

function mergeSamples(rows: ToolRow[]): SampleRow[] | undefined {
  const samples = new Map<string, SampleRow>();
  for (const sample of rows.flatMap((row) => row.samples ?? [])) {
    const merged = samples.get(sample.detail) ?? { detail: sample.detail, count: 0, resultTok: 0 };
    merged.count += sample.count;
    merged.resultTok += sample.resultTok;
    samples.set(sample.detail, merged);
  }
  const result = [...samples.values()]
    .sort((a, b) => b.resultTok - a.resultTok || b.count - a.count)
    .slice(0, 40);
  return result.length ? result : undefined;
}

function mergeToolRows(reports: Report[], field: "tools" | "bash" | "deep"): ToolRow[] {
  const groups = new Map<string, ToolRow[]>();
  for (const row of reports.flatMap((report) => report[field])) {
    const group = groups.get(row.name) ?? [];
    group.push(row);
    groups.set(row.name, group);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({
      name,
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      argTok: rows.reduce((sum, row) => sum + row.argTok, 0),
      resultTok: rows.reduce((sum, row) => sum + row.resultTok, 0),
      ctxCost: rows.reduce((sum, row) => sum + row.ctxCost, 0),
      resultCalls: rows.reduce((sum, row) => sum + row.resultCalls, 0),
      errCalls: rows.reduce((sum, row) => sum + row.errCalls, 0),
      exit127: rows.reduce((sum, row) => sum + row.exit127, 0),
      samples: mergeSamples(rows),
    }))
    .sort((a, b) => b.ctxCost - a.ctxCost);
}

function mergeNamed<T>(
  rows: T[],
  key: (row: T) => string,
  merge: (current: T, row: T) => void,
  value: (row: T) => number,
): T[] {
  const result = new Map<string, T>();
  for (const row of rows) {
    const current = result.get(key(row));
    if (current) merge(current, row);
    else result.set(key(row), structuredClone(row));
  }
  return [...result.values()].sort((a, b) => value(b) - value(a));
}

export function mergeReports(
  reports: Report[],
  source = "all",
  accountGrouping: AccountGrouping = "service",
): Report {
  const tools = mergeToolRows(reports, "tools");
  const bash = mergeToolRows(reports, "bash");
  const deep = mergeToolRows(reports, "deep");
  const targets = mergeNamed<TargetRow>(
    reports.flatMap((report) => report.targets),
    (row) => row.command,
    (current, row) => {
      const preferReason = row.score > current.score;
      const calls = current.calls + row.calls;
      current.errPct = calls ? (current.errPct * current.calls + row.errPct * row.calls) / calls : 0;
      current.calls = calls;
      current.ctxCost += row.ctxCost;
      current.score += row.score;
      if (preferReason) current.reason = row.reason;
    },
    (row) => row.score,
  ).slice(0, 16);
  const prompts = reports
    .flatMap((report) => report.prompts)
    .map<PromptRow>((row, index) => ({ ...row, key: `${index}:${row.key}` }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 15);
  const models = mergeNamed<ModelRow>(
    reports.flatMap((report) => report.models),
    (row) => row.model,
    (current, row) => {
      current.calls += row.calls;
      current.inTok += row.inTok;
      current.outTok += row.outTok;
      current.cacheReadTok += row.cacheReadTok;
      current.cacheWriteTok += row.cacheWriteTok;
      current.cost += row.cost;
    },
    (row) => row.inTok + row.outTok + row.cacheReadTok + row.cacheWriteTok,
  );
  const projects = mergeNamed(
    reports.flatMap((report) => report.projects),
    (row) => row.project,
    (current, row) => { current.tokens += row.tokens; current.cost += row.cost; },
    (row) => row.tokens,
  );
  const accounts = mergeNamed<AccountRow>(
    reports.flatMap((report) =>
      report.accounts.map((account) => ({
        ...account,
        account: accountLabel(report.source, account.account, accountGrouping),
      })),
    ),
    (row) => row.account,
    (current, row) => {
      current.tokens += row.tokens;
      current.cost += row.cost;
      current.calls += row.calls;
      current.sessions += row.sessions;
    },
    (row) => row.tokens,
  );
  return {
    source,
    totalTokens: reports.reduce((sum, report) => sum + report.totalTokens, 0),
    totalCost: reports.reduce((sum, report) => sum + report.totalCost, 0),
    apiCalls: reports.reduce((sum, report) => sum + report.apiCalls, 0),
    sessions: reports.reduce((sum, report) => sum + report.sessions, 0),
    tools,
    bash,
    deep,
    targets,
    prompts,
    models,
    projects,
    accounts,
    sinceTs: Math.min(...reports.map((report) => report.sinceTs).filter(Boolean)),
  };
}

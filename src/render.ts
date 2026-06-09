// Terminal table rendering for spend reports.
import type { Report } from "./aggregate";

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};
const color = process.stdout.isTTY ?? false;
const c = (code: string, s: string) => (color ? code + s + C.reset : s);

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function table(headers: string[], rows: string[][], rightAlign: Set<number>): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells.map((s, i) => (rightAlign.has(i) ? s.padStart(widths[i]) : s.padEnd(widths[i]))).join("  ");
  return [c(C.dim, line(headers)), ...rows.map(line)].join("\n");
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function renderReport(r: Report, opts: { width?: number } = {}): string {
  const w = opts.width ?? Math.min(process.stdout.columns ?? 120, 140);
  const out: string[] = [];
  const since = r.sinceTs ? new Date(r.sinceTs).toISOString().slice(0, 10) : "?";
  out.push(
    c(C.bold, `spendwatch`) +
      c(C.dim, `  since ${since}  `) +
      `${c(C.green, fmtUsd(r.totalCost))} est  ·  ${r.apiCalls} API calls  ·  ${r.sessions} sessions`,
  );

  out.push("\n" + c(C.bold, "BY TOOL") + c(C.dim, "  (ctx $ = est cost of result tokens via cache write + rereads)"));
  out.push(
    table(
      ["tool", "calls", "arg tok", "result tok", "ctx $"],
      r.tools.slice(0, 20).map((t) => [clip(t.name, 42), String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
      new Set([1, 2, 3, 4]),
    ),
  );

  if (r.bash.length) {
    out.push("\n" + c(C.bold, "BY BASH COMMAND") + c(C.dim, "  (Bash calls split by executable)"));
    out.push(
      table(
        ["command", "calls", "arg tok", "result tok", "ctx $"],
        r.bash.slice(0, 15).map((t) => [clip(t.name, 30), String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
        new Set([1, 2, 3, 4]),
      ),
    );
  }

  out.push("\n" + c(C.bold, "BY PROMPT") + c(C.dim, "  (⑂ = subagent task; $ = API spend attributed to prompt)"));
  const tw = Math.max(30, w - 46);
  out.push(
    table(
      ["$", "tools", "out tok", "project", "prompt"],
      r.prompts.map((p) => [fmtUsd(p.cost), String(p.toolCalls), fmtTok(p.outTok), clip(p.project, 18), clip(p.text, tw)]),
      new Set([0, 1, 2]),
    ),
  );

  out.push("\n" + c(C.bold, "BY MODEL"));
  out.push(
    table(
      ["model", "calls", "in", "out", "cache rd", "cache wr", "$"],
      r.models.map((m) => [m.model, String(m.calls), fmtTok(m.inTok), fmtTok(m.outTok), fmtTok(m.cacheReadTok), fmtTok(m.cacheWriteTok), fmtUsd(m.cost)]),
      new Set([1, 2, 3, 4, 5, 6]),
    ),
  );

  out.push("\n" + c(C.bold, "BY PROJECT"));
  out.push(
    table(
      ["project", "$"],
      r.projects.slice(0, 12).map((p) => [clip(p.project, 50), fmtUsd(p.cost)]),
      new Set([1]),
    ),
  );
  return out.join("\n") + "\n";
}

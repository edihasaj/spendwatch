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

// Compact daily-glance: total, biggest hog, and the automate shortlist per agent.
export function renderBrief(reports: Report[]): string {
  const live = reports.filter((r) => r.apiCalls > 0).sort((a, b) => b.totalCost - a.totalCost);
  const total = live.reduce((s, r) => s + r.totalCost, 0);
  const since = Math.min(...live.map((r) => r.sinceTs).filter(Boolean));
  const out: string[] = [];
  out.push(c(C.bold, "spendwatch") + c(C.dim, `  since ${since && isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "?"}  ·  `) + `${c(C.green, fmtUsd(total))} est` + c(C.dim, "  (brief)"));
  for (const r of live) {
    const label = SOURCE_LABEL[r.source] ?? r.source;
    const hog = r.tools[0];
    out.push("");
    out.push(c(C.bold, `▌ ${label}`) + c(C.dim, "  ") + `${c(C.green, fmtUsd(r.totalCost))}` + (hog ? c(C.dim, `  · biggest context: ${hog.name} (${fmtTok(hog.resultTok)} tok)`) : ""));
    const targets = r.targets.slice(0, 5);
    if (targets.length) {
      out.push(
        table(
          ["automate", "calls", "ctx $", "err%", "why"],
          targets.map((t) => [clip(t.command, 28), String(t.calls), fmtUsd(t.ctxCost), t.errPct >= 0.01 ? `${Math.round(t.errPct * 100)}%` : "·", t.reason]),
          new Set([1, 2, 3]),
        ),
      );
    }
  }
  return out.join("\n") + "\n";
}

// Cross-agent comparison line + per-agent totals, shown above the sections.
export function renderOverview(reports: Report[]): string {
  const live = reports.filter((r) => r.apiCalls > 0);
  const total = live.reduce((s, r) => s + r.totalCost, 0);
  const since = Math.min(...live.map((r) => r.sinceTs).filter(Boolean));
  const out: string[] = [];
  out.push(
    c(C.bold, "spendwatch") +
      c(C.dim, `  since ${since && isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "?"}  ·  all agents  `) +
      `${c(C.green, fmtUsd(total))} est`,
  );
  out.push(
    table(
      ["agent", "$", "share", "API calls", "sessions"],
      live
        .sort((a, b) => b.totalCost - a.totalCost)
        .map((r) => [SOURCE_LABEL[r.source] ?? r.source, fmtUsd(r.totalCost), total ? `${((r.totalCost / total) * 100).toFixed(0)}%` : "0%", String(r.apiCalls), String(r.sessions)]),
      new Set([1, 2, 3, 4]),
    ),
  );
  return out.join("\n") + "\n";
}

const SOURCE_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  gemini: "Gemini",
  all: "all agents",
};

export function renderReport(r: Report, opts: { width?: number; heading?: boolean } = {}): string {
  const w = opts.width ?? Math.min(process.stdout.columns ?? 120, 140);
  const out: string[] = [];
  const since = r.sinceTs ? new Date(r.sinceTs).toISOString().slice(0, 10) : "?";
  const label = SOURCE_LABEL[r.source] ?? r.source;
  const acctTag = r.accounts.length === 1 && r.accounts[0].account !== "default" ? c(C.dim, `  ⟨${r.accounts[0].account}⟩`) : "";
  out.push(
    c(C.bold, opts.heading === false ? `▌ ${label}` : `spendwatch`) +
      acctTag +
      c(C.dim, `  since ${since}  `) +
      `${c(C.green, fmtUsd(r.totalCost))} est  ·  ${r.apiCalls} API calls  ·  ${r.sessions} sessions`,
  );

  if (r.accounts.length > 1) {
    out.push("\n" + c(C.bold, "BY ACCOUNT") + c(C.dim, `  (same agent, summed above: ${fmtUsd(r.totalCost)})`));
    out.push(
      table(
        ["account", "$", "calls", "sessions"],
        r.accounts.map((a) => [clip(a.account, 40), fmtUsd(a.cost), String(a.calls), String(a.sessions)]),
        new Set([1, 2, 3]),
      ),
    );
  }

  if (r.targets.length) {
    out.push("\n" + c(C.yellow, c(C.bold, "AUTOMATE — top targets")) + c(C.dim, "  (cost × frequency × friction · build a CLI/MCP for these)"));
    out.push(
      table(
        ["command", "calls", "ctx $", "err%", "why"],
        r.targets.map((t) => [clip(t.command, 30), String(t.calls), fmtUsd(t.ctxCost), t.errPct >= 0.01 ? `${Math.round(t.errPct * 100)}%` : "·", t.reason]),
        new Set([1, 2, 3]),
      ),
    );
  }

  out.push("\n" + c(C.bold, "BY TOOL") + c(C.dim, "  (ctx $ = est cost of result tokens via cache write + rereads)"));
  out.push(
    table(
      ["tool", "calls", "arg tok", "result tok", "ctx $"],
      r.tools.slice(0, 20).map((t) => [clip(t.name, 42), String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
      new Set([1, 2, 3, 4]),
    ),
  );

  if (r.bash.length) {
    out.push("\n" + c(C.bold, "BY COMMAND") + c(C.dim, "  (shell calls split by executable)"));
    out.push(
      table(
        ["command", "calls", "arg tok", "result tok", "ctx $"],
        r.bash.slice(0, 12).map((t) => [clip(t.name, 30), String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
        new Set([1, 2, 3, 4]),
      ),
    );
  }

  if (r.deep.length) {
    out.push("\n" + c(C.bold, "BY COMMAND — DEEP") + c(C.dim, "  (executable + subcommand / ssh remote — what to build a CLI for)"));
    out.push(
      table(
        ["command", "calls", "arg tok", "result tok", "ctx $"],
        r.deep.filter((t) => t.name.includes(" ")).slice(0, 18).map((t) => [clip(t.name, 34), String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
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

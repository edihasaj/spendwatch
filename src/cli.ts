#!/usr/bin/env bun
// spendwatch — across coding agents (Claude Code, Codex, …), find which tool
// calls and prompts spend the most tokens/$, so you know what to automate/fix.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Aggregator } from "./aggregate";
import { writeSnapshot } from "./db";
import { renderHtml } from "./html";
import { loadCodexLimits, renderLimitsHtml, renderLimitsText } from "./limits";
import { renderBrief, renderOverview, renderReport } from "./render";
import { labelReports, loadReports, type AccountGrouping } from "./reports";
import { IncrementalReader } from "./scan";
import { discover, type SourceStatus } from "./sources";

interface Args {
  cmd: "report" | "watch" | "limits";
  days: number;
  project?: string;
  account?: string;
  accountGrouping: AccountGrouping;
  agents?: Set<string>;
  top: number;
  json: boolean;
  brief: boolean;
  html?: string; // output path when --html given
  open: boolean;
  sqlite?: string; // output db path when --sqlite given
  inputs: string[];
  label?: string;
  interval: number;
  limitsHref?: string;
  spendHref?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "report",
    days: 30,
    accountGrouping: "service",
    top: 12,
    json: false,
    brief: false,
    open: false,
    inputs: [],
    interval: 2000,
  };
  const rest = [...argv];
  while (rest.length) {
    const x = rest.shift()!;
    if (x === "report" || x === "watch" || x === "limits") a.cmd = x;
    else if (x === "--days") a.days = Number(rest.shift());
    else if (x === "--project") a.project = rest.shift();
    else if (x === "--agent" || x === "--source") a.agents = new Set((rest.shift() ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    else if (x === "--account") a.account = rest.shift();
    else if (x === "--account-group") {
      const grouping = rest.shift();
      if (grouping !== "service" && grouping !== "email") {
        throw new Error("--account-group must be service or email");
      }
      a.accountGrouping = grouping;
    }
    else if (x === "--top") a.top = Number(rest.shift());
    else if (x === "--json") a.json = true;
    else if (x === "--brief") a.brief = true;
    else if (x === "--html") a.html = rest[0] && !rest[0].startsWith("-") ? rest.shift()! : "spendwatch-report.html";
    else if (x === "--open") a.open = true;
    else if (x === "--sqlite" || x === "--db") a.sqlite = rest[0] && !rest[0].startsWith("-") ? rest.shift()! : "spendwatch.db";
    else if (x === "--input") a.inputs.push(...(rest.shift() ?? "").split(",").filter(Boolean));
    else if (x === "--label" || x === "--machine") a.label = rest.shift();
    else if (x === "--interval") a.interval = Number(rest.shift());
    else if (x === "--limits-href") a.limitsHref = rest.shift();
    else if (x === "--spend-href") a.spendHref = rest.shift();
    else if (x === "--help" || x === "-h") {
      console.log(`spendwatch — token/$ leaderboards across coding agents

usage: spendwatch [report|watch] [options]

  report            aggregate past sessions (default)
  watch             live leaderboard, refreshes as sessions write
  limits            render Codex account quota input as a planning dashboard

options:
  --days N          look back N days (default 30; watch default 1)
  --agent LIST      comma list: claude,codex,copilot,gemini (default all)
  --account STR     filter by account substring (email/label)
  --account-group X group HTML accounts by service (default) or email
  --project STR     filter project by substring
  --top N           prompt rows to show (default 12)
  --brief           TL;DR only: total, biggest hog, top automate targets
  --json            machine-readable output (report only)
  --html [PATH]     also write a standalone HTML report (default spendwatch-report.html)
  --open            open the HTML report in your browser (implies --html)
  --sqlite [PATH]   append a snapshot to a SQLite db (default spendwatch.db)
  --input PATHS     render exported report JSON instead of local logs (repeatable or comma-separated)
  --label STR       prefix local report tabs with a machine/site label
  --interval MS     watch poll interval (default 2000)
  --limits-href URL add a Capacity link to the spend report
  --spend-href URL  set the Spend detail link in the limits dashboard

sources:
  claude   ~/.claude/projects/**/*.jsonl        (token usage ✓)
  codex    ~/.codex/sessions/**/rollout-*.jsonl (token usage ✓)
  copilot  ~/.config/github-copilot             (binary store, no usage)
  gemini   ~/.gemini                             (when present)

multi-account:
  Accounts are auto-detected (Claude email, Codex JWT). For multiple roots
  (e.g. work + personal config dirs), create ~/.config/spendwatch/config.json:
    { "roots": [
        { "agent": "claude", "account": "work", "path": "~/.claude/projects" },
        { "agent": "claude", "account": "personal", "path": "~/personal/.claude/projects" }
    ] }
  Each account is tagged and shown under BY ACCOUNT; agent totals sum across them.`);
      process.exit(0);
    }
  }
  return a;
}

function matchesProject(project: string, filter?: string): boolean {
  return !filter || project.toLowerCase().includes(filter.toLowerCase());
}

interface Built {
  statuses: SourceStatus[];
  readers: Map<string, { reader: IncrementalReader; agg: Aggregator; status: SourceStatus }>;
}

function build(a: Args): Built {
  const sinceMs = Date.now() - a.days * 86400_000;
  // Codex project lives inside the file, so don't pre-filter codex by project name.
  const statuses = discover({ sinceMs, agents: a.agents, project: undefined });
  const readers = new Map<string, { reader: IncrementalReader; agg: Aggregator; status: SourceStatus }>();
  for (const st of statuses) {
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    for (const f of st.files) {
      // Claude can pre-filter by project (it's in the dir name).
      if (st.id === "claude" && !matchesProject(f.project, a.project)) continue;
      if (a.account && !f.account.toLowerCase().includes(a.account.toLowerCase())) continue;
      reader.poll(f);
      reader.flush(f);
    }
    readers.set(st.id, { reader, agg, status: st });
  }
  return { statuses, readers };
}

function reportsFrom(built: Built, a: Args) {
  const reports = [];
  for (const { agg, status } of built.readers.values()) {
    if (!status.parseable) continue;
    const r = agg.report(a.top);
    // Post-filter projects for codex/gemini (project known only after parse).
    if (a.project) {
      r.prompts = r.prompts.filter((p) => matchesProject(p.project, a.project));
      r.projects = r.projects.filter((p) => matchesProject(p.project, a.project));
    }
    if (a.account) r.accounts = r.accounts.filter((ac) => ac.account.toLowerCase().includes(a.account!.toLowerCase()));
    reports.push(r);
  }
  return reports;
}

async function report(a: Args) {
  const built = a.inputs.length ? { statuses: [], readers: new Map() } : build(a);
  const reports = a.inputs.length ? loadReports(a.inputs) : labelReports(reportsFrom(built, a), a.label);
  if (a.json) {
    // Wait for slow consumers such as SSH to drain large reports before exit.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(reports, null, 2) + "\n", (error) =>
        error ? reject(error) : resolve(),
      );
    });
    return;
  }
  const live = reports.filter((r) => r.apiCalls > 0);
  if (a.brief) {
    process.stdout.write(renderBrief(reports));
  } else {
    const buf: string[] = [];
    if (live.length > 1) buf.push(renderOverview(reports));
    for (const r of live) buf.push(renderReport(r, { heading: false }));
    // Footnotes for sources present but not parseable / no data.
    for (const st of built.statuses) {
      const had = live.some((r) => r.source === st.id);
      if (!had && st.note) buf.push(`\x1b[2m· ${st.id}: ${st.note}\x1b[0m`);
    }
    process.stdout.write(buf.join("\n\n") + "\n");
  }

  if (a.html || a.open) {
    const out = resolve(a.html ?? "spendwatch-report.html");
    writeFileSync(out, renderHtml(reports, {
      generatedAt: nowMs(),
      days: a.days,
      accountGrouping: a.accountGrouping,
      limitsHref: a.limitsHref,
    }));
    process.stdout.write(`\n\x1b[2m→ HTML report written to ${out}\x1b[0m\n`);
    if (a.open) Bun.spawn(["open", out]);
  }

  if (a.sqlite) {
    const out = resolve(a.sqlite);
    const { runId, rows } = writeSnapshot(out, reports, { generatedAt: nowMs(), days: a.days });
    process.stdout.write(`\x1b[2m→ SQLite snapshot run #${runId} (${rows} rows) appended to ${out}\x1b[0m\n`);
  }
}

async function limits(a: Args) {
  if (!a.inputs.length) throw new Error("limits requires at least one --input JSON path");
  const accounts = loadCodexLimits(a.inputs);
  if (a.json) {
    process.stdout.write(JSON.stringify(accounts, null, 2) + "\n");
  } else {
    process.stdout.write(renderLimitsText(accounts));
  }
  if (a.html) {
    const out = resolve(a.html);
    writeFileSync(out, renderLimitsHtml(accounts, { generatedAt: nowMs(), spendHref: a.spendHref }));
    process.stdout.write(`\x1b[2m→ Limits HTML written to ${out}\x1b[0m\n`);
  }
}

// Date.now is unavailable in some sandboxed contexts; tolerate it.
function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function watch(a: Args) {
  if (a.inputs.length) throw new Error("--input is only supported by report");
  if (a.days === 30) a.days = 1;
  const built = build(a);
  const sinceMs = Date.now() - a.days * 86400_000;
  const draw = () => {
    const reports = reportsFrom(built, a).filter((r) => r.apiCalls > 0);
    const buf: string[] = [];
    if (reports.length > 1) buf.push(renderOverview(reports));
    for (const r of reports) buf.push(renderReport(r, { heading: false }));
    process.stdout.write("\x1b[2J\x1b[H" + buf.join("\n\n") + `\n\n\x1b[2m${new Date().toLocaleTimeString()} watching — ctrl-c to exit\x1b[0m\n`);
  };
  draw();
  setInterval(() => {
    let changed = 0;
    for (const st of discover({ sinceMs, agents: a.agents })) {
      const slot = built.readers.get(st.id);
      if (!slot) continue;
      for (const f of st.files) changed += slot.reader.poll(f);
    }
    if (changed > 0) draw();
  }, a.interval);
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd === "watch") watch(args);
else if (args.cmd === "limits") await limits(args);
else await report(args);

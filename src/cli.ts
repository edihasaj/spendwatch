#!/usr/bin/env bun
// spendwatch — across coding agents (Claude Code, Codex, …), find which tool
// calls and prompts spend the most tokens/$, so you know what to automate/fix.
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import packageMetadata from "../package.json";
import { addAccount, type AccountAddOptions, type AccountProvider } from "./accounts";
import { Aggregator } from "./aggregate";
import { importCapacityHistory, loadCapacityHistory, writeCapacitySnapshot } from "./capacity-db";
import { runCapacityCommand } from "./capacity-cli";
import { loadCapacityDashboard } from "./capacity-dashboard";
import { exportCapacityHistory } from "./capacity-export";
import { writeSnapshot } from "./db";
import { renderHistoryHtml } from "./history";
import { renderHtml } from "./html";
import { evaluateGuard, renderGuardResult, type GuardWindow } from "./guard";
import { renderLimitsHtml, renderLimitsText, type CapacityProvider } from "./limits";
import { attachSessionEquivalentForecasts } from "./session-equivalents";
import { serveDashboard, testBackgroundPush } from "./push-server";
import { renderBrief, renderOverview, renderReport } from "./render";
import { labelReports, loadReports, type AccountGrouping } from "./reports";
import { runRouteCommand } from "./route-cli";
import { runRunCommand } from "./run-cli";
import { runEvalCommand } from "./eval-cli";
import { IncrementalReader } from "./scan";
import { discover, type SourceStatus } from "./sources";

interface Args {
  cmd: "report" | "watch" | "limits" | "guard" | "server" | "push-test" | "capacity-history-export";
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
  historyHref?: string;
  historyHtml?: string;
  historyInputs: string[];
  guardWindow: GuardWindow;
  minimumRemaining: number;
  provider?: CapacityProvider;
  failOpen: boolean;
  host: string;
  port: number;
  publicDir: string;
  vapidSubject: string;
}

function accountHelp(): string {
  return `spendwatch account add PROVIDER [options]

Connect an account on this trusted Mac using the provider's official login.

  spendwatch account add codex --name work
  spendwatch account add codex --name work --device-auth
  spendwatch account add codex --name api --api-key-env OPENAI_API_KEY
  spendwatch account add claude --name work
  spendwatch account add copilot

providers:
  codex      ChatGPT browser OAuth (default), device OAuth, or metered API key
  claude     Claude browser OAuth in an isolated config directory
  copilot    GitHub browser OAuth; GitHub CLI manages the account list

options:
  --name NAME       isolated profile name (required for Codex and Claude)
  --device-auth     use Codex device OAuth instead of local browser callback
  --api-key-env VAR read a Codex API key from VAR and pass it over stdin

Credentials remain in the provider's local credential files. Spendwatch never
copies OAuth tokens into its dashboard or database.`;
}

function parseAccountArgs(argv: string[]): AccountAddOptions | undefined {
  if (argv[0] !== "account") return undefined;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(accountHelp());
    process.exit(0);
  }
  if (argv[1] !== "add") throw new Error("usage: spendwatch account add PROVIDER [options]");
  const provider = argv[2] as AccountProvider | undefined;
  if (provider !== "codex" && provider !== "claude" && provider !== "copilot") {
    throw new Error("provider must be codex, claude, or copilot");
  }
  const options: AccountAddOptions = { provider };
  const rest = argv.slice(3);
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--name") options.name = rest.shift();
    else if (arg === "--device-auth") options.deviceAuth = true;
    else if (arg === "--api-key-env") options.apiKeyEnv = rest.shift();
    else throw new Error(`unknown account option: ${arg}`);
  }
  return options;
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
    historyInputs: [],
    interval: 2000,
    guardWindow: "weekly",
    minimumRemaining: 10,
    failOpen: false,
    host: "127.0.0.1",
    port: 8899,
    publicDir: ".",
    vapidSubject: "mailto:admin@localhost",
  };
  const rest = [...argv];
  while (rest.length) {
    const x = rest.shift()!;
    if (x === "report" || x === "watch" || x === "limits" || x === "guard" || x === "server" || x === "push-test" || x === "capacity-history-export") a.cmd = x;
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
    else if (x === "--history-href") a.historyHref = rest.shift();
    else if (x === "--history-html") a.historyHtml = rest.shift();
    else if (x === "--history-input") a.historyInputs.push(...(rest.shift() ?? "").split(",").filter(Boolean));
    else if (x === "--window") {
      const window = rest.shift();
      if (window !== "session" && window !== "weekly") throw new Error("--window must be session or weekly");
      a.guardWindow = window;
    }
    else if (x === "--min-remaining") a.minimumRemaining = Number(rest.shift());
    else if (x === "--provider") {
      const provider = rest.shift();
      if (provider !== "codex" && provider !== "claude" && provider !== "copilot" && provider !== "lokai") throw new Error("--provider must be codex, claude, copilot, or lokai");
      a.provider = provider;
    }
    else if (x === "--fail-open") a.failOpen = true;
    else if (x === "--host") a.host = rest.shift() ?? "";
    else if (x === "--port") a.port = Number(rest.shift());
    else if (x === "--public-dir") a.publicDir = rest.shift() ?? "";
    else if (x === "--vapid-subject") a.vapidSubject = rest.shift() ?? "";
    else if (x === "--help" || x === "-h") {
      console.log(`spendwatch — token/$ leaderboards across coding agents

usage: spendwatch [report|watch|limits|guard|route|run|eval|capacity|server|push-test|capacity-history-export] [options]
       spendwatch account add PROVIDER [options]

  report            aggregate past sessions (default)
  watch             live leaderboard, refreshes as sessions write
  limits            render Codex account quota input as a planning dashboard
  guard             exit nonzero when an account is below minimum capacity
  route TASK        preview an evidence-driven model plan; never executes it
  run TASK          execute, verify, record, and escalate a routed task
  eval [JSONL]      replay tasks through the routing policy without model calls
  capacity          archive or restore old capacity history safely
  server            serve the dashboard and deliver background Web Push alerts
  push-test         send a background test to every enrolled browser
  capacity-history-export
                    export recoverable Codex quota history as sanitized JSONL
  account add       connect Codex, Claude, or Copilot using official auth

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
  --history-href URL
                    set the History link in Capacity and Spend pages
  --history-input P import sanitized capacity history JSONL (repeatable)
  --history-html P  render the SQLite capacity archive to this HTML path
  --window W        guard session or weekly capacity (default weekly)
  --min-remaining N guard minimum remaining percentage (default 10)
  --provider P      guard a specific provider
  --fail-open       guard exits 0 when capacity is unavailable
  --host HOST       server bind address (default 127.0.0.1)
  --port N          server port (default 8899)
  --public-dir PATH server dashboard directory
  --vapid-subject S Web Push contact URI, usually mailto:address

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
      historyHref: a.historyHref,
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
  const dashboard = loadCapacityDashboard(a.inputs);
  const accounts = dashboard.accounts;
  if (a.json) {
    process.stdout.write(JSON.stringify(accounts, null, 2) + "\n");
  } else {
    process.stdout.write(renderLimitsText(accounts));
  }
  if (a.sqlite) {
    const out = resolve(a.sqlite);
    const live = writeCapacitySnapshot(out, accounts, { collectedAt: nowMs() });
    process.stdout.write(`\x1b[2m→ Capacity snapshot (${live.rows} new rows) appended to ${out}\x1b[0m\n`);
    if (a.historyInputs.length) {
      const imported = importCapacityHistory(out, a.historyInputs);
      process.stdout.write(`\x1b[2m→ Capacity history (${imported.inserted} new rows from ${imported.accepted} records) imported\x1b[0m\n`);
    }
    attachSessionEquivalentForecasts(out, accounts, nowMs());
    if (a.historyHtml) {
      const historyOut = resolve(a.historyHtml);
      writeFileSync(historyOut, renderHistoryHtml(loadCapacityHistory(out), {
        capacityHref: a.html ? relative(dirname(historyOut), resolve(a.html)) || "./" : "./",
        spendHref: a.spendHref,
      }));
      process.stdout.write(`\x1b[2m→ History HTML written to ${historyOut}\x1b[0m\n`);
    }
  } else if (a.historyInputs.length || a.historyHtml) {
    throw new Error("--history-input and --history-html require --sqlite");
  }
  if (a.html) {
    const out = resolve(a.html);
    writeFileSync(out, renderLimitsHtml(accounts, { generatedAt: nowMs(), spendHref: a.spendHref, historyHref: a.historyHref, sources: dashboard.sources, authentication: dashboard.authentication }));
    process.stdout.write(`\x1b[2m→ Limits HTML written to ${out}\x1b[0m\n`);
  }
}

function guard(a: Args): number {
  if (!a.inputs.length) throw new Error("guard requires at least one --input JSON path");
  if (!Number.isFinite(a.minimumRemaining) || a.minimumRemaining < 0 || a.minimumRemaining > 100) {
    throw new Error("--min-remaining must be between 0 and 100");
  }
  const result = evaluateGuard(loadCapacityDashboard(a.inputs).accounts, {
    account: a.account,
    provider: a.provider,
    window: a.guardWindow,
    minimumPercent: a.minimumRemaining,
    failOpen: a.failOpen,
  });
  process.stdout.write(a.json ? JSON.stringify(result) + "\n" : renderGuardResult(result));
  return result.exitCode;
}

async function server(a: Args): Promise<never> {
  if (a.inputs.length !== 1) throw new Error("server requires exactly one --input capacity JSON path");
  if (!a.sqlite) throw new Error("server requires --sqlite for push subscriptions and threshold state");
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error("--port must be between 1 and 65535");
  if (!a.host || !a.publicDir) throw new Error("--host and --public-dir cannot be empty");
  if (!/^(mailto:|https:\/\/)/.test(a.vapidSubject)) throw new Error("--vapid-subject must be a mailto: or https: URI");
  return serveDashboard({
    host: a.host,
    port: a.port,
    publicDir: resolve(a.publicDir),
    capacityPath: resolve(a.inputs[0]!),
    databasePath: resolve(a.sqlite),
    vapidSubject: a.vapidSubject,
  });
}

async function pushTest(a: Args): Promise<void> {
  if (!a.sqlite) throw new Error("push-test requires --sqlite");
  if (!/^(mailto:|https:\/\/)/.test(a.vapidSubject)) throw new Error("--vapid-subject must be a mailto: or https: URI");
  const result = await testBackgroundPush(resolve(a.sqlite), a.vapidSubject);
  process.stdout.write(`Background push test: ${result.sent} sent, ${result.failed} failed${result.disabled ? `, ${result.disabled} stale disabled` : ""}\n`);
  if (result.sent === 0) process.exitCode = 69;
}

async function capacityHistoryExport(a: Args) {
  const stats = await exportCapacityHistory(a.label ?? "local");
  process.stderr.write(`exported ${stats.records.toLocaleString()} records${stats.firstAt ? ` from ${stats.firstAt} to ${stats.lastAt}` : ""}\n`);
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

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
  process.stdout.write(`${packageMetadata.version}\n`);
  process.exit(0);
}
const routeExit = runRouteCommand(argv);
if (routeExit !== undefined) {
  process.exitCode = routeExit;
} else {
  const runExit = await runRunCommand(argv);
  if (runExit !== undefined) {
    process.exitCode = runExit;
  } else {
    const capacityExit = await runCapacityCommand(argv);
    if (capacityExit !== undefined) {
      process.exitCode = capacityExit;
    } else {
      const evalExit = runEvalCommand(argv);
      if (evalExit !== undefined) {
        process.exitCode = evalExit;
      } else {
        const accountArgs = parseAccountArgs(argv);
        if (accountArgs) {
          console.log(await addAccount(accountArgs));
          process.exit(0);
        }
        const args = parseArgs(argv);
        if (args.cmd === "watch") watch(args);
        else if (args.cmd === "limits") await limits(args);
        else if (args.cmd === "guard") process.exitCode = guard(args);
        else if (args.cmd === "server") await server(args);
        else if (args.cmd === "push-test") await pushTest(args);
        else if (args.cmd === "capacity-history-export") await capacityHistoryExport(args);
        else await report(args);
      }
    }
  }
}

#!/usr/bin/env bun
// spendwatch — find which tool calls and prompts burn the most tokens/$ in Claude Code.
import { homedir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "./aggregate";
import { renderReport } from "./render";
import { IncrementalReader, listTranscripts } from "./scan";

interface Args {
  cmd: "report" | "watch";
  days: number;
  dir: string;
  project?: string;
  top: number;
  json: boolean;
  interval: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "report",
    days: 30,
    dir: join(homedir(), ".claude", "projects"),
    top: 15,
    json: false,
    interval: 2000,
  };
  const rest = [...argv];
  while (rest.length) {
    const x = rest.shift()!;
    if (x === "report" || x === "watch") a.cmd = x;
    else if (x === "--days") a.days = Number(rest.shift());
    else if (x === "--dir") a.dir = rest.shift()!;
    else if (x === "--project") a.project = rest.shift();
    else if (x === "--top") a.top = Number(rest.shift());
    else if (x === "--json") a.json = true;
    else if (x === "--interval") a.interval = Number(rest.shift());
    else if (x === "--help" || x === "-h") {
      console.log(`spendwatch — token/$ leaderboards for Claude Code transcripts

usage: spendwatch [report|watch] [options]

  report            aggregate past sessions (default)
  watch             live leaderboard, refreshes as sessions write

options:
  --days N          look back N days (default 30; watch default 1)
  --project STR     filter project dir by substring
  --top N           prompt rows to show (default 15)
  --json            machine-readable output (report only)
  --dir PATH        transcript root (default ~/.claude/projects)
  --interval MS     watch poll interval (default 2000)`);
      process.exit(0);
    }
  }
  return a;
}

function buildOnce(a: Args): { agg: Aggregator; reader: IncrementalReader; files: Array<{ path: string; project: string }> } {
  const agg = new Aggregator();
  const reader = new IncrementalReader(agg);
  const sinceMs = Date.now() - a.days * 86400_000;
  const files = listTranscripts({ dir: a.dir, sinceMs, project: a.project });
  for (const f of files) {
    reader.poll(f.path, f.project);
    reader.flush(f.path, f.project);
  }
  return { agg, reader, files };
}

function report(a: Args) {
  const { agg } = buildOnce(a);
  const r = agg.report(a.top);
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else process.stdout.write(renderReport(r));
}

async function watch(a: Args) {
  if (a.days === 30) a.days = 1; // watch defaults to today-ish
  const { agg, reader } = buildOnce(a);
  const sinceMs = Date.now() - a.days * 86400_000;
  const draw = () => {
    const body = renderReport(agg.report(a.top));
    process.stdout.write("\x1b[2J\x1b[H" + body + `\n\x1b[2m${new Date().toLocaleTimeString()} watching ${a.dir} (ctrl-c to exit)\x1b[0m\n`);
  };
  draw();
  setInterval(() => {
    let changed = 0;
    for (const f of listTranscripts({ dir: a.dir, sinceMs, project: a.project })) {
      changed += reader.poll(f.path, f.project);
    }
    if (changed > 0) draw();
  }, a.interval);
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd === "watch") watch(args);
else report(args);

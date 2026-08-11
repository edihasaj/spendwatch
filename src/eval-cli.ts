import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRoutePlan, type RoutingModel, type RoutingRisk, type TaskKind } from "./routing";

interface EvalCase {
  task: string;
  repo?: string;
  files?: string[];
  risk?: RoutingRisk;
  expectedModel?: RoutingModel;
  expectedRisk?: "low" | "medium" | "high";
  expectedKind?: TaskKind;
}

interface EvalArgs { input?: string; sqlite?: string; repo: string; json: boolean; help: boolean }

export function evalHelp(): string {
  return `spendwatch eval [JSONL] [options]

Replay historical tasks through the current routing policy without model calls.

options:
  --input PATH      JSONL cases; fields: task, repo/files/risk, expectedModel/Risk/Kind
  --sqlite PATH     replay tasks recorded by spendwatch run and report routing drift
  --repo PATH       default repository for JSONL cases
  --json            machine-readable report
  -h, --help        show this help`;
}

function parseEvalArgs(argv: string[]): EvalArgs | undefined {
  if (argv[0] !== "eval") return undefined;
  if (argv.includes("--help") || argv.includes("-h")) return { repo: process.cwd(), json: false, help: true };
  const args: EvalArgs = { repo: process.cwd(), json: false, help: false };
  const rest = argv.slice(1);
  while (rest.length) {
    const arg = rest.shift()!;
    const value = (flag: string) => {
      const next = rest.shift();
      if (!next || next.startsWith("-")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (arg === "--input") args.input = resolve(value(arg));
    else if (arg === "--sqlite") args.sqlite = resolve(value(arg));
    else if (arg === "--repo") args.repo = resolve(value(arg));
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown eval option: ${arg}`);
    else if (!args.input) args.input = resolve(arg);
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.input && !args.sqlite) throw new Error("provide JSONL or --sqlite PATH");
  if (args.input && args.sqlite) throw new Error("use either JSONL or --sqlite, not both");
  return args;
}

function loadCases(args: EvalArgs): EvalCase[] {
  if (args.sqlite) {
    const db = new Database(args.sqlite, { readonly: true });
    try {
      return db.query("SELECT task, repo, planned_model AS expectedModel FROM routing_runs WHERE status != 'running'").all() as EvalCase[];
    } finally { db.close(); }
  }
  return readFileSync(args.input!, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as EvalCase; }
    catch { throw new Error(`invalid JSON on line ${index + 1}`); }
  });
}

export function evaluateCases(cases: EvalCase[], defaultRepo: string) {
  let assertions = 0;
  let passed = 0;
  const results = cases.map((item, index) => {
    if (!item.task) throw new Error(`case ${index + 1} is missing task`);
    const plan = buildRoutePlan({ task: item.task, repo: item.repo ?? defaultRepo, files: item.files, risk: item.risk });
    const checks = {
      model: item.expectedModel === undefined ? undefined : item.expectedModel === plan.decision.model,
      risk: item.expectedRisk === undefined ? undefined : item.expectedRisk === plan.contract.risk,
      kind: item.expectedKind === undefined ? undefined : item.expectedKind === plan.contract.kind,
    };
    for (const value of Object.values(checks)) if (value !== undefined) { assertions++; if (value) passed++; }
    return { task: item.task, actual: { model: plan.decision.model, risk: plan.contract.risk, kind: plan.contract.kind }, expected: { model: item.expectedModel, risk: item.expectedRisk, kind: item.expectedKind }, checks };
  });
  return { policyVersion: cases.length ? buildRoutePlan({ task: cases[0]!.task, repo: cases[0]!.repo ?? defaultRepo }).policyVersion : undefined, cases: cases.length, assertions, passed, failed: assertions - passed, accuracy: assertions ? passed / assertions : null, results };
}

export function runEvalCommand(argv: string[]): number | undefined {
  try {
    const args = parseEvalArgs(argv);
    if (!args) return undefined;
    if (args.help) { process.stdout.write(evalHelp() + "\n"); return 0; }
    const report = evaluateCases(loadCases(args), args.repo);
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else process.stdout.write(`SpendWatch routing eval: ${report.passed}/${report.assertions} assertions passed across ${report.cases} tasks${report.accuracy === null ? "" : ` (${(report.accuracy * 100).toFixed(1)}%)`}\n`);
    return report.failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`spendwatch eval: ${error instanceof Error ? error.message : String(error)}\nTry 'spendwatch eval --help'.\n`);
    return 2;
  }
}

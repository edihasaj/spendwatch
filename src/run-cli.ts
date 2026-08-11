import { homedir } from "node:os";
import { resolve } from "node:path";
import { executeRoute } from "./run-engine";
import { buildRoutePlan, type RoutingRisk } from "./routing";

interface RunArgs {
  task: string;
  repo: string;
  files: string[];
  risk: RoutingRisk;
  provider: "auto" | "codex" | "deepseek";
  verify?: string[];
  database?: string;
  shadow: boolean;
  maxAttempts: number;
  json: boolean;
  help: boolean;
}

function defaultDatabase(): string {
  const data = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
  return resolve(data, "spendwatch", "routing.db");
}

export function runHelp(): string {
  return `spendwatch run TASK [options]

Route, execute, verify, and record a coding task. Failed work escalates one model tier.

examples:
  spendwatch run "fix the parser bug" --repo .
  spendwatch run "explain the cache" --repo . --provider deepseek
  spendwatch run "add pagination" --repo . --shadow --json

options:
  --task TEXT          task text; positional TASK is also accepted
  --repo PATH          repository to work in (default current directory)
  --file PATH          scoped file, repeatable
  --risk LEVEL         auto, low, medium, or high (default auto)
  --provider P         auto, codex, or deepseek (default auto)
  --verify COMMAND     deterministic check, repeatable; overrides inferred checks
  --shadow             record the proposed route but execute with Sol
  --max-attempts N     maximum model tiers, 1-3 (default 3)
  --sqlite PATH        routing outcome database (default user data directory)
  --no-store           do not persist this run
  --json               machine-readable summary
  -h, --help           show this help

DeepSeek is opt-in, needs DEEPSEEK_API_KEY, and starts read-only. Repository edits use Codex.`;
}

export function parseRunArgs(argv: string[]): RunArgs | undefined {
  if (argv[0] !== "run") return undefined;
  if (argv.includes("--help") || argv.includes("-h")) return {
    task: "", repo: process.cwd(), files: [], risk: "auto", provider: "auto", database: defaultDatabase(),
    shadow: false, maxAttempts: 3, json: false, help: true,
  };
  const rest = argv.slice(1);
  const tasks: string[] = [];
  const args: RunArgs = {
    task: "", repo: process.cwd(), files: [], risk: "auto", provider: "auto", database: defaultDatabase(),
    shadow: false, maxAttempts: 3, json: false, help: false,
  };
  while (rest.length) {
    const arg = rest.shift()!;
    const value = (flag: string): string => {
      const next = rest.shift();
      if (!next || next.startsWith("-")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (arg === "--task") tasks.push(value(arg));
    else if (arg === "--repo") args.repo = value(arg);
    else if (arg === "--file") args.files.push(value(arg));
    else if (arg === "--verify") (args.verify ??= []).push(value(arg));
    else if (arg === "--risk") {
      const risk = value(arg);
      if (risk !== "auto" && risk !== "low" && risk !== "medium" && risk !== "high") throw new Error("--risk must be auto, low, medium, or high");
      args.risk = risk;
    } else if (arg === "--provider") {
      const provider = value(arg);
      if (provider !== "auto" && provider !== "codex" && provider !== "deepseek") throw new Error("--provider must be auto, codex, or deepseek");
      args.provider = provider;
    } else if (arg === "--max-attempts") args.maxAttempts = Number(value(arg));
    else if (arg === "--sqlite") args.database = resolve(value(arg));
    else if (arg === "--no-store") args.database = undefined;
    else if (arg === "--shadow") args.shadow = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown run option: ${arg}`);
    else tasks.push(arg);
  }
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 3) throw new Error("--max-attempts must be an integer from 1 to 3");
  args.task = tasks.join(" ").trim();
  return args;
}

export async function runRunCommand(argv: string[]): Promise<number | undefined> {
  try {
    const args = parseRunArgs(argv);
    if (!args) return undefined;
    if (args.help) { process.stdout.write(runHelp() + "\n"); return 0; }
    if (!args.task) throw new Error("TASK is required");
    const plan = buildRoutePlan({ task: args.task, repo: args.repo, files: args.files, risk: args.risk });
    const result = await executeRoute({ plan, provider: args.provider, shadow: args.shadow, maxAttempts: args.maxAttempts, verify: args.verify, database: args.database });
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      const route = args.shadow ? `${plan.decision.model} proposed; gpt-5.6-sol baseline` : `${plan.decision.model} selected`;
      process.stdout.write(`SpendWatch run: ${result.status} (${route})\n`);
      for (const attempt of result.attempts) process.stdout.write(`  ${attempt.attempt}. ${attempt.result.provider}/${attempt.model}: ${attempt.result.ok ? "passed" : "failed"} (${attempt.durationMs}ms)\n`);
      if (result.output) process.stdout.write(`\n${result.output.trim()}\n`);
      if (result.error) process.stderr.write(`\n${result.error}\n`);
      if (result.database) process.stdout.write(`\nOutcome: ${result.database}\n`);
    }
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`spendwatch run: ${error instanceof Error ? error.message : String(error)}\nTry 'spendwatch run --help'.\n`);
    return 2;
  }
}

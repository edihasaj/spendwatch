import { buildRoutePlan, renderRoutePlan, type RoutingRisk } from "./routing";

interface RouteArgs {
  task: string;
  repo: string;
  files: string[];
  risk: RoutingRisk;
  json: boolean;
  help: boolean;
}

export function routeHelp(): string {
  return `spendwatch route TASK [options]

Build an evidence-driven model plan. Read-only: no model or network calls.

examples:
  spendwatch route "find the source of this build error" --repo .
  spendwatch route "rename the account label" --repo . --file src/accounts.ts
  spendwatch route "plan the auth migration" --repo . --risk high --json

options:
  --task TEXT       task text; positional TASK is also accepted
  --repo PATH       repository to inspect (default current directory)
  --file PATH       scoped file, repeatable; stronger evidence than wording
  --risk LEVEL      auto, low, medium, or high (default auto)
  --dry-run         accepted for explicitness; route never executes models
  --json            stable machine-readable plan
  -h, --help        show this help`;
}

export function parseRouteArgs(argv: string[]): RouteArgs | undefined {
  if (argv[0] !== "route") return undefined;
  if (argv.includes("--help") || argv.includes("-h")) {
    return { task: "", repo: process.cwd(), files: [], risk: "auto", json: false, help: true };
  }
  const rest = argv.slice(1);
  const tasks: string[] = [];
  const args: RouteArgs = { task: "", repo: process.cwd(), files: [], risk: "auto", json: false, help: false };
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
    else if (arg === "--risk") {
      const risk = value(arg);
      if (risk !== "auto" && risk !== "low" && risk !== "medium" && risk !== "high") {
        throw new Error("--risk must be auto, low, medium, or high");
      }
      args.risk = risk;
    } else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") {}
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown route option: ${arg}`);
    else tasks.push(arg);
  }
  args.task = tasks.join(" ").trim();
  return args;
}

export function runRouteCommand(argv: string[]): number | undefined {
  try {
    const args = parseRouteArgs(argv);
    if (!args) return undefined;
    if (args.help) {
      process.stdout.write(routeHelp() + "\n");
      return 0;
    }
    if (!args.task) throw new Error("TASK is required");
    const plan = buildRoutePlan({ task: args.task, repo: args.repo, files: args.files, risk: args.risk });
    process.stdout.write(args.json ? JSON.stringify(plan, null, 2) + "\n" : renderRoutePlan(plan));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`spendwatch route: ${message}\nTry 'spendwatch route --help'.\n`);
    return 2;
  }
}

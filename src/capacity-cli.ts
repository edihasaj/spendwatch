import { resolve } from "node:path";
import { archiveCapacityHistory, restoreCapacityArchive } from "./capacity-archive";

interface CapacityArgs {
  action: "archive" | "restore";
  sqlite: string;
  archive?: string;
  archiveDir?: string;
  keepDays: number;
  before?: number;
  force: boolean;
  dryRun: boolean;
  vacuum: boolean;
  json: boolean;
  help: boolean;
}

export function capacityHelp(): string {
  return `spendwatch capacity <archive|restore> [options]

Archive history older than one year into a verified compressed SQLite file.

examples:
  spendwatch capacity archive --sqlite spendwatch.db
  spendwatch capacity archive --sqlite spendwatch.db --force
  spendwatch capacity restore data/archives/capacity-before-2025-08-12-20260812T000000Z.db.gz --sqlite restored.db

archive options:
  --sqlite PATH       live SQLite database (required)
  --archive-dir PATH  destination (default archives/ beside the database)
  --keep-days N       live retention, at least 30 days (default 365)
  --before DATE       explicit UTC cutoff, YYYY-MM-DD; replaces --keep-days
  --force             archive, verify, delete matched rows, and compact
  --dry-run           preview only (also the default without --force)
  --no-vacuum         retain reusable free pages instead of shrinking now
  --json              machine-readable result

restore options:
  ARCHIVE             .db.gz archive to verify and restore
  --sqlite PATH       destination SQLite database (required)
  --json              machine-readable result
  -h, --help          show this help

Restore is additive and idempotent. Archives are never deleted automatically.`;
}

export function parseCapacityArgs(argv: string[]): CapacityArgs | undefined {
  if (argv[0] !== "capacity") return undefined;
  if (argv.includes("--help") || argv.includes("-h")) return { action: "archive", sqlite: "", keepDays: 365, force: false, dryRun: true, vacuum: true, json: false, help: true };
  const action = argv[1];
  if (action !== "archive" && action !== "restore") throw new Error("action must be archive or restore");
  const args: CapacityArgs = { action, sqlite: "", keepDays: 365, force: false, dryRun: false, vacuum: true, json: false, help: false };
  const rest = argv.slice(2);
  while (rest.length) {
    const arg = rest.shift()!;
    const value = (flag: string) => {
      const next = rest.shift();
      if (!next || next.startsWith("-")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (arg === "--sqlite" || arg === "--db") args.sqlite = resolve(value(arg));
    else if (arg === "--archive-dir") args.archiveDir = resolve(value(arg));
    else if (arg === "--keep-days") args.keepDays = Number(value(arg));
    else if (arg === "--before") {
      const date = value(arg);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--before must use YYYY-MM-DD");
      args.before = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(args.before)) throw new Error("--before is not a valid date");
    } else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-vacuum") args.vacuum = false;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown capacity option: ${arg}`);
    else if (action === "restore" && !args.archive) args.archive = resolve(arg);
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.sqlite) throw new Error("--sqlite PATH is required");
  if (args.before !== undefined && argv.includes("--keep-days")) throw new Error("use either --before or --keep-days, not both");
  if (args.force && args.dryRun) throw new Error("--force and --dry-run cannot be combined");
  if (action === "restore" && !args.archive) throw new Error("ARCHIVE is required");
  if (action === "restore" && (args.force || args.before !== undefined || args.archiveDir || argv.includes("--keep-days") || !args.vacuum)) throw new Error("archive-only options cannot be used with restore");
  return args;
}

export async function runCapacityCommand(argv: string[]): Promise<number | undefined> {
  try {
    const args = parseCapacityArgs(argv);
    if (!args) return undefined;
    if (args.help) { process.stdout.write(capacityHelp() + "\n"); return 0; }
    const result = args.action === "archive"
      ? await archiveCapacityHistory({ database: args.sqlite, archiveDir: args.archiveDir, keepDays: args.keepDays, before: args.before, force: args.force && !args.dryRun, vacuum: args.vacuum })
      : await restoreCapacityArchive(args.sqlite, args.archive!);
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (args.action === "restore") process.stdout.write(`Capacity restore complete: ${result.windows} window rows, ${result.accounts} account rows added.\n`);
    else if (result.dryRun) process.stdout.write(`Capacity archive preview: ${result.eligible.windows + result.eligible.accounts} rows before ${result.cutoff}. Rerun with --force.\n`);
    else if (!result.archive) process.stdout.write(`Capacity archive: no rows older than ${result.cutoff}.\n`);
    else process.stdout.write(`Capacity archive complete: ${result.deleted.windows + result.deleted.accounts} rows → ${result.archive}; database ${(result.bytes.after / 1_048_576).toFixed(1)} MiB.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`spendwatch capacity: ${error instanceof Error ? error.message : String(error)}\nTry 'spendwatch capacity --help'.\n`);
    return 2;
  }
}

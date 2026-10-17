// Compiles the self-contained binary (bin/spendwatch) and cleans up after itself.
//
// `bun build --compile` stages the binary in a hidden `.<hash>-00000000.bun-build` file in the working directory, a
// copy of the Bun runtime of about 68 MB, and a build can leave one behind: nineteen of them sat in a checkout, over a
// gigabyte. This removes the ones a build made, and only those: files that were there before it started are not this
// script's to delete.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const STAGING = /^\..+\.bun-build$/;

const staged = (cwd: string): Set<string> => new Set(readdirSync(cwd).filter((name) => STAGING.test(name)));

/** Runs `command` in `cwd`, then removes the staging files it left there. Returns the command's exit code. */
export function buildClean(cwd: string, command: string[]): number {
  const before = staged(cwd);
  const result = Bun.spawnSync(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  for (const name of staged(cwd)) if (!before.has(name)) rmSync(join(cwd, name), { force: true });
  return result.exitCode ?? 1;
}

if (import.meta.main) {
  process.exit(buildClean(process.cwd(), ["bun", "build", "src/cli.ts", "--compile", "--outfile", "bin/spendwatch"]));
}

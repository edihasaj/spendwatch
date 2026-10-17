// Temporary directories for tests, removed once every test file has run (the preload, isolate-gateway.ts, calls
// `removeTempDirs` from an afterAll hook; `bun test` never fires the process "exit" event). A test that makes its own
// with mkdtempSync leaves it behind on every run; make it here instead.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set<string>();

/** Removes every directory `tempDir` made so far. */
export function removeTempDirs(): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.clear();
}

/** A new empty directory under the system temp directory, named `prefix` plus a random suffix. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

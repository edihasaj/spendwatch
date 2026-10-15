import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClean } from "../scripts/build";
import { tempDir } from "./tmp";

// `bun build --compile` stages a copy of Bun in a hidden `.<hash>-00000000.bun-build` file and can leave it behind, so
// the build script removes what a build left. It must not remove what was there already: those files are not its own.
describe("the build script", () => {
  const stage = (dir: string, name: string) => writeFileSync(join(dir, name), "staged");
  const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".bun-build")).sort();

  test("removes the staging files a build left, and returns its exit code", () => {
    const dir = tempDir("spendwatch-build-script-");
    expect(buildClean(dir, ["sh", "-c", "touch .abc-00000000.bun-build .def-00000000.bun-build; exit 0"])).toBe(0);
    expect(leftovers(dir)).toEqual([]);
  });

  test("keeps the files that were there before the build, and any file that is not a staging file", () => {
    const dir = tempDir("spendwatch-build-script-");
    stage(dir, ".old-00000000.bun-build");
    stage(dir, "notes.bun-build");
    mkdirSync(join(dir, "bin"));
    expect(buildClean(dir, ["sh", "-c", "touch .new-00000000.bun-build bin/spendwatch"])).toBe(0);
    expect(leftovers(dir)).toEqual([".old-00000000.bun-build", "notes.bun-build"]);
    expect(existsSync(join(dir, "bin", "spendwatch"))).toBe(true);
  });

  test("cleans up after a build that fails too, and reports the failure", () => {
    const dir = tempDir("spendwatch-build-script-");
    expect(buildClean(dir, ["sh", "-c", "touch .half-00000000.bun-build; exit 3"])).toBe(3);
    expect(leftovers(dir)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCases } from "../src/eval-cli";
import { parseRunArgs } from "../src/run-cli";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "spendwatch-eval-"));
  writeFileSync(join(path, "package.json"), "{}");
  return path;
}

describe("routing CLI and eval", () => {
  test("parses execution controls without confusing task wording", () => {
    expect(parseRunArgs(["run", "quick", "auth", "fix", "--repo", ".", "--file", "src/auth.ts", "--shadow", "--verify", "bun test"])).toMatchObject({
      task: "quick auth fix", repo: ".", files: ["src/auth.ts"], risk: "auto", shadow: true, verify: ["bun test"], maxAttempts: 3,
    });
  });

  test("scores representative historical contracts", () => {
    const path = repo();
    const report = evaluateCases([
      { task: "inspect the parser", expectedModel: "gpt-5.6-luna", expectedKind: "read-only" },
      { task: "add pagination", expectedModel: "gpt-5.6-terra", expectedRisk: "medium" },
      { task: "migrate the production database", expectedModel: "gpt-5.6-sol", expectedRisk: "high" },
    ], path);
    expect(report).toMatchObject({ cases: 3, assertions: 6, passed: 6, failed: 0, accuracy: 1 });
  });
});

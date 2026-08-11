import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRouteArgs } from "../src/route-cli";
import { buildRoutePlan } from "../src/routing";

function repo(manifests: string[] = []): string {
  const path = mkdtempSync(join(tmpdir(), "spendwatch-route-"));
  for (const manifest of manifests) writeFileSync(join(path, manifest), "{}");
  return path;
}

describe("route policy", () => {
  test("routes bounded read-only work to Luna", () => {
    const plan = buildRoutePlan({ task: "inspect the parser and explain the failure", repo: repo(["package.json"]) }, 0);
    expect(plan.decision).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    expect(plan.contract).toMatchObject({ kind: "read-only", risk: "low" });
    expect(plan.dryRun).toBe(true);
  });

  test("uses scoped files as evidence for mechanical work", () => {
    const path = repo(["package.json"]);
    writeFileSync(join(path, "README.md"), "hello");
    const plan = buildRoutePlan({ task: "fix the typo", repo: path, files: ["README.md"] }, 0);
    expect(plan.decision.model).toBe("gpt-5.6-luna");
    expect(plan.contract.scopedFiles).toEqual(["README.md"]);
    expect(plan.decision.reasonCodes).toContain("scoped_files");
  });

  test("hard-routes migration and auth scope to Sol", () => {
    const path = repo(["package.json"]);
    mkdirSync(join(path, "migrations"));
    const plan = buildRoutePlan({ task: "update account storage", repo: path, files: ["migrations/001.sql"] }, 0);
    expect(plan.decision).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    expect(plan.evidence.riskSignals).toContain("database_migration");
  });

  test("keeps ordinary implementation on Terra", () => {
    const plan = buildRoutePlan({ task: "add pagination to the report", repo: repo(["package.json"]) }, 0);
    expect(plan.decision).toMatchObject({ model: "gpt-5.6-terra", effort: "medium" });
  });

  test("raises uncertainty for an unscoped workspace", () => {
    const plan = buildRoutePlan({ task: "improve error handling", repo: repo(["package.json", "pnpm-workspace.yaml"]) }, 0);
    expect(plan.contract).toMatchObject({ kind: "broad", uncertainty: "high" });
    expect(plan.decision).toMatchObject({ model: "gpt-5.6-terra", effort: "high" });
  });

  test("parses composable CLI input", () => {
    expect(parseRouteArgs(["route", "fix", "copy", "--repo", ".", "--file", "README.md", "--risk", "low", "--json"])).toMatchObject({
      task: "fix copy", repo: ".", files: ["README.md"], risk: "low", json: true,
    });
  });

  test("help ignores other arguments", () => {
    expect(parseRouteArgs(["route", "--risk", "impossible", "--help"])?.help).toBe(true);
  });
});

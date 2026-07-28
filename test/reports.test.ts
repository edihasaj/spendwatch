import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { labelReports, loadReports, sourceLabel } from "../src/reports";

function report(source = "codex"): Report {
  return {
    source,
    totalCost: 1,
    apiCalls: 2,
    sessions: 1,
    tools: [],
    bash: [],
    deep: [],
    targets: [],
    prompts: [],
    models: [],
    projects: [],
    accounts: [],
    sinceTs: 1,
  };
}

describe("portable reports", () => {
  test("loads arrays exported on another machine", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spendwatch-reports-")), "report.json");
    writeFileSync(path, JSON.stringify([report("codex"), report("claude")]));
    expect(loadReports([path]).map((item) => item.source)).toEqual(["codex", "claude"]);
  });

  test("labels reports without mutating exported input", () => {
    const input = [report()];
    const output = labelReports(input, "macbook");
    expect(output[0].source).toBe("macbook:codex");
    expect(input[0].source).toBe("codex");
    expect(sourceLabel(output[0].source)).toBe("macbook · Codex");
  });

  test("rejects malformed imports", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spendwatch-reports-")), "bad.json");
    writeFileSync(path, JSON.stringify({ source: "codex" }));
    expect(() => loadReports([path])).toThrow("invalid spendwatch report");
  });
});

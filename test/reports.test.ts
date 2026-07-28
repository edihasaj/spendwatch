import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { renderHtml } from "../src/html";
import { labelReports, loadReports, mergeReports, reportBreakdowns, sourceLabel } from "../src/reports";

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

  test("merges machines into one report and preserves useful dimensions", () => {
    const studio = {
      ...report("studio:codex"),
      accounts: [{ account: "edi@example.com", cost: 1, calls: 2, sessions: 1 }],
    };
    const macbook = {
      ...report("macbook:codex"),
      totalCost: 2,
      apiCalls: 3,
      accounts: [{ account: "edi@example.com", cost: 2, calls: 3, sessions: 1 }],
    };
    const merged = mergeReports([studio, macbook]);
    expect(merged.source).toBe("all");
    expect(merged.totalCost).toBe(3);
    expect(merged.apiCalls).toBe(5);
    expect(merged.accounts).toEqual([{ account: "Codex · edi@example.com", cost: 3, calls: 5, sessions: 2 }]);

    const dimensions = reportBreakdowns([studio, macbook]);
    expect(dimensions.machines.map((row) => row.label)).toEqual(["macbook", "studio"]);
    expect(dimensions.agents).toEqual([{ label: "Codex", cost: 3, calls: 5, sessions: 2 }]);
    expect(dimensions.accounts).toEqual([{ label: "Codex · edi@example.com", cost: 3, calls: 5, sessions: 2 }]);
  });

  test("keeps the same email separate by service unless email grouping is requested", () => {
    const codex = {
      ...report("studio:codex"),
      accounts: [{ account: "edi@example.com", cost: 1, calls: 2, sessions: 1 }],
    };
    const claude = {
      ...report("macbook:claude"),
      totalCost: 2,
      accounts: [{ account: "edi@example.com", cost: 2, calls: 3, sessions: 1 }],
    };

    expect(reportBreakdowns([codex, claude]).accounts.map((row) => row.label)).toEqual([
      "Claude Code · edi@example.com",
      "Codex · edi@example.com",
    ]);
    expect(reportBreakdowns([codex, claude], "email").accounts).toEqual([
      { label: "edi@example.com", cost: 3, calls: 5, sessions: 2 },
    ]);

    const serviceHtml = renderHtml([codex, claude], { generatedAt: 1, days: 30 });
    expect(serviceHtml).toContain("By service &amp; account");
    expect(serviceHtml).toContain("Claude Code · edi@example.com");
    expect(serviceHtml).toContain("Codex · edi@example.com");

    const emailHtml = renderHtml([codex, claude], {
      generatedAt: 1,
      days: 30,
      accountGrouping: "email",
    });
    expect(emailHtml).toContain("By account email");
  });
});

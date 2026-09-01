import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { renderHtml } from "../src/html";
import { monthPeriod } from "../src/periods";
import { labelReports, loadReports, mergeReports, reportBreakdowns, sourceLabel } from "../src/reports";

function report(source = "codex"): Report {
  return {
    source,
    totalTokens: 100,
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

  test("hydrates token totals from legacy cost-only exports", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spendwatch-reports-")), "legacy.json");
    const legacy = {
      ...report("codex"),
      totalTokens: undefined,
      models: [{ model: "gpt-5", calls: 1, inTok: 100, outTok: 20, cacheReadTok: 300, cacheWriteTok: 10, cost: 1 }],
      accounts: [{ account: "edi@example.com", cost: 1, calls: 1, sessions: 1 }],
      prompts: [{ key: "p", text: "hello", project: "demo", cost: 1, toolCalls: 0, outTok: 20, ts: 1 }],
      projects: [{ project: "demo", cost: 1 }],
    };
    writeFileSync(path, JSON.stringify(legacy));

    const [loaded] = loadReports([path]);
    expect(loaded.totalTokens).toBe(430);
    expect(loaded.accounts[0].tokens).toBe(0);
    expect(loaded.prompts[0].tokens).toBe(20);
    expect(loaded.projects[0].tokens).toBe(0);
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
      accounts: [{ account: "edi@example.com", tokens: 100, cost: 1, calls: 2, sessions: 1 }],
    };
    const macbook = {
      ...report("macbook:codex"),
      totalCost: 2,
      totalTokens: 200,
      apiCalls: 3,
      accounts: [{ account: "edi@example.com", tokens: 200, cost: 2, calls: 3, sessions: 1 }],
    };
    const merged = mergeReports([studio, macbook]);
    expect(merged.source).toBe("all");
    expect(merged.totalCost).toBe(3);
    expect(merged.totalTokens).toBe(300);
    expect(merged.apiCalls).toBe(5);
    expect(merged.accounts).toEqual([{ account: "Codex · edi@example.com", tokens: 300, cost: 3, calls: 5, sessions: 2 }]);

    const dimensions = reportBreakdowns([studio, macbook]);
    expect(dimensions.machines.map((row) => row.label)).toEqual(["macbook", "studio"]);
    expect(dimensions.agents).toEqual([{ label: "Codex", tokens: 300, cost: 3, calls: 5, sessions: 2 }]);
    expect(dimensions.accounts).toEqual([{ label: "Codex · edi@example.com", tokens: 300, cost: 3, calls: 5, sessions: 2 }]);
  });

  test("keeps the same email separate by service unless email grouping is requested", () => {
    const codex = {
      ...report("studio:codex"),
      accounts: [{ account: "edi@example.com", tokens: 100, cost: 1, calls: 2, sessions: 1 }],
    };
    const claude = {
      ...report("macbook:claude"),
      totalCost: 2,
      totalTokens: 200,
      accounts: [{ account: "edi@example.com", tokens: 200, cost: 2, calls: 3, sessions: 1 }],
    };

    expect(reportBreakdowns([codex, claude]).accounts.map((row) => row.label)).toEqual([
      "Claude Code · edi@example.com",
      "Codex · edi@example.com",
    ]);
    expect(reportBreakdowns([codex, claude], "email").accounts).toEqual([
      { label: "edi@example.com", tokens: 300, cost: 3, calls: 5, sessions: 2 },
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

  test("shows stable account number chips per service", () => {
    const studio = {
      ...report("studio:codex"),
      accounts: [
        { account: "third@example.com", tokens: 300, cost: 3, calls: 3, sessions: 1 },
        { account: "first@example.com", tokens: 100, cost: 1, calls: 1, sessions: 1 },
      ],
    };
    const macbook = {
      ...report("macbook:codex"),
      accounts: [
        { account: "second@example.com", tokens: 200, cost: 2, calls: 2, sessions: 1 },
        { account: "first@example.com", tokens: 100, cost: 1, calls: 1, sessions: 1 },
      ],
    };

    const html = renderHtml([studio, macbook], { generatedAt: 1, days: 30 });
    expect(html).toContain('<span class="account-chip" aria-label="Account 1">Account 1</span>');
    expect(html).toContain('<span class="account-chip" aria-label="Account 2">Account 2</span>');
    expect(html).toContain('<span class="account-chip" aria-label="Account 3">Account 3</span>');
    expect(html).toContain("Codex · first@example.com");
    expect(html).toContain("Codex · second@example.com");
    expect(html).toContain("Codex · third@example.com");
    expect(html).toContain("td .account-identity{align-items:flex-start;flex-direction:column;gap:4px;min-width:140px}");
  });

  test("uses the same application shell as the capacity view", () => {
    const html = renderHtml([report("studio:codex")], {
      generatedAt: 1,
      days: 30,
      limitsHref: "./",
    });
    expect(html).toContain('class="topbar"');
    expect(html).toContain('class="nav"');
    expect(html).toContain("History");
    expect(html.indexOf("Spend detail")).toBeLessThan(html.indexOf(">History</a>"));
    expect(html).toContain('href="./#setup">Add account</a>');
    expect(html).toContain("Fragment+Mono");
    expect(html).toContain('class="panels"');
    expect(html).toContain('100 tokens');
    expect(html).toContain('100 exact');
    expect(html.indexOf('100 tokens')).toBeLessThan(html.indexOf('$1.00 estimated'));
    expect(html).toContain('>100</span><span class="l">tokens');
    expect(html).toContain('for the last 30 days');
    expect(html).toContain('role="region" aria-label="By machine"');
    expect(html).toContain("min-height:44px");
    expect(html).toContain("refreshValues");
    expect(html).not.toContain("location.reload()");
    expect(html).not.toContain("Know what you can");
  });
});

describe("spend report period", () => {
  test("names the calendar month, and marks it as still running", () => {
    const september = monthPeriod("2026-09");
    const live = renderHtml([report("studio:claude")], {
      generatedAt: september.from + 86_400_000,
      days: 30,
      period: september,
    });
    expect(live).toContain("for September 2026 so far.");
    expect(live).not.toContain("for the last 30 days.");

    const closed = renderHtml([report("studio:claude")], {
      generatedAt: september.to,
      days: 30,
      period: september,
    });
    expect(closed).toContain("for September 2026.");
  });

  test("still describes a rolling window when one was asked for", () => {
    const html = renderHtml([report("studio:claude")], { generatedAt: 1, days: 7 });
    expect(html).toContain("for the last 7 days.");
  });
});

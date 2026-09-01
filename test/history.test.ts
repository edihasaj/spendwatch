import { describe, expect, test } from "bun:test";
import { renderHistoryHtml } from "../src/history";

describe("capacity history", () => {
  test("refreshes chart values without reloading the document", () => {
    const html = renderHistoryHtml({
      generatedAt: Date.parse("2026-08-10T10:00:00Z"),
      firstSampleAt: Date.parse("2026-08-01T10:00:00Z"),
      lastSampleAt: Date.parse("2026-08-10T10:00:00Z"),
      sampleCount: 2,
      series: [{
        provider: "codex",
        account: "work@example.com",
        kind: "weekly",
        sampleCount: 2,
        points: [
          { at: Date.parse("2026-08-09T10:00:00Z"), value: 20 },
          { at: Date.parse("2026-08-10T10:00:00Z"), value: 30 },
        ],
      }],
    });

    expect(html).toContain('id="stored-rows"');
    expect(html).toContain("setInterval(refreshValues,60000)");
    expect(html).toContain("values 60s");
    expect(html).toContain("compactDuration(ageMs)");
    expect(html.indexOf("Spend detail")).toBeLessThan(html.indexOf(">History</a>"));
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("location.reload()");
  });

  test("lists each closed month collapsed, with the live month open", () => {
    const html = renderHistoryHtml(
      { generatedAt: Date.parse("2026-09-01T06:00:00Z"), sampleCount: 0, series: [] },
      {
        months: [
          { month: "2026-09", label: "September 2026", tokens: 241_000_000, cost: 209, calls: 817, sessions: 12, updatedAt: Date.parse("2026-09-01T06:00:00Z"), sources: [{ source: "studio:claude", tokens: 241_000_000, cost: 209, calls: 817, sessions: 12 }], projects: [{ project: "spendwatch", tokens: 241_000_000, cost: 209 }] },
          { month: "2026-08", label: "August 2026", tokens: 79_920_000_000, cost: 67_369, calls: 300_015, sessions: 900, updatedAt: Date.parse("2026-08-31T23:00:00Z"), sources: [{ source: "mbp:codex", tokens: 79_920_000_000, cost: 67_369, calls: 300_015, sessions: 900 }], projects: [] },
        ],
      },
    );

    expect(html).toContain("Monthly spend");
    expect(html).toContain('<details class="month" open><summary><span class="month-name">September 2026');
    expect(html).toContain('<details class="month"><summary><span class="month-name">August 2026');
    expect(html).toContain("79.9B");
    expect(html).toContain("studio · Claude Code");
    // The caret is a literal glyph: a CSS unicode escape does not survive the
    // template literal this page is built from.
    expect(html).toContain('content:"▸"');
    // All time is the point of keeping closed months, so it leads the section.
    expect(html).toContain("80.2B tokens · $67578");
    expect(html).toContain("2 months since August 2026");
    // Usage shape, not just the bill.
    expect(html).toContain("Where it went");
    expect(html).toContain("spendwatch");
    // A month recorded before projects were tracked simply omits that pane.
    expect(html.match(/Where it went/g)).toHaveLength(1);
  });

  test("omits the monthly section entirely when nothing has been recorded", () => {
    const html = renderHistoryHtml({ generatedAt: 1, sampleCount: 0, series: [] });
    expect(html).not.toContain("Monthly spend");
  });
});

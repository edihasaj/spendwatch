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
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("location.reload()");
  });
});

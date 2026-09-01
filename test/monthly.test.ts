import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { MonthlyAggregator } from "../src/monthly";
import { monthPeriod } from "../src/periods";
import { parseLine } from "../src/parse";
import { IncrementalReader } from "../src/scan";
import type { SourceFile } from "../src/sources";

const SESS = "22222222-2222-2222-2222-222222222222";
const AUG_MID = new Date(2026, 7, 14, 10, 0, 0).toISOString();
const AUG_LATE = new Date(2026, 7, 31, 23, 45, 0).toISOString();
const SEP_EARLY = new Date(2026, 8, 1, 0, 15, 0).toISOString();

function usage(input: number) {
  return { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

// One session file, written across the month boundary: this is the shape that
// made a rolling window report August traffic as September spend.
function fixture(): SourceFile {
  const lines = [
    JSON.stringify({ type: "user", promptId: "p1", promptSource: "typed", sessionId: SESS, timestamp: AUG_MID, message: { role: "user", content: "august work" } }),
    JSON.stringify({
      type: "assistant", requestId: "req-aug", sessionId: SESS, timestamp: AUG_MID,
      message: { model: "claude-opus-4-8", usage: usage(1000), content: [{ type: "text", text: "ok" }] },
    }),
    JSON.stringify({
      type: "assistant", requestId: "req-edge", sessionId: SESS, timestamp: AUG_LATE,
      message: { model: "claude-opus-4-8", usage: usage(300), content: [{ type: "tool_use", id: "toolu_edge", name: "Bash", input: { command: "make" } }] },
    }),
    // The result lands after midnight, but it answers August's call.
    JSON.stringify({ type: "user", sessionId: SESS, timestamp: SEP_EARLY, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_edge", content: "x".repeat(400) }] } }),
    JSON.stringify({ type: "user", promptId: "p2", promptSource: "typed", sessionId: SESS, timestamp: SEP_EARLY, message: { role: "user", content: "september work" } }),
    JSON.stringify({
      type: "assistant", requestId: "req-sep", sessionId: SESS, timestamp: SEP_EARLY,
      message: { model: "claude-opus-4-8", usage: usage(70), content: [{ type: "text", text: "ok" }] },
    }),
  ];
  const path = join(mkdtempSync(join(tmpdir(), "spendwatch-monthly-")), `${SESS}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return { path, project: "demo", source: "claude", account: "default", parse: (line) => parseLine(line), ctx: null };
}

function drain(sink: Aggregator | MonthlyAggregator, file: SourceFile) {
  const reader = new IncrementalReader(sink);
  reader.poll(file);
  reader.flush(file);
}

describe("calendar-month windows", () => {
  test("a file touched this month does not carry last month's turns into it", () => {
    const september = new Aggregator(monthPeriod("2026-09"));
    drain(september, fixture());
    const report = september.report();
    expect(report.apiCalls).toBe(1);
    expect(report.totalTokens).toBe(70);
    expect(report.period?.key).toBe("2026-09");
  });

  test("an unwindowed aggregator still sees everything the file holds", () => {
    const all = new Aggregator();
    drain(all, fixture());
    expect(all.report().totalTokens).toBe(1370);
    expect(all.report().period).toBeUndefined();
  });

  test("one pass splits the same stream into per-month reports", () => {
    const monthly = new MonthlyAggregator([monthPeriod("2026-08"), monthPeriod("2026-09")]);
    drain(monthly, fixture());
    const reports = monthly.reports();
    expect(reports.get("2026-08")!.totalTokens).toBe(1300);
    expect(reports.get("2026-09")!.totalTokens).toBe(70);
    expect(reports.get("2026-08")!.apiCalls).toBe(2);
    expect(reports.get("2026-09")!.apiCalls).toBe(1);
    // Both months saw the one session, and neither invented a second one.
    expect(reports.get("2026-08")!.sessions).toBe(1);
    expect(reports.get("2026-09")!.sessions).toBe(1);
    // Project attribution survives the split even though `meta` is file-wide.
    expect(reports.get("2026-09")!.projects.map((row) => row.project)).toEqual(["demo"]);
  });

  test("a tool result that lands after midnight stays with the call it answers", () => {
    const monthly = new MonthlyAggregator([monthPeriod("2026-08"), monthPeriod("2026-09")]);
    drain(monthly, fixture());
    const reports = monthly.reports();
    const august = reports.get("2026-08")!.tools.find((row) => row.name === "Bash");
    expect(august?.calls).toBe(1);
    expect(august?.resultTok).toBeGreaterThan(0);
    expect(reports.get("2026-09")!.tools.find((row) => row.name === "Bash")).toBeUndefined();
  });

  test("a month with no traffic reports zero rather than being dropped", () => {
    const monthly = new MonthlyAggregator([monthPeriod("2026-06"), monthPeriod("2026-08")]);
    drain(monthly, fixture());
    const june = monthly.reports().get("2026-06")!;
    expect(june.totalTokens).toBe(0);
    expect(june.sessions).toBe(0);
    expect(june.period?.key).toBe("2026-06");
  });
});

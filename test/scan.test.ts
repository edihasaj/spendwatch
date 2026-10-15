import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import type { GatewayIndex } from "../src/gateway";
import { MonthlyAggregator } from "../src/monthly";
import type { Event } from "../src/parse";
import { monthPeriod } from "../src/periods";
import { IncrementalReader } from "../src/scan";
import type { SourceFile } from "../src/sources";
import { tempDir } from "./tmp";

// The reader keeps one parser state per file for as long as it reads that file, however often the file is found.

const line = (value: unknown) => JSON.stringify(value);
const ledger: GatewayIndex = { claim: () => false, covers: (id) => id === "resp_gl_1" };

function rollout(trailing: string): string {
  const path = join(tempDir("spendwatch-scan-"), "rollout-a.jsonl");
  writeFileSync(path, line({ timestamp: "2026-10-05T09:00:00.000Z", type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway", model: "m" } }) + "\n" + trailing);
  return path;
}

const found = (path: string): SourceFile => ({ path, key: "codex:rollout-a.jsonl", project: "?", source: "codex", account: "a", parse: parseCodexLine, ctx: newCodexCtx(ledger) });

describe("IncrementalReader.flush", () => {
  test("parses a trailing line with the state the file's earlier lines built, not a newly found file's", () => {
    // The last line has no newline yet; it is a routed call this Mac's ledger bills.
    const path = rollout(line({ timestamp: "2026-10-05T09:00:01.000Z", type: "token_usage_record", payload: { response_id: "resp_gl_1", usage: { input_tokens: 10, output_tokens: 1 } } }));
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    reader.poll(found(path));
    // Found again, with a parser that never saw session_meta: only the kept one knows the call was routed.
    reader.flush(found(path));
    expect(agg.report()).toMatchObject({ apiCalls: 0, routedCalls: 1 });
  });

  test("leaves a line that is still being written for the next poll", () => {
    const path = rollout('{"timestamp":"2026-10-05T09:00:01.000Z","type":"token_usage_rec');
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const file = found(path);
    reader.poll(file);
    reader.flush(file);
    writeFileSync(path, 'ord","payload":{"response_id":"resp_b","usage":{"input_tokens":10,"output_tokens":1}}}\n', { flag: "a" });
    reader.poll(file);
    expect(agg.report().apiCalls).toBe(1);
  });
});

describe("IncrementalReader with a file that yields all its events on every poll", () => {
  const NOW = Date.UTC(2026, 9, 15, 12);
  const api = (id: string): Event => ({ t: "api", sessionId: "s", requestId: id, model: "m", usage: { input: 1, output: 1, cacheRead: 0, cache5m: 0, cache1h: 0 }, sidechain: false, ts: NOW });
  /** A file whose events are whatever `state.ids` holds, with a version that says when they changed. */
  const snapshot = (state: { version: string; ids: string[] }): SourceFile => ({
    path: "ledger", key: "gateway:claude", project: "gateway", source: "claude", account: "a", parse: () => [], ctx: null,
    events: () => [{ t: "meta", sessionId: "s", project: "gateway", ts: 0 } as Event, ...state.ids.map(api)], version: () => state.version,
  });

  for (const [name, sink, calls] of [
    ["an Aggregator", () => new Aggregator(), (s: Aggregator | MonthlyAggregator) => (s as Aggregator).report().apiCalls],
    ["a MonthlyAggregator", () => new MonthlyAggregator([monthPeriod("2026-10")]), (s: Aggregator | MonthlyAggregator) => (s as MonthlyAggregator).reports().get("2026-10")!.apiCalls],
  ] as const) {
    test(`replaces what the last poll folded into ${name}: an event that is gone stops counting`, () => {
      const agg = sink();
      const reader = new IncrementalReader(agg);
      const state = { version: "1", ids: ["a", "b"] };
      const file = snapshot(state);
      expect(reader.poll(file)).toBeGreaterThan(0);
      expect(calls(agg)).toBe(2);
      // A ledger row a rollout's bill now covers no longer bills, so the next snapshot does not hold it.
      state.version = "2"; state.ids = ["a"];
      expect(reader.poll(file)).toBeGreaterThan(0);
      expect(calls(agg)).toBe(1);
      expect(reader.poll(file)).toBe(0);
      expect(calls(agg)).toBe(1);
    });
  }

  test("folds nothing for a file that says it cannot be read, and tries it again at the next poll", () => {
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    let readable = false;
    const file: SourceFile = { ...snapshot({ version: "1", ids: ["a"] }), events: undefined, snapshot: () => readable ? { version: "1", events: [api("a")] } : undefined };
    expect(reader.poll(file)).toBe(0);
    expect(agg.report().sessions).toBe(0);
    readable = true;
    expect(reader.poll(file)).toBeGreaterThan(0);
    expect(agg.report().apiCalls).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { newCodexCtx, parseCodexLine } from "../src/codex";
import type { GatewayIndex } from "../src/gateway";
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

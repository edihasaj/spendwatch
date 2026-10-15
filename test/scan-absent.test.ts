import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate";
import type { Event } from "../src/parse";
import { IncrementalReader } from "../src/scan";
import type { SourceFile } from "../src/sources";

// `watch` finds the same files again on every tick; a file it found before and does not find now (Codex filed the
// rollout away, outside the roots) still has parser state, and what that state decided about the gateway ledger counts.
const call: Event = { t: "api", sessionId: "s", requestId: "r", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cache5m: 0, cache1h: 0 }, sidechain: false, ts: 1 };

const parserFile = (key: string, over: Partial<SourceFile> = {}): SourceFile =>
  ({ path: `/nowhere/${key}.jsonl`, key, project: "p", source: "codex", account: "a", parse: () => [], ctx: { name: key }, ...over });
const ledgerFile = (key: string, over: Partial<SourceFile> = {}): SourceFile =>
  ({ path: `/nowhere/${key}`, key, project: "gateway", source: "copilot", account: "a", parse: () => [], ctx: null, version: () => "v", events: () => [], ...over });

describe("a file the last discovery did not find again", () => {
  test("is carried what the discovery decided afresh, with the state it kept", () => {
    const reader = new IncrementalReader(new Aggregator());
    const gone = parserFile("gone");
    const here = parserFile("here");
    reader.renew(gone);
    reader.renew(here);
    const carried: unknown[] = [];
    reader.renewAbsent([parserFile("here")], (kept) => carried.push(kept));
    expect(carried).toEqual([gone.ctx]);
  });

  test("is not carried when it is found, wherever it now lies", () => {
    const reader = new IncrementalReader(new Aggregator());
    reader.renew(parserFile("moved", { path: "/sessions/moved.jsonl" }));
    const carried: unknown[] = [];
    reader.renewAbsent([parserFile("moved", { path: "/archived_sessions/moved.jsonl" })], (kept) => carried.push(kept));
    expect(carried).toEqual([]);
  });

  test("settles what it left waiting, against the state it kept", () => {
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const settled: unknown[] = [];
    const gone = parserFile("gone", { settle: (ctx, final) => { settled.push([ctx, final]); return [call]; } });
    reader.renew(gone);
    expect(reader.settleAbsent([parserFile("here")])).toBe(1);
    expect(settled).toEqual([[gone.ctx, false]]);
    expect(agg.report().apiCalls).toBe(1);
  });

  test("is not a ledger or Copilot stream, which keep no parser state to carry", () => {
    const reader = new IncrementalReader(new Aggregator());
    const stream = ledgerFile("gateway:copilot");
    reader.renew(stream);
    reader.flush(stream);
    reader.poll(stream);
    const carried: unknown[] = [];
    reader.renewAbsent([], (kept) => carried.push(kept));
    expect([carried, reader.settleAbsent([])]).toEqual([[], 0]);
  });

  test("is not a Copilot snapshot either", () => {
    const reader = new IncrementalReader(new Aggregator());
    const session = ledgerFile("copilot-session:one", { version: undefined, events: undefined, snapshot: () => ({ version: "v", events: [] }) });
    reader.renew(session);
    reader.flush(session);
    const carried: unknown[] = [];
    reader.renewAbsent([], (kept) => carried.push(kept));
    expect(carried).toEqual([]);
  });
});

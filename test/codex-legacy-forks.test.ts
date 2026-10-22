import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { discover, type SourceFile } from "../src/sources";
import { tempDir } from "./tmp";

// Synthetic fixtures only.
const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const J = (o: unknown) => JSON.stringify(o);
const at = (n: number) => new Date(Date.UTC(2026, 7, 13, 10, 0, n)).toISOString();
const meta = (id: string, extra: object = {}) => J({ timestamp: at(0), type: "session_meta", payload: { id, model_provider: "openai", cwd: "/w", ...extra } });
const start = (turn: string, n: number) => J({ timestamp: at(n), type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const done = (turn: string, n: number) => J({ timestamp: at(n), type: "event_msg", payload: { type: "task_complete", turn_id: turn } });
const count = (input: number, n: number) => J({ timestamp: at(n), type: "event_msg", payload: { type: "token_count", info: {
  last_token_usage: { input_tokens: input, output_tokens: 1 }, total_token_usage: { input_tokens: input * 10, output_tokens: 10 } } } });
const name = (id: string) => `rollout-2026-08-13T10-00-00-${id}.jsonl`;

const previous = process.env.SPENDWATCH_CONFIG;
afterEach(() => {
  if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
  else process.env.SPENDWATCH_CONFIG = previous;
});

function codex(roots: string[]) {
  const config = join(tempDir("spendwatch-fork-config-"), "config.json");
  writeFileSync(config, J(roots.map((path) => ({ agent: "codex", path, account: "fixture" }))));
  process.env.SPENDWATCH_CONFIG = config;
  return discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex")!;
}
function tokens(files: ReadonlyArray<SourceFile>, id: string): number {
  const aggregate = new Aggregator();
  const reader = new IncrementalReader(aggregate);
  for (const file of files.filter((f) => f.path.includes(id))) { reader.poll(file); reader.flush(file); }
  return aggregate.report().totalTokens;
}
function write(dir: string, id: string, lines: string[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name(id)), lines.join("\n") + "\n");
}

const parentLines = [meta(PARENT), start("turn-a", 1), count(100, 2), done("turn-a", 3), start("turn-b", 4), count(200, 5), done("turn-b", 6)];
const legacyChild = [meta(CHILD, { forked_from_id: PARENT }), meta(PARENT),
  start("turn-a", 1), count(100, 2), done("turn-a", 3), start("turn-b", 4), count(200, 5), done("turn-b", 6),
  start("turn-child", 7), count(50, 8), done("turn-child", 9)];

test("a legacy fork counts only turns its actual parent did not open", () => {
  const root = tempDir("spendwatch-fork-");
  write(root, PARENT, parentLines);
  write(root, CHILD, legacyChild);
  const status = codex([root]);
  expect(tokens(status.files, PARENT)).toBe(302);
  expect(tokens(status.files, CHILD)).toBe(51);
  expect(status.warning).toBeUndefined();
});

test("a legacy fork without its parent rollout is counted whole and flagged", () => {
  const root = tempDir("spendwatch-fork-orphan-");
  write(root, CHILD, legacyChild);
  const status = codex([root]);
  expect(tokens(status.files, CHILD)).toBe(353);
  expect(status.warning).toContain("no readable parent rollout");
});

test("rows outside any turn and conflicting parent references are never subtracted", () => {
  const root = tempDir("spendwatch-fork-unscoped-");
  write(root, PARENT, parentLines);
  write(root, CHILD, [meta(CHILD, { forked_from_id: PARENT }), count(100, 2), start("turn-a", 3), count(200, 4)]);
  expect(tokens(codex([root]).files, CHILD)).toBe(101);
  const other = tempDir("spendwatch-fork-conflict-");
  write(other, PARENT, parentLines);
  write(other, CHILD, [meta(CHILD, { forked_from_id: PARENT, parent_thread_id: "someone-else" }), start("turn-a", 1), count(100, 2)]);
  expect(tokens(codex([other]).files, CHILD)).toBe(101);
});

test("a context-only native rewrite yields to its complete legacy original", () => {
  const root = tempDir("spendwatch-fork-rewrite-");
  write(join(root, "a"), PARENT, parentLines);
  write(join(root, "a"), CHILD, legacyChild);
  const rewrite = [J({ ordinal: 0, ...JSON.parse(meta(CHILD, { forked_from_id: PARENT, history_mode: "paginated", subagent_history_start_ordinal: 3 })) }),
    J({ ordinal: 1, ...JSON.parse(count(100, 2)) }), J({ ordinal: 2, ...JSON.parse(count(200, 5)) })];
  write(join(root, "b"), CHILD, rewrite);
  const files = codex([join(root, "a"), join(root, "b")]).files.filter((f) => f.path.includes(CHILD));
  expect(files.map((f) => f.path)).toEqual([join(root, "a", name(CHILD))]);
  expect(tokens(files, CHILD)).toBe(51);
});

test("a rewrite with child-owned rows is not discarded", () => {
  const root = tempDir("spendwatch-fork-owned-");
  write(join(root, "a"), PARENT, parentLines);
  write(join(root, "a"), CHILD, legacyChild);
  const rewrite = [J({ ordinal: 0, ...JSON.parse(meta(CHILD, { forked_from_id: PARENT, history_mode: "paginated", subagent_history_start_ordinal: 2 })) }),
    J({ ordinal: 1, ...JSON.parse(count(100, 2)) }), J({ ordinal: 2, ...JSON.parse(count(50, 8)) })];
  write(join(root, "b"), CHILD, rewrite);
  expect(() => codex([join(root, "a"), join(root, "b")])).toThrow(/divergent|parser contracts/);
});

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { discover, pollWatched } from "../src/sources";

// Watch mode finds every rollout again on each tick, so a routed turn that arrives later must still be
// recognised as routed: the session_meta line that says so was read ticks ago.
const line = (value: unknown) => JSON.stringify(value) + "\n";
const iso = (ms: number) => new Date(ms).toISOString();
const record = (id: string, at: number) => line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } });
const count = (at: number, total: number) => line({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }, total_token_usage: { input_tokens: total, output_tokens: total / 10 } } } });
const ledgerRow = (id: string, at: number) => JSON.stringify({ v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, providerType: "copilot-subscription", model: "copilot/gpt", status: "completed", origin: "gateway", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete" }) + "\n";

const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

function watched(options: { records?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "spendwatch-watch-"));
  const sessions = join(root, "home", ".codex", "sessions", "2026", "10", "15"); const state = join(root, "state");
  const archived = join(root, "home", ".codex", "archived_sessions");
  mkdirSync(sessions, { recursive: true }); mkdirSync(archived, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now(); const rollout = join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  const month = new Date(now).toISOString().slice(0, 7); const ledger = join(state, "usage", `usage-${month}.jsonl`);
  writeFileSync(rollout, line({ timestamp: iso(now - 60_000), type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway" } })
    + line({ timestamp: iso(now - 60_000), type: "turn_context", payload: { model: "copilot/gpt" } }) + (options.records === false ? "" : record("resp_gl_1", now - 50_000)) + count(now - 50_000, 100));
  writeFileSync(ledger, ledgerRow("1", now - 50_000));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([{ agent: "codex", path: join(root, "home", ".codex", "sessions") }, { agent: "codex", path: archived }, { agent: "copilot", path: join(root, "home", ".copilot", "session-store.db") }, { agent: "gateway", path: state }]));
  process.env.SPENDWATCH_CONFIG = config; delete process.env.SPENDWATCH_GATEWAY_SOURCE;
  const sinceMs = now - 86_400_000;
  const readers = new Map<string, { reader: IncrementalReader; agg: Aggregator }>();
  const tick = () => {
    const statuses = discover({ sinceMs });
    for (const st of statuses) if (!readers.has(st.id)) { const agg = new Aggregator(); readers.set(st.id, { reader: new IncrementalReader(agg), agg }); }
    return pollWatched(readers, statuses);
  };
  const calls = (id: string) => readers.get(id)!.agg.report().apiCalls;
  return { now, rollout, ledger, archived, tick, calls };
}

describe("watch mode with a gateway ledger", () => {
  test("a routed turn that arrives after the first tick is billed by the ledger, not by the rollout", () => {
    const w = watched();
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 1]);
    // The next tick discovers the rollout again, with a parser that has not seen session_meta.
    appendFileSync(w.rollout, record("resp_gl_2", w.now - 1000) + count(w.now - 1000, 200));
    appendFileSync(w.ledger, ledgerRow("2", w.now - 1000));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
  });

  test("a poll that falls between a record and its token_count does not bill the count", () => {
    const w = watched();
    w.tick();
    appendFileSync(w.rollout, record("resp_gl_2", w.now - 1000));
    appendFileSync(w.ledger, ledgerRow("2", w.now - 1000));
    w.tick();
    appendFileSync(w.rollout, count(w.now - 1000, 200));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
  });

  test("an ordinary rollout is still counted by the rollout as it grows", () => {
    const w = watched();
    writeFileSync(w.ledger, "");
    writeFileSync(w.rollout, line({ timestamp: iso(w.now - 60_000), type: "session_meta", payload: { id: "s2", model_provider: "openai" } }) + record("resp_a", w.now - 50_000));
    w.tick();
    appendFileSync(w.rollout, record("resp_b", w.now - 1000));
    w.tick();
    expect(w.calls("codex")).toBe(2);
  });
});

describe("rollouts that record only token_count", () => {
  test("a routed call is billed once, from the ledger, whether or not a response id is recorded", () => {
    const w = watched({ records: false });
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 1]);
    appendFileSync(w.rollout, count(w.now - 1000, 200));
    appendFileSync(w.ledger, ledgerRow("2", w.now - 1000));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
  });

  test("a call the ledger never held is still counted from the rollout", () => {
    const w = watched({ records: false });
    w.tick();
    appendFileSync(w.rollout, count(w.now - 1000, 200));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([1, 1]);
  });
});

describe("a token_count that lands before its ledger row", () => {
  test("is billed once, by the rollout that read it first, when the row arrives on a later tick", () => {
    const w = watched({ records: false });
    w.tick();
    // Codex wrote the count; the gateway has not appended its row yet. Nothing can claim it, so the rollout bills it.
    appendFileSync(w.rollout, count(w.now - 1000, 200));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([1, 1]);
    // The row lands. The call was billed already, so the ledger must not bill it a second time.
    appendFileSync(w.ledger, ledgerRow("2", w.now - 1000));
    w.tick();
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([1, 1]);
  });

  test("a row that did arrive first still bills the ledger, not the rollout", () => {
    const w = watched({ records: false });
    w.tick();
    appendFileSync(w.ledger, ledgerRow("2", w.now - 1000));
    w.tick();
    appendFileSync(w.rollout, count(w.now - 1000, 200));
    w.tick();
    expect([w.calls("codex"), w.calls("copilot")]).toEqual([0, 2]);
  });
});

describe("a rollout that Codex files away while watched", () => {
  test("is not read again from the top under its new path", () => {
    const w = watched();
    writeFileSync(w.ledger, "");
    writeFileSync(w.rollout, line({ timestamp: iso(w.now - 60_000), type: "session_meta", payload: { id: "s2", model_provider: "openai" } }) + record("resp_a", w.now - 50_000));
    w.tick();
    expect(w.calls("codex")).toBe(1);
    // Codex moves a finished thread into archived_sessions and keeps its mtime.
    const moved = join(w.archived, basename(w.rollout));
    renameSync(w.rollout, moved);
    w.tick();
    expect(w.calls("codex")).toBe(1);
    // What the thread writes afterwards is still read from where the reader left off.
    appendFileSync(moved, record("resp_b", w.now - 1000));
    w.tick();
    expect(w.calls("codex")).toBe(2);
  });
});

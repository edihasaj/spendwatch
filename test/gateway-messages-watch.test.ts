// What `watch` does with the Claude Code lines of gateway-routed calls: the ledger it reloads on a tick, the rows that
// land late, and the lines that reach the transcript late. Claude Code writes every line of a response when the response
// ends, but stamps each with the time its content block began, so a line can be read a minute past its own stamp; the
// wait for its row is measured from when it was read (see `since` in claude-routed.ts).
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { build, pollWatched, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { UNCONFIRMED } from "../src/codex";
import { CLAIM_WINDOW_MS } from "../src/gateway";
import { rollingDays } from "../src/periods";
import { discover } from "../src/sources";
import { tempDir } from "./tmp";

const LABEL = `claude-opus-5.5 (${UNCONFIRMED})`;
// A stamp this old is past the claim window the moment the line is read, but well inside the lag a line of a long
// response may carry, so a watch tick that sees it must still wait for its row.
const LATE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  setSystemTime();
});

/** One Mac: Claude Code transcripts of one project, this Mac's gateway ledger, and no Codex or Copilot store. */
function mac() {
  const root = tempDir("spendwatch-messages-watch-");
  const projects = join(root, "claude", "projects"); const state = join(root, "state");
  mkdirSync(join(projects, "-tmp-proj"), { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now();
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "claude", path: projects }, { agent: "copilot", path: join(root, "copilot", "session-store.db") }, { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = config;
  delete process.env.SPENDWATCH_GATEWAY_SOURCE;
  return { now, ledger, transcript: join(projects, "-tmp-proj", "session-1.jsonl"), other: join(projects, "-tmp-proj", "session-2.jsonl") };
}

/** One assistant line of a Claude Code transcript, with the message id of every line of its response. */
const turn = (id: string, at: number, output = 7) => JSON.stringify({
  type: "assistant", sessionId: "cs1", timestamp: iso(at), requestId: `req-${Math.round(at)}-${id}`, cwd: "/tmp/proj", isSidechain: false,
  message: { id, model: "claude-opus-5.5", usage: { input_tokens: 30, cache_read_input_tokens: 120, cache_creation_input_tokens: 0, output_tokens: output }, content: [{ type: "text", text: "hi" }] },
}) + "\n";

/** A ledger row the gateway wrote for a Messages request, billed to Copilot. */
const messagesRow = (id: string, at: number) => JSON.stringify({
  v: 1, at: iso(at), host: "studio", requestId: id, responseId: `msg_gl_${id}`, origin: "gateway", providerType: "copilot-subscription", provider: "copilot",
  model: "copilot/claude", status: "completed", inputTokens: 150, cachedTokens: 120, cacheWriteTokens: 0, outputTokens: 7, reasoningTokens: 0, nanoAiu: 2e9, nanoAiuStatus: "complete",
}) + "\n";

/** The same for a Responses request, which is what a Codex rollout records and no Claude line ever matches. */
const responsesRow = (id: string, at: number) => JSON.stringify({
  v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, origin: "gateway", providerType: "copilot-subscription", provider: "copilot",
  model: "copilot/gpt", status: "completed", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete",
}) + "\n";

/** One report per source, of a read over this Mac that settles everything it finds. */
function run(m: ReturnType<typeof mac>) {
  const a: BuildOptions = { top: 5 };
  const built = build(a, [rollingDays(m.now, 30)]);
  const report = (id: string) => (built.readers.get(id)!.sink as Aggregator).report();
  return { built, report, calls: (id: string) => report(id).apiCalls };
}

/** The same Mac, driven the way `watch` drives it: the first read, then one discovery and poll per tick. */
function watched(m: ReturnType<typeof mac>) {
  const a: BuildOptions = { top: 5 };
  let built: Built | undefined;
  const tick = () => (built ? pollWatched(built, discover({ sinceMs: m.now - 86_400_000 }), a) : (built = build(a, [watchPeriod(m.now, 1)], { watching: true }), 1));
  const report = (id: string) => (built!.readers.get(id)!.sink as Aggregator).report();
  return { tick, report, calls: (id: string) => report(id).apiCalls };
}

/** A clock a claim window past this moment, so a message that has been waiting long enough is decided. */
const pastWindow = () => setSystemTime(new Date(Date.now() + CLAIM_WINDOW_MS + 1000));

describe("a line that reaches the transcript after it was stamped", () => {
  test("waits out its claim window from the moment it was read, then follows whichever way its row goes", () => {
    const m = mac();
    writeFileSync(m.ledger, responsesRow("old", m.now - 300_000));
    const w = watched(m);
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    // The response ended a minute ago, so every line of it arrived with a stamp already past the claim window.
    appendFileSync(m.transcript, turn("msg_gl_late", m.now - LATE));
    w.tick();
    // Read now: the row the gateway appends for it is a moment away, so nothing is billed from the transcript yet.
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    expect(w.report("claude").routedCalls ?? 0).toBe(0);
    appendFileSync(m.ledger, messagesRow("late", m.now - LATE));
    w.tick();
    // The row bills it, under the vendor that served it, and Claude keeps nothing.
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 2]);
    expect(w.report("claude").routedCalls).toBe(1);
    // The same again, with a row that never comes: the wait ends a claim window after the line was read.
    appendFileSync(m.transcript, turn("msg_gl_lost", m.now - LATE));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 2]);
    pastWindow();
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 2]);
    expect(w.report("claude").models.map((row) => [row.model, row.outTok])).toEqual([[LABEL, 7]]);
    expect(w.report("claude").gatewayUnconfirmed?.map((call) => call.id)).toEqual(["lost"]);
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 2]);
  });
});

describe("one message id kept in two transcripts of a project", () => {
  test("is billed once, by its row where the ledger holds one", () => {
    const m = mac();
    // A session copied from another: the same response sits in two files of the same project.
    writeFileSync(m.transcript, turn("msg_gl_twin", m.now - LATE));
    writeFileSync(m.other, turn("msg_gl_twin", m.now - LATE, 19));
    writeFileSync(m.ledger, messagesRow("twin", m.now - LATE));
    const { report, calls } = run(m);
    expect([calls("claude"), calls("copilot")]).toEqual([0, 1]);
    expect(report("copilot").models.map((row) => row.outTok)).toEqual([7]);
  });

  test("is billed once, here, where the ledger holds no row for it", () => {
    const m = mac();
    writeFileSync(m.transcript, turn("msg_gl_copy", m.now - LATE));
    writeFileSync(m.other, turn("msg_gl_copy", m.now - LATE, 19));
    writeFileSync(m.ledger, "");
    const { report, calls } = run(m);
    expect([calls("claude"), calls("copilot")]).toEqual([1, 0]);
    expect(report("claude").models.map((row) => row.model)).toEqual([LABEL]);
    expect(report("claude").gatewayUnconfirmed?.map((call) => call.id)).toEqual(["copy"]);
  });
});

describe("the later lines of a message `watch` has decided", () => {
  test("follow a decision that dropped the message for its row", () => {
    const m = mac();
    writeFileSync(m.transcript, turn("msg_gl_kept", m.now - 5000));
    writeFileSync(m.ledger, messagesRow("kept", m.now - 5000));
    const w = watched(m);
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    // The next content block of that response, read a tick later, is still the same call its row bills.
    appendFileSync(m.transcript, turn("msg_gl_kept", m.now, 44));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    expect(w.report("claude").routedCalls).toBe(1);
  });

  test("follow a decision that billed a message whose row never came", () => {
    const m = mac();
    writeFileSync(m.ledger, "");
    const w = watched(m);
    w.tick();
    appendFileSync(m.transcript, turn("msg_gl_grown", m.now - 1000));
    w.tick();
    pastWindow();
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 0]);
    // The response went on afterwards, so a later line of it carries more output. The call is still the one call, at
    // the figure the transcript last recorded.
    appendFileSync(m.transcript, turn("msg_gl_grown", m.now + CLAIM_WINDOW_MS, 44));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 0]);
    expect(w.report("claude").models.map((row) => [row.model, row.outTok])).toEqual([[LABEL, 44]]);
  });
});

describe("a transcript `watch` stops finding", () => {
  test("carries its bill to the ledger reloaded after it went", () => {
    const m = mac();
    writeFileSync(m.ledger, "");
    const w = watched(m);
    w.tick();
    appendFileSync(m.transcript, turn("msg_gl_moved", m.now - 1000));
    w.tick();
    pastWindow();
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 0]);
    // Claude Code files the transcript away, and only then does the gateway append the row of the call it billed.
    rmSync(m.transcript);
    appendFileSync(m.ledger, messagesRow("moved", m.now - 1000));
    w.tick();
    // The row the ledger now holds belongs to the call this Mac billed: neither side bills it twice.
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 0]);
    expect(w.report("claude").models.map((row) => row.model)).toEqual([LABEL]);
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 0]);
  });
});

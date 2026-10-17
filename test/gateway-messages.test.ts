// The Messages marker family: a call the gateway served for a Claude Code transcript, billed once by its `msg_gl_*`
// ledger row, the same way a Codex rollout's turn is billed once by its `resp_gl_*` row.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator, type Report } from "../src/aggregate";
import { build, pollWatched, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { UNCONFIRMED } from "../src/codex";
import { GatewayIndex, isMarked, markedId, markerOf, MARKERS, MESSAGES_MARKER, RESPONSES_MARKER } from "../src/gateway";
import { parseLine } from "../src/parse";
import { rollingDays } from "../src/periods";
import { discover } from "../src/sources";
import { settleAcrossMacs } from "../src/gateway-settle";
import { copilot, stateDir } from "./ledger-fixtures";
import { tempDir } from "./tmp";

const LABEL = `claude-opus-5.5 (${UNCONFIRMED})`;
const CLAUDE_ALIAS = "claude-sonnet-4.5";
const ROLLOUT = "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
const iso = (ms: number) => new Date(ms).toISOString();

const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  setSystemTime();
});

/** One Mac: Claude Code transcripts, Codex rollouts, this Mac's gateway ledger, and no Copilot store. */
function mac(gatewaySource?: string) {
  const root = tempDir("spendwatch-messages-");
  const projects = join(root, "claude", "projects"); const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(join(projects, "-tmp-proj"), { recursive: true }); mkdirSync(sessions, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now();
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "claude", path: projects }, { agent: "codex", path: sessions, account: "main" },
    { agent: "copilot", path: join(root, "copilot", "session-store.db") }, { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = config;
  if (gatewaySource === undefined) delete process.env.SPENDWATCH_GATEWAY_SOURCE; else process.env.SPENDWATCH_GATEWAY_SOURCE = gatewaySource;
  return { now, ledger, transcript: join(projects, "-tmp-proj", "session-1.jsonl"), rollout: join(sessions, ROLLOUT) };
}

/**
 * One assistant line of a Claude Code transcript. Claude Code writes several of these for one response, one per
 * content block, all with the same message id and usage that has grown since the last.
 */
const turn = (id: string, at: number, output = 7) => JSON.stringify({
  type: "assistant", sessionId: "cs1", timestamp: iso(at), requestId: `req-${Math.round(at)}-${id}`, cwd: "/tmp/proj", isSidechain: false,
  message: { id, model: "claude-opus-5.5", usage: { input_tokens: 30, cache_read_input_tokens: 120, cache_creation_input_tokens: 0, output_tokens: output }, content: [{ type: "text", text: "hi" }] },
}) + "\n";

/** A ledger row the gateway wrote for a Messages request: a marked id of the other family, billed to Copilot. */
const messagesRow = (id: string, at: number, over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, at: iso(at), host: "studio", requestId: id, responseId: `msg_gl_${id}`, origin: "gateway", providerType: "copilot-subscription", provider: "copilot",
  model: "copilot/claude", status: "completed", inputTokens: 150, cachedTokens: 120, cacheWriteTokens: 0, outputTokens: 7, reasoningTokens: 0, nanoAiu: 2e9, nanoAiuStatus: "complete", ...over,
}) + "\n";

/** The same for a Responses request, which is what a Codex rollout records. */
const responsesRow = (id: string, at: number) => JSON.stringify({
  v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, origin: "gateway", providerType: "copilot-subscription", provider: "copilot",
  model: "copilot/gpt", status: "completed", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete",
}) + "\n";

const codexMeta = (at: number, model: string) => JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id: "cx1", model_provider: "subscription_gateway", model, cwd: "/tmp/proj" } }) + "\n";
const codexRecord = (id: string, at: number) => JSON.stringify({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } }) + "\n";
/** A count with no response id of its own, which the ledger can only match by model, tokens and time. */
const codexCount = (at: number, input: number, output: number) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output }, total_token_usage: { input_tokens: input, output_tokens: output } } } }) + "\n";

/** One report per source, of a read over this Mac. */
function run(m: ReturnType<typeof mac>, watching = false) {
  const a: BuildOptions = { top: 5 };
  const built = build(a, [rollingDays(m.now, 30)], { watching });
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

describe("the marker family", () => {
  test("recognises both families and reads the same request id out of each", () => {
    expect([MARKERS, MESSAGES_MARKER, RESPONSES_MARKER]).toEqual([["resp_gl_", "msg_gl_"], "msg_gl_", "resp_gl_"]);
    expect([isMarked("resp_gl_x"), isMarked("msg_gl_x"), isMarked("msg_01abc"), isMarked(undefined)]).toEqual([true, true, false, false]);
    expect([markedId("msg_gl_ab12"), markedId("resp_gl_ab12"), markerOf("msg_gl_ab12")]).toEqual(["ab12", "ab12", MESSAGES_MARKER]);
  });
});

describe("a Messages row of the ledger", () => {
  test("bills a Claude transcript and a Responses row bills a rollout, each call once", () => {
    const m = mac();
    writeFileSync(m.rollout, codexMeta(m.now - 60_000, "copilot/gpt") + codexRecord("resp_gl_aa", m.now - 50_000));
    writeFileSync(m.transcript, turn("msg_gl_bb", m.now - 40_000) + turn("msg_gl_bb", m.now - 40_000, 12));
    writeFileSync(m.ledger, responsesRow("aa", m.now - 50_000) + messagesRow("bb", m.now - 40_000, { outputTokens: 12 }));
    const { report, calls } = run(m);
    expect(calls("copilot")).toBe(2);
    expect(report("copilot").totalCost).toBeCloseTo((1e9 + 2e9) / 1e11, 12);
    // Neither transcript kept its own copy of a call its row bills.
    expect([calls("codex"), report("codex").routedCalls]).toEqual([0, 1]);
    expect([calls("claude"), report("claude").routedCalls]).toEqual([0, 1]);
  });

  test("leaves a Claude record out of the transcript's own report when it holds the row", () => {
    const m = mac();
    writeFileSync(m.transcript, turn("msg_gl_cc", m.now - 20_000));
    writeFileSync(m.ledger, messagesRow("cc", m.now - 20_000, { providerType: "claude-subscription", provider: "claude", model: CLAUDE_ALIAS, nanoAiu: undefined, nanoAiuStatus: undefined }));
    const { report, calls } = run(m);
    expect(calls("claude")).toBe(1);
    // The one call is the ledger row's: the gateway's alias for the model, and the project every ledger row reports under.
    expect(report("claude").models.map((row) => row.model)).toEqual([CLAUDE_ALIAS]);
    expect(report("claude").projects.map((row) => row.project)).toEqual(["gateway"]);
    // Both sides of the pair are handed to the ledger: the row that bills it, and the transcript copy that was dropped.
    expect(report("claude").routedCalls).toBe(2);
  });

  test("keeps a Claude record it has no row for as Claude usage, labelled, and says so", () => {
    const m = mac();
    writeFileSync(m.transcript, turn("msg_gl_dd", m.now - 20_000));
    writeFileSync(m.ledger, responsesRow("other", m.now - 30_000));
    const { built, report, calls } = run(m);
    expect(calls("claude")).toBe(1);
    const r = report("claude");
    expect(r.models.map((row) => row.model)).toEqual([LABEL]);
    expect(r.totalCost).toBeGreaterThan(0);
    expect(r.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["dd"]);
    expect(built.statuses.find((s) => s.id === "claude")!.warning).toContain("had no row in this Mac's gateway ledger");
    // The same usage under an ordinary message id is priced the same: the label is a name, not a different rate.
    const plain = mac();
    writeFileSync(plain.transcript, turn("msg_01ABCDEF0123456789", plain.now - 20_000));
    writeFileSync(plain.ledger, responsesRow("other", plain.now - 30_000));
    expect(run(plain).report("claude").totalCost).toBe(r.totalCost);
  });

  test("leaves an ordinary Claude record exactly as it was", () => {
    const m = mac();
    writeFileSync(m.transcript, turn("msg_01ABCDEF0123456789", m.now - 20_000));
    writeFileSync(m.ledger, messagesRow("unrelated", m.now - 30_000, { providerType: "claude-subscription", provider: "claude", model: CLAUDE_ALIAS, nanoAiu: undefined, nanoAiuStatus: undefined }));
    const r = run(m).report("claude");
    expect([r.apiCalls, r.routedCalls, r.gatewayUnconfirmed, r.gatewayBilled]).toEqual([2, 1, undefined, ["unrelated"]]);
    expect(r.models.map((row) => row.model).sort()).toEqual([CLAUDE_ALIAS, "claude-opus-5.5"].sort());
  });

  test("follows its decision across the later lines of one message, keeping it one call", () => {
    const m = mac();
    // Three content blocks of one response, all past the claim window by the time they are read.
    writeFileSync(m.transcript, turn("msg_gl_ee", m.now - 40_000) + turn("msg_gl_ee", m.now - 39_000, 20) + turn("msg_gl_ee", m.now - 38_000, 33));
    writeFileSync(m.ledger, "");
    const r = run(m).report("claude");
    expect(r.apiCalls).toBe(1);
    expect(r.models.map((row) => [row.model, row.outTok])).toEqual([[LABEL, 33]]);
    expect(r.gatewayUnconfirmed?.map((call) => call.outTok)).toEqual([33]);
  });

  test("does not let a token_count claim it, which has no id to compare", () => {
    const m = mac();
    writeFileSync(m.rollout, codexMeta(m.now - 60_000, "copilot/claude") + codexCount(m.now - 20_000, 150, 7));
    writeFileSync(m.ledger, messagesRow("ff", m.now - 20_000));
    const { calls } = run(m);
    // The row bills the Claude Code call it is the record of; this rollout's turn is another call, counted here.
    expect([calls("codex"), calls("copilot")]).toEqual([1, 1]);
  });

  test("is not settled against a ledger at all, with the gateway source off", () => {
    const m = mac("off");
    writeFileSync(m.transcript, turn("msg_gl_gg", m.now - 20_000));
    const r = run(m).report("claude");
    expect(r.apiCalls).toBe(1);
    // Plain Claude model, and the id that lets the Mac whose gateway served it take the call over.
    expect(r.models.map((row) => row.model)).toEqual(["claude-opus-5.5"]);
    expect(r.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["gg"]);
  });
});

describe("watched", () => {
  test("waits for a Messages row, bills the call once when it lands, and once here when it never does", () => {
    const m = mac();
    writeFileSync(m.ledger, responsesRow("old", m.now - 60_000));
    const w = watched(m);
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    // The transcript line is read before the gateway has appended its row.
    appendFileSync(m.transcript, turn("msg_gl_hh", m.now - 1000));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 1]);
    appendFileSync(m.ledger, messagesRow("hh", m.now - 1000));
    w.tick();
    // The row bills it; the transcript never did.
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 2]);
    expect(w.report("claude").routedCalls).toBe(1);
    // A second message whose row does not come within the claim window is Claude's after all.
    appendFileSync(m.transcript, turn("msg_gl_ii", m.now - 1000));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([0, 2]);
    setSystemTime(new Date(m.now + 40_000));
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 2]);
    expect(w.report("claude").models.map((row) => row.model)).toEqual([LABEL]);
    // And when that row lands late, the ledger must not bill the call the transcript already billed.
    appendFileSync(m.ledger, messagesRow("ii", m.now - 1000));
    w.tick();
    w.tick();
    expect([w.calls("claude"), w.calls("copilot")]).toEqual([1, 2]);
  });
});

describe("across Macs", () => {
  test("a client Claude call a serving Mac's Messages row bills leaves the client's report", () => {
    // The client's report, read with no ledger of its own to settle against: the record is kept, labelled, with its id.
    const clientAgg = new Aggregator();
    const fold = clientAgg.stream("transcript", "/tmp/proj", "claude", "me@example.com");
    for (const event of parseLine(turn("msg_gl_jj", Date.now() - 20_000).slice(0, -1))) fold(event);
    const client: Report = { ...clientAgg.report(), source: "client:claude" };
    expect(client.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["jj"]);
    const ledgerAgg = new Aggregator();
    const dir = stateDir([copilot({ requestId: "jj", responseId: "msg_gl_jj", at: Date.now() - 20_000, model: "copilot/claude", inputTokens: 150, cachedTokens: 120, outputTokens: 7 })]);
    for (const file of GatewayIndex.load({ sinceMs: 0, stateDir: dir }).files("copilot")) {
      const serve = ledgerAgg.stream(file.key!, file.project, file.source, file.account);
      for (const event of file.events!()) serve(event);
    }
    const serving: Report = { ...ledgerAgg.report(), source: "studio:copilot" };
    expect(serving.gatewayBilled).toEqual(["jj"]);
    const [settled, served] = settleAcrossMacs([client, serving]);
    expect([settled.apiCalls, settled.routedCalls, served.apiCalls]).toEqual([0, 1, 1]);
  });
});

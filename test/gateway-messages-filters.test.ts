// Which filters were asked for must not decide what the gateway ledger bills. A `--agents copilot`, `--project`
// or `--account` run leaves Claude transcripts out of its report; it still has to read them for the claims their
// `msg_gl_*` rows need, or a row landing late bills in the filtered run where the full run has already adopted it.
// Each case runs the SAME world twice, unfiltered and filtered, and the Copilot reports must agree.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { build, pollWatched, reportsByPeriod, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { discover } from "../src/sources";
import { tempDir } from "./tmp";

const iso = (ms: number) => new Date(ms).toISOString();
const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE, copilot: process.env.SPENDWATCH_COPILOT_ACCOUNT };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source], ["SPENDWATCH_COPILOT_ACCOUNT", saved.copilot]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  setSystemTime();
});

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

/** The same for a Responses request, which no Claude transcript line ever matches. */
const responsesRow = (id: string, at: number) => JSON.stringify({
  v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, origin: "gateway", providerType: "copilot-subscription", provider: "copilot",
  model: "copilot/gpt", status: "completed", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete",
}) + "\n";

/** A Claude transcript, and this Mac's ledger already holding an older, unrelated Copilot Messages row. */
function world(now = Date.now()) {
  const root = tempDir("spendwatch-messages-filters-");
  const projects = join(root, "claude", "projects"); const state = join(root, "state");
  mkdirSync(join(projects, "-tmp-proj"), { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "claude", path: projects }, { agent: "copilot", path: join(root, "copilot", "session-store.db") }, { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = config;
  delete process.env.SPENDWATCH_GATEWAY_SOURCE;
  // Seeded, so `hasMessages()` is true from the first tick whichever filters the run carries.
  writeFileSync(ledger, messagesRow("seed", now - 3_600_000));
  return { now, ledger, state, transcript: join(projects, "-tmp-proj", "session-1.jsonl") };
}

/** The same scenario, watched as `report`'s `watch` drives it, with `a`'s filters: the reports at the end. */
function run(a: BuildOptions, m: ReturnType<typeof world>): Report[] {
  setSystemTime();
  const built: Built = build(a, [watchPeriod(m.now, 1)], { watching: true });
  const tick = () => pollWatched(built, discover({ sinceMs: m.now - 86_400_000, agents: a.agents }), a);
  tick();
  appendFileSync(m.transcript, turn("msg_gl_late", m.now - 1000));
  tick();
  setSystemTime(new Date(m.now + 40_000)); // past the claim window from when it was read: the transcript bills it itself, unconfirmed.
  tick();
  appendFileSync(m.ledger, messagesRow("late", m.now - 1000));
  tick();
  tick();
  setSystemTime();
  return [...reportsByPeriod(built, a).values()].flat();
}

const copilotOf = (reports: Report[]) => reports.find((r) => r.source === "copilot")!;
const claudeCalls = (reports: Report[]) => reports.filter((r) => r.source === "claude").reduce((sum, r) => sum + r.apiCalls, 0);

/** The same scenario in two identical worlds: one run unfiltered, one with `filtered`'s extra options. */
function both(filtered: BuildOptions, setup?: () => void) {
  setSystemTime();
  const now = Date.now();
  setup?.();
  return { full: run({ top: 5 }, world(now)), filtered: run({ top: 5, ...filtered }, world(now)) };
}

describe("a filtered run beside the full one", () => {
  test("--agents copilot still claims the late row: Copilot bills it in neither run, and Claude reports nothing", () => {
    const { full, filtered } = both({ agents: new Set(["copilot"]) });
    expect([copilotOf(full).apiCalls, copilotOf(filtered).apiCalls]).toEqual([1, 1]); // only the seed row
    expect(copilotOf(filtered).totalCost).toBe(copilotOf(full).totalCost);
    expect(full.some((r) => r.source === "claude" && r.apiCalls === 1)).toBe(true); // the unconfirmed bill it handed over
    expect(filtered.some((r) => r.source === "claude")).toBe(false); // claim-only: the Claude report never appears
  });

  test("--project still claims the late row, and the filtered project shows no Claude calls", () => {
    const { full, filtered } = both({ project: "other" });
    expect([copilotOf(full).apiCalls, copilotOf(filtered).apiCalls]).toEqual([1, 1]);
    expect(copilotOf(filtered).totalCost).toBe(copilotOf(full).totalCost);
    expect(claudeCalls(filtered)).toBe(0);
  });

  test("--account still claims the late row, and the filtered account shows no Claude calls", () => {
    const { full, filtered } = both({ account: "other@example.com" }, () => { process.env.SPENDWATCH_COPILOT_ACCOUNT = "other@example.com"; });
    // The Copilot ledger stream keeps the filter's account, so Copilot reports; only the Claude account is left out.
    expect([copilotOf(full).apiCalls, copilotOf(filtered).apiCalls]).toEqual([1, 1]);
    expect(copilotOf(filtered).totalCost).toBe(copilotOf(full).totalCost);
    expect(claudeCalls(filtered)).toBe(0);
  });
});

describe("a filtered run with nothing to claim", () => {
  test("has no Claude status, ledger or not, when no Messages row is here to bill", () => {
    const agents = new Set(["copilot"]);
    setSystemTime();
    const m = world();
    writeFileSync(m.ledger, responsesRow("seed", m.now - 3_600_000)); // a ledger, but no Messages row
    writeFileSync(m.transcript, turn("msg_gl_late", m.now - 1000));
    expect(discover({ sinceMs: m.now - 86_400_000, agents }).some((s) => s.id === "claude")).toBe(false);
    rmSync(join(m.state, "usage"), { recursive: true }); // and no ledger at all
    expect(discover({ sinceMs: m.now - 86_400_000, agents }).some((s) => s.id === "claude")).toBe(false);
  });
});

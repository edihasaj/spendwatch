import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Aggregator, type Report } from "../src/aggregate";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { settleAcrossMacs } from "../src/gateway-settle";
import type { Event } from "../src/parse";
import { mergeReports } from "../src/reports";
import { GatewayIndex } from "../src/gateway";
import { apiEvents, copilot, NOW, stateDir, telemetry } from "./ledger-fixtures";

const marked = (id: string) => `resp_gl_${id}`;
const record = (id: string, at: number, input = 1000, output = 50) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } });
const meta = (provider = "subscription_gateway") =>
  JSON.stringify({ timestamp: new Date(NOW - 60_000).toISOString(), type: "session_meta", payload: { id: "s1", model_provider: provider, model: "gpt-5.1-codex", cwd: "/work/app" } });

/** A client's Codex report from these rollout lines, read to the end with `gateway` as its Mac's ledger. */
function codexReport(lines: string[], gateway?: ReturnType<typeof GatewayIndex.load>): Report {
  const ctx = newCodexCtx(gateway);
  const agg = new Aggregator();
  const fold = agg.stream("rollout", "?", "codex", "me@example.com");
  for (const text of lines) for (const event of parseCodexLine(text, ctx)) fold(event);
  for (const event of settleRouted(ctx, true)) fold(event);
  return { ...agg.report(), source: "client:codex" };
}

/** A serving Mac's Copilot report billing these marked ids from its ledger. */
function servingReport(ids: string[]): Report {
  const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: stateDir(ids.map((id, i) => copilot({ requestId: id, responseId: marked(id), at: NOW + i }))) });
  const agg = new Aggregator();
  for (const file of ledger.files("copilot")) {
    const fold = agg.stream(file.key!, file.project, file.source, file.account);
    for (const event of file.events!()) fold(event);
  }
  return { ...agg.report(), source: "studio:copilot" };
}

describe("settling reports of several Macs", () => {
  const OLD = NOW - 3_600_000;
  const client = () => codexReport([meta(), record(marked("aa"), OLD), record(marked("bb"), OLD + 1000, 2000, 100)], GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([]) }));

  test("a client keeps every marked call no ledger of its own holds, with its id", () => {
    const report = client();
    expect(report.apiCalls).toBe(2);
    expect(report.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["aa", "bb"]);
    expect(report.gatewayUnconfirmed?.[0]).toMatchObject({ project: "/work/app", account: "me@example.com", tokens: 1050, inTok: 1000, outTok: 50 });
  });

  test("takes out only the calls another report billed, from every row they added", () => {
    const serving = servingReport(["aa"]);
    const [codex, studio] = settleAcrossMacs([client(), serving]);
    expect(codex).toMatchObject({ apiCalls: 1, totalTokens: 2100, routedCalls: 1 });
    expect(codex!.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["bb"]);
    expect(codex!.models).toMatchObject([{ calls: 1, inTok: 2000, outTok: 100 }]);
    expect(codex!.accounts).toMatchObject([{ account: "me@example.com", calls: 1, tokens: 2100 }]);
    expect(codex!.projects).toMatchObject([{ project: "/work/app", tokens: 2100 }]);
    expect(codex!.tokenDays!.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(2100);
    expect(codex!.totalCost).toBeCloseTo(client().totalCost - client().gatewayUnconfirmed![0]!.cost, 12);
    // The serving Mac's report is the one that bills it, and it is left as it is.
    expect(studio).toBe(serving);
  });

  test("changes nothing when settled again, or when no report billed the calls", () => {
    const once = settleAcrossMacs([client(), servingReport(["aa", "bb"])]);
    expect(once[0]).toMatchObject({ apiCalls: 0, totalTokens: 0, models: [], projects: [] });
    expect(settleAcrossMacs(once)).toEqual(once);
    // A serving Mac that does not run Spendwatch: the client's copy is the only one, and it stays.
    const alone = client();
    expect(settleAcrossMacs([alone, servingReport(["cc"])])[0]).toBe(alone);
  });

  test("keeps the ids through a merge, so a merged report can still be settled", () => {
    const merged = mergeReports([client(), servingReport(["aa"])], "all");
    expect(merged.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["aa", "bb"]);
    expect(merged.gatewayBilled).toEqual(["aa"]);
    expect(settleAcrossMacs([merged])[0]!.apiCalls).toBe(2);
  });

  test("a client with the gateway source off still names its marked calls, unlabelled", () => {
    const report = codexReport([meta(), record(marked("aa"), OLD)]);
    expect(report.models.map((row) => row.model)).toEqual(["gpt-5.1-codex"]);
    expect(report.gatewayUnconfirmed?.map((call) => call.id)).toEqual(["aa"]);
    expect(settleAcrossMacs([report, servingReport(["aa"])])[0]!.apiCalls).toBe(0);
  });

  test("an ordinary provider's response id is never taken for a gateway mark", () => {
    const report = codexReport([meta("openai"), record(marked("aa"), OLD)], GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([]) }));
    expect(report.gatewayUnconfirmed).toBeUndefined();
    expect(settleAcrossMacs([report, servingReport(["aa"])])[0]!.apiCalls).toBe(1);
  });
});

describe("a read whose rollout line is newer than its ledger", () => {
  test("looks for the rows appended since, before it bills the call from the rollout", () => {
    const dir = stateDir([copilot({ requestId: "g1", responseId: marked("g1"), at: NOW - 10_000 })]);
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    const streams = ledger.files("copilot");
    // The gateway appends the row of a call that ended after the ledger was read.
    const [file] = readdirSync(join(dir, "usage"));
    appendFileSync(join(dir, "usage", file!), JSON.stringify({ v: 1, host: "studio", ...copilot({ requestId: "g2", responseId: marked("g2"), at: Date.now() }) }) + "\n");
    const ctx = newCodexCtx(ledger);
    const events: Event[] = [];
    for (const text of [meta(), record(marked("g2"), Date.now())]) events.push(...parseCodexLine(text, ctx));
    events.push(...settleRouted(ctx, true));
    expect(events.filter((e) => e.t === "api")).toEqual([]);
    expect(events.filter((e) => e.t === "routed")).toMatchObject([{ id: marked("g2") }]);
    // The ledger bills it, in the stream it already handed out.
    expect([...streams[0]!.events!()].filter((e) => e.t === "api").map((e) => (e as { requestId: string }).requestId)).toEqual(["studio:g1", "studio:g2"]);
    expect(apiEvents(ledger, "copilot").map((e) => e.gateway)).toEqual([{ id: "g1", role: "billed" }, { id: "g2", role: "billed" }]);
  });

  test("bills the call from the rollout when the row has still not landed", () => {
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: stateDir([copilot({ requestId: "g1", responseId: marked("g1"), at: NOW - 10_000 })]) });
    ledger.files("copilot");
    const ctx = newCodexCtx(ledger);
    const events: Event[] = [];
    for (const text of [meta(), record(marked("g3"), Date.now())]) events.push(...parseCodexLine(text, ctx));
    // While it may still come, the call waits.
    expect(events.filter((e) => e.t === "api" || e.t === "routed")).toEqual([]);
    events.push(...settleRouted(ctx, true));
    expect(events.filter((e) => e.t === "api")).toMatchObject([{ requestId: marked("g3"), gateway: { id: "g3", role: "unconfirmed" } }]);
  });
});

describe("a routed record without the gateway's marker", () => {
  const events = (ledger: ReturnType<typeof GatewayIndex.load>, ...lines: string[]) => {
    const ctx = newCodexCtx(ledger);
    return { ctx, events: [meta(), ...lines].flatMap((text) => [...parseCodexLine(text, ctx)]) };
  };

  test("is decided when it is read: only a telemetry row can match it, so no ledger row is awaited", () => {
    const { ctx, events: read } = events(GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([]) }), record("resp_plain", NOW - 1000));
    // Billed at once from the rollout, under its own id; nothing waits for a row the gateway will never write for it.
    expect(read.filter((event) => event.t === "api").map((event) => (event as Extract<Event, { t: "api" }>).requestId)).toEqual(["resp_plain"]);
    expect(ctx.pending ?? []).toEqual([]);
    expect(ctx.unconfirmed).toBeUndefined();
  });

  test("takes the imported telemetry row it matches, and leaves the rollout without a bill for it", () => {
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([telemetry({ requestId: "history", session: true, at: NOW - 1000 })]) });
    const { ctx, events: read } = events(ledger, record("resp_plain", NOW - 1000));
    expect(read.map((event) => event.t)).toEqual(["meta", "routed"]);
    expect(ctx.pending ?? []).toEqual([]);
    expect(apiEvents(ledger, "copilot").map((event) => event.requestId)).toEqual(["studio:history"]);
  });
});

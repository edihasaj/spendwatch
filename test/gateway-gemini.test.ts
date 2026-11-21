// Turns this Mac's gateway billed on a Google AI Ultra subscription (`gemini-subscription`).
//
// The ledger writes a row for every provider it serves, so the Gemini rows arrive on their own; what this
// file pins down is that they are billed once, under the Gemini agent, to the Google account the provider's
// own home is signed in as — and that the Codex rollout which recorded the same turn through the gateway
// does not bill it a second time.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { newCodexCtx, parseCodexLine, settleRouted, UNCONFIRMED } from "../src/codex";
import { GatewayIndex } from "../src/gateway";
import { readGatewayConfig } from "../src/gateway-config";
import { priceFor } from "../src/pricing";
import { UNKNOWN_GEMINI_ACCOUNT } from "../src/gemini";
import { apiEvents, stateDir, withEnv, type Api, type Row } from "./ledger-fixtures";
import { tempDir } from "./tmp";

let NOW = Date.now();
beforeEach(() => { NOW = Date.now(); });
const iso = (ms: number) => new Date(ms).toISOString();

const ALIAS = "gemini/gemini-3.1-pro-preview";
const usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 };

/** A gateway row for one turn the CLI answered on the Ultra subscription. */
const gemini = (over: Row = {}): Row => ({
  at: NOW, requestId: "req-1", responseId: "resp_gl_g1", origin: "gateway",
  provider: "gemini", providerType: "gemini-subscription", model: ALIAS,
  session: true, inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 0,
  outputTokens: 50, reasoningTokens: 10, ...over,
});

/** The same turn as the Codex rollout that sent it leaves it: one marked record, and the count it observed. */
function rollout(id: string, at = NOW - 30_000): string {
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  return line({ timestamp: iso(at - 20_000), type: "session_meta", payload: { id: "s", model_provider: "subscription_gateway" } })
    + line({ timestamp: iso(at - 20_000), type: "turn_context", payload: { model: ALIAS } })
    + line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage } })
    + line({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { input_tokens: 1000, output_tokens: 50 } } } });
}

/** The Google sign-in a Gemini home keeps, as the CLI writes it. */
function signIn(home: string, active: string): void {
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active, activeProject: "some-project" }));
}

describe("a Gemini row the gateway billed", () => {
  test("counts under Gemini, priced from its tokens, and keeps the alias the caller asked for", () => {
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([gemini()]) });
    const billed = apiEvents(ledger, "gemini");
    expect(billed).toHaveLength(1);
    expect(billed[0]).toMatchObject({
      model: ALIAS,
      usage: { input: 600, output: 50, cacheRead: 400, cache5m: 0 },
      requestId: "studio:req-1",
    });
    // No credit figure arrives for a Gemini row — a subscription is not billed per token — so the ledger
    // bills the tokens it saw and the report prices them: $2/M input, $12/M output, cached at $0.20/M.
    expect(billed[0]!.costUsd).toBeUndefined();
    expect(priceFor(billed[0]!.model)).toMatchObject({ input: 2, output: 12, cachedInput: 0.2 });
  });

  test("is not billed again by the Codex rollout that recorded it", () => {
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([gemini()]) });
    const ctx = newCodexCtx(ledger);
    const bills = [...rollout("resp_gl_g1").split("\n")].flatMap((text) => [...parseCodexLine(text, ctx)]);
    expect(bills.filter((event) => event.t === "api")).toHaveLength(0);
    expect(bills.filter((event) => event.t === "routed")).toHaveLength(1);
    expect(apiEvents(ledger, "gemini")).toHaveLength(1); // one bill, from the ledger
  });

  test("stays in Codex, labelled, when this Mac's ledger holds no row for it", () => {
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: stateDir([]) });
    const ctx = newCodexCtx(ledger);
    const bills = [...rollout("resp_gl_remote").split("\n")].flatMap((text) => [...parseCodexLine(text, ctx)]);
    bills.push(...settleRouted(ctx, true)); // the read ends: nothing may wait for a row any longer
    const api = bills.filter((event): event is Api => event.t === "api");
    expect(api).toHaveLength(1);
    expect(api[0]).toMatchObject({ model: `${ALIAS} (${UNCONFIRMED})`, gateway: { id: "remote", role: "unconfirmed" } });
    expect(apiEvents(ledger, "gemini")).toHaveLength(0);
  });

  test("is credited to the active Google account of the provider's own home", () => {
    const dir = stateDir([gemini({ provider: "gemini-ultra" })]);
    signIn(join(dir, "gemini-home"), "user@example.com");
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    expect(ledger.files("gemini").map((file) => file.account)).toEqual(["user@example.com"]);
  });

  test("is credited to the home the gateway config names for that provider", () => {
    const root = tempDir("spendwatch-gemini-config-");
    const state = join(root, "state");
    signIn(join(root, "ultra-home"), "ultra@example.com");
    writeFileSync(join(root, "gateway.json"), JSON.stringify({
      stateDirectory: "state",
      providers: [{ id: "gemini-ultra", type: "gemini-subscription", geminiHome: "ultra-home" }],
    }));
    mkdirSync(join(state, "usage"), { recursive: true });
    writeFileSync(join(state, "usage", `usage-${iso(NOW).slice(0, 7)}.jsonl`), JSON.stringify({ v: 1, host: "studio", ...gemini({ provider: "gemini-ultra" }) }) + "\n");

    withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(root, "gateway.json"), SPENDWATCH_GATEWAY_STATE: undefined }, () => {
      const config = readGatewayConfig();
      expect(Object.fromEntries(config.geminiHomes ?? [])).toEqual({ "gemini-ultra": join(root, "ultra-home") });
      const ledger = GatewayIndex.load({ sinceMs: 0 });
      expect(ledger.files("gemini").map((file) => file.account)).toEqual(["ultra@example.com"]);
    });
  });

  test("falls back to one fixed account when no home names an active one", () => {
    const dir = stateDir([gemini()]);
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    expect(ledger.files("gemini").map((file) => file.account)).toEqual([UNKNOWN_GEMINI_ACCOUNT]);
  });

  test("folds two providers that name no home of their own into the one account the state directory holds", () => {
    const dir = stateDir([gemini({ requestId: "a", responseId: "resp_gl_a", provider: "ultra-a" }), gemini({ requestId: "b", responseId: "resp_gl_b", provider: "ultra-b" })]);
    signIn(join(dir, "gemini-home"), "user@example.com");
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    expect(ledger.files("gemini").map((file) => [file.key, file.account])).toEqual([["gateway:gemini", "user@example.com"]]);
    expect(apiEvents(ledger, "gemini")).toHaveLength(2);
  });

  test("bills a row the gateway imported from telemetry only once, whichever way it arrived", () => {
    // An imported row carries no provider type, so the provider name decides, as `SPENDWATCH_GATEWAY_PROVIDER_MAP` can too.
    const dir = stateDir([gemini({ origin: "telemetry", providerType: undefined, responseId: "", requestId: "tel", session: false })]);
    const ledger = GatewayIndex.load({ sinceMs: 0, stateDir: dir });
    expect(apiEvents(ledger, "gemini")).toHaveLength(1);
    expect(apiEvents(ledger, "gemini")[0]).toMatchObject({ model: `${ALIAS} (telemetry backfill)` });
  });

  test("leaves an imported row whose provider name the map does not recognise out entirely", () => {
    // A row that names no provider type is only a Gemini row because the provider map says so; under a map
    // that has had its Gemini name removed, nothing here knows whose subscription it was, so nothing bills it.
    const dir = stateDir([gemini({ origin: "telemetry", providerType: undefined, responseId: "", requestId: "tel", session: false })]);
    const ledger = withEnv({ SPENDWATCH_GATEWAY_PROVIDER_MAP: "gemini=none" }, () => GatewayIndex.load({ sinceMs: 0, stateDir: dir }));
    expect(ledger.files("gemini")).toEqual([]);
  });
});

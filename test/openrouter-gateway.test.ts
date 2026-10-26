import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";
import { GatewayIndex } from "../src/gateway";
import { Aggregator } from "../src/aggregate";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { settleAcrossMacs } from "../src/gateway-settle";
import { stateDir, copilot, NOW, withEnv } from "./ledger-fixtures";
import { tempDir } from "./tmp";

function fixture(baseUrl = "https://openrouter.ai/api/v1") {
  const config = join(tempDir("spendwatch-or-gateway-"), "gateway.json");
  const dir = stateDir([copilot({ provider: "openrouter", providerType: "responses-api", model: "or-glm", requestId: "or1", responseId: "resp_gl_or1" })]);
  writeFileSync(config, JSON.stringify({ stateDirectory: dir, providers: [{ id: "openrouter", type: "responses-api", baseUrl, models: { "or-glm": "z-ai/glm-5.3-flash" } }] }));
  return { config, dir };
}

function report(ledger: ReturnType<typeof GatewayIndex.load>) {
  const agg = new Aggregator();
  for (const file of ledger.files("openrouter")) {
    expect(file.source).toBe("codex");
    expect(file.account).toBe("Unknown OpenRouter account");
    const fold = agg.stream(file.key!, file.project, file.source, file.account);
    for (const event of file.events!()) fold(event);
  }
  return { ...agg.report(), source: "studio:codex" };
}

test("only verified OpenRouter routes bill ledger calls with exact upstream models", () => {
  const { config } = fixture();
  withEnv({ SPENDWATCH_GATEWAY_CONFIG: config }, () => {
    const ledger = GatewayIndex.load({ sinceMs: 0 });
    const events = [...ledger.files("openrouter")[0]!.events!()];
    expect(events.find(e => e.t === "api")).toMatchObject({ modelProvider: "openrouter", model: "z-ai/glm-5.3-flash" });
    expect(ledger.claim("or-glm", 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    expect(report(ledger).apiCalls).toBe(1);
  });
  for (const url of ["https://example.com/api/v1", "https://openrouter.ai.evil.test/api/v1", "https://openrouter.ai/api/v1?secret=x"]) {
    const invalid = fixture(url);
    withEnv({ SPENDWATCH_GATEWAY_CONFIG: invalid.config }, () => expect(GatewayIndex.load({ sinceMs: 0 }).files("openrouter")).toEqual([]));
  }
});

test("an OpenRouter gateway call and its remote rollout settle to one Codex bill", () => {
  const { config } = fixture();
  withEnv({ SPENDWATCH_GATEWAY_CONFIG: config }, () => {
    const serving = report(GatewayIndex.load({ sinceMs: 0 }));
    const agg = new Aggregator();
    const fold = agg.stream("client", "?", "codex");
    const ctx = newCodexCtx();
    const lines = [
      { timestamp: new Date(NOW).toISOString(), type: "session_meta", payload: { id: "client", model_provider: "subscription_gateway", model: "or-glm" } },
      { timestamp: new Date(NOW).toISOString(), type: "token_usage_record", payload: { response_id: "resp_gl_or1", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } } },
    ];
    for (const line of lines) for (const event of parseCodexLine(JSON.stringify(line), ctx)) fold(event);
    for (const event of settleRouted(ctx, true)) fold(event);
    const client = { ...agg.report(), source: "macbook:codex" };
    expect(client.apiCalls).toBe(1);
    const settled = settleAcrossMacs([client, serving]);
    expect(settled.reduce((n,r) => n+r.apiCalls,0)).toBe(1);
    expect(settled.reduce((n,r) => n+r.totalTokens,0)).toBe(1050);
  });
});

test("unmarked OpenRouter ledger rows bill only calls matched to local rollouts", () => {
  const { config, dir } = fixture();
  // The actual Responses API ledger currently lacks a responseId.
  const month = new Date(NOW).toISOString().slice(0,7);
  appendFileSync(join(dir,"usage",`usage-${month}.jsonl`),JSON.stringify(copilot({host:"studio", provider:"openrouter",providerType:"responses-api",model:"or-glm",requestId:"unmarked",responseId:"",at:NOW+10000,inputTokens:2000,outputTokens:100}))+"\n");
  withEnv({ SPENDWATCH_GATEWAY_CONFIG: config }, () => {
    const ledger=GatewayIndex.load({sinceMs:0});
    expect(report(ledger).apiCalls).toBe(1);
    expect(ledger.claim("or-glm",2000,100,NOW+10000)).toBe(true);
    expect(ledger.claim("or-glm",2000,100,NOW+10000)).toBe(false);
    const r=report(ledger);
    expect(r.apiCalls).toBe(2);
    expect(r.totalTokens).toBe(3150);
  });
});

test("provider-owned unmarked response IDs remain locally claimable", () => {
  const { config, dir } = fixture();
  const month = new Date(NOW).toISOString().slice(0, 7);
  appendFileSync(join(dir, "usage", `usage-${month}.jsonl`), JSON.stringify(copilot({ host: "studio", provider: "openrouter", providerType: "responses-api", model: "or-glm", requestId: "provider-id", responseId: "provider-response-123", at: NOW + 10000, inputTokens: 2000, outputTokens: 100 })) + "\n");
  withEnv({ SPENDWATCH_GATEWAY_CONFIG: config }, () => {
    const ledger = GatewayIndex.load({ sinceMs: 0 });
    expect(ledger.openRouterWarning()).toBeDefined();
    expect(report(ledger).apiCalls).toBe(1);
    expect(ledger.claim("or-glm", 2000, 100, NOW + 10000)).toBe(true);
    expect(report(ledger).apiCalls).toBe(2);
    expect(ledger.openRouterWarning()).toBeUndefined();
  });
});

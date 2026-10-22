import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { reportsByPeriod } from "../src/build";
import {
  CodexAccountAttributor,
  UNKNOWN_CODEX_ACCOUNT,
  type CodexAccountRoute,
  type CodexLedgerCall,
  loadCodexAccountAttributor,
} from "../src/codex-account-attribution";
import type { Event } from "../src/parse";
import { tempDir } from "./tmp";

const ts = Date.parse("2026-10-19T10:00:00.000Z");
const usage = { input: 50, cacheRead: 900, cache5m: 50, cache1h: 0, output: 20 };

function row(overrides: Partial<CodexLedgerCall> = {}): CodexLedgerCall {
  return { at: ts + 1_000, provider: "personal", model: "gpt-5.5", input: 1_000, cached: 900, cacheWrite: 50, output: 20, account: "alex@example.com", ...overrides };
}

function routes(): CodexAccountRoute[] {
  return [
    { provider: "personal", alias: "personal/gpt-5.5", upstream: "gpt-5.5", account: "alex@example.com" },
    { provider: "work", alias: "work/gpt-5.5", upstream: "gpt-5.5", account: "alex.work@example.com" },
  ];
}

function event(requestId = "r1", model = "personal/gpt-5.5", value = usage, modelProvider?: string): Event {
  return { t: "api", sessionId: "s1", requestId, model, usage: value, sidechain: false, ts, ...(modelProvider ? { modelProvider } : {}) };
}

function report(rows: CodexLedgerCall[], events: Event[], account = UNKNOWN_CODEX_ACCOUNT) {
  const agg = new Aggregator();
  const fold = agg.stream("rollout", "project", "codex", account, "unknown", new CodexAccountAttributor(routes(), rows));
  for (const value of events) fold(value);
  return agg;
}

describe("Codex gateway account attribution", () => {
  test("uses the matched configured route instead of the current default auth", () => {
    const agg = report([row()], [event()]);
    const first = agg.report();
    expect(first.accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
    expect(first.tokenDays?.accountRows).toMatchObject([{ account: "alex@example.com", tokens: 1_020 }]);
    expect(first.accountAttribution).toEqual({ version: 1, configuredRoute: 1, profile: 0, unknown: 0 });
    // Re-rendering a report keeps its already reserved row and attribution.
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
  });

  test("does not consume another ledger row for repeated rollout records", () => {
    const agg = report([row()], [event(), event()]);
    expect(agg.report()).toMatchObject({ apiCalls: 1, totalTokens: 1_020 });
  });

  test("keeps unmatched or full-vector-mismatched usage unknown", () => {
    const wrongWrite = { ...usage, cache5m: 49, input: 51 };
    const r = report([row()], [event("missing", "not-configured"), event("wrong", "personal/gpt-5.5", wrongWrite)]).report();
    expect(r.accounts).toMatchObject([{ account: UNKNOWN_CODEX_ACCOUNT, calls: 2 }]);
    expect(r.accountAttribution).toEqual({ version: 1, configuredRoute: 0, profile: 0, unknown: 2 });
  });

  test("does not guess when the same complete vector could belong to two accounts", () => {
    const r = report([row(), row({ provider: "work", account: "alex.work@example.com" })], [event("r1", "gpt-5.5", usage, "subscription_gateway")]).report();
    expect(r.accounts).toMatchObject([{ account: UNKNOWN_CODEX_ACCOUNT, calls: 1 }]);
    expect(r.accountAttribution).toEqual({ version: 1, configuredRoute: 0, profile: 0, unknown: 1 });
  });

  test("prefers an exact future ledger response id over an otherwise ambiguous vector", () => {
    const r = report([
      row({ responseId: "r1" }),
      row({ provider: "work", account: "alex.work@example.com", responseId: "r2" }),
    ], [event("r1", "gpt-5.5", usage, "subscription_gateway")]).report();
    expect(r.accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
  });

  test("never treats a native openai upstream model as gateway proof", () => {
    const r = report([row()], [event("r1", "gpt-5.5")]).report();
    expect(r.accounts).toMatchObject([{ account: UNKNOWN_CODEX_ACCOUNT, calls: 1 }]);
  });

  test("keeps an exact request/vector match through report rerenders and re-reserves only after an update", () => {
    const initial = new CodexAccountAttributor(routes(), [row(), row({ output: 21 })]);
    const agg = new Aggregator();
    let fold = agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", initial);
    fold(event("r1"));
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
    fold(event("r1", "personal/gpt-5.5", { ...usage, output: 21 }));
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
  });

  test("a refreshed ledger matcher can resolve a previously unknown stable request", () => {
    const agg = new Aggregator();
    const empty = new CodexAccountAttributor(routes(), []);
    const first = agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", empty);
    first(event("r1"));
    expect(agg.report().accounts).toMatchObject([{ account: UNKNOWN_CODEX_ACCOUNT, calls: 1 }]);
    // `stream` receives each discovery during watch. The existing stream must
    // adopt the fresh index rather than keep the initial empty one.
    agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", new CodexAccountAttributor(routes(), [row()]));
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
  });

  test("does not overwrite an already proven request when a later matcher has another account", () => {
    const agg = new Aggregator();
    const first = agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", new CodexAccountAttributor(routes(), [row()]));
    first(event("r1"));
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
    const changedRoute = [{ ...routes()[0]!, account: "different@example.com" }, routes()[1]!];
    agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", new CodexAccountAttributor(changedRoute, [row({ account: "different@example.com" })]));
    expect(agg.report().accounts).toMatchObject([{ account: "alex@example.com", calls: 1 }]);
  });

  test("carries an immutable ledger reservation into a refreshed matcher", () => {
    const ledger = row({ key: "studio:one", origin: "gateway" });
    const agg = new Aggregator();
    agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", new CodexAccountAttributor(routes(), [ledger]))(event("r1"));
    expect(agg.report().accountAttribution).toEqual({ version: 1, configuredRoute: 1, profile: 0, unknown: 0 });
    const fold = agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", new CodexAccountAttributor(routes(), [ledger]));
    fold({ ...event("r2"), ts: ts + 500 });
    const next = agg.report();
    expect(next).toMatchObject({ totalTokens: 2_040, apiCalls: 2 });
    expect(next.accountAttribution).toEqual({ version: 1, configuredRoute: 1, profile: 0, unknown: 1 });
  });

  test("filters every report dimension from resolved per-call account ownership", () => {
    const agg = new Aggregator();
    const attributor = new CodexAccountAttributor(routes(), [
      row(),
      row({ provider: "work", account: "alex.work@example.com" }),
    ]);
    const fold = agg.stream("rollout", "project", "codex", UNKNOWN_CODEX_ACCOUNT, "unknown", attributor);
    fold({ t: "prompt", sessionId: "s1", promptId: "p1", text: "personal", sidechain: false, ts });
    fold({ t: "tooluse", sessionId: "s1", requestId: "r1", id: "t1", name: "Bash", argChars: 10, ts });
    fold(event("r1"));
    fold({ t: "toolresult", sessionId: "s1", id: "t1", chars: 100, ts });
    fold({ t: "prompt", sessionId: "s1", promptId: "p2", text: "work", sidechain: false, ts });
    fold({ t: "tooluse", sessionId: "s1", requestId: "r2", id: "t2", name: "Read", argChars: 20, ts });
    fold(event("r2", "work/gpt-5.5"));
    fold({ t: "toolresult", sessionId: "s1", id: "t2", chars: 200, ts });
    const period = { key: "2026-10", label: "October 2026", from: ts - 10_000, to: ts + 10_000, month: true };
    const built: any = {
      periods: [period],
      readers: new Map([["codex", { sink: agg, status: { id: "codex", present: true, parseable: true, files: [] } }]]),
    };
    const [filtered] = reportsByPeriod(built, { top: 15, account: "alex@example.com" }).get(period.key)!;
    expect(filtered).toMatchObject({ totalTokens: 1_020, apiCalls: 1, observedCalls: 1, sessions: 1 });
    expect(filtered.accounts).toMatchObject([{ account: "alex@example.com", tokens: 1_020, calls: 1 }]);
    expect(filtered.models).toMatchObject([{ model: "personal/gpt-5.5", calls: 1 }]);
    expect(filtered.projects).toEqual([{ project: "project", tokens: 1_020, cost: expect.any(Number) }]);
    expect(filtered.tokenDays?.rows).toEqual([{ day: "2026-10-19", model: "personal/gpt-5.5", tokens: 1_020 }]);
    expect(filtered.tokenDays?.accountRows).toEqual([{ day: "2026-10-19", model: "personal/gpt-5.5", account: "alex@example.com", tokens: 1_020 }]);
    expect(filtered.prompts.map((prompt) => prompt.text)).toEqual(["personal"]);
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["Bash"]);
  });

  test("uses an exact configured ledger alias and the explicit gateway state root", () => {
    const root = tempDir("spendwatch-codex-account-");
    const configuredState = join(root, "configured-state");
    const selectedState = join(root, "selected-state");
    const credentials = join(root, "credentials.json");
    const config = join(root, "gateway.json");
    const bindings = join(root, "bindings.json");
    mkdirSync(join(selectedState, "usage"), { recursive: true });
    // This changed current credential must not rewrite the dated public route.
    writeFileSync(credentials, JSON.stringify({ email: "different@example.com", subject: "different-subject" }));
    writeFileSync(config, JSON.stringify({
      version: 1, stateDirectory: configuredState,
      providers: [{ id: "personal", type: "codex-subscription", credentialFile: "credentials.json", models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } }],
    }));
    writeFileSync(join(selectedState, "usage", "usage-2026-10.jsonl"), JSON.stringify({
      at: new Date(ts + 1_000).toISOString(), host: "studio", requestId: "gateway-1", responseId: "absent-in-current-ledger",
      provider: "personal", providerType: "codex-subscription", model: "codex/gpt-6.1-sol", status: "completed", origin: "gateway",
      inputTokens: 1_000, cachedTokens: 900, cacheWriteTokens: 50, outputTokens: 20,
    }) + "\n");
    writeFileSync(bindings, JSON.stringify({
      version: 1,
      bindings: [{ config, provider: "personal", account: "alex@example.com", from: "2026-10-01T00:00:00.000Z", basis: "configured-route" }],
    }));
    const prior = process.env.SPENDWATCH_GATEWAY_CONFIG;
    const priorBindings = process.env.SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS;
    process.env.SPENDWATCH_GATEWAY_CONFIG = config;
    process.env.SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS = bindings;
    try {
      const attributor = loadCodexAccountAttributor(ts - 10_000, selectedState)!;
      const resolved = attributor.resolve("rollout\u0000r1", "codex/gpt-6.1-sol", usage, ts, undefined, false);
      expect(resolved).toMatchObject({ account: "alex@example.com", provider: "personal", ledgerKey: "studio:gateway-1" });
    } finally {
      if (prior === undefined) delete process.env.SPENDWATCH_GATEWAY_CONFIG;
      else process.env.SPENDWATCH_GATEWAY_CONFIG = prior;
      if (priorBindings === undefined) delete process.env.SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS;
      else process.env.SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS = priorBindings;
    }
  });
});

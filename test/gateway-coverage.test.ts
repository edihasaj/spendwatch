import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, reportsByPeriod } from "../src/build";
import type { Period } from "../src/periods";
import { rollingDays } from "../src/periods";
import { iso, line } from "./gateway-world";
import { tempDir } from "./tmp";

// A rollout drops a gateway-marked call only when this Mac's ledger proves another record bills it. Every other
// marked call stays in the Codex report, labelled, so no turn is ever counted nowhere.

const saved = { config: process.env.SPENDWATCH_CONFIG, tz: process.env.TZ };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["TZ", saved.tz]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const record = (id: string, at: number, input = 400, output = 20) =>
  line({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } });
const row = (over: Record<string, unknown>) => JSON.stringify({ v: 1, host: "studio", requestId: "r1", responseId: "resp_gl_abc", origin: "gateway",
  providerType: "copilot-subscription", provider: "copilot", model: "copilot/gpt", inputTokens: 400, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 20,
  reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete", ...over }) + "\n";

/**
 * A subscription_gateway rollout and this Mac's gateway state. `ledger` is the files of `<state>/usage`, by name;
 * undefined leaves no usage directory at all.
 */
function world(rollout: string, ledger?: Record<string, string>) {
  const root = tempDir("spendwatch-coverage-");
  const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), rollout);
  if (ledger) {
    mkdirSync(join(state, "usage"));
    for (const [name, body] of Object.entries(ledger)) writeFileSync(join(state, "usage", name), body);
  }
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "copilot", "session-store.db") }, { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = config;
}

function run(periods: Period[]) {
  const options = { top: 5 };
  const built = build(options, periods);
  const reports = [...reportsByPeriod(built, options).values()].flat();
  const of = (source: string) => reports.find((r) => r.source === source);
  return { built, codex: of("codex"), copilot: of("copilot") };
}

const NOW = Date.now();
const meta = (at: number) => line({ timestamp: iso(at), type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway", model: "copilot/gpt" } });
const routedRollout = meta(NOW - 60_000) + record("resp_gl_abc", NOW - 30_000);
const month = iso(NOW).slice(0, 7);
const LABEL = "copilot/gpt (gateway-routed, not in this Mac's ledger)";

describe("a gateway-marked rollout call", () => {
  test("is dropped when this Mac's ledger holds its row, which bills it", () => {
    world(routedRollout, { [`usage-${month}.jsonl`]: row({ at: iso(NOW - 30_000) }) });
    const { codex, copilot } = run([rollingDays(NOW, 30)]);
    expect([codex?.apiCalls, copilot?.apiCalls]).toEqual([0, 1]);
    expect([codex?.routedCalls, copilot?.routedCalls]).toEqual([1, 1]);
  });

  for (const [name, ledger] of [
    ["no ledger directory at all", undefined],
    ["an empty ledger directory", {}],
    ["an empty month file", { [`usage-${month}.jsonl`]: "" }],
  ] as const) {
    test(`is kept and labelled with ${name}`, () => {
      world(routedRollout, ledger as Record<string, string> | undefined);
      const { built, codex, copilot } = run([rollingDays(NOW, 30)]);
      expect([codex?.apiCalls, copilot?.apiCalls ?? 0]).toEqual([1, 0]);
      expect(codex!.models.map((m) => m.model)).toEqual([LABEL]);
      expect(codex!.routedCalls).toBeUndefined();
      expect(built.statuses.find((s) => s.id === "codex")!.warning).toContain("had no row in this Mac's gateway ledger");
    });
  }

  test("is kept when its month's ledger file is gone, pruned past the gateway's retention", () => {
    // Only a newer month survives; the rollout's own month was pruned while the rollout still exists.
    world(routedRollout, { "usage-2099-01.jsonl": row({ at: "2099-01-05T00:00:00.000Z", requestId: "future", responseId: "resp_gl_future" }) });
    const { codex } = run([rollingDays(NOW, 30)]);
    expect(codex?.apiCalls).toBe(1);
    expect(codex!.models.map((m) => m.model)).toEqual([LABEL]);
  });

  test("is kept when another Mac's gateway served it: this ledger has rows, but not that one", () => {
    world(routedRollout + record("resp_gl_local", NOW - 20_000, 500, 30), {
      [`usage-${month}.jsonl`]: row({ at: iso(NOW - 20_000), requestId: "local", responseId: "resp_gl_local", inputTokens: 500, outputTokens: 30 }),
    });
    const { codex, copilot } = run([rollingDays(NOW, 30)]);
    // The local turn is the ledger's; the remote one stays here, flagged, for whoever reads this report.
    expect([codex?.apiCalls, copilot?.apiCalls]).toEqual([1, 1]);
    expect(codex!.models.map((m) => `${m.model}:${m.calls}`)).toEqual([`${LABEL}:1`]);
  });
});

describe("a call at the very end of a UTC month", () => {
  test("is billed once when its rollout line is read with the next month alone", () => {
    process.env.TZ = "UTC";
    // The gateway filed the call 10 s before October; Codex wrote its rollout line 5 s after.
    const at = Date.UTC(2026, 8, 30, 23, 59, 50);
    const rollout = meta(at - 60_000) + record("resp_unmarked", Date.UTC(2026, 9, 1, 0, 0, 5));
    world(rollout, { "usage-2026-09.jsonl": row({ at: iso(at), origin: "telemetry", providerType: undefined, responseId: "", session: true }) });
    const period = (key: string, from: number, to: number): Period => ({ key, label: key, from, to, month: true });
    const october = run([period("2026-10", Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1))]);
    const september = run([period("2026-09", Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1))]);
    // September bills the claimed row; October drops the rollout line that row already billed.
    expect([september.copilot?.apiCalls, october.codex?.apiCalls ?? 0]).toEqual([1, 0]);
    expect([september.codex?.apiCalls ?? 0, october.copilot?.apiCalls ?? 0]).toEqual([0, 0]);
    // October did read the rollout: the call counts as observed there, and as handed to the ledger.
    expect([october.codex?.observedCalls, october.codex?.routedCalls]).toEqual([1, 1]);
  });
});

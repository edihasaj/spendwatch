import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/aggregate";
import { build, reportsByPeriod } from "../src/build";
import { monthPeriod } from "../src/periods";
import { labelReports } from "../src/reports";
import { loadMonthlySpend, writeMonthlySpend } from "../src/spend-history";
import { loadArchivedReports } from "../src/spend-report-archive";
import { tokenSummary } from "../src/token-summary";
import { iso, line } from "./gateway-world";

// One routed turn, two Macs: the client's Codex sent it through the serving Mac's gateway. The client has no ledger
// of its own, so it keeps the turn, labelled; the serving Mac's ledger bills it on Copilot. Wherever the two Macs'
// reports meet, the turn must be counted once, on the serving Mac.

const ROOT = join(import.meta.dir, "..");
const SEPTEMBER = monthPeriod("2026-09");
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour, minute);
const REQUEST = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const MARKED = `resp_gl_${REQUEST.replaceAll("-", "")}`;
const LABEL = "copilot/gpt (gateway-routed, not in this Mac's ledger)";
const usage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output });

const saved = { config: process.env.SPENDWATCH_CONFIG, zone: process.env.SPENDWATCH_TOKEN_TIME_ZONE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_TOKEN_TIME_ZONE", saved.zone]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** One Mac's September, read the way `report --json --label <mac>` reads it, with its day rows measured that evening. */
function read(machine: string, files: { rollouts?: Record<string, string>; ledger?: string }): Report[] {
  const root = mkdtempSync(join(tmpdir(), `spendwatch-${machine}-`));
  const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(state, { recursive: true });
  for (const [name, body] of Object.entries(files.rollouts ?? {})) writeFileSync(join(sessions, name), body);
  if (files.ledger) {
    mkdirSync(join(state, "usage"));
    writeFileSync(join(state, "usage", "usage-2026-09.jsonl"), files.ledger);
  }
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([
    { agent: "codex", path: sessions, account: `${machine}@example.com` }, { agent: "copilot", path: join(root, "copilot", "session-store.db") },
    { agent: "gateway", path: state },
  ]));
  process.env.SPENDWATCH_CONFIG = config;
  process.env.SPENDWATCH_TOKEN_TIME_ZONE = "UTC";
  const options = { top: 5 };
  const reports = (reportsByPeriod(build(options, [SEPTEMBER]), options).get(SEPTEMBER.key) ?? [])
    .filter((report) => (report.observedCalls ?? report.apiCalls) > 0)
    .map((report) => ({ ...report, tokenDays: { ...report.tokenDays!, measuredAt: at(15, 20) } }));
  return labelReports(reports, machine);
}

/** The client: one turn the serving Mac's gateway served (marked), one ordinary OpenAI turn. */
const client = () => read("client", {
  rollouts: {
    "rollout-2026-09-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl":
      line({ timestamp: iso(at(15, 10)), type: "session_meta", payload: { id: "routed", model_provider: "subscription_gateway", model: "copilot/gpt", cwd: "/work/spend" } })
      + line({ timestamp: iso(at(15, 10, 1)), type: "token_usage_record", payload: { response_id: MARKED, usage: usage(4_000, 200) } }),
    "rollout-2026-09-15T11-00-00-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl":
      line({ timestamp: iso(at(15, 11)), type: "session_meta", payload: { id: "plain", model_provider: "openai", model: "gpt-5.5", cwd: "/work/spend" } })
      + line({ timestamp: iso(at(15, 11, 1)), type: "token_usage_record", payload: { response_id: "resp_plain", usage: usage(1_000, 100) } }),
  },
});

/** The serving Mac: no Codex of its own that day, and the ledger row of the client's turn. */
const serving = () => read("studio", {
  ledger: JSON.stringify({ v: 1, at: iso(at(15, 10, 1)), host: "studio", requestId: REQUEST, responseId: MARKED, origin: "gateway",
    provider: "copilot", providerType: "copilot-subscription", model: "copilot/gpt", status: "completed", inputTokens: 4_000, cachedTokens: 0,
    cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0, nanoAiu: 3e9, nanoAiuStatus: "complete" }) + "\n",
});

const ROUTED_TOKENS = 4_200;
const PLAIN_TOKENS = 1_100;

describe("a routed turn served by another Mac", () => {
  test("is kept by the client alone, labelled: nothing on the client proves a ledger counts it", () => {
    const [codex] = client().filter((r) => r.source === "client:codex");
    expect(codex!.apiCalls).toBe(2);
    expect(codex!.models.map((m) => m.model).sort()).toEqual([LABEL, "gpt-5.5"].sort());
  });

  test("is counted once in an archive holding both Macs' reports, in every view of it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spendwatch-two-macs-")), "spendwatch.db");
    writeMonthlySpend(path, [...client(), ...serving()], { generatedAt: at(15, 20) });

    const reports = Object.fromEntries(loadArchivedReports(path).map((r) => [r.source, r]));
    expect(reports["client:codex"]).toMatchObject({ apiCalls: 1, totalTokens: PLAIN_TOKENS });
    expect(reports["client:codex"]!.models.map((m) => m.model)).toEqual(["gpt-5.5"]);
    expect(reports["studio:copilot"]).toMatchObject({ apiCalls: 1, totalTokens: ROUTED_TOKENS });

    const [month] = loadMonthlySpend(path);
    expect(month).toMatchObject({ calls: 2, tokens: PLAIN_TOKENS + ROUTED_TOKENS });
    expect(Object.fromEntries(month!.sources.map((s) => [s.source, s.calls]))).toEqual({ "client:codex": 1, "studio:copilot": 1 });
    // The client's project keeps only its own turn; the routed one is the serving Mac's, under `gateway`.
    expect(Object.fromEntries(month!.projects.map((p) => [p.project, p.tokens]))).toEqual({ "/work/spend": PLAIN_TOKENS, gateway: ROUTED_TOKENS });

    const summary = tokenSummary(path, { now: at(15, 21), timeZone: "UTC" });
    expect(summary.periods.month.counts?.total).toBe(PLAIN_TOKENS + ROUTED_TOKENS);
    expect(summary.periods.day.counts?.total).toBe(PLAIN_TOKENS + ROUTED_TOKENS);
  });

  test("is counted once when the collector renders both Macs' exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-two-macs-inputs-"));
    const files = { client: join(dir, "client.json"), studio: join(dir, "studio.json") };
    writeFileSync(files.client, JSON.stringify(client()));
    writeFileSync(files.studio, JSON.stringify(serving()));
    const render = (inputs: string[]) => {
      const out = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), "report", "--input", inputs.join(",")], {
        cwd: ROOT, env: { ...process.env, SPENDWATCH_GATEWAY_CONFIG: process.env.SPENDWATCH_GATEWAY_CONFIG },
      });
      expect(out.exitCode).toBe(0);
      return out.stdout.toString();
    };
    // Alone, the client's export still shows the turn it kept.
    expect(render([files.client])).toContain(LABEL);
    // Beside the serving Mac's, the turn is the serving Mac's alone.
    const both = render([files.client, files.studio]);
    expect(both).not.toContain(LABEL);
    expect(both).toContain("copilot/gpt");
  });

  test("passes through `--json` as measured, so the next collector can settle it", () => {
    const dir = mkdtempSync(join(tmpdir(), "spendwatch-two-macs-json-"));
    writeFileSync(join(dir, "client.json"), JSON.stringify(client()));
    writeFileSync(join(dir, "studio.json"), JSON.stringify(serving()));
    const out = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), "report", "--input", `${join(dir, "client.json")},${join(dir, "studio.json")}`, "--json"], {
      cwd: ROOT, env: { ...process.env, SPENDWATCH_GATEWAY_CONFIG: process.env.SPENDWATCH_GATEWAY_CONFIG },
    });
    const rows = JSON.parse(out.stdout.toString()) as Report[];
    expect(rows.find((r) => r.source === "client:codex")).toMatchObject({ apiCalls: 2 });
  });
});

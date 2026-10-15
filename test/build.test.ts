import { afterEach, describe, expect, test } from "bun:test";
import { build, reportsByPeriod } from "../src/build";
import { rollingDays } from "../src/periods";
import { gatewayWorld } from "./gateway-world";

// Whole-run behaviour: what `report` builds from a Codex rollout and a gateway ledger, whichever agents were asked for.
const saved = { config: process.env.SPENDWATCH_CONFIG, source: process.env.SPENDWATCH_GATEWAY_SOURCE, state: process.env.SPENDWATCH_GATEWAY_STATE };
afterEach(() => {
  for (const [key, value] of [["SPENDWATCH_CONFIG", saved.config], ["SPENDWATCH_GATEWAY_SOURCE", saved.source], ["SPENDWATCH_GATEWAY_STATE", saved.state]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** Builds the world and points this process at it. */
function useWorld(options: { codexAccount?: string; telemetry?: boolean } = {}) {
  const w = gatewayWorld(options);
  process.env.SPENDWATCH_CONFIG = w.config; delete process.env.SPENDWATCH_GATEWAY_SOURCE; delete process.env.SPENDWATCH_GATEWAY_STATE;
  return w;
}

// The sources with a gateway story; the idle ones (Grok, pi) report empty.
const SOURCES = new Set(["claude", "codex", "copilot"]);
const reports = (agents: string[] | undefined, extra: { account?: string; project?: string } = {}) => {
  const w = useWorld({ codexAccount: extra.account ? "zzz-codex" : undefined });
  const options = { agents: agents ? new Set(agents) : undefined, top: 5, ...extra };
  const built = build(options, w.periods);
  return { built, reports: [...reportsByPeriod(built, options).values()].flat().filter((r) => SOURCES.has(r.source)) };
};
const bySource = (rows: ReturnType<typeof reports>["reports"]) => Object.fromEntries(rows.map((r) => [r.source, r]));

describe("a run with the gateway ledger", () => {
  test("tags the Codex, Claude and Copilot reports as read with the ledger", () => {
    const { reports: rows } = reports(undefined);
    const found = bySource(rows);
    expect(Object.keys(found).sort()).toEqual(["claude", "codex", "copilot"]);
    // The archive's ledger guard reads this flag; without it a month read with the ledger could be undone.
    expect(rows.map((r) => r.ledger)).toEqual([true, true, true]);
  });

  test("does not tag them when the ledger is off", () => {
    useWorld();
    process.env.SPENDWATCH_GATEWAY_SOURCE = "off";
    const options = { top: 5 };
    const built = build(options, [rollingDays(Date.now(), 30)]);
    const rows = [...reportsByPeriod(built, options).values()].flat();
    expect(rows.filter((r) => SOURCES.has(r.source)).map((r) => r.source)).toEqual(["codex"]);
    expect(rows.every((r) => r.ledger === undefined)).toBe(true);
  });

  test("reads rollouts before the ledger, so a telemetry row they claim reaches the Claude report", () => {
    const found = bySource(reports(undefined).reports);
    // The unmarked rollout record claimed the telemetry row: Codex dropped it and the ledger bills it once.
    expect(found.claude!.models.map((m) => `${m.model}:${m.calls}`).sort()).toEqual(["claude-opus-5.5 (telemetry backfill):1", "claude-opus-5.5:1"]);
    expect(found.copilot!.apiCalls).toBe(1);
    // Codex keeps neither routed turn: the marked one is the ledger's, the claimed one was billed there already.
    expect(found.codex!.apiCalls).toBe(0);
    expect(found.codex!.observedCalls).toBe(2);
  });
});

describe("a run limited to some agents", () => {
  test("reports the same Claude spend as the full run, and nothing for the agents it was not asked for", () => {
    const full = bySource(reports(undefined).reports);
    const subset = reports(["claude"]);
    const only = bySource(subset.reports);
    expect(Object.keys(only)).toEqual(["claude"]);
    // The Codex rollout is read only so it can claim its telemetry row: the claimed row stays in the report.
    expect(only.claude!.apiCalls).toBe(full.claude!.apiCalls);
    expect(only.claude!.totalTokens).toBe(full.claude!.totalTokens);
    expect(only.claude!.totalCost).toBeCloseTo(full.claude!.totalCost, 12);
    expect(subset.built.statuses.find((s) => s.id === "codex")?.claimOnly).toBe(true);
  });

  test("does not read rollouts for claims when nothing is waiting to be claimed", () => {
    useWorld({ telemetry: false });
    const options = { agents: new Set(["copilot"]), top: 5 };
    const built = build(options, [rollingDays(Date.now(), 30)]);
    expect(built.statuses.map((s) => s.id)).toEqual(["copilot"]);
  });

  test("an account filter keeps the claims of the rollouts it leaves out of the Codex report", () => {
    // The account the suite names in test/isolate-gateway.ts, never one read from a real login.
    const filter = process.env.SPENDWATCH_CLAUDE_ACCOUNT!;
    expect(filter).toBeTruthy();
    const filtered = reports(undefined, { account: filter });
    const found = bySource(filtered.reports);
    // The Codex rollout belongs to another account and is not in the Codex report, but it still vouched for its row.
    expect(found.claude!.apiCalls).toBe(2);
    expect(found.codex?.apiCalls ?? 0).toBe(0);
  });
});

describe("a run limited to one project", () => {
  test("keeps the routed Claude rows in the Claude totals, as the Copilot and Codex reports keep theirs", () => {
    const all = bySource(reports(undefined).reports);
    const filtered = bySource(reports(undefined, { project: "zzz" }).reports);
    // The ledger's rows are not a project's transcript: their project is "gateway", not a name to pre-filter by.
    expect(filtered.claude!.apiCalls).toBe(all.claude!.apiCalls);
    expect(filtered.claude!.totalTokens).toBe(all.claude!.totalTokens);
    expect(filtered.claude!.totalCost).toBeCloseTo(all.claude!.totalCost, 12);
    expect(filtered.copilot!.apiCalls).toBe(all.copilot!.apiCalls);
    expect(filtered.codex!.apiCalls).toBe(all.codex!.apiCalls);
    // Only the project lists are filtered afterwards.
    expect(all.claude!.projects.map((p) => p.project)).toEqual(["gateway"]);
    expect(filtered.claude!.projects).toEqual([]);
  });

  test("counts each routed Claude call once under the project that was asked for", () => {
    const filtered = bySource(reports(undefined, { project: "gateway" }).reports);
    expect(filtered.claude!.apiCalls).toBe(2);
    expect(filtered.claude!.projects.map((p) => p.project)).toEqual(["gateway"]);
  });
});

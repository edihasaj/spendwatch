import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { GatewayIndex } from "../src/gateway";
import { copilotRow, iso, onlySeed, rng, routedLine, seedCount } from "./fuzz-world";
import { tempDir } from "./tmp";

// The same promise as the watch fuzz, for one read (`report`): the ledger is loaded once, then the rollouts are read
// line by line while the clock runs and the gateway keeps appending rows. Every one of six routed calls must be billed
// exactly once, by the rollout (a Codex api event) or by the ledger (a Copilot api event). Rows land before the
// call, with it, or up to 20 s after it; one never lands, as when another Mac's gateway served the call. In the
// "ambiguous" worlds only two token shapes exist, so a call has several rows it could match, and a call with no
// row of its own is tempted by a neighbour's. In "mixed" worlds one rollout writes marked records and the other bare
// token_counts, so a record and a token_count can both reach for the same row.
afterEach(() => setSystemTime());

const LAG = [-5_000, 0, 1_000, 3_000, 20_000, Infinity];
const CALLS = 6;

function read(seed: number, mode: "records" | "counts" | "mixed", ambiguous: boolean): { codex: number; ledger: number } {
  const random = rng(seed);
  const state = tempDir("spendwatch-fuzz-report-");
  try {
    mkdirSync(join(state, "usage"));
    const start = Date.now();
    setSystemTime(new Date(start));
    const file = join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`);
    writeFileSync(file, copilotRow("seed", start - 300_000, 7));
    const calls = Array.from({ length: CALLS }, (_, i) => {
      const at = start - 40_000 + Math.floor(random() * 80_000);
      const lag = LAG[Math.floor(random() * LAG.length)]!;
      return { id: `c${i}`, at, landAt: at + 200 + Math.max(0, lag), input: ambiguous ? 100 + Math.floor(random() * 2) : 100 + i, file: Math.floor(random() * 2), landed: false };
    });
    const landDue = (): void => {
      for (const call of calls) if (!call.landed && call.landAt <= Date.now()) { appendFileSync(file, copilotRow(call.id, call.at + 200, call.input)); call.landed = true; }
    };
    landDue();
    const ledger = GatewayIndex.load({ sinceMs: start - 86_400_000, stateDir: state });
    let codex = 0;
    for (const rollout of [0, 1]) {
      const ctx = newCodexCtx(ledger);
      const lines = [
        JSON.stringify({ timestamp: iso(start - 90_000), type: "session_meta", payload: { id: `s${rollout}`, model_provider: "subscription_gateway" } }),
        JSON.stringify({ timestamp: iso(start - 90_000), type: "turn_context", payload: { model: "copilot/gpt" } }),
      ];
      let total = 0;
      for (const call of calls.filter((c) => c.file === rollout).sort((a, b) => a.at - b.at)) {
        total += call.input;
        lines.push(routedLine(mode === "mixed" ? (rollout === 0 ? "records" : "counts") : mode, call.id, call.at, call.input, total));
      }
      // Reading takes time: up to 15 s a line, and rows land meanwhile.
      for (const text of lines) {
        setSystemTime(new Date(Date.now() + Math.floor(random() * 15_000)));
        landDue();
        for (const event of parseCodexLine(text, ctx)) if (event.t === "api") codex++;
      }
      setSystemTime(new Date(Date.now() + Math.floor(random() * 5_000)));
      landDue();
      for (const event of settleRouted(ctx, true)) if (event.t === "api") codex++;
    }
    // The seed row is the ledger's; every other row it bills is a call no rollout billed.
    const ledgerBilled = [...ledger.files("copilot")[0]!.events!()].filter((event) => event.t === "api").length - 1;
    return { codex, ledger: ledgerBilled };
  } finally {
    setSystemTime();
    rmSync(state, { recursive: true, force: true });
  }
}

const SEEDS = 1000;

describe("a report bills every routed call exactly once", () => {
  const worlds: Array<["records" | "counts" | "mixed", boolean]> = [
    ["records", false], ["records", true], ["counts", false], ["counts", true], ["mixed", true],
  ];
  for (const [mode, ambiguous] of worlds) {
    test(`${mode}${ambiguous ? ", ambiguous token shapes" : ""}: ${SEEDS} seeded reads`, () => {
      const bad: unknown[] = [];
      const only = onlySeed();
      for (let seed = only ?? 1; seed <= (only ?? seedCount(SEEDS)); seed++) {
        const out = read(seed, mode, ambiguous);
        if (out.codex + out.ledger !== CALLS) bad.push({ seed, ...out });
      }
      expect({ failedSeeds: bad.length, first: bad.slice(0, 3) }).toEqual({ failedSeeds: 0, first: [] });
    }, 120_000);
  }
});

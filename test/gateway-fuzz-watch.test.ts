import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Aggregator } from "../src/aggregate";
import { build, pollWatched, reportsFrom, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { rollingDays } from "../src/periods";
import { discover } from "../src/sources";
import { copilotRow, iso, rng, routedLine } from "./fuzz-world";
import { tempDir } from "./tmp";

// The ledger's one promise, shaken by seeded random worlds: however the gateway's rows and the rollouts' lines
// interleave across `watch` ticks, every routed call is billed exactly once (here: in Codex when no row bills it, in
// Copilot when one does). Six calls and one older row make seven bills, whatever happens.
//
//   * two rollouts write calls in random ticks; a call's ledger row lands before, with, or up to 99 ticks after its line
//     (a late row, and one that never lands in the run, as when another Mac's gateway served the call);
//   * "records" calls carry the marked response id; "counts" calls are bare token_counts, with only two token
//     shapes, so several calls match the same row; in "mixed" worlds one rollout writes records and the other
//     token_counts (two Codex builds on one Mac), so a record and a token_count can both reach for the same row;
//   * each tick reloads the ledger, as `watch` does, 5 s apart.
//
// The "crowded" worlds hold ten calls over three token shapes in a longer run: many calls have several rows they could
// take, and a call that is billed from its rollout can end up standing on a row a rearrangement moved it to.
afterEach(() => { setSystemTime(); delete process.env.SPENDWATCH_CONFIG; });

const TICK_MS = 5_000;
const LATE = [-1, 0, 0, 1, 2, 9, 99];

interface Size { calls: number; shapes: number; ticks: number }
const USUAL: Size = { calls: 6, shapes: 2, ticks: 6 };
const CROWDED: Size = { calls: 10, shapes: 3, ticks: 9 };

interface Outcome {
  codex: number;
  copilot: number;
  freshCodex: number;
  freshCopilot: number;
  log: string[];
}

type Mode = "records" | "counts" | "mixed";

function world(seed: number, mode: Mode, agents?: Set<string>, size: Size = USUAL): Outcome {
  const random = rng(seed);
  const root = tempDir("spendwatch-fuzz-watch-");
  try {
    const sessions = join(root, "codex");
    const state = join(root, "state");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(state, "usage"), { recursive: true });
    const start = Date.now();
    setSystemTime(new Date(start));
    const ledger = join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`);
    writeFileSync(ledger, copilotRow("seed", start - 100_000, 7)); // so the Copilot stream exists
    const rollouts = [0, 1].map((k) => join(sessions, `rollout-2026-10-15T10-00-0${k}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${k}.jsonl`));
    rollouts.forEach((path, k) => writeFileSync(path,
      JSON.stringify({ timestamp: iso(start - 90_000), type: "session_meta", payload: { id: `s${k}`, model_provider: "subscription_gateway" } }) + "\n"
      + JSON.stringify({ timestamp: iso(start - 90_000), type: "turn_context", payload: { model: "copilot/gpt" } }) + "\n"));
    writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "none.db") }, { agent: "gateway", path: state }]));
    process.env.SPENDWATCH_CONFIG = join(root, "config.json");

    const calls = Array.from({ length: size.calls }, (_, i) => {
      const tick = 1 + Math.floor(random() * size.ticks);
      const rowTick = tick + LATE[Math.floor(random() * LATE.length)]!;
      return { id: `c${i}`, tick, rowTick, file: Math.floor(random() * 2), input: mode === "records" ? 100 + i : 100 + Math.floor(random() * size.shapes) };
    });
    const totals = [0, 0];
    const options: BuildOptions = { top: 5, ...(agents ? { agents } : {}) };
    const log: string[] = [];
    let built: Built | undefined;
    for (let tick = 0; tick <= size.ticks + 15; tick++) {
      setSystemTime(new Date(start + tick * TICK_MS));
      for (const call of calls) {
        const at = start + call.tick * TICK_MS - 500;
        if (call.rowTick === tick) { appendFileSync(ledger, copilotRow(call.id, at + 200, call.input)); log.push(`t${tick} row ${call.id}`); }
        if (call.tick === tick) {
          totals[call.file]! += call.input;
          appendFileSync(rollouts[call.file]!, routedLine(mode === "mixed" ? (call.file === 0 ? "records" : "counts") : mode, call.id, at, call.input, totals[call.file]!) + "\n");
          log.push(`t${tick} line ${call.id} in rollout ${call.file}`);
        }
      }
      if (!built) built = build(options, [watchPeriod(start, 1)], { watching: true });
      else pollWatched(built, discover({ sinceMs: start - 86_400_000, agents: options.agents }), options);
    }
    const calls_ = (id: string): number => (built!.readers.get(id)?.sink as Aggregator | undefined)?.report().apiCalls ?? 0;
    // A report made at the end reads the same files once, with no later tick to wait for.
    const fresh = reportsFrom(build({ top: 5 }, [rollingDays(start + 200_000, 1)]), { top: 5 });
    const freshCalls = (source: string): number => fresh.find((report) => report.source === source)?.apiCalls ?? 0;
    return { codex: calls_("codex"), copilot: calls_("copilot"), freshCodex: freshCalls("codex"), freshCopilot: freshCalls("copilot"), log };
  } finally {
    setSystemTime();
    rmSync(root, { recursive: true, force: true });
  }
}

const SEEDS = 600;

describe("watch bills every routed call exactly once", () => {
  const worlds: Array<[string, Size, Mode, number]> = [
    ["usual", USUAL, "records", SEEDS], ["usual", USUAL, "counts", SEEDS], ["usual", USUAL, "mixed", SEEDS],
    ["crowded", CROWDED, "counts", 200], ["crowded", CROWDED, "mixed", 200],
  ];
  for (const [kind, size, mode, seeds] of worlds) {
    test(`${kind} worlds, ${mode}: ${seeds} seeds, every call billed once, watched and fresh`, () => {
      const bad: unknown[] = [];
      for (let seed = 1; seed <= seeds; seed++) {
        const out = world(seed, mode, undefined, size);
        // The calls, and the one older row.
        if (out.codex + out.copilot !== size.calls + 1 || out.freshCodex + out.freshCopilot !== size.calls + 1) bad.push({ seed, ...out, log: out.log.join("; ") });
      }
      expect({ failedSeeds: bad.length, first: bad.slice(0, 3) }).toEqual({ failedSeeds: 0, first: [] });
    }, 120_000);
  }

  for (const mode of ["counts", "mixed"] as const) {
    test(`${mode}: reading only the Codex rollouts bills them as the full read does`, () => {
      const bad: unknown[] = [];
      for (let seed = 1; seed <= 100; seed++) {
        const full = world(seed, mode);
        const only = world(seed, mode, new Set(["codex"]));
        if (only.codex !== full.codex) bad.push({ seed, full: full.codex, only: only.codex, log: full.log.join("; ") });
      }
      expect({ failedSeeds: bad.length, first: bad.slice(0, 3) }).toEqual({ failedSeeds: 0, first: [] });
    }, 120_000);
  }
});

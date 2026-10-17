import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import type { Report } from "../src/aggregate";
import { build, pollWatched, reportsByPeriod, reportsFrom, watchPeriod, type BuildOptions, type Built } from "../src/build";
import { settleAcrossMacs, settledAmong } from "../src/gateway-settle";
import { rollingDays, type Period } from "../src/periods";
import { primaryPeriod } from "../src/report-window";
import { discover } from "../src/sources";
import { allowed, generate, makeMac, TICK, writeTick, type Mac, type Options, type World } from "./fuzz-macs-world";
import { onlySeed, seedCount } from "./fuzz-world";

// The promise of the gateway ledger, shaken across whole Macs: however the calls, their ledger rows and their rollout
// lines interleave over time, a routed call is billed exactly once, by `watch` and by a report, on one Mac or on two
// whose reports are settled against each other. Every world is a few Macs (one or two), each with a Codex that writes
// marked records, one that writes bare token_counts, and a gateway that appends a row for a call some ticks after it,
// or never (as when a Mac nobody reads served it). Tokens come in two or three shapes, so alike calls and rows
// compete for each other. A telemetry import echoes some calls before their own row, and rows nobody's rollout
// accounts for sit in the ledger. In the "forks" worlds a rollout is forked mid-run, copying the records so far.
//
// Each world checks, with fixed seeds:
//   * a report taken mid-run bills what the disk then holds, once per call (`allowed`);
//   * at the end, `watch` bills exactly what a report of the same files does, for every Mac;
//   * a report limited to some agents bills each of them as the full report does;
//   * at the end, the bills of the Macs' reports, settled against each other, are once per call (`allowed`).
// `allowed` states the two cases no ledger can resolve without an id on the call, so a failure is a real double or
// lost bill: the README spells the two out.
afterEach(() => { setSystemTime(); delete process.env.SPENDWATCH_CONFIG; });

const bills = (reports: Report[]): number => reports.reduce((n, r) => n + r.apiCalls, 0);
const bySource = (reports: Report[]): string => JSON.stringify(Object.fromEntries(reports.filter((r) => r.apiCalls).map((r) => [r.source, r.apiCalls])));

interface Reading { measured: Report[]; settled: Report[] }

function readMac(mac: Mac, period: Period, agents?: Set<string>): Reading {
  process.env.SPENDWATCH_CONFIG = mac.config;
  const options: BuildOptions = { top: 5, ...(agents ? { agents } : {}) };
  const byPeriod = reportsByPeriod(build(options, [period]), options);
  const measured = byPeriod.get(primaryPeriod([period]).key) ?? [];
  return { measured, settled: settledAmong(measured, [...byPeriod.values()].flat()) };
}

function trace(macs: Map<string, Mac>, world: World): string {
  const lines = world.calls.map((c) => `${c.id} ${c.fmt} client=${c.client} server=${c.server} shape=${c.shape} file=${c.file} line@t${c.lineTick} row@${c.rowTick === null ? "never" : `t${c.rowTick}`} echo@${c.echo}`);
  for (const f of world.forks) lines.push(`fork ${f.mac} t${f.tick}`);
  for (const x of world.extras) lines.push(`extra ${x.kind} ${x.mac} t${x.tick}`);
  for (const mac of macs.values()) for (const file of [mac.ledger, ...mac.rollouts]) lines.push(`--- ${file}`, readFileSync(file, "utf8").trimEnd());
  return lines.join("\n");
}

/** One world, run to the end; the ways it broke the promise. */
function run(seed: number, o: Options): { failures: string[]; world: string } {
  const failures: string[] = [];
  const start = Date.now();
  setSystemTime(new Date(start));
  const world = generate(seed, o, start);
  const macs = new Map(o.macs.map((name) => [name, makeMac(name, start, o.files, o.forks ? 1 : 0)]));
  try {
    const options: BuildOptions = { top: 5 };
    const watches = new Map<string, Built>();
    writeTick(macs, world, 0);
    for (const mac of macs.values()) {
      process.env.SPENDWATCH_CONFIG = mac.config;
      watches.set(mac.name, build(options, [watchPeriod(start, 30)], { watching: true }));
    }
    const lastTick = o.ticks + 50;
    const midRun = new Set([Math.floor(o.ticks / 2), o.ticks + 1, o.ticks + 9]);
    for (let tick = 1; tick <= lastTick; tick++) {
      setSystemTime(new Date(start + tick * TICK));
      writeTick(macs, world, tick);
      for (const mac of macs.values()) {
        process.env.SPENDWATCH_CONFIG = mac.config;
        const built = watches.get(mac.name)!;
        pollWatched(built, discover({ sinceMs: built.periods[0]!.from }), options);
      }
      if (!midRun.has(tick)) continue;
      const readings = [...macs.values()].map((mac) => readMac(mac, rollingDays(start + tick * TICK, 30)));
      const got = bills(settleAcrossMacs(readings.flatMap((r) => r.measured)));
      const range = allowed(world, o.macs, tick);
      if (got < range.min || got > range.max) failures.push(`report@t${tick}: ${got} bills, expected ${range.min}..${range.max} ${readings.map((r) => bySource(r.measured)).join(" | ")}`);
    }
    setSystemTime(new Date(start + lastTick * TICK));
    const period = rollingDays(start + lastTick * TICK, 30);
    const finals: Report[] = [];
    for (const mac of macs.values()) {
      const full = readMac(mac, period);
      finals.push(...full.measured);
      process.env.SPENDWATCH_CONFIG = mac.config;
      const watched = reportsFrom(watches.get(mac.name)!, options);
      if (bills(watched) !== bills(full.measured)) failures.push(`mac ${mac.name}: watch bills ${bills(watched)}, a report ${bills(full.measured)} (${bySource(watched)} | ${bySource(full.measured)})`);
      for (const source of ["copilot", "codex"]) {
        const part = readMac(mac, period, new Set([source]));
        const of = (r: Reading): number => r.measured.find((x) => x.source === source)?.apiCalls ?? 0;
        if (of(part) !== of(full)) failures.push(`mac ${mac.name}: --agents ${source} bills ${of(part)}, the full report ${of(full)}`);
      }
    }
    const range = allowed(world, o.macs, lastTick);
    const got = bills(settleAcrossMacs(finals));
    if (got < range.min || got > range.max) failures.push(`final: ${got} bills, expected ${range.min}..${range.max} ${finals.map((r) => `${r.source}:${r.apiCalls}`).join(" ")}`);
    if (o.macs.length === 1) {
      const watched = bills(reportsFrom(watches.get(o.macs[0]!)!, options));
      if (watched < range.min || watched > range.max) failures.push(`final watch: ${watched} bills, expected ${range.min}..${range.max}`);
    }
    return { failures, world: failures.length ? trace(macs, world) : "" };
  } finally {
    setSystemTime();
    for (const mac of macs.values()) rmSync(mac.root, { recursive: true, force: true });
  }
}

const SINGLE: Options = { macs: ["A"], nCalls: 8, shapes: 2, ticks: 8, idlessRemote: false, files: 2, echo: true, extras: true };
const TWO: Options = { macs: ["A", "B"], nCalls: 10, shapes: 2, ticks: 8, idlessRemote: true, files: 2, echo: true, extras: true };

// [name, options, seeds]: the seeds are 1..N, and the same worlds on every run.
const WORLDS: Array<[string, Options, number]> = [
  ["one Mac", SINGLE, 60],
  ["one Mac, counts served by a gateway nobody reads", { ...SINGLE, idlessRemote: true, files: 3 }, 60],
  ["one Mac, crowded", { ...SINGLE, nCalls: 16, ticks: 6, files: 3 }, 40],
  ["one Mac, forked rollout", { ...SINGLE, forks: true }, 60],
  ["two Macs, every row lands", { ...TWO, noNull: true, echo: false }, 40],
  ["two Macs, only records cross", { ...TWO, idlessRemote: false }, 40],
  ["two Macs", TWO, 40],
  ["two Macs, forked rollouts", { ...TWO, idlessRemote: false, forks: true }, 40],
];

describe("every routed call is billed once across Macs", () => {
  for (const [name, options, usual] of WORLDS) {
    test(`${name}: ${usual} seeded worlds, in a report and in watch`, () => {
      const only = onlySeed();
      const seeds = seedCount(usual);
      const bad: Array<{ seed: number; failures: string[]; world: string }> = [];
      for (let seed = only ?? 1; seed <= (only ?? seeds); seed++) {
        const out = run(seed, options);
        if (out.failures.length) bad.push({ seed, ...out });
      }
      if (bad.length) console.log(`${bad.length} failed seeds; first:\n${bad[0]!.world}`);
      expect({ failedSeeds: bad.map((b) => b.seed), first: bad[0]?.failures ?? [] }).toEqual({ failedSeeds: [], first: [] });
    }, 300_000);
  }
});

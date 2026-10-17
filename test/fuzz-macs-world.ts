// The worlds of the multi-Mac gateway fuzz (gateway-fuzz-macs.test.ts): what each Mac's ledger and rollouts hold,
// tick by tick, and what a report or `watch` may show for it.
//
// A call is made by a client Mac and served by a Mac's gateway (the client's own, the other Mac in the set, or one
// nobody reads). The serving Mac appends a row to its ledger some ticks later, or never, and the client's Codex writes
// its line some ticks after the call. A call is one of:
//   * record: a marked token_usage_record, which names its row exactly;
//   * count: a bare token_count from an older Codex build, which only model, tokens and time can match to a row;
//   * unmarked: a record from before the gateway kept a ledger, whose only row is the telemetry import of it.
// Tokens come in a few shapes, so alike calls and rows are interchangeable, which is where the matching can go wrong.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { iso } from "./fuzz-world";
import { tempDir } from "./tmp";

export const MODEL = "gpt-5.1-codex";
export const TICK = 5_000;
const CLAIM_MS = 30_000;
/** A row is stamped just after its call, as the gateway stamps it when the response ends. */
const ROW_AFTER_MS = 150;

/** A deterministic random stream in [0, 1), so a seed always makes the same world. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fmt = "record" | "count" | "unmarked";

export interface Call {
  id: string;
  client: string;
  /** The Mac whose ledger gets the row; null when no ledger that is read does. */
  server: string | null;
  fmt: Fmt;
  shape: number;
  lineTick: number;
  rowTick: number | null;
  /** The tick the telemetry echo of the call lands, for a record that was imported before its own row. */
  echo: number | null;
  file: number;
  ts: number;
}

/** A row nobody's rollout accounts for. */
export interface Extra {
  mac: string;
  kind: "gwonly" | "telfalse" | "telorphan";
  id: string;
  tick: number;
  shape: number;
}

/** A fork of a Mac's first rollout: at `tick` it copies the records written so far, under a session of its own. */
export interface Fork {
  mac: string;
  tick: number;
}

export interface Options {
  /** Every row lands within the run; no call is served by a Mac nobody reads. */
  noNull?: boolean;
  macs: string[];
  nCalls: number;
  shapes: number;
  ticks: number;
  /** A count may be served by another Mac, or by none that is read, as when a client uses a remote gateway. */
  idlessRemote: boolean;
  files: number;
  echo: boolean;
  extras: boolean;
  forks?: boolean;
}

export interface World {
  calls: Call[];
  extras: Extra[];
  forks: Fork[];
}

export interface Mac {
  name: string;
  root: string;
  ledger: string;
  /** The first is the records build's rollout, then the token_count build's, then the forks'. */
  rollouts: string[];
  totals: number[];
  config: string;
}

const shapeIn = (shape: number): number => 100 + shape;
const J = (value: unknown): string => JSON.stringify(value) + "\n";

export function makeMac(name: string, start: number, files: number, forks: number): Mac {
  const root = tempDir(`spendwatch-fuzz-${name}-`);
  const sessions = join(root, "codex", "sessions");
  const state = join(root, "state");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(state, "usage"), { recursive: true });
  const ledger = join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`);
  writeFileSync(ledger, "");
  const rollouts = Array.from({ length: files + forks }, (_, k) => join(sessions, `rollout-2026-10-15T10-00-0${k}-${name}aaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${k}.jsonl`));
  rollouts.forEach((path, k) => {
    const own = k < files ? `${name}-s${k}` : `${name}-fork${k}`;
    const meta = (id: string) => J({ timestamp: iso(start - 200_000), type: "session_meta", payload: { id, model_provider: "subscription_gateway" } });
    // A fork copies its parent's session_meta after its own; it describes the parent and must not replace the fork's.
    writeFileSync(path, meta(own) + J({ timestamp: iso(start - 200_000), type: "turn_context", payload: { model: MODEL } }) + (k < files ? "" : meta(`${name}-s0`)));
  });
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "none.db") }, { agent: "claude", path: join(root, "claude") }, { agent: "gateway", path: state }]));
  return { name, root, ledger, rollouts, totals: Array.from({ length: files }, () => 0), config };
}

interface RowSpec { id: string; at: number; shape: number; origin: "gateway" | "telemetry"; session?: boolean }

function rowText(mac: string, spec: RowSpec): string {
  return J({
    v: 1, at: iso(spec.at), host: mac, requestId: spec.id, responseId: spec.origin === "gateway" ? `resp_gl_${spec.id}` : "",
    ...(spec.origin === "gateway" ? { providerType: "copilot-subscription" } : {}), provider: "copilot", model: MODEL, origin: spec.origin,
    ...(spec.session !== undefined ? { session: spec.session } : {}), inputTokens: shapeIn(spec.shape), cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10,
    reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete",
  });
}

function lineText(mac: Mac, call: Call): string {
  const input = shapeIn(call.shape);
  const usage = { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 };
  if (call.fmt === "count") {
    mac.totals[call.file]! += input;
    return J({ timestamp: iso(call.ts), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { input_tokens: mac.totals[call.file], output_tokens: 10 } } } });
  }
  return J({ timestamp: iso(call.ts), type: "token_usage_record", payload: { response_id: call.fmt === "record" ? `resp_gl_${call.id}` : `resp_plain_${call.id}`, usage } });
}

export function generate(seed: number, o: Options, start: number): World {
  const random = mulberry(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const calls: Call[] = [];
  for (let i = 0; i < o.nCalls; i++) {
    const client = pick(o.macs);
    const fmt: Fmt = pick(["record", "record", "count", "count", "unmarked"]);
    // File 0 is the records build's rollout; the token_count build writes the others.
    const file = fmt === "count" ? 1 + Math.floor(random() * (o.files - 1)) : 0;
    const remote = o.macs.length > 1 ? o.macs.find((m) => m !== client)! : null;
    let server: string | null = random() < 0.65 ? client : remote;
    if (server === null && fmt !== "record" && !o.idlessRemote) server = client;
    if (server !== client && fmt !== "record" && !o.idlessRemote) server = client;
    const callTick = 1 + Math.floor(random() * o.ticks);
    const lineLag = pick([0, 0, 0, 0, 1, 3]);
    const rowLag = o.noNull ? pick([0, 0, 0, 1, 2, 5, 7, 12, 40]) : pick([0, 0, 0, 1, 2, 5, 7, 12, 40, null]);
    let lineTick = callTick + lineLag;
    let rowTick: number | null = server === null || rowLag === null ? null : callTick + rowLag;
    let ts = start + callTick * TICK - 400 - Math.floor(random() * 3000);
    if (fmt === "unmarked") { lineTick = 0; ts = start - 5_000 - Math.floor(random() * 90_000); rowTick = server === null ? null : 0; }
    if (rowTick === null && fmt !== "record" && !o.idlessRemote) rowTick = fmt === "unmarked" ? 0 : callTick;
    const echo = o.echo && fmt === "record" && rowTick !== null && random() < 0.2 ? Math.max(callTick, rowTick - Math.floor(random() * 3)) : null;
    calls.push({ id: `c${seed}x${i}`, client, server: rowTick === null ? null : (server ?? client), fmt, shape: Math.floor(random() * o.shapes), lineTick, rowTick, echo, file, ts });
  }
  // A rollout flushes in order: a line is never written before an earlier line of the same file.
  const last = new Map<string, number>();
  for (const call of [...calls].sort((a, b) => a.ts - b.ts)) {
    const key = `${call.client}/${call.file}`;
    call.lineTick = Math.max(call.lineTick, last.get(key) ?? 0);
    last.set(key, call.lineTick);
  }
  const extras: Extra[] = [];
  if (o.extras) {
    for (const mac of o.macs) for (let k = 0; k < 3; k++) {
      extras.push({ mac, kind: pick(["gwonly", "telfalse", "telorphan"]), id: `x${seed}${mac}${k}`, tick: Math.floor(random() * o.ticks), shape: 1000 + k + (mac === "B" ? 50 : 0) });
    }
  }
  // Drawn last, so the worlds of a seed without forks are the same ones as before forks existed.
  const forks: Fork[] = o.forks ? o.macs.map((mac) => ({ mac, tick: 1 + Math.floor(random() * (o.ticks + 2)) })) : [];
  return { calls, extras, forks };
}

/** What lands on disk at `tick`: ledger rows first (the gateway writes just after the response), then rollout lines. */
export function writeTick(macs: Map<string, Mac>, world: World, tick: number): void {
  for (const call of world.calls) {
    const at = call.ts + ROW_AFTER_MS;
    if (call.server && call.echo === tick) appendFileSync(macs.get(call.server)!.ledger, rowText(call.server, { id: call.id, at, shape: call.shape, origin: "telemetry", session: true }));
    if (call.server && call.rowTick === tick) {
      const spec: RowSpec = call.fmt === "unmarked" ? { id: call.id, at, shape: call.shape, origin: "telemetry", session: true } : { id: call.id, at, shape: call.shape, origin: "gateway" };
      appendFileSync(macs.get(call.server)!.ledger, rowText(call.server, spec));
    }
  }
  for (const call of [...world.calls].sort((a, b) => a.ts - b.ts)) {
    if (call.lineTick !== tick) continue;
    const mac = macs.get(call.client)!;
    appendFileSync(mac.rollouts[call.file]!, lineText(mac, call));
  }
  for (const fork of world.forks) {
    if (fork.tick !== tick) continue;
    const mac = macs.get(fork.mac)!;
    const copies = world.calls.filter((c) => c.client === fork.mac && c.fmt === "record" && c.lineTick <= tick).sort((a, b) => a.ts - b.ts);
    appendFileSync(mac.rollouts[mac.rollouts.length - 1]!, copies.map((call) => lineText(mac, call)).join(""));
  }
  for (const extra of world.extras) {
    if (extra.tick !== tick) continue;
    // Stamped at the moment it is written, a few seconds before the clock of the tick.
    const at = Date.now() - 1000;
    const mac = extra.mac;
    appendFileSync(macs.get(mac)!.ledger, extra.kind === "gwonly"
      ? rowText(mac, { id: extra.id, at, shape: extra.shape, origin: "gateway" })
      : rowText(mac, { id: extra.id, at, shape: extra.shape, origin: "telemetry", session: extra.kind === "telfalse" ? false : true }));
  }
}

/**
 * How many bills a Mac set's reports may show once `tick` has been written, by what is on disk then. A call is billed
 * once when a line or a row of it is there. The fuzz allows two residue the matching cannot tell from the call itself
 * (a count carries no id), each only where a count has no row of its own:
 *   - under: such a count can stand on the row of a call whose own line is not read yet (it is written after its row)
 *     or is on another Mac, and the calls standing on rows make room for it by moving, so that call is taken for the
 *     count's. The figure is short by at most the rows the largest matching of counts to rows uses beyond the counts'
 *     own: until the line is read, or for good when it is a record on another Mac that is then taken out;
 *   - over: a count a different Mac in the set served is billed from its own rollout and again by the serving ledger.
 */
export function allowed(world: World, macs: string[], tick: number): { min: number; max: number } {
  const lineThere = (call: Call): boolean => call.lineTick <= tick && macs.includes(call.client);
  const rowThere = (call: Call): boolean => call.rowTick !== null && call.rowTick <= tick && call.server !== null && macs.includes(call.server) && call.fmt !== "unmarked";
  let base = 0;
  let over = 0;
  for (const call of world.calls) {
    if (lineThere(call) || rowThere(call)) base++;
    if (call.fmt === "count" && lineThere(call) && rowThere(call) && call.server !== call.client) over++;
  }
  for (const extra of world.extras) if (extra.tick <= tick && macs.includes(extra.mac) && extra.kind !== "telorphan") base++;
  let under = 0;
  for (const mac of macs) {
    const counts = world.calls.filter((c) => c.fmt === "count" && c.client === mac && lineThere(c));
    // A row a record's own line vouches for is its alone; every other row can be taken by a count of its size and time.
    const rows = world.calls.filter((c) => c.server === mac && rowThere(c) && !(c.fmt === "record" && c.client === mac && lineThere(c)));
    const own = counts.filter((c) => c.server === mac && rowThere(c)).length;
    under += largestMatching(counts, rows, (count, row) => count.shape === row.shape && Math.abs(count.ts - (row.ts + ROW_AFTER_MS)) <= CLAIM_MS) - own;
  }
  return { min: base - under, max: base + over };
}

/** The most pairs that can be made of one from each list, with no call in two. */
function largestMatching<A, B>(left: A[], right: B[], fits: (a: A, b: B) => boolean): number {
  const taken = new Map<B, A>();
  const augment = (a: A, seen: Set<B>): boolean => {
    for (const b of right) {
      if (seen.has(b) || !fits(a, b)) continue;
      seen.add(b);
      const holder = taken.get(b);
      if (holder === undefined || augment(holder, seen)) { taken.set(b, a); return true; }
    }
    return false;
  };
  let size = 0;
  for (const a of left) if (augment(a, new Set())) size++;
  return size;
}

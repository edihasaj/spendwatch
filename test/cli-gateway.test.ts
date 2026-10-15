import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayWorld, iso, line } from "./gateway-world";

// The collector reads `report --months N --json` over SSH, so what that payload keeps is what the archive can ever see.
const ROOT = join(import.meta.dir, "..");

function spawn(args: string[], env: Record<string, string | undefined>): string {
  // The preload's isolation is passed on explicitly: the CLI must not read a gateway installed on this machine either.
  const out = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, SPENDWATCH_GATEWAY_CONFIG: process.env.SPENDWATCH_GATEWAY_CONFIG, ...env },
  });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString();
}

function run(args: string[], env: Record<string, string | undefined>) {
  return JSON.parse(spawn(args, env)) as Array<{ source: string; apiCalls: number; observedCalls?: number; routedCalls?: number; ledger?: boolean; period?: { key: string } }>;
}

describe("report --months N --json", () => {
  test("keeps a month whose every call was routed: it billed nothing here but observed calls", () => {
    // Both rollout turns are the ledger's (one marked, one claimed from telemetry), so Codex bills none of them.
    const world = gatewayWorld();
    const rows = run(["report", "--months", "2", "--json"], { SPENDWATCH_CONFIG: world.config, SPENDWATCH_GATEWAY_SOURCE: undefined, SPENDWATCH_GATEWAY_STATE: undefined });
    const codex = rows.find((r) => r.source === "codex" && r.observedCalls);
    expect(codex).toMatchObject({ apiCalls: 0, observedCalls: 2, routedCalls: 2, ledger: true });
  });
});

describe("report's footnotes", () => {
  /** A subscription_gateway rollout as `rollout` writes it, beside an empty ledger of this Mac. */
  function world(rollout: (now: number) => string): string {
    const root = mkdtempSync(join(tmpdir(), "spendwatch-cli-notes-"));
    const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
    mkdirSync(sessions, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
    writeFileSync(join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), rollout(Date.now()));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify([{ agent: "codex", path: sessions }, { agent: "gateway", path: state }]));
    return config;
  }
  const meta = (at: number) => line({ timestamp: iso(at), type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway", model: "claude-opus-5-5" } });
  const usage = { input_tokens: 400, cached_input_tokens: 0, output_tokens: 20 };

  test("say how a token_count-only routed rollout was counted, though Codex reported calls", () => {
    const config = world((now) => meta(now - 60_000)
      + line({ timestamp: iso(now - 30_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }));
    const out = spawn(["report", "--days", "2", "--agent", "codex"], { SPENDWATCH_CONFIG: config });
    expect(out).toContain("codex: gateway-routed rollouts recorded token_count without token_usage_record");
  });

  test("say which routed calls no ledger here vouches for", () => {
    const config = world((now) => meta(now - 60_000)
      + line({ timestamp: iso(now - 30_000), type: "token_usage_record", payload: { response_id: "resp_gl_remote", usage } }));
    const out = spawn(["report", "--days", "2", "--agent", "codex"], { SPENDWATCH_CONFIG: config });
    expect(out).toContain("claude-opus-5-5 (gateway-routed, not in this Mac's ledger)");
    expect(out).toContain("codex: some gateway-routed calls in these rollouts had no row in this Mac's gateway ledger");
  });
});

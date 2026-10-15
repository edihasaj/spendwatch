import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gatewayWorld } from "./gateway-world";

// The collector reads `report --months N --json` over SSH, so what that payload keeps is what the archive can ever see.
const ROOT = join(import.meta.dir, "..");

function run(args: string[], env: Record<string, string | undefined>) {
  const out = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), ...args], { cwd: ROOT, env: { ...process.env, ...env } });
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout.toString()) as Array<{ source: string; apiCalls: number; observedCalls?: number; ledger?: boolean; period?: { key: string } }>;
}

describe("report --months N --json", () => {
  test("keeps a month whose every call was routed: it billed nothing here but observed calls", () => {
    // Both rollout turns are the ledger's (one marked, one claimed from telemetry), so Codex bills none of them.
    const world = gatewayWorld();
    const rows = run(["report", "--months", "2", "--json"], { SPENDWATCH_CONFIG: world.config, SPENDWATCH_GATEWAY_SOURCE: undefined, SPENDWATCH_GATEWAY_STATE: undefined });
    const codex = rows.find((r) => r.source === "codex" && r.observedCalls);
    expect(codex).toMatchObject({ apiCalls: 0, observedCalls: 2, ledger: true });
  });
});

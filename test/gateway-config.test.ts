import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayConfigFile, installedConfigDirectory, readGatewayConfig, resolveStateDirectory } from "../src/gateway-config";
import { withEnv } from "./ledger-fixtures";

// What Spendwatch reads from the gateway's own config, and what it never does.

describe("the test environment", () => {
  test("never reads a gateway installed on the machine running the tests", () => {
    // A Mac with a gateway installed would otherwise lend its providers and ledger to every test. The preload in
    // bunfig.toml does this, not this file: importing it here would make the test pass without it.
    expect(gatewayConfigFile()).not.toBe(join(installedConfigDirectory(), "gateway.json"));
    expect(readGatewayConfig().found).toBe(false);
    expect(process.env.SPENDWATCH_GATEWAY_STATE).toBeUndefined();
  });
});

describe("the gateway config file", () => {
  test("is the installed one unless SPENDWATCH_GATEWAY_CONFIG names another; the gateway's GATEWAY_CONFIG is ignored", () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), "spendwatch-dev-gateway-")), "gateway.json");
    const installed = join(installedConfigDirectory(), "gateway.json");
    expect(withEnv({ SPENDWATCH_GATEWAY_CONFIG: undefined, GATEWAY_CONFIG: elsewhere }, () => gatewayConfigFile())).toBe(installed);
    expect(withEnv({ SPENDWATCH_GATEWAY_CONFIG: elsewhere, GATEWAY_CONFIG: undefined }, () => gatewayConfigFile())).toBe(elsewhere);
  });

  test("expands a leading ~ in SPENDWATCH_GATEWAY_CONFIG and SPENDWATCH_GATEWAY_STATE", () => {
    expect(withEnv({ SPENDWATCH_GATEWAY_CONFIG: "~/gw/gateway.json" }, () => gatewayConfigFile())).toBe(join(homedir(), "gw", "gateway.json"));
    const none = { directory: "/nowhere", found: false, stateDirectory: "", authDirectories: new Map() };
    expect(withEnv({ SPENDWATCH_GATEWAY_STATE: "~/gw-state" }, () => resolveStateDirectory(none))).toBe(join(homedir(), "gw-state"));
  });
});

describe("the ledger home without a gateway config", () => {
  test("is the `state` directory beside where the config would be, only when that directory exists", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-unconfigured-")));
    const view = withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(dir, "gateway.json") }, () => readGatewayConfig());
    expect(view.found).toBe(false);
    expect(resolveStateDirectory(view)).toBeUndefined();
    mkdirSync(join(dir, "state"));
    expect(resolveStateDirectory(view)).toBe(join(dir, "state"));
  });
});

describe("provider logins", () => {
  test("are read for Claude and Copilot subscriptions only, resolved against the config directory", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-providers-")));
    writeFileSync(join(dir, "gateway.json"), JSON.stringify({ version: 1, providers: [
      { id: "claude-work", type: "claude-subscription", authDirectory: "claude-work" },
      { id: "copilot-work", type: "copilot-subscription", authDirectory: "/abs/copilot-work" },
      // Neither is billed through this ledger, so neither names an account here.
      { id: "codex", type: "codex-subscription", authDirectory: "codex-home" },
      { id: "anthropic", type: "anthropic-api", authDirectory: "anthropic" },
      { id: "plain", type: "claude-subscription" },
      { id: "odd", type: "toString", authDirectory: "odd" },
    ] }));
    const view = withEnv({ SPENDWATCH_GATEWAY_CONFIG: join(dir, "gateway.json") }, () => readGatewayConfig());
    expect(Object.fromEntries(view.authDirectories)).toEqual({
      "claude-work": { vendor: "claude", directory: join(dir, "claude-work") },
      "copilot-work": { vendor: "copilot", directory: "/abs/copilot-work" },
    });
  });
});

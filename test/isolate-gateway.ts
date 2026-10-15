// Loaded before every test file (bunfig.toml). Spendwatch reads the gateway config installed on the machine
// whenever SPENDWATCH_GATEWAY_CONFIG is unset, so without this a Mac whose gateway gives a provider its own
// authDirectory, or a shell that exports a gateway variable, would turn the suite red. Each test that needs a
// gateway builds its own and names it explicitly.
import { afterAll } from "bun:test";
import { join } from "node:path";
import { removeTempDirs, tempDir } from "./tmp";

/** A gateway config path that never exists: the default for every test and for every CLI a test spawns. */
export const NO_GATEWAY_CONFIG = join(tempDir("spendwatch-no-gateway-"), "gateway.json");

process.env.SPENDWATCH_GATEWAY_CONFIG = NO_GATEWAY_CONFIG;
// Account labels come from the signed-in logins in the home directory (~/.claude.json, ~/.config/gh/hosts.yml), which
// bun resolves once at start, so a test cannot move them. Naming the accounts here keeps every test off those files.
process.env.SPENDWATCH_CLAUDE_ACCOUNT = "test-claude@example.com";
process.env.SPENDWATCH_COPILOT_ACCOUNT = "test-copilot";
for (const key of ["SPENDWATCH_GATEWAY_STATE", "SPENDWATCH_GATEWAY_SOURCE", "SPENDWATCH_GATEWAY_PROVIDER_MAP"]) delete process.env[key];

// In a preload, afterAll runs once after the last test file: every directory the tests made goes then.
afterAll(removeTempDirs);

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
for (const key of ["SPENDWATCH_GATEWAY_STATE", "SPENDWATCH_GATEWAY_SOURCE", "SPENDWATCH_GATEWAY_PROVIDER_MAP"]) delete process.env[key];

// In a preload, afterAll runs once after the last test file: every directory the tests made goes then.
afterAll(removeTempDirs);

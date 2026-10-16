// Only the explicitly configured server database can use PostgreSQL.
// The default CLI and provider-owned SQLite caches keep Bun's native driver.
import { Database as NativeDatabase } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ManagedPostgresDatabase } from "./managed/postgres-db";

interface ManagedConfiguration {
  path: string;
  connection: Record<string, string>;
  localFixture?: boolean;
  mode?: "staging" | "production";
}
let cached: { filename: string; value: ManagedConfiguration } | undefined;
function configuration(): ManagedConfiguration | undefined {
  const filename = process.env.SPENDWATCH_MANAGED_DATABASE_CONFIG;
  if (!filename) return undefined;
  if (cached?.filename === filename) return cached.value;
  const value = JSON.parse(readFileSync(filename, "utf8")) as ManagedConfiguration;
  if (!value || typeof value.path !== "string" || !value.connection ||
      !Object.values(value.connection).every((item) => typeof item === "string")) {
    throw new Error("Managed database configuration is incomplete");
  }
  const test = value.localFixture === true && value.connection.host === "127.0.0.1" &&
    (!value.connection.hostaddr || value.connection.hostaddr === "127.0.0.1") &&
    value.connection.port === "15487" && (value.connection.dbname === "postgres" ||
      /^spendwatch_test_[a-z0-9_]+$/.test(value.connection.dbname ?? ""));
  if (!test && (value.connection.sslmode !== "verify-full" ||
      !value.connection.sslrootcert || !value.connection.sslcert || !value.connection.sslkey)) {
    throw new Error("Managed PostgreSQL requires verified mutual TLS");
  }
  if (!test && value.mode !== "staging" && value.mode !== "production") {
    throw new Error("Managed deployment mode is missing");
  }
  if (test && !value.mode) value.mode = "staging";
  cached = { filename, value };
  return value;
}
export function isManagedDatabase(path: string): boolean {
  const config = configuration();
  return Boolean(config && resolve(path) === resolve(config.path));
}
export function databaseExists(path: string): boolean {
  return isManagedDatabase(path) || existsSync(path);
}
export function managedDeploymentMode(): "staging" | "production" | undefined {
  return configuration()?.mode;
}

// The proxy retains native static methods. The managed object implements only
// the subset used by the server; unsupported filesystem operations fail explicitly.
export const Database: typeof NativeDatabase = new Proxy(NativeDatabase, {
  construct(target, args) {
    const path = args[0];
    if (typeof path !== "string" || !isManagedDatabase(path)) return Reflect.construct(target, args);
    const config = configuration()!;
    return new ManagedPostgresDatabase(config.connection, {
      ...(args[1] ?? {}), job: process.env.SPENDWATCH_MANAGED_JOB === "1",
    });
  },
});
export type Database = NativeDatabase;

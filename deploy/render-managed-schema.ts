import { readFileSync } from "node:fs";
import { translateSql } from "../src/managed/pg-sql";
import { COMPATIBILITY_CATALOG, COMPATIBILITY_FUNCTION } from "../src/managed/postgres-db";

interface Manifest {
  schema: [string, string, string, string][];
  source_database_sha256: string;
}
const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Manifest;
if (!/^[a-f0-9]{64}$/.test(manifest.source_database_sha256)) throw new Error("Invalid admitted snapshot");
const statements = { tables: [] as { name: string; sql: string }[],
  indexes: [] as { name: string; sql: string }[] };
const definitions = new Map(manifest.schema.filter(([kind]) => kind === "table")
  .map(([, name, , sql]) => [name, sql]));
const pending = new Set(definitions.keys()), ordered: string[] = [];
while (pending.size) {
  const before = pending.size;
  for (const name of pending) {
    const references = [...definitions.get(name)!.matchAll(/\bREFERENCES\s+["`[]?([a-z][a-z0-9_]*)/gi)]
      .map((match) => match[1]!);
    if (references.some((parent) => parent !== name && pending.has(parent))) continue;
    ordered.push(name); pending.delete(name);
  }
  if (pending.size === before) throw new Error("Admit cyclic source foreign keys explicitly");
}
for (const [kind, name, , sql] of manifest.schema) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Unexpected source schema identity");
  if (kind !== "table" && kind !== "index") throw new Error("Explicitly admit source views or triggers");
  statements[kind === "table" ? "tables" : "indexes"].push({ name, sql: translateSql(sql).sql });
}
statements.tables.sort((a, b) => ordered.indexOf(a.name) - ordered.indexOf(b.name));
process.stdout.write(JSON.stringify({
  ...statements, compatibility: [COMPATIBILITY_FUNCTION, COMPATIBILITY_CATALOG],
  source_database_sha256: manifest.source_database_sha256,
}));

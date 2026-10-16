import { PgConnection, type PgParameter } from "./libpq";
import { translateSql } from "./pg-sql";
import { quoteIdentifier, sqlStatements, sqlTokens, word } from "./sql-tokens";
import { decodeSampleDetail } from "./codecs";

const initialized = new Set<string>();
export const COMPATIBILITY_FUNCTION = `CREATE OR REPLACE FUNCTION sqlite_nocase(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') $$`;
export const COMPATIBILITY_CATALOG = `CREATE OR REPLACE VIEW sqlite_master AS
SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
 WHEN 'i' THEN 'index' ELSE 'view' END::text AS type,
 c.relname::text AS name, COALESCE(t.relname,c.relname)::text AS tbl_name,
 NULL::bigint AS rootpage, NULL::text AS sql
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid
WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','i','v')
 AND c.relname<>'sqlite_master'`;
const COLUMNS = `SELECT c.column_name AS name,c.is_identity AS identity,
 (quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass::oid AS table_oid,
 c.ordinal_position AS column_number,
 c.ordinal_position-1 AS cid,
 CASE WHEN c.data_type IN ('bigint','integer','smallint') THEN 'INTEGER'
 WHEN c.data_type IN ('real','double precision','numeric') THEN 'REAL'
 WHEN c.data_type='bytea' THEN 'BLOB' ELSE 'TEXT' END AS type,
 CASE WHEN c.is_nullable='NO' THEN 1 ELSE 0 END AS "notnull",
 c.column_default AS dflt_value,COALESCE(k.ordinal_position,0) AS pk
FROM information_schema.columns c
LEFT JOIN information_schema.key_column_usage k
 ON k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name
 AND k.constraint_name IN (SELECT constraint_name FROM information_schema.table_constraints
 WHERE table_schema=current_schema() AND table_name=$1 AND constraint_type='PRIMARY KEY')
WHERE c.table_schema=current_schema() AND c.table_name=$1 ORDER BY c.ordinal_position`;

function compatible(value: unknown, safeIntegers: boolean): unknown {
  if (typeof value === "bigint") return safeIntegers ? value : Number(value);
  if (typeof value === "boolean") return Number(value);
  return value;
}
function parameters(values: unknown[]): PgParameter[] {
  if (values.length === 1 && Array.isArray(values[0])) return parameters(values[0]);
  return values.map((value) => {
    if (value === undefined) return null;
    if (value === null || typeof value === "string" || typeof value === "number" ||
        typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value;
    throw new Error("Unsupported managed database binding");
  });
}

export class ManagedPostgresDatabase {
  private readonly connection: PgConnection;
  private readonly catalog = new Map<string, Record<string, unknown>[]>();
  private sampleOrigin?: { table: number; column: number } | null;
  private depth = 0;
  private ownsWriterLock = false;
  private lastRowid = 0n;
  private lockTimeout = 10_000;
  readonly readonly: boolean;
  readonly safeIntegers: boolean;
  get inTransaction(): boolean { return this.depth > 0; }

  constructor(private readonly options: Record<string, string>, settings: {
    readonly?: boolean; safeIntegers?: boolean; job?: boolean;
  } = {}) {
    this.readonly = Boolean(settings.readonly);
    this.safeIntegers = Boolean(settings.safeIntegers);
    this.connection = new PgConnection(options, settings.job ? 120_000 : 20_000);
    try {
      this.connection.query("SET client_min_messages=warning");
      this.connection.query("SET synchronous_commit=on");
      this.connection.query(settings.job ? "SET statement_timeout='100s'" : "SET statement_timeout='15s'");
      if (settings.job) this.connection.query("SET work_mem='64MB'");
      this.connection.query("SET lock_timeout='10s'");
      this.connection.query("SET idle_in_transaction_session_timeout='15s'");
      const durability = this.connection.query(
        "SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS pages," +
        "current_setting('synchronous_commit') AS commit",
      ).rows[0]!;
      if (durability.fsync !== "on" || durability.pages !== "on" || durability.commit !== "on") {
        throw new Error("Managed database durability has not been admitted");
      }
      const identity = [options.hostaddr ?? options.host, options.port, options.dbname].join("|");
      if (!initialized.has(identity) && !this.readonly) {
        this.connection.query(COMPATIBILITY_FUNCTION);
        this.connection.query(COMPATIBILITY_CATALOG);
        initialized.add(identity);
      }
      if (this.readonly) this.connection.query("SET default_transaction_read_only=on");
    } catch (error) { this.connection.close(); throw error; }
  }

  private columns(table: string): Record<string, unknown>[] {
    let rows = this.catalog.get(table);
    if (!rows) {
      rows = this.connection.query(COLUMNS, [table]).rows;
      this.catalog.set(table, rows);
    }
    return rows;
  }

  private pragma(sql: string): Record<string, unknown>[] | undefined {
    const tokens = sqlTokens(sql);
    if (!word(tokens[0], "PRAGMA")) return undefined;
    const name = tokens[1]?.name?.toLowerCase();
    if (name === "table_info" && tokens[2]?.text === "(" && tokens[3]?.name && tokens[4]?.text === ")") {
      return this.columns(tokens[3].name).map(({ identity, table_oid, column_number, ...column }) =>
        tokens[3]!.name === "samples" && column.name === "detail" ? { ...column, type: "TEXT" } : column);
    }
    const setting = tokens[2]?.text === "=" ? tokens[3]?.text.toUpperCase() : undefined;
    if (name === "journal_mode" && (!setting || setting === "WAL")) return [{ journal_mode: "wal" }];
    if (name === "foreign_keys" && (!setting || setting === "ON" || setting === "1")) return [{ foreign_keys: 1 }];
    if (name === "busy_timeout") {
      if (setting !== undefined) {
        const timeout = Number(setting);
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) throw new Error("Invalid lock timeout");
        this.connection.query("SELECT set_config('lock_timeout',$1,false)", [timeout + "ms"]);
        this.lockTimeout = timeout;
      }
      return [{ timeout: this.lockTimeout }];
    }
    throw new Error("This SQLite operation requires an explicit managed implementation");
  }

  execute(sql: string, input: unknown[], mode: "run" | "rows", safe = this.safeIntegers) {
    const pragma = this.pragma(sql);
    if (pragma) return { rows: pragma, changes: 0, lastInsertRowid: compatible(this.lastRowid, safe) };
    let translated = translateSql(sql), identity: string | undefined;
    if (translated.insertTable) {
      const columns = this.columns(translated.insertTable);
      translated = translateSql(sql, new Set(columns.map((column) => String(column.name))));
      identity = columns.find((column) => column.identity === "YES")?.name as string | undefined;
    }
    if (mode === "run" && identity && !sqlTokens(sql).some((token) => word(token, "RETURNING"))) {
      translated.sql += " RETURNING " + quoteIdentifier(identity);
    }
    const result = this.connection.query(translated.sql, parameters(input));
    if (result.columns.some((column) => column.type === 17)) {
      if (this.sampleOrigin === undefined) {
        const detail = this.columns("samples").find((column) => column.name === "detail" && column.type === "BLOB");
        this.sampleOrigin = detail ? { table: Number(detail.table_oid), column: Number(detail.column_number) } : null;
      }
      if (this.sampleOrigin) {
        for (const column of result.columns) {
          if (column.table === this.sampleOrigin.table && column.column === this.sampleOrigin.column) {
            for (const row of result.rows) row[column.name] = decodeSampleDetail(row[column.name]);
          }
        }
      }
    }
    if (identity && result.rows.length && result.rows[0]![identity] !== undefined) {
      this.lastRowid = BigInt(result.rows[0]![identity] as bigint);
    }
    return {
      rows: result.rows.map((row) => Object.fromEntries(Object.entries(row)
        .map(([name, value]) => [name, compatible(value, safe)]))),
      changes: result.changes, lastInsertRowid: compatible(this.lastRowid, safe),
    };
  }

  prepare<T = Record<string, unknown>>(sql: string): ManagedStatement<T> {
    return new ManagedStatement<T>(this, sql);
  }
  query<T = Record<string, unknown>>(sql: string): ManagedStatement<T> { return this.prepare<T>(sql); }
  run(sql: string, ...values: unknown[]) {
    const { changes, lastInsertRowid } = this.execute(sql, values, "run");
    return { changes, lastInsertRowid };
  }
  storageBytes(): number {
    return Number(this.connection.query("SELECT pg_database_size(current_database()) AS bytes").rows[0]!.bytes);
  }
  compactHistory(): void {
    if (this.readonly || this.inTransaction) throw new Error("Maintenance requires an idle writable connection");
    const maintenance = new PgConnection(this.options, 600_000);
    try {
      maintenance.query("SET statement_timeout='9min'");
      maintenance.query("SET lock_timeout='10s'");
      maintenance.query("SET vacuum_cost_delay='5ms'");
      maintenance.query("VACUUM (ANALYZE) capacity_history,capacity_account_history");
    } finally { maintenance.close(); }
  }
  exec(sql: string): void {
    for (const statement of sqlStatements(sql)) {
      const tokens = sqlTokens(statement);
      if (word(tokens[0], "BEGIN")) this.begin();
      else if (word(tokens[0], "COMMIT") || word(tokens[0], "END")) this.commit();
      else if (word(tokens[0], "ROLLBACK") && tokens.length === 1) this.rollback();
      else this.execute(statement, [], "rows");
      if (word(tokens[0], "CREATE") || word(tokens[0], "ALTER") || word(tokens[0], "DROP")) this.catalog.clear();
      if (word(tokens[0], "CREATE") || word(tokens[0], "ALTER") || word(tokens[0], "DROP")) this.sampleOrigin = undefined;
    }
  }

  begin(): void {
    if (this.depth) {
      this.connection.query("SAVEPOINT spendwatch_nested_" + this.depth);
      this.depth++;
      return;
    }
    // Acquire before BEGIN so the repeatable-read snapshot follows the prior
    // writer's commit. Taking an xact lock inside BEGIN could freeze an older snapshot.
    if (!this.readonly) {
      this.connection.query("SELECT pg_advisory_lock(hashtextextended(current_database(),193764))");
      this.ownsWriterLock = true;
    }
    try {
      this.connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ" + (this.readonly ? " READ ONLY" : ""));
      this.depth = 1;
    } catch (error) { this.unlock(); throw error; }
  }
  private unlock(): void {
    if (!this.ownsWriterLock) return;
    this.ownsWriterLock = false;
    this.connection.query("SELECT pg_advisory_unlock(hashtextextended(current_database(),193764))");
  }
  commit(): void {
    if (!this.depth) throw new Error("No managed transaction is active");
    if (this.depth > 1) {
      this.connection.query("RELEASE SAVEPOINT spendwatch_nested_" + (this.depth - 1));
      this.depth--; return;
    }
    try { this.connection.query("COMMIT"); }
    finally { this.depth = 0; this.unlock(); }
  }
  rollback(): void {
    if (!this.depth) return;
    if (this.depth > 1) {
      const savepoint = "spendwatch_nested_" + (this.depth - 1);
      this.connection.query("ROLLBACK TO SAVEPOINT " + savepoint);
      this.connection.query("RELEASE SAVEPOINT " + savepoint);
      this.depth--; return;
    }
    try { this.connection.query("ROLLBACK"); }
    finally { this.depth = 0; this.unlock(); }
  }
  transaction<A extends unknown[], T>(callback: (...args: A) => T) {
    const wrapped = (...args: A): T => {
      this.begin();
      try {
        const result = callback(...args);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new Error("Managed transactions require a synchronous callback");
        }
        this.commit(); return result;
      } catch (error) {
        try { this.rollback(); } catch { this.close(); }
        throw error;
      }
    };
    return Object.assign(wrapped, { deferred: wrapped, immediate: wrapped, exclusive: wrapped });
  }
  close(): void { this.connection.close(); this.depth = 0; this.ownsWriterLock = false; }
}

export class ManagedStatement<T> {
  private integers: boolean;
  constructor(private readonly database: ManagedPostgresDatabase, private readonly sql: string) {
    this.integers = database.safeIntegers;
  }
  all(...input: unknown[]): T[] { return this.database.execute(this.sql, input, "rows", this.integers).rows as T[]; }
  get(...input: unknown[]): T | null { return this.all(...input)[0] ?? null; }
  run(...input: unknown[]) {
    const { changes, lastInsertRowid } = this.database.execute(this.sql, input, "run", this.integers);
    return { changes, lastInsertRowid };
  }
  *iterate(...input: unknown[]): IterableIterator<T> { yield* this.all(...input); }
  values(...input: unknown[]): unknown[][] {
    return this.all(...input).map((row) => Object.values(row as Record<string, unknown>));
  }
  safeIntegers(enabled = true): this { this.integers = enabled; return this; }
  finalize(): void {}
}

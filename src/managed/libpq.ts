// The dashboard stays synchronous like bun:sqlite. libpq supplies native,
// verified TLS and PostgreSQL's wire protocol; poll bounds every socket wait.
import { createRequire } from "node:module";
import type { Pointer } from "bun:ffi";

const require = createRequire(import.meta.url);
function loadLibraries() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { FFIType: t } = ffi;
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("The managed PostgreSQL server requires Linux or macOS");
  }
  const path = process.env.SPENDWATCH_LIBPQ_PATH ??
    (process.platform === "darwin" ? "/opt/homebrew/opt/libpq/lib/libpq.5.dylib" : "libpq.so.5");
  const pq = ffi.dlopen(path, {
    PQconnectStart: { args: [t.ptr], returns: t.ptr },
    PQconnectPoll: { args: [t.ptr], returns: t.i32 },
    PQstatus: { args: [t.ptr], returns: t.i32 },
    PQsocket: { args: [t.ptr], returns: t.i32 },
    PQsetnonblocking: { args: [t.ptr, t.i32], returns: t.i32 },
    PQsendQueryParams: { args: [t.ptr, t.ptr, t.i32, t.ptr, t.ptr, t.ptr, t.ptr, t.i32], returns: t.i32 },
    PQflush: { args: [t.ptr], returns: t.i32 },
    PQconsumeInput: { args: [t.ptr], returns: t.i32 },
    PQisBusy: { args: [t.ptr], returns: t.i32 },
    PQgetResult: { args: [t.ptr], returns: t.ptr },
    PQresultStatus: { args: [t.ptr], returns: t.i32 },
    PQntuples: { args: [t.ptr], returns: t.i32 },
    PQnfields: { args: [t.ptr], returns: t.i32 },
    PQfname: { args: [t.ptr, t.i32], returns: t.ptr },
    PQftype: { args: [t.ptr, t.i32], returns: t.u32 },
    PQftable: { args: [t.ptr, t.i32], returns: t.u32 },
    PQftablecol: { args: [t.ptr, t.i32], returns: t.i32 },
    PQgetisnull: { args: [t.ptr, t.i32, t.i32], returns: t.i32 },
    PQgetlength: { args: [t.ptr, t.i32, t.i32], returns: t.i32 },
    PQgetvalue: { args: [t.ptr, t.i32, t.i32], returns: t.ptr },
    PQcmdTuples: { args: [t.ptr], returns: t.ptr },
    PQresultErrorField: { args: [t.ptr, t.i32], returns: t.ptr },
    PQclear: { args: [t.ptr], returns: t.void },
    PQfinish: { args: [t.ptr], returns: t.void },
  });
  const system = ffi.dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    poll: { args: [t.ptr, process.platform === "darwin" ? t.u32 : t.u64, t.i32], returns: t.i32 },
  });
  return { ffi, pq: pq.symbols, poll: system.symbols.poll };
}
let loaded: ReturnType<typeof loadLibraries> | undefined;
function library() { return loaded ??= loadLibraries(); }

export class ManagedDatabaseError extends Error {
  constructor(readonly code: string, readonly transport = false) {
    // Server DETAIL and bound data may contain private account information.
    super(`Managed database operation failed (${code})`);
    this.name = "ManagedDatabaseError";
  }
}
export interface PgResult {
  rows: Record<string, unknown>[];
  changes: number;
  columns: { name: string; type: number; table: number; column: number }[];
}
export type PgParameter = string | number | bigint | boolean | Uint8Array | null;

function cString(value: string): Buffer {
  if (value.includes("\0")) throw new Error("PostgreSQL text cannot contain NUL bytes");
  return Buffer.from(value + "\0", "utf8");
}
function connectionString(options: Record<string, string>): Buffer {
  return cString(Object.entries(options).map(([key, value]) => {
    if (!/^[a-z_]+$/.test(key)) throw new Error("Invalid libpq option");
    if (value.includes("\0")) throw new Error("Invalid libpq value");
    return key + "='" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  }).join(" "));
}

export class PgConnection {
  private connection: Pointer | null = null;
  private readonly api = library();

  constructor(options: Record<string, string>, private readonly timeoutMs = 20_000) {
    const input = connectionString(options);
    this.connection = this.api.pq.PQconnectStart(this.api.ffi.ptr(input));
    if (!this.connection) throw new ManagedDatabaseError("08001", true);
    const deadline = performance.now() + 5_000;
    try {
      for (;;) {
        const state = this.api.pq.PQconnectPoll(this.connection);
        if (state === 3) break;
        if (state !== 1 && state !== 2) throw new ManagedDatabaseError("08001", true);
        this.wait(state === 1 ? 1 : 4, deadline);
      }
      if (this.api.pq.PQstatus(this.connection) !== 0 ||
          this.api.pq.PQsetnonblocking(this.connection, 1) !== 0) {
        throw new ManagedDatabaseError("08001", true);
      }
    } catch (error) { this.close(); throw error; }
    // Keep the connect option memory alive through the native start call.
    void input.byteLength;
  }

  private wait(events: number, deadline: number): void {
    const connection = this.connection;
    if (!connection) throw new ManagedDatabaseError("08003", true);
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new ManagedDatabaseError("57014", true);
    const descriptor = new ArrayBuffer(8), view = new DataView(descriptor);
    const fd = this.api.pq.PQsocket(connection);
    if (fd < 0) throw new ManagedDatabaseError("08006", true);
    view.setInt32(0, fd, true);
    view.setInt16(4, events, true);
    const result = this.api.poll(this.api.ffi.ptr(new Uint8Array(descriptor)), 1, Math.min(remaining, 1_000));
    if (result < 0) throw new ManagedDatabaseError("08006", true);
    if (view.getInt16(6, true) & 0x20) throw new ManagedDatabaseError("08006", true);
  }

  private text(pointer: Pointer | null, length?: number): string {
    if (length === 0) return "";
    return pointer ? String(new this.api.ffi.CString(pointer, 0, length)) : "";
  }

  private decode(value: string, type: number): unknown {
    if (type === 20) return BigInt(value);
    if ([21, 23, 26, 700, 701, 1700].includes(type)) return Number(value);
    if (type === 16) return value === "t";
    if (type === 17) {
      if (!value.startsWith("\\x")) throw new Error("Unexpected PostgreSQL bytea encoding");
      return Buffer.from(value.slice(2), "hex");
    }
    return value;
  }

  query(sql: string, parameters: readonly PgParameter[] = []): PgResult {
    if (!this.connection) throw new ManagedDatabaseError("08003", true);
    const { ffi, pq } = this.api, connection = this.connection;
    const statement = cString(sql), count = parameters.length;
    const values = new BigUint64Array(count), lengths = new Int32Array(count);
    const formats = new Int32Array(count), types = new Uint32Array(count);
    const memory: Buffer[] = [];
    parameters.forEach((value, index) => {
      if (value === null) return;
      let buffer: Buffer;
      if (value instanceof Uint8Array) {
        buffer = Buffer.from(value);
        // Even an empty bytea parameter needs a non-null pointer.
        if (!buffer.length) buffer = Buffer.alloc(1);
        lengths[index] = value.byteLength; formats[index] = 1; types[index] = 17;
      } else {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error("Non-finite database parameter");
        }
        buffer = cString(typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      }
      memory.push(buffer);
      values[index] = BigInt(ffi.ptr(buffer));
    });
    const deadline = performance.now() + this.timeoutMs;
    try {
      if (pq.PQsendQueryParams(connection, ffi.ptr(statement), count,
          count ? ffi.ptr(types) : null, count ? ffi.ptr(values) : null,
          count ? ffi.ptr(lengths) : null, count ? ffi.ptr(formats) : null, 0) !== 1) {
        throw new ManagedDatabaseError("08006", true);
      }
      for (;;) {
        const pending = pq.PQflush(connection);
        if (pending === 0) break;
        if (pending < 0) throw new ManagedDatabaseError("08006", true);
        this.wait(4, deadline);
      }
      let result: PgResult = { rows: [], changes: 0, columns: [] };
      let failure: ManagedDatabaseError | undefined;
      for (;;) {
        while (pq.PQisBusy(connection)) {
          this.wait(1, deadline);
          if (pq.PQconsumeInput(connection) !== 1) throw new ManagedDatabaseError("08006", true);
        }
        const native = pq.PQgetResult(connection);
        if (!native) break;
        try {
          const status = pq.PQresultStatus(native);
          if (status !== 1 && status !== 2) {
            failure = new ManagedDatabaseError(this.text(pq.PQresultErrorField(native, 67)) || "XX000");
            continue;
          }
          const columns = Array.from({ length: pq.PQnfields(native) }, (_, index) => ({
            name: this.text(pq.PQfname(native, index)), type: pq.PQftype(native, index),
            table: pq.PQftable(native, index), column: pq.PQftablecol(native, index),
          }));
          const rows = Array.from({ length: pq.PQntuples(native) }, (_, row) =>
            Object.fromEntries(columns.map((column, index) => [column.name,
              pq.PQgetisnull(native, row, index) ? null :
                this.decode(this.text(pq.PQgetvalue(native, row, index),
                  pq.PQgetlength(native, row, index)), column.type),
            ])));
          const affected = this.text(pq.PQcmdTuples(native));
          result = { rows, changes: affected ? Number(affected) : 0, columns };
        } finally { pq.PQclear(native); }
      }
      // Native parameter memory cannot be reclaimed before libpq has consumed it.
      void memory.length; void statement.byteLength;
      if (failure) throw failure;
      return result;
    } catch (error) {
      if (!(error instanceof ManagedDatabaseError) || error.transport) this.close();
      throw error;
    }
  }

  close(): void {
    if (this.connection) this.api.pq.PQfinish(this.connection);
    this.connection = null;
  }
}

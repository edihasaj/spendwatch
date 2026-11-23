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
    // Read only to classify a failed connect. Its text is never stored, thrown,
    // logged or reported: it names the host and can quote the user.
    PQerrorMessage: { args: [t.ptr], returns: t.ptr },
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
  /**
   * `transport` keeps its upstream meaning: the socket could not be opened or died, so a
   * long-lived holder must discard this connection (`isDeadConnectionError` in the push
   * and poll stores). `transient` is deliberately narrower and affirmative: the managed
   * archive is known to be briefly unreachable and a later run may simply retry. It is
   * set only where a typed failure or libpq's own bounded diagnostic proves a socket-level
   * loss — never by default — so a wrong password, an unverified certificate, a refused
   * SSL policy or an unresolved host stays an ordinary reported configuration error.
   */
  constructor(readonly code: string, readonly transport = false, readonly transient = false) {
    // Server DETAIL and bound data may contain private account information.
    super(`Managed database operation failed (${code})`);
    this.name = "ManagedDatabaseError";
  }
}

/**
 * The reasons libpq reports when the peer is unreachable at the socket level before any
 * protocol state is reached. Each is the whole reason on the location line, matched
 * exactly: the bare errno when nothing ever answered the connect, and the two socket
 * forms libpq reports when the listener disappeared mid-handshake — which is what a
 * restarting or dying archive looks like. Anything else, and in particular a
 * server-side rejection — `FATAL: password authentication failed for user`,
 * `fe_sendauth: no password supplied`, `server does not support SSL, but SSL was
 * required`, a certificate verification failure or an untranslated host — is not a
 * transport death and stays a reported failure.
 */
const REFUSAL_DIAGNOSTICS = [
  "connection refused", "connection reset by peer",
  "could not connect to server: connection refused",
  "could not connect to server: connection reset by peer",
  "could not receive data from server: connection refused",
  "could not receive data from server: connection reset by peer",
] as const;
/** The one explanatory line libpq may add beneath a bare refusal, and nothing else. */
const REFUSAL_HINT = "is the server running on that host and accepting tcp/ip connections?";
/** Anything longer is ambiguous, so it is discarded rather than matched at all. */
const MAX_DIAGNOSTIC_CHARACTERS = 512;

/**
 * True only when libpq's own diagnostic is exactly a refusal or reset against `location`,
 * which the caller pins to this connection's single configured endpoint. `diagnostic` is
 * raw driver text: callers may derive a boolean from it and must then discard it, never
 * store, print or report it.
 */
export function isRefusalDiagnostic(diagnostic: string, location: string): boolean {
  if (!diagnostic || diagnostic.length > MAX_DIAGNOSTIC_CHARACTERS) return false;
  const lines = diagnostic.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
  const first = lines.shift();
  if (!first) return false;
  const head = location.trim().toLowerCase();
  if (!head || !first.startsWith(head)) return false;
  // Only the canonical trailing explanation may follow. A second, different line means the
  // driver reported more than one thing, which is ambiguous and stays a reported failure.
  if (lines.length > 1 || (lines.length === 1 && lines[0] !== REFUSAL_HINT)) return false;
  const reason = first.slice(head.length).trim();
  return (REFUSAL_DIAGNOSTICS as readonly string[]).includes(reason);
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
    // libpq names the endpoint it tried on the first line of the diagnostic. Pinning the
    // configured host and port here means only a refusal against this command's own
    // managed archive can classify, never text about some other address.
    const location = `connection to server at "${options.host ?? ""}", port ${options.port ?? ""} failed:`;
    this.connection = this.api.pq.PQconnectStart(this.api.ffi.ptr(input));
    if (!this.connection) throw new ManagedDatabaseError("08001", true);
    const deadline = performance.now() + 5_000;
    try {
      for (;;) {
        const state = this.api.pq.PQconnectPoll(this.connection);
        if (state === 3) break;
        // `PQconnectPoll` reports every connect-phase failure the same generic way, so
        // only libpq's own diagnostic can tell a dead archive from a bad credential.
        if (state !== 1 && state !== 2) throw new ManagedDatabaseError("08001", true, this.refusedToConnect(location));
        this.wait(state === 1 ? 1 : 4, deadline);
      }
      if (this.api.pq.PQstatus(this.connection) !== 0 ||
          this.api.pq.PQsetnonblocking(this.connection, 1) !== 0) {
        throw new ManagedDatabaseError("08001", true, this.refusedToConnect(location));
      }
    } catch (error) { this.close(); throw error; }
    // Keep the connect option memory alive through the native start call.
    void input.byteLength;
  }

  /**
   * One read of libpq's connect diagnostic as its documented NUL-terminated C string, so
   * no readable buffer length is ever assumed; the decoded string is then length-checked
   * before any parsing. It returns a boolean: the diagnostic text is dropped here and
   * never leaves this file.
   */
  private refusedToConnect(location: string): boolean {
    const connection = this.connection;
    if (!connection) return false;
    const pointer = this.api.pq.PQerrorMessage(connection);
    if (!pointer) return false;
    return isRefusalDiagnostic(String(new this.api.ffi.CString(pointer)), location);
  }

  private wait(events: number, deadline: number): void {
    const connection = this.connection;
    if (!connection) throw new ManagedDatabaseError("08003", true);
    const remaining = Math.ceil(deadline - performance.now());
    // The bounded socket wait elapsed: the peer is not answering within the window the
    // caller allowed. Retryable by definition, and typed without consulting any driver text.
    if (remaining <= 0) throw new ManagedDatabaseError("57014", true, true);
    const descriptor = new ArrayBuffer(8), view = new DataView(descriptor);
    const fd = this.api.pq.PQsocket(connection);
    if (fd < 0) throw new ManagedDatabaseError("08006", true);
    view.setInt32(0, fd, true);
    view.setInt16(4, events, true);
    const result = this.api.poll(this.api.ffi.ptr(new Uint8Array(descriptor)), 1, Math.min(remaining, 1_000));
    // A failed `poll` call or an invalid descriptor is an error in our own wait, not
    // proof the archive is down, so it discards the connection without claiming retry.
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
        throw new ManagedDatabaseError("08006", true, true);
      }
      for (;;) {
        const pending = pq.PQflush(connection);
        if (pending === 0) break;
        if (pending < 0) throw new ManagedDatabaseError("08006", true, true);
        this.wait(4, deadline);
      }
      let result: PgResult = { rows: [], changes: 0, columns: [] };
      let failure: ManagedDatabaseError | undefined;
      for (;;) {
        while (pq.PQisBusy(connection)) {
          this.wait(1, deadline);
          if (pq.PQconsumeInput(connection) !== 1) throw new ManagedDatabaseError("08006", true, true);
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

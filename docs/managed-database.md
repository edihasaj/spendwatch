---
summary: Qualify Spendwatch's optional managed PostgreSQL backend while keeping the local CLI on native SQLite.
read_when:
  - Moving the private Spendwatch server to disposable Cloudflare Containers.
  - Changing managed SQL transport, import, archive durability or transaction behavior.
---

# Managed database conversion

Production still uses its existing SQLite database on `ops-eu`. This worktree
contains preparation only. Do not stop that source or publish a candidate
until copied-state staging, uploads, private ingress, notifications and
independent recovery have passed.

The ordinary CLI must retain native `bun:sqlite`, including its self-contained
build and local history archives. The managed server will select PostgreSQL
only for its exact configured application database path. Other local SQLite
files, including provider caches and independently restored archives, retain
their existing behavior.

The native libpq transport uses Bun FFI and PostgreSQL's verified TLS protocol.
Socket polling bounds connect and query waits. Parameters use libpq bindings,
with binary transport for blobs and explicit signed 64-bit result decoding.
It never automatically retries a statement after an uncertain transport
failure. A separate supervised controller must terminate the Bun process
after loss of database authority.

The current isolated transport fixture is loopback-only PostgreSQL on 15487.
Its random credential stays outside Git. Run its regressions with
`SPENDWATCH_TEST_PG_CONFIG=<owner-only-config> bun test test/managed-libpq.test.ts`.
Ordinary `bun test` skips that fixture. These tests cover binary/Unicode
fidelity, both signed integer limits, parameter binding, constraint rollback
and bounded connection failure.

The libSQL alternative was investigated using its maintained native Bun
driver. It preserved blobs, integers and rollback but rejected the attached
database and maintenance operations used by the existing archive path.
Its remote interface also rejected changing the reported synchronization and
lock-wait settings. It has not been admitted as this application's destination.

The compatibility layer is limited to Spendwatch's admitted SQL. It keeps
ASCII-only NOCASE comparisons, returned column aliases, positional bindings,
conflict handling and scalar MIN/MAX NULL behavior. A session writer lock is
acquired before opening a repeatable-read transaction, so waiting writers do
not inherit an older snapshot. Nested transactions use savepoints. Runtime
connections verify PostgreSQL fsync, full-page writes and synchronous commit.

Managed archives retain the existing readable SQLite archive format. A
repeatable-read export writes bounded batches into a local scratch archive,
then records typed row fingerprints. Compression is independently restored
and checked. Before pruning, the configured loopback supervisor must confirm
a complete, independently read-back off-machine copy. The live values are
fingerprinted again inside the deleting transaction; any changed value or
new old-history row rolls deletion back. Missing archive transport fails
before pruning. PostgreSQL maintenance reuses freed pages and reports actual
database size; it does not promise SQLite's file-rewrite behavior.

The supervisor archive protocol is an authenticated PUT of the gzip bytes to
`SPENDWATCH_ARCHIVE_COMMIT_URL`, restricted to HTTP loopback. Its separate
capability is `SPENDWATCH_ARCHIVE_COMMIT_TOKEN`. The response must contain
`durable: true`, the exact byte count and SHA-256 after independent storage
readback. This protocol is tested with an isolated local supervisor;
production R2 implementation and provider verification remain admission gates.

Existing uncommitted shared-polling changes were copied into the isolated
candidate without editing the primary checkout. The source admission lists
which files match the current serving code. The baseline native suite passed
before backend changes; managed tests compare real business outputs against
native SQLite using separate loopback PostgreSQL databases.

Normalized report snapshots may receive a managed-only SHA-256 idempotency
key. Their receipt and all normalized rows commit in one transaction; retrying
the same input returns the original snapshot. The ordinary local CLI still
appends snapshots. Managed leaf inserts are sent in bounded batches, with
actual affected-row checks before the receipt commits.

The source installation selected for legacy reports is ordered by its stable
original archive label, rather than SQLite's private rowid. All valid source
installation groups have one original unsuffixed label; migration admission
checks that invariant. Native and managed tests cover resets and partial rereads.
The daily/monthly token summary and quota burn paths use the same database
factory as the server. Staging explicitly disables observation and every Web
Push send path, while preserving notification configuration in its isolated copy.

The representative import found a legacy NUL byte in `samples.detail`.
That logical text field uses PostgreSQL BYTEA with a type tag: zero for UTF-8
text and one for historical binary values. Text is decoded with strict UTF-8;
NUL and original blob/text distinctions survive exactly. Result-origin
metadata handles aliased reads. The importer fingerprints decoded logical
values against SQLite and normalized snapshot writes apply the same codec.

The isolated offsite qualification is `deploy/qualify-managed-archive.ts`.
It admits only the loopback test cluster on port 15487 and a loopback supervisor.
The private manager supervisor stores the native archive in staging R2, reads
it back independently, and only then confirms durability. Qualification proved
pruning two window rows and one account row, restoring from actual downloaded
R2 bytes, and a second restore writing zero rows. It does not mutate a serving
database or contact a quota provider.

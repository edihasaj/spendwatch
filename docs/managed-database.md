---
summary: Qualify Spendwatch's optional managed PostgreSQL backend while keeping the local CLI on native SQLite.
read_when:
  - Moving the private Spendwatch server to disposable Cloudflare Containers.
  - Changing managed SQL transport, import, archive durability or transaction behavior.
---

# Managed database conversion

Managed read-only report readers can reuse a disposable binary cache under
`SPENDWATCH_SERVER_ROOT/.report-read-cache`. Only four explicit deterministic
archive queries qualify. Every access still checks the original projection's
database permissions and result types, then reads row-version metadata from
PostgreSQL in the same repeatable-read snapshot as a cold fetch. Inserts,
updates, deletes, table/database recreation, server recovery and transaction-ID
epochs invalidate saved results. A database failure never serves a stale file.

The private, checksummed files retain the complete result, including signed
64-bit values. Missing or corrupt files cause a fresh database read. They are
bounded to one current file per query/identity and are not application state,
recovery archives or a replacement for PostgreSQL. Native SQLite, writers,
parameterized reads and all other queries keep their existing behavior.
File loading and persistence run outside the database transaction so slow
container disks or CPU limits cannot consume its idle timeout. Readers already
inside a caller-owned transaction bypass the optional cache.

The managed reader sends fixed timeout, durability and read-only settings in
the PostgreSQL startup packet, then independently verifies durability. Capacity
renders batch all live account/window burn reads into one query. Stale readings
still age on every render and need no burn-history connection. Forecasts retain
case-insensitive account matching, provider/window separation and per-sample
maximum aggregation across devices.
The managed capacity renderer retains one read-only connection for at most five
minutes. It runs fresh queries on each render, discards a failed socket without
replaying the read, and reconnects on the next request. Native CLI reads retain
their existing connection lifecycle.

Production serves from this managed build on Cloudflare EU since the cutover
recorded in the manager repository's Spendwatch Cloudflare operations runbook;
the source SQLite writers on `ops-eu` are stopped. Publish a candidate only
through that runbook's reviewed release, staging first.

The gateway usage ledger adds three nullable INTEGER columns, `observed_calls`,
`ledger` and `routed_calls`, to `spend_month` and `spend_report`.
`addArchiveColumns` adds a missing one with `ALTER TABLE` the first time a
writer opens the archive, so the managed database migrates on its first write
after a release that brings them. That migration needs the owner's approval;
the application role must own both tables, and the `ALTER` briefly takes an
exclusive table lock bounded by the managed lock timeout. Two writers that
migrate at the same time are tolerated: the second re-reads the columns after
its `ALTER` fails, and the managed layer drops its cached column lists after
any DDL statement, failed or not. `test/managed-gateway-archive.test.ts` holds
the month take-over, a refused take-over, an archive from before the columns
and the concurrent migration to identical results on both engines.

The long-running server holds its alert push store and its quota poll store
through `ReconnectingPushStore` and `ReconnectingPollStore`. The managed layer
closes a connection after a transport error and never reopens it, so each
holder discards its store and opens a fresh one on the next call; the failed
statement is never replayed. The push store reconnects only when
`isDeadConnectionError` is true (a `ManagedDatabaseError` with `transport`), so
ordinary failures do not reopen the connection every monitor tick. Native
SQLite never matches that check.

The capacity monitor on that server reports per failure episode, not per tick. Before, any
failure outside native SQLite's `database is locked` produced a `spendwatch.monitor.failure`
report and a stderr line on every poll, and the SQLite rule itself went permanently silent
after its fourth consecutive poll. Now the first failure of a
tick stage reports once, a contended failure — native `database is locked`/`is busy` or the
managed backend's `55P03` — waits for the fourth consecutive contended poll in that stage,
and an episode that is still failing emits one reminder per 30 minutes rather than nothing.
A tick that completes its own work ends the episode, so the next occurrence is reported again;
a process restart begins a fresh episode. Nothing is retried or replayed: the failed statement
is still never re-run on the dead connection, the next tick issues it again, and
`ReconnectingPushStore` still discards and reopens only on a transport death.

What a report and the log line may carry is bounded to a failure identity: the fixed stage
(`load-capacity`, `observe` or `pending-deliveries`), a category from a closed list, and an
exact five-character SQLSTATE or fixed errno name. Error messages, file paths, endpoints and
driver diagnostics are matched against fixed patterns and discarded, so the recurring
`ManagedDatabaseError` is now diagnosable from its code without any of its text being sent.

`observe` is where managed contention is expected. `PushStore.observe` takes the shared
per-database advisory lock with `pg_try_advisory_lock` before `BEGIN`: when another managed
writer holds it, it defers with no transaction, no mutation and no replay, and throws a typed
`ManagedDatabaseError('55P03')` that the next tick simply tries again. So a `55P03` at
`observe` means the monitor was locked out by that writer — which specific lock is still
suspected until timestamps are matched. A `55P03` at another stage, or outside the defer path,
is PostgreSQL's own `lock_not_available` from a genuine lock wait. Both are contention and
share the fourth-consecutive-poll gate; an ordinary managed failure keeps its immediate first
report.

The ordinary CLI must retain native `bun:sqlite`, including its self-contained
build and local history archives. The managed server will select PostgreSQL
only for its exact configured application database path. Other local SQLite
files, including provider caches and independently restored archives, retain
their existing behavior.

A CLI command that writes to the managed archive (a `report --sqlite`, and the
other archive writers) may find PostgreSQL briefly unreachable. When the managed
layer can affirm that, it marks the error `transient` in addition to
`transport`: a bounded connect or query wait elapsed, a send or consume died on
an already authenticated connection, or `PQconnectPoll` failed and libpq's own
diagnostic — read once, bounded, matched on its host/location line only and then
discarded — reports a socket-level refusal or reset. The entrypoint treats those
as a retryable condition rather than a defect: instead of reporting
`spendwatch.cli.failure` and rethrowing a raw crash, it writes one line carrying
only the SQLSTATE the managed layer chose, reports a single
`spendwatch.cli.archive-unavailable` event at `warning`, and exits 69
(`EX_UNAVAILABLE`) so the next scheduled run retries. The supervisor bounds how
often that run happens and the reporter groups the event into one issue, so a
prolonged outage keeps reporting instead of going quiet.

That classification is affirmative and never the default, because
`PQconnectPoll` reports every connect-phase failure the same generic way. A wrong
credential, a missing password, a refused SSL policy, an unverified certificate
or an untranslated host is a configuration error, is not marked `transient`, and
still reports `spendwatch.cli.failure` and propagates unchanged. Ordinary SQL
errors carry no transport flag at all, native SQLite never produces these errors,
and neither one degrades this way. `transport` itself keeps its upstream meaning
for `isDeadConnectionError`, so a misconfigured connection still discards the
socket instead of being replayed. The driver's own diagnostic text names the host
and can quote the user, so it is never stored on the error, printed or reported.

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

History imports send at most 250 window rows per parameterized insert. Each
source file remains one transaction, including the final partial batch. The
existing sample keys, retention floor and first-sample-wins duplicate policy
remain unchanged. This bounds database round trips when replaying uploaded
history and keeps later failures from committing earlier batches in that file.

When normalized source-health records identify current devices, the dashboard
shows sign-in requirements only for those devices. Historical account and
window data remain intact. Standalone inputs without valid source-health
records retain their existing authentication prompts.

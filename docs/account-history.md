---
summary: "Account token history is built from reconciled per-call day evidence, never inferred from monthly totals."
read_when:
  - Changing Spendwatch account attribution.
  - Changing monthly spend or history rendering.
  - Changing gateway call settlement.
---

# Account history

Spendwatch stores global day/model token totals in `TokenDays.rows`. New reports
may also store `TokenDays.accountRows`, keyed by day, model, and account. The
account rows are optional and remain inside the archived report JSON, so old
SQLite archives require no migration.

History accepts account detail only when all of these reconcile exactly:

1. Each day/model account sum equals its global day/model row.
2. Account rows sum to the report's `totalTokens`.
3. Global day/model rows sum to that same total.

The monthly view then folds installation variants under their original source.
A gateway call settled onto another Mac is removed from both the global and
account day rows before validation, so it is counted once.

Older reports without account rows are shown as `Unknown account`. If their
global daily evidence is intact, those exact days can also be shown as unknown;
otherwise history leaves daily detail absent. It never estimates account daily
history by apportioning a monthly total.

An explicit `restoredFromInstallationId` declaration links a restored Codex,
Claude or Grok installation to its original history. Readers select the fullest
retained report in that exact source/month lineage rather than adding
overlapping snapshots. Independent installations still add normally. Archive
rows remain intact. The UI warns that the exact historical union is unavailable.

If any monthly total in a linked component disagrees with its report JSON,
readers suppress nothing and disclose the uncertain overlap. Token summaries
compute lineage visibility across the entire archive before settling gateway
calls, including calls crossing a year boundary.

## Missing source history

An operator can pin a verified retained month through the trusted
`SPENDWATCH_CAPTURE_GUARDS` file. Each guard names the logical source, month,
installation, timezone and SHA-256 of the exact stored report JSON. The writer
checks the stored scope and hash before changing data. The pin also protects
installation aliases and rejects a gateway takeover involving the guarded month
as a whole. Higher counters never clear it automatically.
The current display admits one guarded installation per logical source/month;
configuration rejects multiple baselines for the same merged card.

Spend, History and the token summary continue to use the retained archive.
The latest source scan is published separately, with a visible coverage warning;
the two captures are never added, subtracted or combined with maxima. Missing
capture times remain unavailable. Clear a guard only after explicitly
reconciling its historical coverage.

When `SPENDWATCH_CAPTURE_DIR` names the private `public/captures` directory,
imports publish immutable JSON and HTML before linking them. Their names contain
the original input payload SHA-256 and original element index. The downloaded
JSON preserves the source element; rendering may normalize legacy missing
totals separately. Links, report hashes and capture times identify the exact
capture. These pages use private, non-storable HTTP responses.

## Divergent Codex copies

Ordinary duplicate rollouts retain the byte-prefix check. Discovery additionally
permits a bounded semantic proof when copied records differ: it uses the actual
source parser, requires equal ordered usage and raw response records, and
selects one existing file only when its nonbilling events contain the others.
Different parser contracts cannot bypass this proof through the prefix path.
The proof ignores the recorder's positional `ordinal` and treats absent and
null `content` as equivalent only for reasoning response items. Other content,
routing, malformed rows and incomparable copies remain errors. Native files
are never rewritten or concatenated.
Each candidate proof is bounded to 1 GiB, 16 MiB per line, and 1,000,000 parsed
facts; a larger or incomplete candidate remains an explicit divergent-copy error.
Its 64-entry manifest cache retains at most 2,000,000 parser facts and evicts
only old in-memory summaries.

Codex may retain immutable archived rollouts as `.jsonl.zst`. Spendwatch opens
that native file without following links, checks it did not change while `zstd`
decodes it, and validates a private immutable `.jsonl` snapshot before its
normal parser and duplicate proof read it. A missing codec, malformed or
truncated stream, source race or link fails collection visibly. The snapshot
retains the original `.jsonl` basename, so a live rollout moving to a compressed
archive keeps its watch identity. Decoding is capped at 1 GiB per rollout and
64 GiB across 10,000 private snapshots; reaching either limit fails visibly
rather than dropping archive history.

## Isolated Claude clients

Default discovery also reads the two retained Claude-3p proof namespaces:
`auto-review-prep/native-proofs/*/claude-config/projects` and
`alias-trial/proofs/*/claude-home/projects` under the user's Application Support
directory. It checks the fixed paths, rejects symlink descendants and bounds
proof-directory traversal. Explicit root configuration still overrides defaults.
These calls use `Unknown isolated account`; current login credentials do not
prove the historical account of a bridge call.

An optional private `~/.config/spendwatch/claude-model-aliases.json` maps exact
opaque `claude-hg-route-*` aliases to verified model names. It changes API model
labels only. Counts, timestamps and gateway IDs retain their original semantics,
including settlement of messages already billed by the gateway. Missing or
invalid mappings leave models unclassified rather than guessing a provider.

## Legacy archive guards

A guard may explicitly use `timeZone: null` to pin an older report that recorded
no timezone. Null matches only a missing stored timezone. Its exact report hash,
source, installation and month remain required; the UI says that the timezone
is unavailable rather than assigning one retrospectively.

Duplicate copies may also differ only by nonbilling detail. A bare
`payload.metadata` of `{turn_id}` on a response item is ignored. The fuller copy
may hold extra user or developer messages inside the same billing segment, and
extra observed calls that repeat the preceding `token_count` exactly. API calls
must still match in order, and every other response must appear unchanged.

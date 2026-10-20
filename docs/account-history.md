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

---
summary: "Paginated Codex subagent rollouts report only their child-owned ordinal range."
read_when:
  - Changing the Codex rollout parser.
  - Changing Local Qwen's Codex-format parser.
  - Investigating duplicate Codex or subagent usage.
---

# Codex subagent history ownership

Recent native Codex paginated subagent rollouts can retain a copied parent
prefix in the child's JSONL. The first `session_meta` header declares this with
`history_mode: "paginated"` and a safe integer
`subagent_history_start_ordinal`. Native Codex treats that value as the first
child-owned row.

Spendwatch admits every line before any parser state, usage, gateway claim, or
deduplication can change:

| Ordinal | Meaning | Spendwatch action |
| --- | --- | --- |
| `< subagent_history_start_ordinal` | Copied parent context | Ignore for reporting and accounting |
| `>= subagent_history_start_ordinal` | Child-owned history | Parse normally |

The header still seeds the child's id, project, model, and provider even when
its ordinal falls in the copied prefix. It produces no report event in that
case. Later copied `session_meta` and `turn_context` rows cannot replace that
identity.

Once an explicit boundary is present, every row must have a non-negative safe
integer ordinal, strictly larger than the previous row. Missing, unsafe, or
regressed ordinals fail the rollout visibly. The first header freezes its
identity, history mode, boundary, and supplied parent references. Conflicting
`forked_from_id`, `parent_thread_id`, or
`source.subagent.thread_spawn.parent_thread_id` values fail rather than
guessing lineage.

The first owning header requires a nonblank child id; any supplied parent
reference must also be a nonblank string. At the final read, the file must reach
at least `subagent_history_start_ordinal - 1`. A shorter inherited prefix is
incomplete and fails visibly. Watch mode can wait for that prefix to finish.

Legacy rollouts and paginated root threads without
`subagent_history_start_ordinal` remain on the existing parser path. A
subsequent copied parent header cannot turn a legacy file into an explicitly
owned subagent rollout.

`parseFreeCodexLocalQwen` uses the same admission gate before filtering cloud
models. This validates ordinals in filtered rows while keeping cloud calls out
of the Local Qwen source and preserving a model-less child header until its
first Qwen turn.

## Older forked subagent rollouts

Before native pagination, Codex wrote a forked subagent's rollout by copying the
parent's whole history into the child file. Those copied turns are already
billed by the parent's own rollout. Spendwatch links such a child (first header
with a parent reference and no ownership boundary) to the actual parent rollout
it discovered, and skips every row inside a turn whose `turn_id` the parent also
opened. Turn ids are unique per turn, so this uses identity rather than
timestamps or token vectors. Child-only turns and rows outside any turn still
count; nothing is subtracted on a guess. A child whose parent rollout is missing
or unreadable is counted whole and the Codex source reports a warning.

Codex later rewrote some of these files into paginated form. When every row of
the rewrite lies below its ownership boundary, it holds only copied context and
has lost the child's own turns. If it shares the child id and parent with a
legacy original, the rewrite is dropped and the original is read instead.

---
summary: "Subagent spend is a projection of calls already counted, split by role and by agent, with no extra collection."
read_when:
  - Changing how Codex or Claude subagent usage is attributed.
  - Changing the Spend page's Subagents section.
  - Changing gateway ledger claims or settlement.
---

# Subagent spend

Spendwatch reports how much of a report's usage ran in subagents, overall, by
role and by individual agent. It never adds to a total: the projection is built
from the calls the report already counts, so it costs no extra I/O, API call or
latency.

## Where the tag comes from

- **Codex:** a rollout's own `session_meta` names it (`thread_source: "subagent"`
  or `source.subagent`, plus `agent_role`, `agent_nickname`, `agent_path`). The
  parser keeps it on the context and tags every call from that rollout. A
  subagent with no role is `subagent`.
- **Claude Code:** a sidechain transcript (`isSidechain`) is a subagent. It records
  no role, so the role is `subagent` and the name is its `agentId`.
- **Gateway-billed calls:** when a ledger row bills a call and the rollout copy is
  dropped, the claim carries the tag onto the row (`RowHolder.agent`), so the call
  keeps its role. A ledger row no rollout claims has no tag and counts as main.

## What a report holds

`Report.subagents` has `main` and `subagent` totals (tokens, cost, calls,
sessions), a row per role with its top models, and the largest 30 individual
agents. `localShare` is the fraction of subagent tokens on the self-hosted Qwen
model, the figure for how far work has moved off paid models.

Reports merge across machines by summing totals and roles; agents stay separate
rows and only the largest are kept. Malformed archived input is dropped, never
trusted. Gateway settlement removes a settled call from its role and model, so a
call is never counted by two Macs. Per-agent rows are an approximate top list and
are not adjusted by settlement.

## Limits

Only Codex rollouts and Claude sidechains carry subagent evidence. The History
page and monthly archive do not store this projection yet.

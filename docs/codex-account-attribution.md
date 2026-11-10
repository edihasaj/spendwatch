---
summary: "Codex account history is corrected from uniquely matching gateway ledger vectors, without changing spend totals."
read_when:
  - Changing Codex account attribution.
  - Changing subscription-gateway ledger parsing.
  - Changing Codex report aggregation.
---

# Codex account attribution

Codex rollout files record token usage but a default `~/.codex/auth.json` only
describes the account logged in now. It cannot identify historical calls.

Spendwatch therefore preserves every call, token total, model total, project
total, and tool total, then annotates a Codex call only when exactly one
completed `codex-subscription` gateway ledger row has the same configured
provider/upstream model, gross input, cached input, cache-write input, output,
and timestamp within 30 seconds.

Each ledger row can annotate one deduplicated API call. A missing match,
different complete vector, or ambiguity stays `Unknown Codex account`. A named
Codex profile can remain profile-labelled; an explicit Spendwatch root account
is accepted as configured evidence.

Gateway history needs a dated, public route declaration:

```json
{
  "version": 1,
  "bindings": [{
    "config": "/absolute/path/to/gateway.json",
    "provider": "codex",
    "account": "person@example.com",
    "from": "2026-10-11T00:00:00.000Z",
    "to": "2026-10-20T00:00:00.000Z",
    "basis": "configured-route"
  }]
}
```

Put it at `~/.config/spendwatch/gateway-account-bindings.json`, or point
`SPENDWATCH_GATEWAY_ACCOUNT_BINDINGS` at it. `to` is optional and exclusive.
Bindings never contain tokens. Managed collectors use finite intervals and a
public identity observer; account changes leave an unknown transition gap.
A row outside one unambiguous dated binding stays unknown; Spendwatch never
backdates the credential currently on disk. Spend detail discloses route-based,
profile-based and unknown attribution separately.

## Calls that have no Codex account

Three kinds of call reach a Codex rollout without a gateway Codex ledger row, and
they are labelled by what the evidence supports instead of all being unknown:

- **Self-hosted Qwen** (`qwen3.8-flash-next`) has no Codex account. It is its own
  `Local Qwen` account with profile basis.
- **A Claude model called through the Codex harness** (`claude-primary/…`) is
  labelled `<email> (claude-primary)`. The gateway's Claude provider names its own
  auth directory (`~/.claude-<name>`), and the account signed in there owns the
  call. The label keeps the route, so it never merges with a Codex account.
- **A bare model on the direct login** (`gpt-6.1-sol`, no gateway) stays
  `Unknown Codex account`. The default `~/.codex` login is overwritten by every
  sign-in, so it cannot name past calls.

The dated bindings only cover time the identity observer has actually seen.
`spendwatch-refresh-capacity` runs the observer every five minutes; when it only ran
with the daily export, every gateway call after its last run was unknown.

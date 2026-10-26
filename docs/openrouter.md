---
summary: "OpenRouter transcript routes, pricing estimates, and account activity stay distinct."
read_when:
  - Adding OpenRouter routes or model pricing.
  - Changing Spend or History OpenRouter rendering.
  - Changing OpenRouter capacity collection.
---

# OpenRouter reporting

Spendwatch records OpenRouter calls under the ordinary `machine:codex` source.
It does not create an `openrouter` source suffix, because source suffixes name
the agent and are used for machine attribution.

Each report may contain `providerUsage` for exact OpenRouter-routed transcript
calls. It is a validated UTC day/model projection of calls already included in
the report's tokens, cost and call count. Spend and History display it as a
machine route breakdown; it never adds another row to global totals.

The report estimate uses the local dated public model-price cache. A missing
exact slug or ambiguous timed rate is marked `unpriced`; its displayed cost is
`unavailable`, rather than treating a zero estimate as a free call. A known
zero-priced model remains a normal estimate.

Account credits, key counters, and the management-key Activity endpoint are
capacity evidence. They are separate from transcript provider usage: Activity
has no machine/key identifier and only retains completed UTC days that the API
returns. Do not apportion account history to a machine or add it to transcript
totals.

The first direct local OpenRouter routes were configured on 2026-10-26. Older
machine attribution appears only when a retained transcript or gateway ledger
proves its route. Gateway settlement removes a matching unconfirmed call from
both the ordinary report and its `providerUsage` row, so a billed route counts
once.

## Collection and pricing

The trusted account collector reads `~/.config/spendwatch/openrouter.json`
(or `SPENDWATCH_OPENROUTER_CONFIG`). Its owner-only JSON contains `account`,
`apiKeyFile` for the management key, `usageKeyFile` for the inference key and
an optional `cacheDir`. The keys themselves never enter reports. Credits and
key counters cache for five minutes; completed-day activity caches for one
hour and is merged into a persistent private archive. Failed reads retain the
original capture time. Earlier account activity that the API no longer returns
cannot be reconstructed from lifetime counters.

`spendwatch openrouter-prices-refresh` updates the public catalog once per day,
without account credentials. The daily source exporter runs it before scanning
transcripts. Report rendering reads only the dated local cache at
`~/.config/spendwatch/openrouter-model-prices.json` (or
`SPENDWATCH_OPENROUTER_PRICES`). Current catalog rates estimate old calls;
they are not historical invoices.

A gateway `responses-api` route is identified only by its configured exact
`https://openrouter.ai/api/v1` origin. The configured alias maps to the public
model slug for pricing, while matching preserves the original alias. Marked
calls use the ordinary gateway settlement. Some OpenRouter ledger rows have no
response ID: only matching local transcript calls are attributed, so unmatched
ledger rows cannot create a second bill for an unmarked remote rollout. The
source warning discloses that missing attribution. No current login assigns an
OpenRouter account to old calls.

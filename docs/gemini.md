---
summary: "Gemini spend comes from two distinct records: the CLI's own sessions and the gateway ledger; direct-CLI prices are API-equivalent estimates."
read_when:
  - Changing Gemini parsing, account naming, or the `geminiHome` config key.
  - Adding or changing Gemini model pricing.
  - Changing how gateway Gemini rows are billed or deduped.
---

# Gemini reporting

A Gemini turn reaches Spendwatch by one of two routes, and each is the whole
record of its kind:

* A **direct `gemini` run** the user started leaves its own session records
  under `~/.gemini` (or a configured root). `src/gemini.ts` parses these.
* A turn a **`gemini-subscription` provider** of the gateway served is recorded
  in a disposable home the gateway deletes when the session ends. Nothing
  survives there to parse: the gateway's month ledger
  (`usage/usage-YYYY-MM.jsonl`) is the only record of these turns, and it is
  what bills them. The Codex rollout that proxied the same turn carries the
  marked `resp_gl_*` response id, so `covers`/`claim` drop its copy of the
  call — the turn is billed once, from the ledger.

A row is a Gemini row when its `providerType` is `gemini-subscription`, or —
for a telemetry row imported with the ledger's first creation — when its
provider name maps to Gemini through `SPENDWATCH_GATEWAY_PROVIDER_MAP`. A name
mapped to nothing removes even the built-in `gemini` name, and the row goes
unbilled rather than guessed at.

## Account

Gemini has no `authDirectory`: the sign-in lives in the home the CLI runs in.
A provider may set `geminiHome` in the gateway config; providers that name no
home share the gateway's own, beside its state directory. The account is the
`active` field of that home's `.gemini/google_accounts.json`; a home that
names no active account is the fixed `Unknown Google account`, never a guess
at whoever signed in last.

## Session records

The CLI's `ChatRecordingService` (checked against 0.70.0) writes one JSON
object per line to `<home>/.gemini/tmp/<short id>/chats/session-*.jsonl`, and
`<home>/.gemini/projects.json` maps each project path to that short id. A
metadata record carries `sessionId` and `projectHash`; message records carry
`{ id, timestamp, type: "user" | "gemini", content, model?, tokens?,
toolCalls? }`. The CLI re-appends a whole message as its usage and tool
results arrive and keeps only the last record of an id, so the parser keeps
the last record too — one message is one `api` event.

**Usage.** `tokens.input` is gross of `cached`, so the cache is subtracted
rather than added. `output` and `thoughts` are recorded apart
(`candidatesTokenCount` and `thoughtsTokenCount`) and Google bills thinking at
the output rate, so the two together are a call's billable output. A tool
result that came back `error` (the CLI's own status word; `failed` is never
written) is counted as a failure.

**Older layouts.** An older directory is named by `sha256(projectRoot)`: the
registry's current short id does not match it, so the project comes from the
hash the session's own metadata record carries. Before the CLI moved to JSONL
a session was one `session-*.json` document whose `messages` array holds the
same records, which no line-at-a-time parser can read, so `parseGeminiDoc`
takes the whole document (falling back to lines, as the CLI's own loader does).
A resumed session exists under both names at once and the `.jsonl` holds the
whole record, so the `.json` is read only when its `.jsonl` twin is absent: one
session is one bill, whichever file holds it.

**Subagents.** A subagent keeps its own transcript one level deeper, at
`chats/<parent session id>/<agent id>.jsonl`. It runs its own model calls and
records its own tokens, and the parent's tool record for the child carries no
usage of them, so Spendwatch collects each child transcript once, from that
directory only, and tags its calls as a subagent — the delegated-work
projection in `subagents.ts` shows them by role and by agent without adding a
call to any total.

## Pricing

A Google AI subscription is not billed per token, so Gemini figures are
estimates: each model is priced at Google's current public list rate (the
citations sit beside the entries in `src/pricing.ts`). The gateway's model
alias may carry a `gemini/` provider prefix; `priceFor` strips it before the
lookup. Retired models (`gemini-3-pro-preview`, `gemini-3.5-flash`) keep
entries that route to the model Google directs them to, at its published
rates. Google's context caching bills stored bytes per hour rather than a write
premium, so every listed Gemini entry prices cache creation at zero.

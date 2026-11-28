---
summary: "Quota readings preserve one provider pool, real timestamps, and coordinator-owned polling state."
read_when:
  - Changing Codex or Claude capacity collection.
  - Changing Gemini capacity collection or the Gemini quota card.
  - Investigating a mismatch between Spendwatch and a provider quota page.
  - Changing capacity poll coordination or snapshot persistence.
  - Changing the Local Qwen capacity card.
---

# Quota accuracy

Spendwatch reports an official provider quota value for one account and one
quota pool. It does not add per-machine usage to a provider percentage.

Codex app-server can return generic (`codex`), legacy, and model-specific
(`codex_*`) pools in one response. The collector selects exactly one coherent
pool: generic first, then legacy, then the alphabetically first viable
model-specific pool. It never combines matching-duration windows from separate
pools. The selected pool identifier is retained with the sanitized snapshot for
diagnosis.

Live capacity is discovered from a profile's credential, not from its history.
`codexCapacityProfileHomes` lists `$HOME/.codex` and `$HOME/.codex-*` directories
that hold their own regular `auth.json`, default home first, resolved to real
directories so a home reached through an alias is read once. A signed-in profile
with no `sessions` or `archived_sessions` directory is therefore still collected,
and the reader never creates a history directory or moves a credential to get it.
A profile whose `auth.json` is a link to another home's login is not counted as a
second account. The rollout-root scan remains as a union so Qwen worker homes and
archived-only homes keep their accounts; as before, that legacy scan resolves
symlinked roots, so a borrowed credential can still surface there under its own
account. Discovery only proposes homes: the native `account/read` decides whether
a home is a ChatGPT subscription account, and an API-key mode, a free plan, or a
missing quota window contributes no capacity rather than an estimate.

A Codex card is named by its profile, like a Claude card: `~/.codex-secondary` is
"Codex Secondary", and `primary`, `secondary` and `tertiary` keep that order. The
collector reads the name from the home's directory, only from a plain `.codex-<name>`
suffix, and attaches it to the result after the coordinator step, so a shared snapshot
from a server that predates profiles still carries it. When the default `~/.codex` and a
named home hold the same login, the named home gives the label. An account with no
profile keeps the positional label, which orders by email, so a new login could take
another account's "Secondary" until it is added under a named profile.

The shared coordinator owns quota attempt timing: Codex may read once a minute,
Claude once every two minutes, and a rate limit has at least a one-hour
cooldown. When the coordinator is unavailable, a source can display only its
validated locally cached shared result; it does not issue a provider fallback
read or alter the remote lease or cooldown.

A shared snapshot can freeze while the coordinator is reachable: if the machine
that wins each lease keeps failing (for example a revoked login on one Mac), the
coordinator backs off and every other machine keeps receiving the old reading.
When a machine gets no lease and the newest snapshot it knows, shared or local, is
more than 15 minutes old, it reads the account directly, at most once per
15 minutes per account and at most once per hour after a rate limit. The result is
cached locally only; the remote lease and cooldown are not touched, and an older
shared snapshot never replaces a newer local reading. A Codex email signed in to
several homes is read from the first home that answers, so one stale login does
not hide a working one; a rate limit stops that fallback because it applies to
the account.

The server holds the poll store through `ReconnectingPollStore`. A managed
PostgreSQL connection closes itself after a transport error and never reopens, so
the store is discarded after any non-validation failure and the next request opens
a fresh connection; the failed statement is never replayed. Database failures
return HTTP 500, and only a malformed request returns HTTP 400. If every claim
returns 400 and collectors show only cached data, the server predates this
behavior: restart the container, then publish a release that includes it.

Snapshots more than five minutes ahead of local time are rejected. Smaller
clock skew can be stored so a source is not needlessly discarded, but it stays
stale until local time reaches its sample timestamp.

A provider percentage is live for at most seven minutes. The five-minute floor
still applies to short quota windows; the seven-minute cap covers the healthy
one-minute collector cadence, two-minute Claude polling and bounded import delivery, and
matches the recommendation freshness budget. A passed reset remains expired
regardless of sample age.

The capacity page may immediately render a newer authenticated coordinator
snapshot already stored in `capacity_poll`, before its imported limits file
arrives. It overlays only a registered matching Codex or Claude account and
never writes, contacts a provider, or creates an account from the cache.

Historical `capacity-history-export` records percentage windows and timestamps
from Codex session logs, but a default `~/.codex/auth.json` identifies only the
account signed in now. Exports therefore use `Unknown Codex account` for the
default profile. Named profiles are labelled as unverified profiles unless an
operator explicitly supplies an account for that export root. The exporter
never relabels historical quota percentages from a current credential.

Credit blocks are reported next to the quota windows, not inside them, and they
use different units. Claude's promotional cloud credits arrive as dollar
amounts, while its paid extra usage arrives as integer cents; the collector
converts the cents so both reach the dashboard in one currency unit. A
malformed Claude credit block with invalid amounts — such as a non-finite amount
or a remaining balance above its limit — is dropped while its snapshot's quota
windows are kept. An unparsable promotional expiry is omitted, so the valid
balance remains visible. A malformed Claude credit reading is a reporting gap,
not a reason to discard an accurate window. Codex purchased-credit fields remain
part of strict snapshot validation. A null Codex balance is an absent credit
reading, so it does not discard valid quota windows. Unlimited credits with no
balance use the existing zero-balance representation.

An exhausted Claude allowance is not an absent one. When extra usage runs out, the
usage endpoint stops returning the credit blocks: the cloud-credit block is null and
`extra_usage` becomes disabled with `spend_limit_reached: true` and no amounts. The
collector marks that reading `creditsExhausted`, and only when no live credit figure
is present, so a disabled block that never reached its limit stays unmarked. The
capacity poll store holds one row per account and overwrites it on every poll, so it
also carries the last credit figures forward as `lastKnownCredits`, with the time they
were last read from the provider. A reading that still omits them keeps the original
time; live figures replace and clear it. The carry runs in `complete`, in the local
`cacheSnapshot`, and in the collector, so a shared server that predates the field
cannot erase what this Mac already holds. The kept block is re-validated on every
write and read, and a future-dated one is dropped. The card shows the kept figures as
"exhausted" with their last-seen date, only while the provider reports the allowance
spent, and says "Credits exhausted" without an amount when no figure was ever
recorded. History tables do not store credit figures, so the first reading that omits
a block can only keep what the store was already holding.

Named Claude profiles can keep their login in macOS Keychain rather than in
`.credentials.json`. Discovery uses only the profile's exact service,
`Claude Code-credentials-` followed by the first eight SHA-256 hex characters
of its absolute configuration directory. It never borrows the default profile's
credential. A live file credential still takes precedence. An expired file can
fall back to a newer login in that profile's exact Keychain service; an absent
or older Keychain login leaves the file available for renewal. Keychain
refreshes retain the exact original service, account and Keychain path.

## Gemini card

Gemini publishes neither a 5-hour window nor a weekly one. `capacity-current
--provider gemini` reads the same `retrieveUserQuota` call the official Gemini
CLI makes, so it gets one bucket per model id: a fraction left, sometimes an
absolute amount, and the instant that allowance refills. The shared coordinator
reserves one attempt per account every five minutes, and collection is opt-in by
presence — a machine with no signed-in
`.gemini/oauth_creds.json` produces no card and sends no request, and a
credential file that is a link, owned by somebody else, or readable by the
group is refused with a fixed reason rather than a read.
The judgement and the read share one descriptor — opened `O_NOFOLLOW`, judged by
its `fstat`, read from that same fd — so the file cannot be swapped for another
account's grant in between, and `O_NONBLOCK` stops a planted pipe from hanging the
collect. Only the grant file is held to 0600: the CLI writes the account label with
no mode at all (chunk-37D3S3FZ.js:284911) and it holds no secret, so demanding a
private label would lose the account and the card with it.

Because the API reports a reset instant and never a cycle length, the row's
`windowMinutes` is a nominal 24 hours used only by the pace and burn maths;
`resetsAt` is the figure to act on. A reset already behind us is carried rather
than dropped, which is what lets the card say "Cycle ended" instead of showing a
percentage from a cycle that no longer exists, and what makes the burn forecast
decline to say anything rather than project a window through a closed cycle.

Only the aliases the CLI itself folds are merged: `gemini-3-flash`, `-3.5-flash`
and `-3.8-flash` share one Flash allowance and the two flash-lite ids share one of
theirs (chunk-37D3S3FZ.js:406024-406032), so they collapse to one row and the
tightest bucket wins it. Every other reported id keeps its own row, because two Pro
versions are two allowances and merging them would report one averaged figure for a
quota that is really two. Where a family does hold several rows, the card and the
text output name each row by the ids it reports rather than by the family heading
they all share. A bucket that reported no fraction at all is dropped rather than
read as a spent one: `Number(null)` is 0, and a coerced zero is not a measurement.
The headline is the most constrained Pro bucket — the allowance an agent
hits first — falling back to the tightest row at all, and the top three rows
also fill the shared `primary`/`secondary`/`tertiary` windows, so a consumer that
already reads Codex or Claude capacity reads Gemini the same way.

One collect spends at most one OAuth refresh grant per account. Google can
rotate a refresh grant when it issues a new access token, and this collector may
never write the rotated grant back: the gateway owns that file and its lock, so
a second exchange in the same read could strand the stored login. Both Code
Assist calls therefore share the one token the session obtained. A refused
`invalid_grant` is reported as a sign-in problem, the same class as a 401, and
never as a retry.

The refresh uses the official CLI's own installed-app OAuth client. Spendwatch
keeps no copy of it in source: `src/gemini-oauth-client.ts` reads the pair from
the installed `@google/gemini-cli` bundle (the `gemini` on PATH, then the npm,
Homebrew and `~/.local/bin` locations a launchd PATH lacks). Without an installed
CLI an expired token cannot be refreshed, and the read reports `unavailable`
without contacting Google; a still-valid access token keeps working.

### Antigravity sign-in

Google moved Google AI Pro and Ultra subscriptions from the Gemini CLI to
Antigravity CLI (`agy`) on 18 June 2026, and GateFox's `gemini-subscription`
provider now signs in through it. Its sign-in is
`<gemini home>/.gemini/antigravity-cli/antigravity-oauth-token`
(`{token:{access_token, refresh_token, expiry}, id_token_email}`); with GateFox's
default home that is `<state>/gemini-home`. A home holding it is read before the
older `oauth_creds.json`, under the same descriptor checks, and the account is
named by `id_token_email`. `retrieveUserQuota` refuses an Antigravity login, so
`src/antigravity-capacity.ts` reads what Antigravity itself reads:
`loadCodeAssist` with `ideType: "ANTIGRAVITY"` for the project and plan, then
`fetchAvailableModels`, which answers each model's `quotaInfo.remainingFraction`
and `resetTime`. Code Assist serves this only to an Antigravity client, so the
User-Agent is `antigravity/spendwatch (<platform>; <arch>)`.

Antigravity reports two pools, and the card shows exactly those two rows:
**Gemini models** (every `gemini-*` id, the headline and `primary` window) and
**Claude & GPT models** (`claude-*` and `gpt-*`, the `secondary` window). Each
pool is read at its tightest model; ids with no reset, such as tab completion,
are internal and skipped. Both pools refill five hours after first use, so their
`windowMinutes` is 300.

`agy` ships its OAuth client without a usable secret, so an expired access token
is refreshed the way GateFox refreshes it: `agy models` runs in a fresh 0700
folder under `/tmp` holding a copy of the sign-in and the installation id, with
only that folder as `HOME` and no Google variables. `models` only lists models
and starts no conversation. The refreshed access token is read into memory, and
the folder is deleted whatever happens. Google kept the same refresh grant across
this refresh when checked on 28 November 2026, so discarding the copy never
strands GateFox's login, and Spendwatch still never writes the gateway's file. A
copy that comes back without a newer token is a sign-in problem (401), and no
`agy` on PATH, in Homebrew or in `~/.local/bin` is `unavailable`. One read spends
at most one refresh, ahead of expiry or after a 401.

The manager capacity refresher polls `--provider gemini` only on a Mac whose
GateFox state holds a Gemini sign-in, the way it polls OpenRouter only where its
config is.

A stored Gemini snapshot keeps its per-model rows, because those rows are the
reading. A snapshot arrives from another machine's collector, so on every read
each figure is checked again and the card's label is always re-derived from the
family and the validated model ids — never taken from the stored string. A row
that fails validation is dropped, and a snapshot with no usable row is rejected
outright rather than rendered as an empty quota card.

A failure leaves this collector as one of a fixed set of sentences. A message from
SQLite, a coordinator transport or a fetch can quote a file path, a URL or part of
a request, and a caller prints those lines on a terminal, so an unknown fault is
reported as an unknown fault and nothing more. The account label that travels with
a failure is held to an address shape first, since it also keys history and a poll
reservation.

## Local Qwen card

Local Qwen publishes no quota window, so `capacity-current --provider local`
(or `qwen`) builds its card from the machine itself, with
no provider pacing and no coordinator lease:

- **Local Qwen**: tokens this machine sent to the self-hosted model, whichever
  agent routed them. It carries no money. If the usage report cannot be read,
  the card omits the figures instead of showing zero.

The card reads its own machine, so it is only as current as the last time a
scheduler ran the command on that machine. A failure goes to stderr and stdout
stays the JSON contract.

A report build scans the whole window whichever agent is asked for, so the
30-day window is far costlier than the 1-day window (about 40 s against about
4 s on a busy machine). The 30-day
totals are cached in `~/.local/state/spendwatch/local-capacity.json` for 30
minutes, so a frequent schedule normally pays only for the 1-day window. A
cached sample from the future or with malformed fields is ignored, and the
1-day figures are always read fresh. A scheduler must allow a cold read (no
cache) to finish, or the cache never fills.

A report build reads compressed Codex archives through the persistent decoded
cache described in `docs/codex-compressed-rollouts.md`. A warm 30-day refresh
reads the cached files and writes no transcript data. The first refresh on a
Mac fills the cache at a capped rate. It may take more than one scheduled run
to finish, and every completed entry is kept between runs.

The Local Qwen report build tolerates a divergent Codex rollout (for example an
archive copy whose `model_provider` header was rewritten) by reading its longest
complete copy. Qwen figures cannot depend on which copy of a non-Qwen rollout
wins, and one divergent file must not blank the card. Ordinary `report` builds
still refuse divergent copies. The scheduled local refresh allows a 170 s cold
read, because a month scan without cached totals can take about 100 s.

`gatefox` is the renamed local subscription gateway. Codex rewrites an archived
rollout's header to the current provider name, so the live copy says
`subscription_gateway` and its archive says `gatefox`. The Codex parser treats
both as one provider, so the two copies of a session agree and the strict
duplicate proof accepts them instead of failing the whole report.

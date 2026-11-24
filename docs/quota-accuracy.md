---
summary: "Quota readings preserve one provider pool, real timestamps, and coordinator-owned polling state."
read_when:
  - Changing Codex or Claude capacity collection.
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

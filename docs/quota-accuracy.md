---
summary: "Quota readings preserve one provider pool, real timestamps, and coordinator-owned polling state."
read_when:
  - Changing Codex or Claude capacity collection.
  - Investigating a mismatch between Spendwatch and a provider quota page.
  - Changing capacity poll coordination or snapshot persistence.
  - Changing the Copilot, Grok or Local Qwen capacity cards.
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

The shared coordinator owns quota attempt timing: Codex may read once a minute,
Claude once every two minutes, and a rate limit has at least a one-hour
cooldown. When the coordinator is unavailable, a source can display only its
validated locally cached shared result; it does not issue a provider fallback
read or alter the remote lease or cooldown.

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
part of strict snapshot validation.

Named Claude profiles can keep their login in macOS Keychain rather than in
`.credentials.json`. Discovery uses only the profile's exact service,
`Claude Code-credentials-` followed by the first eight SHA-256 hex characters
of its absolute configuration directory. It never borrows the default profile's
credential. A usable file credential still takes precedence, and Keychain
refreshes retain the exact original service, account and Keychain path.

## Copilot, Grok and Local Qwen cards

These providers publish no quota window, so `capacity-current --provider local`
(or `copilot`, `grok`, `qwen`) builds their cards from the machine itself, with
no provider pacing and no coordinator lease:

- **Copilot**: for every account `gh` is signed in to, the premium-credit usage
  GitHub reports for that account. The token is passed to one `gh api` call
  through the environment and never appears in the output.
- **Grok**: the signed-in account's email, with the last day and last 30 days
  of this machine's Grok spend (API-equivalent estimate, not billed money).
- **Local Qwen**: tokens this machine sent to the self-hosted model, whichever
  agent routed them. It carries no money. If the usage report cannot be read,
  the card omits the figures instead of showing zero.

Each card reads its own machine, so a card is only as current as the last time a
scheduler ran the command on that machine. One provider failing never hides the
others; the reason goes to stderr and stdout stays the JSON contract.

A report build scans the whole window whichever agent is asked for, so the
30-day window is far costlier than the 1-day window (about 40 s against about
4 s on a busy machine). One build per window serves every provider. The 30-day
totals are cached in `~/.local/state/spendwatch/local-capacity.json` for 30
minutes, so a frequent schedule normally pays only for the 1-day window. A
cached sample from the future or with malformed fields is ignored, and the
1-day figures are always read fresh. A scheduler must allow a cold read (no
cache) to finish, or the cache never fills.

Copilot is the one card that calls a provider endpoint (GitHub's per-user
Copilot endpoint, through `gh`). To stay clear of rate limits, a machine asks
GitHub at most once every 15 minutes and serves the last reading in between,
keeping its original `updatedAt` so the card ages honestly. After any failure,
a rate limit included, it waits 30 minutes, doubling per consecutive failure up
to 4 hours, and keeps serving the last good reading meanwhile. The state lives
in `~/.local/state/spendwatch/copilot-capacity.json`; a malformed file or one
dated in the future is ignored. A missing `gh` or a missing local login sends
nothing to GitHub and starts no backoff.

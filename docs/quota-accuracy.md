---
summary: "Quota readings preserve one provider pool, real timestamps, and coordinator-owned polling state."
read_when:
  - Changing Codex or Claude capacity collection.
  - Investigating a mismatch between Spendwatch and a provider quota page.
  - Changing capacity poll coordination or snapshot persistence.
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

The shared coordinator owns quota attempt timing: Codex may read once a minute,
Claude once every five minutes, and a rate limit has at least a one-hour
cooldown. When the coordinator is unavailable, a source can display only its
validated locally cached shared result; it does not issue a provider fallback
read or alter the remote lease or cooldown.

Snapshots more than five minutes ahead of local time are rejected. Smaller
clock skew can be stored so a source is not needlessly discarded, but it stays
stale until local time reaches its sample timestamp.

A provider percentage is live for at most seven minutes. The five-minute floor
still applies to short quota windows; the seven-minute cap covers the healthy
one-minute Codex and five-minute Claude collectors plus import delivery, and
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

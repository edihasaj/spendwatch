---
summary: "Compressed Codex archives are decoded once into a private, rate-limited cache that later runs reuse without writing."
read_when:
  - Changing how Spendwatch reads `.jsonl.zst` Codex archives.
  - Investigating Spendwatch disk writes, disk usage, or a Mac that froze during a report or capacity refresh.
  - Changing the Local Qwen 30-day refresh or any schedule that builds reports often.
---

# Compressed Codex rollouts

Codex compresses archived sessions to `.jsonl.zst`. Every Spendwatch reader
opens a rollout by path and reads it by offset, so an archive must exist as a
plain decoded file before it can be parsed.

## Why the cache exists

Releases before 15 November 2026 decoded every in-range archive into a new
temporary directory on each run and deleted it on exit. On Studio, one Local
Qwen 30-day refresh wrote and then deleted about 20 GB (47 GB of total disk
traffic) in 94 seconds, and the refresh ran every 30 minutes. On 13 and
15 November 2026 that load stalled the disk long enough for macOS's `logd`
watchdog to panic the Mac (`userspace watchdog timeout: no successful checkins
from logd`).

## Behaviour

- Each archive is decoded once into
  `~/.cache/spendwatch/codex-decoded/<entry>/<rollout>.jsonl`. You can override
  the location with `SPENDWATCH_CODEX_DECODED_CACHE`. Otherwise it uses
  `XDG_CACHE_HOME` when that is set. The directory is mode 0700, owned by the
  user, and is never a link. Decoded files are mode 0400.
- The entry name is a hash of the archive path and its identity (device,
  inode, size, modification time and change time). A changed archive gets a
  new entry. A later run reuses an entry only when the stored archive identity
  matches and the decoded file still has the identity it had when it was
  published. Any other entry is decoded again.
- Reuse writes no file data. It refreshes the entry directory's modification
  time at most once a day.
- Filling the cache is paced to 48 MiB/s by default. You can change the rate
  with `SPENDWATCH_DECODE_WRITE_BYTES_PER_SECOND`. A first run on a large
  history therefore takes longer, but cannot flood the disk.
- Entries are written to a `.staging-<pid>-*` directory and published with one
  rename. A run that times out keeps everything it has already published, so the
  next run continues from there. Staging directories from dead writers are removed.
- An entry that no run has used for 21 days is removed. Every report window is
  shorter than that, so only archives outside every window are removed.
- The old per-run `spendwatch-codex-zstd-*` temporary roots are still swept.

The cache holds roughly the decoded size of the archives in the longest report
window. On Studio in November 2026 that was about 15 to 20 GB.

## Regression guard

`test/codex-decoded-cache.test.ts` checks that a second run reuses the decoded
file with the same inode, modification time and change time. It also checks
that an altered or changed entry is decoded again, that fills are paced, and that
stale entries are swept.

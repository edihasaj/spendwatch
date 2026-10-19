# spendwatch

[![license: MIT](https://img.shields.io/badge/license-MIT-amber)](LICENSE) ![runtime: Bun](https://img.shields.io/badge/runtime-Bun-black) ![deps: zero](https://img.shields.io/badge/deps-zero-brightgreen)

Token/$ leaderboards **across coding agents** (Claude Code, Codex, …): which **tool calls**, **shell commands**, and **prompts** spend the most — so you know what to automate (build a CLI for `ssh`/`git diff`/`docker compose`…) or fix (a tool dumping huge results into context).

Parses each agent's local transcripts. Zero runtime deps, Bun. Agents are split out, with a cross-agent overview on top.

> **Privacy:** report and capacity rendering read local files and make no network
> calls. `capacity-current` is the one exception: it asks your own provider
> account for its current quota (Codex through the official app-server, Claude
> through Anthropic's OAuth usage endpoint) using credentials those tools already
> store locally. Optional background alerts send only the displayed account label
> and crossed percentage through the browser's encrypted Web Push service.

## Install

Requires [Bun](https://bun.sh). Run from source, or compile a standalone binary:

```sh
git clone https://github.com/edihasaj/spendwatch && cd spendwatch
bun run report                 # run directly
bun run build                  # → bin/spendwatch (self-contained, embeds Bun + SQLite); removes the .*.bun-build staging files it leaves
install -m 0755 bin/spendwatch /opt/homebrew/bin/   # optional: put on PATH
```

Apple Silicon releases are also self-contained:

```sh
curl -L https://github.com/edihasaj/spendwatch/releases/latest/download/spendwatch-darwin-arm64 -o spendwatch
chmod +x spendwatch
install -m 0755 spendwatch /opt/homebrew/bin/spendwatch
```

## Usage

```sh
bun src/cli.ts report                      # all agents, past 30 days
bun src/cli.ts report --agent codex        # one agent (claude,codex,grok,pi,omp,copilot,mission,autoreview,gemini)
bun src/cli.ts report --project chat-sql   # filter by project substring
bun src/cli.ts report --month 2026-08      # one calendar month
bun src/cli.ts report --months 3           # this month plus the two before it
bun src/cli.ts report --days 7 --json      # rolling window instead of a month
bun src/cli.ts report --html               # also write a standalone HTML report
bun src/cli.ts report --open               # write HTML + open it in the browser
bun src/cli.ts report --brief              # TL;DR: total, biggest hog, top automate targets
bun src/cli.ts report --sqlite             # append a snapshot to spendwatch.db
bun src/cli.ts report --account work       # filter by account (email/label)
bun src/cli.ts report --account-group email # optionally merge services by email
bun src/cli.ts report --label studio --json > studio.json
bun src/cli.ts report --input studio.json,macbook.json --html combined.html
bun src/cli.ts watch                        # live leaderboard, refreshes as sessions write
bin/spendwatch route "fix the typo" --repo . --file README.md
bin/spendwatch run "fix the typo" --repo . --file README.md
bin/spendwatch run "review the parser" --repo . --provider deepseek
bin/spendwatch eval routing-cases.jsonl
bin/spendwatch limits --input limits.json --html capacity.html
bin/spendwatch limits --input limits.json --sqlite spendwatch.db --history-html history.html
bin/spendwatch guard --input limits.json --account work --window weekly --min-remaining 15
bin/spendwatch server --input limits.json --sqlite spendwatch.db --public-dir public
bin/spendwatch capacity-current --provider claude   # live Claude 5h/weekly windows
bin/spendwatch capacity-history-export --label studio > capacity-history.jsonl
bin/spendwatch report                       # compiled binary (bun run build)
```

`--html [path]` writes a self-contained, shareable `index.html` (default `spendwatch-report.html`): cross-agent overview, per-agent tabs, every table with heat bars, and **click any tool/command row to drill into the actual invocations** (which files, which commands, with counts + token cost) — the "what to automate" view. `--open` writes it and opens it.

`--sqlite [path]` appends a normalized snapshot (one run per call) so you can build spend history and query with SQL — tables: `runs`, `agent_account`, `tools`, `commands`, `prompts`, `models`, `projects`, `samples`, `spend_month`, `spend_month_project`.

### Months

A report covers the **current calendar month** by default, so spend resets when
the month does. `--month YYYY-MM` reports a single past month and `--days N`
restores a rolling window (`watch` always uses one).

Turns are windowed by their own timestamp, not by the mtime of the file holding
them: a session you resume today no longer drags every earlier turn in the same
file into today's total.

`--months N` folds the last N months out of one pass over the transcripts.
Each report carries the month it belongs to, so `--json` from several machines
can be merged with `--input` and still land in the right month. With `--sqlite`
those totals are recorded in `spend_month` (one row per month and source) and
`spend_month_project` (where that month's tokens went), then shown on the
History tab: an all-time total, then one collapsed card per month with who spent
it and which projects it went to.

Closed months are never deleted and never shrink. A re-read that finds less than
the archive already holds — because session files rotate — is ignored, and its
projects are left alone with it. So the archive keeps growing past the point
where the transcripts behind it still exist:

```sh
spendwatch report --months 13 --sqlite spendwatch.db   # one-time backfill
```

Both archives compare `observed_calls` — the calls the agent itself counted —
rather than billed calls, because one turn can be billed by a subscription
gateway and still appear twice in the rollout. A report that deduped those
duplicates keeps its full month: its billed `calls` can fall below the archived
figure while its `observed_calls` cannot, so the month survives. Older rows fall
back to their `calls`. Check what a month's transcripts actually contributed:

```sql
SELECT source, calls, observed_calls, routed_calls, ledger FROM spend_report
WHERE month = '2026-10' AND source LIKE '%:codex%';
```

`calls` can fall below `observed_calls` for two reasons: Codex re-emits some
`token_count` events, which are no longer billed twice (this alone lowered an
unrouted month by about 6%), and turns the subscription gateway billed on a
subscription are counted from its ledger instead of the rollout. `routed_calls`
counts the second kind: for Codex, the rollout calls handed to the ledger; for
Claude, the Claude Code transcript calls handed to it plus the ledger rows Claude
billed; for Copilot, the ledger rows it billed. A month whose every call was
routed has `calls` of 0 and a positive `observed_calls`; it is still archived, so
it replaces an older read of that month that billed those turns in Codex. How the
archive keeps routed turns in exactly one source is described under
[Subscription gateway](#subscription-gateway).

A month holds the agents whose transcripts still existed when it was first
recorded, which is not the same as the agents you used. Claude Code rotates its
transcripts after about a month; Codex rollouts persist far longer.

With `--sqlite`, monthly exports also keep their detailed reports in
`spend_report`. Rendering reads this archive, so an empty export from a freshly
reset machine still shows the reports collected before the reset. The archive
has no automatic deletion.

Export with `--installation-id ID` when a machine can be reset. Keep the ID
stable while that installation is in use, then choose a new ID for a fresh
installation with empty agent history. The collector adds new usage to the old
installation's totals, and repeated imports do not count it twice. The first ID
adopts older unlabeled totals. If old transcripts are restored, keep their
original ID to avoid counting those transcripts as new usage.

Projects are named from the working directory each session recorded, so every
agent agrees on one name for one directory:

- A path stops at the checkout that contains it, found by looking for the `.git`
  — `Projects/spendwatch/src` is `spendwatch`, while `Projects/oss/paseo-baseline`
  keeps both segments. Where the directory is gone, a two-deep `owner/repo` is
  assumed.
- Worktrees collapse into the directory holding them, so an afternoon of agent
  work does not invent a project per generated name.
- Scratch under a hidden directory is credited to the repository around it, and
  a dated directory (`Codex/2026-08-04/<slug>`) to the tool that made it.
- Everything under `/tmp`, `/private/tmp`, or the macOS `$TMPDIR` becomes one
  `/tmp` entry rather than one project per run, and a directory stamped with an
  epoch (`oktapod-goal-polish-1779439202`) becomes one `~/scratch` entry for the
  same reason.
- Spellings that differ only in case are folded together — macOS is
  case-insensitive, so they were always the same directory.

`--label` and `--input` support private multi-machine dashboards without copying
transcript files. Export JSON on each machine, move those reports through your
own trusted channel, then render them together. The HTML opens on an **All
machines** view and breaks the same total down by machine, service-and-account,
and agent. The same email on Claude Code and Codex remains separate by default
because those services meter usage differently. Use `--account-group email`
only when an email-only rollup is intentional. Machine-agent tabs keep the
detailed source-level drill-down. Spendwatch itself still performs no uploads
or network calls.

## Model routing preview

`route` builds a phase-level model plan without calling a model or making a
network request. It combines explicit scope, repository structure, stable risk
gates, and task shape instead of trusting prompt wording alone:

```sh
spendwatch route "find the source of this build error" --repo .
spendwatch route "rename the account label" --repo . --file src/accounts.ts
spendwatch route "plan the auth migration" --repo . --risk high --json
```

The conservative policy uses GPT-5.6 Luna for strongly bounded read-only or
mechanical phases, Terra for ordinary production work, and Sol for security,
auth, payments, migrations, production, destructive, or explicitly high-risk
work. Verification failures, expanding scope, contradictory evidence, missing
tools, or stalled progress are escalation triggers. The JSON plan includes a
stable task ID, policy version, evidence, candidate decisions, phases, and
reason codes so routing outcomes can be evaluated later. `--dry-run` is accepted
for explicitness; every `route` invocation is already a dry run.

### Execute, verify, and learn

`run` turns the plan into a closed loop. It invokes `codex exec` non-
interactively, keeps one model for the work phase, runs deterministic repository
checks, and escalates Luna → Terra → Sol only after observable failure. Package
scripts named `lint`, `typecheck`, `test`, and `build` are inferred; repeat
`--verify COMMAND` to supply an exact gate instead. `--max-attempts` bounds work.

```sh
spendwatch run "fix the parser bug" --repo . --file src/parse.ts
spendwatch run "add pagination" --repo . --verify "bun test" --json
spendwatch run "add pagination" --repo . --shadow
```

Shadow mode records the proposed route while Sol remains the real worker, which
makes rollout comparisons safe. Every run and attempt is stored locally in
`~/.local/share/spendwatch/routing.db` by default, including the policy version,
planned and actual models, provider, duration, verification results, usage, and
failure evidence. It also calculates estimated model cost per successful task
from the same model-specific pricing table used by reports. Use `--sqlite PATH`
to relocate it or `--no-store` to disable storage.

DeepSeek V4 Flash is deliberately opt-in (`--provider deepseek` plus
`DEEPSEEK_API_KEY`). Its adapter is read-only, exposes bounded list/read/search
tools, and preserves `reasoning_content` across tool turns as required by the
official API. Any failed read-only DeepSeek phase escalates into the Codex
tiers; repository mutation always starts with Codex.

`eval` replays representative JSONL cases without model calls. This is the
promotion gate for policy changes:

```json
{"task":"inspect the parser","expectedModel":"gpt-5.6-luna","expectedKind":"read-only"}
{"task":"migrate production data","expectedModel":"gpt-5.6-sol","expectedRisk":"high"}
```

```sh
spendwatch eval routing-cases.jsonl
spendwatch eval --sqlite ~/.local/share/spendwatch/routing.db --json
```

## Capacity dashboard

`spendwatch limits` turns sanitized provider capacity JSON into a focused
planning page with one account card per identity. Cards show only account,
plan, freshness, reported quota windows, reset times, and pace forecasts;
unreported windows are omitted instead of shown as empty limits. Claude shows
rolling 5-hour and weekly capacity; Codex shows whichever windows its live
account response currently reports (including the five-hour window when
available under a model-specific Codex limit ID). A Codex account that has bought
credits also shows its balance next to the plan name; those credits are what
keeps the account working once the weekly window is spent, so they are reported
even at 0% left. Accounts with no credits stay uncluttered. Copilot is paced against a manual
monthly ceiling instead of GitHub seat maths: 40,000 AI credits for $400 per
calendar month, which fixes the credit price at $0.01. The card shows credits
used against that budget, percent left, the money spent against the $400 cap,
the per-credit price, paid-overflow status, and monthly reset, and it gets the
same pace forecast and utilization plan as the subscription providers. The
ceiling only reports, it never blocks: past it the card switches to
`Over budget by N credits`, shows the dollars spent beyond the cap, and the plan
turns to `More capacity`. Browser alerts follow the same 30/15/10/5/0 steps as
weekly quota, so the 0% alert is the notification that the budget was passed,
sent once per monthly cycle. Override
the ceiling with `SPENDWATCH_COPILOT_MONTHLY_CREDITS` and
`SPENDWATCH_COPILOT_MONTHLY_USD`. For a euro reporting ceiling, set
`SPENDWATCH_COPILOT_MONTHLY_EUR=400` and `SPENDWATCH_USD_EUR_RATE` to the
number of euros per US dollar. `SPENDWATCH_FX_RATE_DATE` records the quote date.
The EUR card converts GitHub's $0.01-per-credit value, displays the dated
estimate, and derives the matching credit allowance. It keeps warning and
pacing behavior; it does not enforce a GitHub spending cap. Subscription fees
and taxes are outside this usage-value meter. Rendering makes no FX requests.
When GitHub reports no monthly reset the next
UTC month boundary is used. It never labels paid overflow as unlimited. API-backed
Lokai routes show sanitized cash balances; route
readiness without a reported balance is never labeled unlimited. Grok Build
publishes neither a quota nor a balance: the xAI plan absorbs the usage and the
CLI holds no API key, so its card reports what was *sent* over a rolling 24 hours
and 30 days rather than an allowance to pace. Those dollars are API-equivalent
estimates at published list rates, not billed money, so the card is excluded from
the utilization planner and from `guard`. Cards render Claude, Codex, Copilot,
Lokai, then local Qwen and Grok, keeping the providers without an allowance last. When the input
includes a reported pace forecast, Spendwatch shows its learned deficit/reserve
and run-out ETA. Other reset windows get a transparent live linear forecast.
That fallback starts as soon as a new window begins, so newly reset Claude
windows immediately show whether their capacity lasts until reset.
Local Qwen is a separate self-hosted card: it is explicitly **Unlimited** only
when the collector declares it so, and shows client-measured tokens from each
calling machine with a $0 provider fee. It has no quota window, reset forecast,
or automatic routing recommendation. The card's readiness is only the latest
sampled route state; missing readiness is shown as unknown rather than
available. Token totals include only machines with a successful client report;
missing reports stay visible as partial coverage, never a zero-use reading.
Repeated uploads keep the newest snapshot per machine before totals are added,
so collector retries cannot inflate usage.
Cycle-average pace hides a burst until the damage is done, so each quota window
also carries a **burn** line measured from the recent slope inside the current
cycle only: a 5-hour window looks back 30 minutes, a weekly window 6 hours.
It reads `Burn 18%/h · safe 4.8%/h · 3.7×`, where *safe* is the rate the
remaining allowance affords until reset and the multiple is how far past it the
recent spend sits. When that rate cannot reach the reset, the line gives the
run-out ETA and how long before the reset it lands. Burn needs at least three
samples in the current cycle, and is omitted for exhausted, stale, or expired
windows, which have no trustworthy rate to report.
Quota tracks place a three-stripe marker at the expected remaining capacity:
green means usage is on or slower than budget, while red means faster.
Reset, run-out, and freshness countdowns use a compact two-unit style:
minutes below one hour, hours below 24 hours, then days (`23h 15m`, `1d 1h`).
When collectors include `source-health` records, cached values are explicitly
marked live, stale, or offline. A compact **Best now** rail ranks fresh Codex
and Claude accounts by session headroom, weekly headroom, pace, and forecast.
After at least three completed 5-hour windows are present in SQLite, the weekly
card also estimates how many typical session quotas remain using median learned
weekly burn.

The dashboard includes a 90% utilization planner for subscription-backed capacity.
Resetting Codex and Claude allowances show projected utilization and the
percentage points per hour or day needed to finish near 90%. Subscription calls
use a 10% interruption buffer. Live projection begins with the first measurable
usage, so early-cycle cards immediately say where to shift work while purchase
and downgrade guidance remains cautious until more of the cycle has elapsed.
Rebalance existing accounts first, add capacity
only for a credible run-out or projection above 105%, and consider less capacity
only below 60% after half the cycle and confirmation in another cycle. Copilot
waits for the organization pool and budget totals. PAYG API and token-credit
balances remain visible on their normal capacity cards, but are excluded from
utilization targets and subscription-sizing guidance because they have no fixed
allowance or reset cycle.

Capacity, History, and Spend detail share a phone-first navigation grid, 44px
touch targets, safe-area spacing, compact cards, and locally scrollable wide
tables so the document itself never overflows the mobile viewport.

The exported dashboard only validates and renders the supplied file. It never
reads tokens or fetches capacity data. Account setup happens on a trusted Mac
through each provider's official login:

```bash
spendwatch account add codex --name work       # ChatGPT browser OAuth
spendwatch account add claude --name work      # Claude browser OAuth
spendwatch account add copilot                 # GitHub browser OAuth
spendwatch limits --input agent-limits.json --html capacity.html
spendwatch limits --input studio.json,macbook.json --json
```

Every named Codex account gets its own `CODEX_HOME`, while the official Codex
CLI owns login, refresh, and
`auth.json`. Spendwatch validates the returned identity and discovers the
profile; it never copies OAuth tokens into its database. Use `--device-auth`
for a headless Codex login. For live quota reads, Spendwatch discovers the
native Codex CLI in `/opt/homebrew/bin/codex`, then `/usr/local/bin/codex`,
before falling back to `~/.local/bin/codex` or `codex` on `PATH`; set
`SPENDWATCH_CODEX_BIN` to choose a specific binary. This default discovery
order applies only to quota reads and does not change the configured inference
gateway. Metered API keys are also supported without placing the secret in argv
or shell history:

```bash
export OPENAI_API_KEY=... # preferably injected by your secret manager
spendwatch account add codex --name api --api-key-env OPENAI_API_KEY
spendwatch account add grok --name personal     # Grok browser OAuth
```

Claude uses an isolated `CLAUDE_CONFIG_DIR`; GitHub CLI owns Copilot's
multi-account credentials. Lokai remains API-key based through the existing
local LiteLLM/1Password configuration. Failed logins retain their profile
directory for inspection or retry; Spendwatch performs no cleanup/deletion.

Duplicate accounts are merged within each provider using the freshest snapshot,
while retaining the names of every contributing device. The input format is the
capacity-only projection produced by a trusted local collector. Keep credential
acquisition outside Spendwatch so an exported dashboard never needs account
tokens.

`capacity-current` deduplicates local profiles before contacting a provider and
reserves at most one attempt per provider and account every five minutes. Its
SQLite cache retains the original sample time. Failures back off; an HTTP 429
starts a one-hour cooldown, doubles on repeated rate limits up to four hours,
and honors a longer `Retry-After`. A crashed read still consumes its reservation.

For several machines, configure one private dashboard server as their shared
coordinator using `SPENDWATCH_CAPACITY_COORDINATOR=https://your-dashboard/`, or
`{"coordinator":"https://your-dashboard/"}` in
`~/.config/spendwatch/polling.json`. The server keeps account reservations,
sanitized capacity results and cooldowns in its existing SQLite database.
Machines share cached results instead of repeating provider reads. If the
coordinator is unavailable, collectors use cached data without contacting
providers. Credentials stay on the source machine. Without a coordinator, the
same gate applies locally in `~/.local/share/spendwatch/capacity-poll.db`
(`SPENDWATCH_CAPACITY_CACHE` overrides that path).

Collection must still run periodically to keep capacity current; refreshing the
browser only renders stored readings. A capacity-only worker can run separately
from transcript and spend-history collection.

Collectors may also emit sanitized `authentication-required` records. The
dashboard then shows provider-specific sign-in links for Codex, Claude, or
Copilot and opens the matching local setup command. API credentials and OAuth
tokens remain on the source machine.

With `--sqlite`, every capacity check is appended to `capacity_history` and
`capacity_account_history`. History stays live until an explicit verified
archive. `--history-html` builds a third dashboard tab with 24-hour through
all-time ranges and a past-month picker. Import recoverable Codex session
history with repeatable
`--history-input` JSONL or `.jsonl.gz` files. Imports are idempotent:

Capacity refreshes visible values every 15 seconds without navigating or
reloading the document. History does the same every 60 seconds while preserving
the selected range or calendar month. Manual Refresh buttons also update only
their current view's values and retain tabs, expanded rows, and scroll position.
View refresh is not provider collection. The dashboard server re-evaluates
stored quota freshness on every Capacity request, so a snapshot becomes
`Not current` or `Cycle ended` even when no collector runs. It suppresses stale
pace forecasts and recommendations without contacting providers or adding
history samples. The displayed update time remains the stored snapshot's time.
Session-equivalent forecasts use the newest 5,000 paired history samples. The
query selects matching timestamps before aggregation, avoiding a full-history
aggregation on refresh. Newer unmatched windows do not hide older pairs.
Background alerts are opt-in per browser. The server registers a service worker
and sends one weekly notification per account at 30%, 15%, 10%, 5%, and 0%.
A large usage jump produces only the most severe newly crossed threshold, so it
never emits a burst. Event and per-device delivery state live in SQLite and are
keyed by the weekly reset, making each threshold eligible again only after the
account enters a new window. The service worker receives notifications while
the dashboard is closed. Enabling alerts immediately sends a test notification.
The alert control remains available for retry until the first test or threshold
notification is delivered successfully, then disappears across page reloads.
VAPID keys are generated once in SQLite and included in normal database backups.
The same Spendwatch gauge mark is used for browser favicons, installable-app
metadata, and Web Push notifications. Copy the **contents** of `assets/icons/`
directly into the server's `--public-dir` beside the rendered HTML files, not
into a nested `assets/icons/` directory:

```bash
rsync -a assets/icons/ /path/to/public/
```

The private dashboard server combines static hosting, subscription management,
and threshold monitoring:

```bash
spendwatch server --input limits.json --sqlite spendwatch.db \
  --public-dir public --host 127.0.0.1 --port 8899 \
  --vapid-subject mailto:operator@example.com
```

### Chrome New Tab

The unpacked extension in `chrome-extension/` displays your self-hosted
dashboard across the full New Tab page while leaving Chrome's omnibox ready for
a search. On first use, enter the dashboard URL and approve access to that exact
origin. The URL is stored in Chrome sync; the public source and extension
package contain no deployment hostname. When the host is temporarily
unavailable, the extension retries every 30 seconds and also retries as soon as
the browser comes online. Connection and frame timeouts prevent a stalled
private route from leaving the New Tab page stuck loading.
The page also renders the profile's Bookmark Bar bookmarks in a Chrome-style
strip using Chrome's `bookmarks` and `favicon` permissions. All Bookmarks stays
fixed at the right, and bookmarks that do not fit move into the native-style
`»` overflow menu between vertical separators.
Bookmark data stays in the browser and is never sent to the dashboard.
Open tab groups across Chrome windows appear first as native-colored chips,
ordered by their window and tab-strip position. Selecting a chip focuses its
window and first tab; group and tab changes update the bar live. Because Chrome
does not expose closed saved groups to extensions, Spendwatch mirrors each group
into browser-local extension storage when it is opened. The outlined chip stays
after the group closes and recreates its tabs when selected. Open each existing
saved Chrome group once to seed its mirror; right-click a closed-group chip to
forget it. Up to three small group pills appear before the bookmarks, with
additional groups under `+N` so bookmark spacing stays stable. This uses only
the browser extension, with no native background app.

Android Chrome does not run Chrome extensions or allow a New Tab override.
On Android, open the dashboard and use **Install app** instead. Spendwatch
installs as a standalone PWA with the same Capacity, Spend detail, History, and
Web Push alert features. The install control appears only when Chrome reports
that the current device and site are eligible.

To install it in Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `chrome-extension`
   directory.
3. Open a new tab, enter the dashboard URL, and approve access to its origin.
4. Keep the private network connection active when your dashboard requires it.
   Disable any other extension that replaces the New Tab page, because Chrome
   permits only one active override.

Change the URL later from the extension's **Details → Extension options** page.
Private deployments may replace the blank `deployment-config.json` while
packaging the extension; never commit that deployment-specific replacement.

After changing these extension files, use the reload button on its card in
`chrome://extensions`.

After enrolling a browser, verify true closed-page delivery from the server host:

```bash
spendwatch push-test --sqlite spendwatch.db \
  --vapid-subject mailto:operator@example.com
```

`spendwatch guard` makes the same capacity safe for scripts. Exit `0` means the
minimum is available, `1` means blocked, and `69` means the account or window
is unavailable. `--fail-open` converts only the unavailable result to exit `0`:

```bash
spendwatch guard --input limits.json --provider codex --account work \
  --window weekly --min-remaining 15
```

```bash
spendwatch capacity-history-export --label studio | gzip -1 > studio-history.jsonl.gz
spendwatch limits --input limits.json --sqlite spendwatch.db \
  --history-input studio-history.jsonl.gz --history-html history.html
```

For bounded storage, preview rows older than one year, then archive them into a
compressed SQLite file. Spendwatch restores the archive into a scratch database
and verifies its row counts before deleting matching live keys. `--force` is
required for cleanup; archives are never deleted automatically:

```bash
spendwatch capacity archive --sqlite spendwatch.db
spendwatch capacity archive --sqlite spendwatch.db --force
spendwatch capacity restore data/archives/capacity-before-2025-08-12-20260812T000000Z.db.gz --sqlite restored.db
```

Restore uses `INSERT OR IGNORE`, so retrying is safe. Use `--no-vacuum` when
SQLite should reuse freed pages instead of shrinking the file immediately.
After cleanup, recurring full-history imports ignore samples below the archived
cutoff so they cannot silently refill the live database.

The history export contains only account identity, timestamps, quota
percentages, window lengths, resets, plan, and device labels. It never exports
prompts, transcript text, or authentication tokens. Account identity comes from
the matching Codex profile's local authentication metadata.

## Multi-account

Accounts are auto-detected per agent (Claude `~/.claude.json` email, Codex auth
JWT email, Grok `auth.json` email). Reports **tag by account but sum per agent**.
Codex and Grok automatically load `~/.codex/sessions` and `~/.grok/sessions`
plus every `~/.codex-*` / `~/.grok-*` profile, so separate desktop or CLI
accounts such as `~/.codex-secondary` require no configuration.

Because the same email can be signed in to several homes, Codex and Grok
accounts carry the profile home in brackets: `~/.codex` shows as `(main)` and
`~/.codex-<name>` as `(<name>)`, e.g. `me@example.com (tertiary)`. A rollout present in more than
one home — homes are often copy-on-write clones of each other — is billed once,
and credited to the named profile rather than the `~/.codex` playground.
`--account-group email` ignores the bracketed profile so one person still merges
across agents.

Codex homes signed into a **free** ChatGPT plan are skipped: they carry no
subscription spend, so they only add noise to a $ leaderboard. This applies to
`report`/`watch` and to `capacity-current`/`limits`. Set
`SPENDWATCH_INCLUDE_FREE=1` to include them.

`SPENDWATCH_CLAUDE_ACCOUNT` and `SPENDWATCH_COPILOT_ACCOUNT` name the Claude and
Copilot account outright, for every transcript and gateway row that has no
account of its own, instead of reading the signed-in login from
`~/.claude.json` or the `gh` user from `~/.config/gh/hosts.yml`. The test suite
sets both, so it never reads a real login.

For custom locations or explicit labels, create
`~/.config/spendwatch/config.json` (or `$SPENDWATCH_CONFIG`). Explicit config
roots replace automatic discovery:

```json
{ "roots": [
  { "agent": "claude", "account": "work",     "path": "~/.claude/projects" },
  { "agent": "claude", "account": "personal", "path": "~/personal/.claude/projects" },
  { "agent": "codex",  "account": "work",     "path": "~/.codex-secondary/sessions" },
  { "agent": "codex",  "account": "personal", "path": "~/.codex/sessions" },
  { "agent": "grok",   "account": "personal", "path": "~/.grok/sessions" }
] }
```

Each account shows under **BY ACCOUNT** within its service tab. The combined
view defaults to **BY SERVICE & ACCOUNT**. Agent totals still sum their own
accounts. Stable **Account 1**, **Account 2**, and later chips identify the same
service account across machines. Filter with `--account <substr>`.

## Sources

| agent   | logs | token usage |
|---------|------|-------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✓ |
| Codex CLI   | `~/.codex/sessions/**/rollout-*.jsonl`, plus `~/.codex*/archived_sessions` | ✓ |
| Grok CLI    | `~/.grok/sessions/**/updates.jsonl` | ✓ |
| Copilot CLI | `~/.copilot/session-store.db` | ✓ per-request token usage and reported AI-credit value |
| Mission Runtime | `~/Projects/mission-runtime/.mission-runtime/authority.sqlite` (or `$MISSION_RUNTIME_DB_PATH`) | ✓ per attempt and model, from its own usage records |
| AutoReview | a job-ledger JSONL named by an `autoreview` config root | ✓ per attempt and model, from its own usage records |
| Gemini CLI  | `~/.gemini` | ✓ when present |
| Subscription gateway | `<state>/usage/usage-YYYY-MM.jsonl` | ✓ per-call tokens, plus AI credits for Copilot rows |

Copilot reads the local `assistant_usage_events` ledger in read-only mode. It
keeps each request in its actual calendar month, separates cached input from
uncached input, and uses reported nano-AI-credit charges when available instead
of estimating them from a model list. Compatible Copilot Chat stores in Code,
Code Insiders and Cursor are detected too. Copies of the same session are
counted once. Legacy stores without this ledger and Gemini logs remain footnotes. Adding a new agent = one parser emitting the shared `Event` model + a `sources.ts` entry.

Mission Runtime and AutoReview leave no transcripts, so Spendwatch reads the
`agent-usage.v1` records they write about their own usage. Mission Runtime is
read in read-only mode from its authority SQLite store (`MISSION_RUNTIME_DB_PATH`
overrides the default path, and a `mission` root of a config names another
store); only the `mission_run_outputs` rows whose key starts with `usage:` are
read, plus the repository key and start time of the run (the repository becomes
the project, and no other part of the run's spec is read). A store that Mission
Runtime has closed cleanly has no `-wal` file, so it is opened as immutable,
which writes nothing. A Mission Runtime record is dated at the run's start
(`mission_runs.created_at`, else the row's last update), so an attempt that runs
past the 1st stays in one month; the `--days` and `--month` windows still select
rows by their last update. AutoReview
has no default location: add a root such as
`{ "agent": "autoreview", "path": "~/autoreview/jobs.jsonl", "account": "ci" }`
that points at its JSONL job ledger, where a later line for an attempt replaces
the earlier ones. `--agent autoreview` without such a root says what is missing. A record is cumulative for its attempt, so each attempt and
model is one "call" in a report, not one per turn (an AutoReview record is
dated at its last update). Input is gross in the record; Spendwatch bills the cached
and cache-write tokens apart from the rest, and uses the reported cost when the
record has one. Without an `account` in the config, the account is the
entry's provider.

Codex calls are read per response: one call for each `token_usage_record`
(its `response_id` is the call), falling back to `token_count` events for
rollouts written by a Codex build that has no record. A `token_count` that
repeats the previous one is a re-emission, not a second call, so it is no longer
billed twice. Cache writes (`cache_write_input_tokens`) come out of the input
and are priced as cache writes instead of as plain input, in a `token_count`
fallback as well as in a record. Totals read before this
change were higher by the repeats and priced the cache writes as input.

Grok reports token usage once per prompt-turn, covering every model call its
agentic loop made for that prompt, so its **API calls** count turns rather than
individual requests. Cost uses xAI's published per-model rates including the
200k-token long-context tier; on captured turns that agrees exactly with the
cost Grok itself reports. Grok exposes no quota endpoint, so it appears in the
spend report but not in `capacity` or `guard`.

### Subscription gateway

A gateway can bill a coding agent's turn on a Copilot or Claude subscription
instead of an API key, and it keeps a month ledger of what it billed. It serves
Codex through `/v1/responses` and, from Harness Gateway 0.4.4, Claude Code and
other Anthropic Messages clients through `/v1/messages`. Spendwatch reads that
ledger as a source, so a routed turn is counted once — by the subscription that
paid for it — instead of twice. Codex rollouts and Claude Code transcripts are
deduped against it; no other agent's transcript is.

Rows are read from `usage/usage-YYYY-MM.jsonl`, oldest month file first. The
state directory is, in order:

1. a `{ "agent": "gateway", "path": … }` root in an explicit spendwatch config;
2. `$SPENDWATCH_GATEWAY_STATE`;
3. the `stateDirectory` key of the gateway's own config, read the way the gateway
   reads it: relative to the directory holding that config, and `.state` when the
   key is missing. The config is `$SPENDWATCH_GATEWAY_CONFIG`, else
   `~/Library/Application Support/Subscription Gateway/gateway.json` on macOS and
   `~/.config/subscription-gateway/gateway.json` on Linux. The gateway's own
   `$GATEWAY_CONFIG` is deliberately not read, because a shell pointed at a
   development gateway must not redirect the spend of the installed one;
4. only when there is no gateway config at all, a `state` directory beside where
   it would be (the layout `gateway setup` creates).

A state directory without a `usage` directory means this Mac has no ledger: then
nothing is counted from it and no rollout call is dropped because of it. Only
`stateDirectory` and, for Claude and Copilot subscription providers,
`authDirectory` are read from that config. `SPENDWATCH_GATEWAY_SOURCE=off` skips
the ledger; with an explicit `~/.config/spendwatch/config.json`, only a gateway
root switches it on. `$SPENDWATCH_GATEWAY_PROVIDER_MAP` (`copilot=claude`, or
JSON) retargets the provider names a telemetry row without a provider type can
arrive with; a name mapped to anything but `claude` or `copilot` is dropped.

**Marker family.** The gateway marks the id of every call it bills on a
subscription with one of two prefixes, each followed by the same gateway request
id without dashes: `resp_gl_<id>` on a Responses id, which Codex records in its
rollout, and `msg_gl_<id>` on a Messages id, which Claude Code records as the
message id in its transcript. Spendwatch treats both as one marker family and
accepts either wherever it matches a marked id: in the ledger's billed rows, in
Codex records, in Claude Code transcripts, and where the reports of several Macs
are settled. A row or record with any other id is not marked.

| the ledger says | what spendwatch does |
|---|---|
| gateway-origin row with a marked response id (`resp_gl_*` or `msg_gl_*`) | counts the row; a Codex rollout record or a Claude Code message with exactly that id is dropped |
| a Codex record or Claude Code message with a marked id that this Mac's ledger holds no row for | keeps it in Codex or Claude as `<model> (gateway-routed, not in this Mac's ledger)`, priced from its tokens as before, says so under the report, and takes it out again wherever its report meets the serving Mac's (see *Several Macs*) |
| telemetry row with `session: true` that a rollout claims — same model, same input and output tokens, within 30 seconds | counts the row once, and drops the rollout's copy |
| telemetry row with `session: false` | counts the row directly: its request carried no Codex session id, so no rollout exists to dedupe against |
| a rollout call with no response id (`token_count` only, from a Codex build without `token_usage_record`) that matches a billed `resp_gl_*` gateway row the same way | counts the gateway row once, and drops the rollout's copy |
| an unmarked gateway row, or a telemetry row nothing claimed | leaves it to the transcript, which already bills it |

A rollout's provider comes from its own `session_meta`, the first one in the
file. A forked rollout copies its parent's `session_meta` after its own, and that
one describes the parent thread, so it never changes which calls count as routed.

Claude Code writes one transcript line per content block of a reply, each with
the message id, so all the lines of one marked message are one call. They wait for
the message's row together and are decided together, and a message billed from its
transcript is billed once, with the usage of its last line. Claude Code writes
those lines when the reply ends but stamps each one with the time its block began,
so a line can reach the transcript more than a minute after its stamp. A message
therefore waits for its row from the moment its line was read, but never from
later than two minutes past its stamp, so a transcript read long after it was
written is decided at once. A message id found in two transcripts is one call too, billed once, as a
forked rollout's copies are. A `msg_gl_*` row is matched only by its id, never by
model, tokens and time, because Claude Code records the id of every call; so a
Codex `token_count` never stands on the row of a Claude Code call.

A transcript's decisions reach the ledger even when a filter leaves the transcript
out of the report, as a rollout's do: `--project` and `--account` still read the
Claude Code transcripts they leave out, for those decisions only, and an `--agents`
subset without Claude still reads them while this Mac's ledger holds a `msg_gl_*`
row. So a late row is billed the same in `report --agents copilot` as in the full
report. Like the Codex claims, this is decided when the sources are found: a
`watch --agents copilot` started before the ledger held its first `msg_gl_*` row
reads no Claude Code transcripts until it is restarted.

Telemetry rows are not written per call. The gateway imports its pre-ledger
request history once, when the ledger is first created, and `session` records
whether that request carried a Codex session id. So `session: true` rows count
only while the rollouts that vouch for them still exist on this Mac, and a
`--agents` subset still reads the Codex rollouts for those claims (reporting
nothing for Codex), so `report --agents claude` shows the Claude spend of the full
report. An `--account` filter keeps the claims of the rollouts it leaves out as
well.

A claim takes the free row nearest in time to the call. A `token_count` carries no id
and its own row may not have landed yet, so it prefers a billed row to a telemetry
row: a telemetry row it took would bill the call a second time once its own row
came. `watch` reloads the ledger on every tick and hands such a claim to the best
row again each time. A call is matched to a row by model, tokens and time alone, so
alike calls and rows are interchangeable; when a call finds every alike row taken,
the calls standing on them step to another free alike row (within their own 30
seconds, and as far as that chain goes, however long it is) to leave it one. A call
that finds no row this way is left alone until the ledger gains a row. A marked
record dropped on the strength of its row holds that row, so a `token_count` of the
same size cannot be dropped on it as well; if one already stands there and cannot
move, the record is billed from its rollout as the plain call it is, because the row
bills the other call. A fork copies its parent's records, so one marked response can
sit in two rollouts: it is one call, and it is billed once. So a call that another
Mac's gateway served, and has no row here, may stand on a neighbour's row for a
while, but never keeps a call without a row that a different arrangement would give
one: each call with a row is billed once, in a report and in `watch`, whichever
order the rows landed in and the rollouts were read.

What no ledger can tell apart without an id on the call, and so what can still be
billed wrong, is limited to a `token_count` (no id) whose own row is not in this
Mac's ledger — another Mac's gateway served it, or its row has not landed — next to
an alike billed or imported row that belongs to another call:

- the `token_count` can stand on that other call's row, and the row then bills one
  call for two. If that call's record is on this Mac, the record is read, finds the
  row taken, and is billed as a plain call: the figure is short by one only until
  the record is read, for instance in a report taken between the gateway's row and
  the rollout's line. If the record is on another Mac whose report is settled
  against this one, that Mac's copy is taken out against the row, and the call is
  lost for good: the two Macs together are short by one. Only a `token_count`
  triggers this, so only a Codex build that writes no `token_usage_record` can;
- a `token_count` served by a Mac in the set, though, has no id to settle with: the
  client's report counts it from its rollout and the serving Mac's ledger bills its
  row, so the pair is billed twice;
- the history import of a new ledger writes a telemetry row for each earlier
  request. A report that reads while the ledger is being created can let a
  `token_count` stand on one of these before its own row is written, and bill the
  call by both rows; the next report and the next `watch` tick bill it once. This
  can happen only around the creation of the ledger.

Everything else — records with an id, a fork's copies, alike calls and rows in any
number, rows that land late, rollouts that are read in any order or filed away — is
billed exactly once; the seeded fuzz tests below check it.

Rows are keyed by `<host>:<requestId>`, so one call recorded twice counts once
and the gateway's own row wins the key: it is the row carrying the charge. A
row without a request id names no call and is dropped. So is a row a gateway
could not have written: a token count that is negative, fractional, infinite or
beyond what a double holds exactly (an input and output that together pass it
too), or a time no date can hold. A count that is missing or is not a number
(`"5000"`, `true`) reads as 0, and cache reads and writes are capped at the input
they are part of.
Copilot rows are labelled as they were billed:

| label | the row |
|---|---|
| `<model>` | credits complete |
| `<model> (partial credits)` | fewer credits arrived than the call cost |
| `<model> (unpriced)` | none arrived, or the figure was negative or beyond what a double holds exactly |
| `<model> (telemetry backfill)` | from the telemetry import, with credits |
| `<model> (telemetry backfill, partial credits)` | from the telemetry import, with partial credits |
| `<model> (telemetry backfill, unpriced)` | from the telemetry import, with no credit figure |

Copilot cost is `nanoAiu / 1e11` dollars, and an imported row keeps the credits it
carries. Claude rows carry no credit figure at all, so they are priced from their
tokens under the model alias, and only gain a `(telemetry backfill)` suffix when
telemetry is where they came from. Codex and self-hosted rows are ignored: this
ledger bills neither. A gateway row's subscription is read from its provider type;
only an imported telemetry row without one is placed by its provider name.

Gateway rows join the Claude and Copilot tabs — that is whose subscription paid —
under the project `gateway`, and under the account the provider billed. `--project`
narrows the project and prompt lists but never drops them from the Claude totals, as
it never drops them from Copilot's or Codex's. A provider
can sign in under its own `authDirectory`: a Claude provider's turns go to the
account in `.claude.json` inside it, a Copilot provider's (its `COPILOT_HOME`) to
`lastLoggedInUser.login` in its `config.json`. A provider without one goes to the
default account of that subscription (the signed-in Claude account, or the
`gh` user), and a directory that holds no signed-in account is named after the
directory, never folded into the default one. Each account gets its own stream.
Rollouts and Claude Code transcripts are always read before the ledger, because a
transcript can only give up a turn it has already asked the ledger about.

The gateway names its month files by UTC month, so spendwatch picks the files a
window needs in UTC too; in a zone east of UTC the previous UTC month's file holds
the first hours of the new local month. The window is widened by the 30-second
claim window, so a call filed in the last seconds of one UTC month still finds its
row when its rollout line landed in the next and that month is read alone. Account
labels are resolved once per read and rows are matched through an index, so a
ledger of 100,000 rows is read and grouped in well under a second, and `watch`
can reload it on every tick.

`watch` finds every rollout again on each tick and reloads the ledger, so it keeps
each rollout's parser state between ticks, and replays on the reloaded ledger what
the rollouts already decided (rows they claimed, calls they billed themselves).
Every rollout's decisions are replayed together, before any rollout reads a new
line, in the order they were made and each on the very row it held, so a rollout
that is read first cannot take a row another rollout's earlier call holds, and a
row that lands more than 30 seconds late still goes to the call it belongs to. The
ledger and a native Copilot session store hand `watch` all their events on every
tick, not only what is new, and each fold replaces the last one, so a row that stops
billing (a rollout's own bill now covers it) stops counting. A routed
turn that arrives after the first tick is still recognised as routed, and a
rollout Codex moves into `archived_sessions` while watched carries on from where
it was read instead of being read again from the top. Each tick applies the same
`--account` and `--project` filters as the first read, and the window stays open
for everything written while `watch` runs. A tick that finds nothing new, in the
rollouts, in the ledger or in a native Copilot session store, draws nothing: the
ledger's rows are folded again only when its files (their lengths and modification
times, so a row rewritten in place shows) or the rows that bill changed, and a
Copilot session only when one of its rows, or a figure in one, changed. A
session's rows are read once per tick, and both the check for a change and the
fold come from that one read. The table has no index on the session, so a store's
sessions are read 50 at a time instead of with a scan each: a store of 1,000,000
rows in 1,000 sessions is read in a few seconds the first time. A store that
has not been written to for two seconds, by its size and modification time and
those of its write-ahead log, is as it was at the last tick: an idle tick reads
nothing from it at all (about 20 ms for that store). A store written more recently,
or with a write in progress, is read again, because a size and a time cannot vouch
for it yet.

The gateway appends a call's ledger row just after the response ends, so the
rollout or transcript line can come first. A routed call with no row yet — a
marked Codex record or Claude Code message, or a `token_count` that could match
a billed row — therefore waits for it instead of being billed at once: `watch` checks it against the ledger it
reloads on each tick, its first read included (a call younger than the claim
window is left waiting there too), and a report first reads the rows the gateway
appended since the report loaded the ledger, before it bills any call from the
rollout: when the report ends, and also when a call has waited out its claim
window while a long read was still going. Such a row joins the account stream
it belongs to if the ledger already had rows for that account; a row of an
account it had none for is left out and never covers a rollout call, and a
gateway row for a call the ledger held only as the telemetry echo replaces the
echo, as a fresh load would. This is the same whichever `--agents` were asked
for, so a run limited to Codex bills the same Codex calls as the full one. The
call is billed from the rollout or transcript (a marked call as
`(gateway-routed, not in this Mac's ledger)`) only when no row has come within
the 30-second claim window, or when a report ends. A row that arrives later still
does not bill it a second time, in the same read as well: the ledger remembers
the calls the rollouts of the read billed, and the row a later refresh finds for
one of them is that call's, not a second bill. While it waits, `watch` shows the
call in neither tab.

**Several Macs.** A routed turn is counted once, on the Mac whose gateway served
it, under the provider's account. A Codex or Claude Code client whose turns
another Mac's gateway served cannot prove from its own files that a ledger
counts them (neither a rollout nor a transcript records the serving host), so
its own report keeps them, labelled
`(gateway-routed, not in this Mac's ledger)`, says so under the report, and
lists each such call by its gateway request id (the part of `resp_gl_<id>` or
`msg_gl_<id>` after the marker) with its tokens, cost, model, account, project and time — nothing
about its content. The serving Mac's Copilot or Claude report lists the ids it
billed from its ledger. Wherever the two reports meet, the client's copy is taken
out of its Codex or Claude totals, model, account, project and daily token rows,
and the turn stays on the serving Mac:

- `report --input a.json,b.json`, in the text and HTML reports and their
  "All machines" view, across every month the inputs hold;
- the spend archive: the reports `report --sqlite` shows, the monthly history
  and its projects, and `spendwatch tokens`. Each report is archived as its Mac
  read it and settled when read back, so the fullest-read rules below never
  compare figures that depend on which other Macs were collected.

`report --json` passes the reports on as measured, so the collector that combines
them can settle them against the others. A client turn that no report in the set
billed stays in the client's Codex or Claude tab, so a serving Mac that does not run
Spendwatch loses nothing. A client with `SPENDWATCH_GATEWAY_SOURCE=off` still
lists its marked calls (under their plain model name), so they are settled the
same way. A rollout that records only `token_count` carries no id: it is matched
against this Mac's ledger by model, tokens and time, and on any other Mac it is
counted from the rollout, unlabelled, and the report says that such rollouts were
found. `SPENDWATCH_GATEWAY_SOURCE`, the gateway root and the Spendwatch version
should be the same on every Mac.

**The spend archive keeps routed turns in one source.** A month read with this
Mac's ledger counts the routed turns it holds in the Claude and Copilot reports
and drops them from Codex and from the Claude Code transcripts; read without it
they stay there. Each archived
report records whether the ledger was read (`ledger`) and how many routed calls it
billed through it (`routed_calls`, in `spend_month` and `spend_report`):

- a read that billed fewer routed calls never replaces one that billed more — the
  source switched off, a ledger month pruned after 13 months, or a rollout that
  vouched for a telemetry row gone — and its daily token rows are left alone. So are
  the daily rows of a read that billed more routed calls but observed fewer (a
  rollout deleted while more turns became covered): the two reads place routed turns
  in different sources, so their days are never merged;
- the first time a month's Codex, Claude and Copilot reports take a read with
  routed calls while any of them holds a read without the ledger, they change
  together or not at all. All of them must offer a fuller read; a source the run
  did not read (a `--agents` subset, or one that reported nothing) holds them
  back, unless it is Claude or Copilot and its own read shows that it routed
  nothing. Until then the month keeps its earlier reads, daily rows included;
- after that, each source keeps its fullest read as every month does. A Claude
  month whose oldest transcripts have rotated keeps its earlier read, and with it
  the routed Claude turns that read held; routed turns billed after that read are
  not added to it, just as its native turns are not.

An archive written before these columns is treated as read without the ledger,
with no routed calls.

## What to automate

The **AUTOMATE — top targets** list (top of the report, and `--brief`) ranks shell commands by **cost × frequency × friction** — the build-a-CLI/MCP shortlist. Friction is measured, not guessed: Claude `tool_result.is_error` and Codex exit codes. A `why` column tells you the driver:

- `frequent + costly` — high spend, lots of calls → wrap it in one tool
- `fails N% · flaky` — the command errors often (the agent retries, burning tokens)
- `exit-127 · agent guessing` — command-not-found: the agent doesn't know this tool → give it a CLI/MCP

> **Honesty note:** spendwatch does **not** invent a "you saved $X" number — that's an unmeasurable counterfactual. It shows *observed* cost and *measured* friction (error/retry rate). After you automate something, its cost and error rate drop and you see it in the data.

## What the numbers mean

### Count-only token export

`spendwatch tokens --sqlite spendwatch.db --time-zone Europe/Berlin` emits only
today, calendar-month and calendar-year token totals, source coverage and
measurement timestamps. It reads the archive without connecting to any device
or provider. It exports no accounts, prompts, commands or transcript content.
Totals include input, output and cache usage, not token estimates from cost.

New reports include deduplicated daily model buckets. Set
`SPENDWATCH_TOKEN_TIME_ZONE=Europe/Berlin` on exporters to align their days.
Older reports still contribute preserved monthly/yearly totals but cannot
fabricate today's count. Daily counts are unavailable or partial until those
sources are collected with the new exporter. These are recorded snapshots, not
a promise that every AI call across all products is captured.

Repeat `--local-model MODEL` for verified self-hosted routes and
`--cloud-model MODEL` for verified hosted open-weight routes. Unmapped models
remain unclassified; zero price never proves that a request ran locally.
There is no automatic device collection.

- **tokens**: the primary Spend detail metric, summed from exact input, output, cache-read, and cache-write usage fields. The hero, source tabs, machine/account/agent breakdowns, and detail tables rank usage by tokens before cost.
- **$**: the API-equivalent estimate from those same per-request `usage` fields (Claude: `cache_creation`/`cache_read`; Codex: `last_token_usage`, summed and verified equal to cumulative). GPT-5.6 Sol/Terra/Luna, GPT-5.5/5.4, and DeepSeek V4 prices are model-specific; OpenAI requests above 272K input context use published long-context rates. Codex $ remains an estimate because much usage is subscription/credit-billed. Cache prices are model-specific when published.
- **ctx $** (per tool/command) — est. cost a call's *results* impose on the session: result tokens (chars/4) × one cache write + a 0.1× reread on every later request in that session. Big outputs early in long sessions cost the most.
- **BY COMMAND** — shell calls split by executable (`echo`, `docker`, `grep`, `ssh`…), skipping `cd X &&`/env/wrappers.
- **BY COMMAND — DEEP** — executable + subcommand (`git diff`, `docker compose`, `pnpm lint`) and, for `ssh`, the remote command head. This is the "what to build a CLI for" list.
- **BY PROMPT** — spend attributed to the active prompt (`⑂` = subagent / Codex task).

## Layout

- `src/pricing.ts` — price table + cost functions (incl. cache multipliers)
- `src/routing.ts` / `src/route-cli.ts` — evidence-driven dry-run model plans
- `src/run-engine.ts` / `src/run-cli.ts` — execution, verification, and escalation
- `src/model-executors.ts` — Codex and read-only DeepSeek adapters
- `src/routing-db.ts` / `src/eval-cli.ts` — outcome telemetry and policy replay
- `src/projects.ts` — one project name per working directory, shared by every parser
- `src/parse.ts` — Claude JSONL → events; `commandPath()` deep shell breakdown
- `src/codex.ts` — Codex rollout JSONL → same events
- `src/gateway.ts` — subscription gateway ledger: dedupe, claims, coverage, and per-account rows
- `src/gateway-events.ts` — which ledger rows bill, and the report events they become
- `src/gateway-match.ts` — which row a rollout call stands on, and how alike calls trade rows
- `src/gateway-config.ts` — where the gateway keeps its ledger, and which login each provider bills
- `src/gateway-ledger-files.ts` — reading the ledger's month files into rows
- `src/gateway-settle.ts` — counting a routed turn once where several Macs' reports meet
- `src/grok.ts` — Grok ACP session updates → same events
- `src/sources.ts` — agent registry: log locations, discovery, account detection, config roots
- `src/aggregate.ts` — per-session fold → leaderboards + per-account + drill-down samples
- `src/periods.ts` / `src/report-window.ts` — calendar-month windows and imported-month filing
- `src/monthly.ts` — one pass over the transcripts, split per month
- `src/spend-history.ts` — per-month spend archive read/write
- `src/spend-report-archive.ts` / `src/archive-ledger.ts` — fullest-read rules, and the month the gateway ledger takes over
- `src/db.ts` — SQLite snapshot writer (`bun:sqlite`)
- `src/capacity-db.ts` — live quota history and adaptive chart queries
- `src/capacity-archive.ts` / `src/capacity-cli.ts` — verified retention and restore
- `src/capacity-export.ts` — sanitized Codex session quota recovery
- `src/push-store.ts` — persistent subscriptions and once-per-reset threshold state
- `src/push-server.ts` — private dashboard and encrypted Web Push delivery
- `src/service-worker.ts` — closed-page notification receiver
- `src/history.ts` — range and past-month history dashboard
- `src/html.ts` — standalone HTML report with tabs + drill-down
- `src/scan.ts` — file walk + incremental offsets (watch mode)
- `src/render.ts` / `src/cli.ts` — tables, cross-agent overview, report/watch

## Test

```sh
bun test   # claude + codex + grok fixtures with hand-computed costs, deep-command,
           # incremental append, multi-account sum/breakout, sqlite round-trip,
           # month-boundary splitting and the monthly spend archive
```

The gateway ledger is also shaken by seeded random worlds (`test/gateway-fuzz-*.test.ts`):
whole Macs whose calls, ledger rows and rollout lines interleave over time, with forks,
late rows and alike calls, read by `watch` and by a report. The seeds are fixed, so a
run is the same every time. `SPENDWATCH_FUZZ_SEED=<n>` replays one seed of every
world (a failure prints its world), and `SPENDWATCH_FUZZ_SEEDS=<n>` runs seeds 1 to n
instead of the usual few hundred, to hunt for a rarer failure.

## Contributing

Adding another agent is one parser emitting the shared `Event` model plus a `sources.ts` entry. PRs welcome.

Production may set `SPENDWATCH_SENTRY_DSN` for private GlitchTip error
grouping. Reports contain only fixed event names, error types, environment,
release, and allowlisted operational tags. Exception messages, account data,
URLs, paths, request contents, and stack frames are never sent. Use
`SPENDWATCH_ENVIRONMENT` and `SPENDWATCH_RELEASE` for deployment labels.

## License

[MIT](LICENSE) © Edi Hasaj

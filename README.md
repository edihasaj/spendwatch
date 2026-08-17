# spendwatch

[![license: MIT](https://img.shields.io/badge/license-MIT-amber)](LICENSE) ![runtime: Bun](https://img.shields.io/badge/runtime-Bun-black) ![deps: zero](https://img.shields.io/badge/deps-zero-brightgreen)

Token/$ leaderboards **across coding agents** (Claude Code, Codex, …): which **tool calls**, **shell commands**, and **prompts** spend the most — so you know what to automate (build a CLI for `ssh`/`git diff`/`docker compose`…) or fix (a tool dumping huge results into context).

Parses each agent's local transcripts. Zero runtime deps, Bun. Agents are split out, with a cross-agent overview on top.

> **Privacy:** report and capacity rendering read local files and make no network
> calls. Optional background alerts send only the displayed account label and
> crossed percentage through the browser's encrypted Web Push service.

## Install

Requires [Bun](https://bun.sh). Run from source, or compile a standalone binary:

```sh
git clone https://github.com/edihasaj/spendwatch && cd spendwatch
bun run report                 # run directly
bun run build                  # → bin/spendwatch (self-contained, embeds Bun + SQLite)
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
bun src/cli.ts report --agent codex        # one agent (claude,codex,copilot,gemini)
bun src/cli.ts report --project chat-sql   # filter by project substring
bun src/cli.ts report --days 7 --json
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
bin/spendwatch capacity-history-export --label studio > capacity-history.jsonl
bin/spendwatch report                       # compiled binary (bun run build)
```

`--html [path]` writes a self-contained, shareable `index.html` (default `spendwatch-report.html`): cross-agent overview, per-agent tabs, every table with heat bars, and **click any tool/command row to drill into the actual invocations** (which files, which commands, with counts + token cost) — the "what to automate" view. `--open` writes it and opens it.

`--sqlite [path]` appends a normalized snapshot (one run per call) so you can build spend history and query with SQL — tables: `runs`, `agent_account`, `tools`, `commands`, `prompts`, `models`, `projects`, `samples`.

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
unreported windows are omitted instead of shown as empty limits. Codex and
Claude show rolling 5-hour and weekly capacity. Copilot Business shows AI
credits used, their USD equivalent, the current per-seat contribution to the
shared organization pool, paid-overflow status, and monthly reset. It never
labels paid overflow as unlimited or invents a remaining company balance when
the GitHub identity cannot read organization seat and budget totals. API-backed
Lokai routes show sanitized cash balances; route
readiness without a reported balance is never labeled unlimited. When the input
includes a reported pace forecast, Spendwatch shows its learned deficit/reserve
and run-out ETA. Other reset windows get a transparent live linear forecast.
That fallback starts as soon as a new window begins, so newly reset Claude
windows immediately show whether their capacity lasts until reset.
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
for a headless Codex login. Metered API keys are also supported without placing
the secret in argv or shell history:

```bash
export OPENAI_API_KEY=... # preferably injected by your secret manager
spendwatch account add codex --name api --api-key-env OPENAI_API_KEY
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
JWT email). Reports **tag by account but sum per agent**. Codex automatically
loads `~/.codex/sessions` plus every `~/.codex-*/sessions` profile, so separate
desktop or CLI accounts such as `~/.codex-work` require no configuration.

For custom locations or explicit labels, create
`~/.config/spendwatch/config.json` (or `$SPENDWATCH_CONFIG`). Explicit config
roots replace automatic discovery:

```json
{ "roots": [
  { "agent": "claude", "account": "work",     "path": "~/.claude/projects" },
  { "agent": "claude", "account": "personal", "path": "~/personal/.claude/projects" },
  { "agent": "codex",  "account": "work",     "path": "~/.codex-work/sessions" },
  { "agent": "codex",  "account": "personal", "path": "~/.codex/sessions" }
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
| Codex CLI   | `~/.codex/sessions/**/rollout-*.jsonl` | ✓ |
| Copilot CLI | `~/.config/github-copilot` | ✗ (binary Xodus store, no usage) |
| Gemini CLI  | `~/.gemini` | ✓ when present |

Copilot/Gemini are detected and reported as footnotes until parseable logs exist. Adding a new agent = one parser emitting the shared `Event` model + a `sources.ts` entry.

## What to automate

The **AUTOMATE — top targets** list (top of the report, and `--brief`) ranks shell commands by **cost × frequency × friction** — the build-a-CLI/MCP shortlist. Friction is measured, not guessed: Claude `tool_result.is_error` and Codex exit codes. A `why` column tells you the driver:

- `frequent + costly` — high spend, lots of calls → wrap it in one tool
- `fails N% · flaky` — the command errors often (the agent retries, burning tokens)
- `exit-127 · agent guessing` — command-not-found: the agent doesn't know this tool → give it a CLI/MCP

> **Honesty note:** spendwatch does **not** invent a "you saved $X" number — that's an unmeasurable counterfactual. It shows *observed* cost and *measured* friction (error/retry rate). After you automate something, its cost and error rate drop and you see it in the data.

## What the numbers mean

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
- `src/parse.ts` — Claude JSONL → events; `commandPath()` deep shell breakdown
- `src/codex.ts` — Codex rollout JSONL → same events
- `src/sources.ts` — agent registry: log locations, discovery, account detection, config roots
- `src/aggregate.ts` — per-session fold → leaderboards + per-account + drill-down samples
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
bun test   # claude + codex fixtures with hand-computed costs, deep-command,
           # incremental append, multi-account sum/breakout, sqlite round-trip
```

## Contributing

Adding another agent is one parser emitting the shared `Event` model plus a `sources.ts` entry. PRs welcome.

Production may set `SPENDWATCH_SENTRY_DSN` for private GlitchTip error
grouping. Reports contain only fixed event names, error types, environment,
release, and allowlisted operational tags. Exception messages, account data,
URLs, paths, request contents, and stack frames are never sent. Use
`SPENDWATCH_ENVIRONMENT` and `SPENDWATCH_RELEASE` for deployment labels.

## License

[MIT](LICENSE) © Edi Hasaj

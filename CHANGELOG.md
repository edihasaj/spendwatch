# Changelog

## Unreleased

- Name a project from the working directory the session recorded instead of the folder Claude stored it under. That folder name has every `/` flattened to `-`, so one project arrived under several names — `tg/payroll-backend` and `tg-payroll-backend`, `dayshape/dayshape` and `dayshape-Dayshape` — and its spend was split between them. Every parser now shares one naming pass: a path stops at the checkout that contains it — located by its `.git`, so `spendwatch/src` is `spendwatch` while `oss/paseo-baseline` keeps both segments — worktrees collapse into the directory holding them rather than inventing a project per generated name, scratch under a hidden directory is credited to the repository around it, dated scratch to the tool that made it, every temporary directory becomes a single `/tmp` entry, a directory stamped with an epoch (one run of a tool, named afresh each time) becomes a single `~/scratch` entry, and spellings differing only in case are folded together since the filesystem never distinguished them.

- Keep an all-time spend archive rather than only the months still on disk. Each recorded month now also stores where its tokens went, so a month card shows who spent it and which projects it went to, and the History tab leads with the all-time token and cost total. `--months N` backfills as far back as the transcripts reach; a month holds the agents whose transcripts still existed when it was first recorded, which is stated on the page rather than implied.

- Reset spend with the calendar month and keep every closed month. A report covers the current month by default, `--month YYYY-MM` reads a past one, and `--days N` still gives a rolling window. The History tab lists one collapsed card per month with its tokens, estimated cost, calls, sessions, and per-machine breakdown, so an expensive August stops inflating a quiet September.
- Window turns by their own timestamp instead of the mtime of the file holding them. Sessions are found by file mtime, so resuming an old session pulled every turn it ever recorded into "the last 30 days" — a 30-day total could quietly cover 37 days of work. `--months N` now also folds several months out of a single pass, and each report records the month it belongs to so per-machine exports merge into the right one.

- Refresh the Claude OAuth token instead of waiting for a human. The access token lives eight hours and no collector host runs Claude Code, so the capacity card reliably died within a working day and only a manual `claude login` brought it back. Reads now refresh ahead of expiry, retry once after a 401, and persist the rotated credentials atomically. Credentials written without an `expiresAt` are treated as due, which is the shape that used to go stale unnoticed.
- Report why a Claude capacity read failed instead of returning an empty array. An expired token, a rate limit, and a transient fault were indistinguishable, so an account that needed re-authentication looked exactly like an account that was never configured. `capacity-current --provider claude` now names the reason on stderr, and an expired token raises the existing sign-in banner rather than letting the card drift into "Not current".
- Fall back to the macOS Keychain when `~/.claude/.credentials.json` is present but blank. Claude Code leaves that husk behind after moving the secret to the Keychain, and preferring the file whenever it merely existed dropped the account with no usable token and no explanation.
- Show Grok on the capacity dashboard after the Lokai routes. Grok Build reports no quota and no balance, so the card reports what was sent over a rolling 24 hours and 30 days, priced at published list rates as an API-equivalent estimate rather than billed money, and stays out of the utilization planner.
- Track Grok CLI spend alongside Claude Code and Codex: read `~/.grok/sessions/**/updates.jsonl`, attribute tokens to the prompt that caused them, and break the run down by tool, shell command, project, and model. `~/.grok-*` profiles and the account email are picked up automatically, and `spendwatch account add grok --name <profile>` connects another one.
- Read live Claude capacity through the account's own OAuth usage endpoint (`capacity-current --provider claude`), removing the third-party menu-bar dependency that could silently freeze Claude windows on an old snapshot.
- Measure the recent burn rate inside the current quota cycle and compare it with the rate the remaining allowance affords, so a burst is visible while there is still time to slow down. Each window now shows its pace, its budget multiple, and how long before the reset it runs out at that rate.
- Never present an expired or unrefreshed quota sample as current capacity: the dashboard labels it "Cycle ended" or "Not current" with the last reading and its age, the terminal summary matches, the utilization planner stops pacing it, and `guard` returns `unknown` instead of `ok`.

- Fill the Copilot budget track solid red once the monthly ceiling is passed instead of draining it to an empty line.
- Report Copilot overspend past the monthly ceiling instead of clamping it, and alert on the monthly credit budget at the same 30/15/10/5/0 steps as weekly quota.
- Pace Copilot against a manual monthly ceiling of 40,000 AI credits for $400 ($0.01 per credit, overridable) and drop the per-seat shared-pool and promotion maths.
- Remove the private dashboard hostname from the public Chrome extension, add origin-scoped URL configuration, and enable repository security automation.
- Add a 90% utilization planner for subscription-backed capacity, excluding PAYG API balances from subscription sizing.
- Match Chrome's native dark bookmark bar and menu typography, sizing, colors, and surfaces.
- Show the Chrome profile's Bookmark Bar on the extension New Tab page.
- Add a self-recovering Chrome New Tab extension for the private capacity dashboard.
- Hide the alert test control after the first verified push delivery.
- Show provider-aware sign-in links when a collector reports expired authentication.

## 0.3.0 — 2026-08-12

- Add preview-first, verified archives for capacity history older than 365 days.
- Add additive, idempotent restoration from compressed SQLite archives.
- Keep archives mode 0600 and preserve them independently from the compact live database.

## 0.2.0 — 2026-08-12

- Add evidence-driven Luna, Terra, and Sol routing previews.
- Add routed task execution through Codex with deterministic verification and escalation.
- Add opt-in, read-only DeepSeek V4 Flash execution with safe repository tools.
- Add local SQLite decision/outcome telemetry, shadow routing, task-cost estimates, and historical policy evaluation.

## 0.1.0 — 2026-08-02

- Initial cross-agent usage, cost, capacity, history, and automation reports.

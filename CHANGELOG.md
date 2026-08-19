# Changelog

## Unreleased

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

// The account a gateway Claude provider paid with, when the provider names no login directory.
//
// A ledger row for a subscription provider with no `authDirectory` has no account of its own, so the
// ledger has always credited it to the Claude account signed in *now*. For a provider that is still
// serving that is right; for a retired one it is not, because a later login change silently moves
// rows that were billed months ago. The operator can pin those providers instead, by id:
//
//   ~/.config/spendwatch/claude-provider-accounts.json → { "claude": "edi.hasaj@applifyer.com" }
//
// `SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS` names another file to read. A missing, unreadable, or invalid
// one is ignored: a mapping that cannot be vouched for must not move spend, so the row falls back to
// the signed-in account exactly as it did before this file existed.
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateConfigText, spendwatchConfigDir } from "./claude-proof-roots";
import { shortEmail } from "./sources";

// A full address with something on both sides of a single `@`, and no room for a second one. That is
// the shape `claudeAccount` reports, so a mapping cannot smuggle a label that no login ever wrote.
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Gateway provider id → account email. Empty when nothing provable is configured. */
export function claudeProviderAccounts(home = homedir()): ReadonlyMap<string, string> {
  const explicit = process.env.SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS;
  const directory = spendwatchConfigDir(home);
  const path = explicit ? explicit : directory === undefined ? "" : join(directory, "claude-provider-accounts.json");
  if (!path) return new Map();
  const text = readPrivateConfigText(path);
  if (text === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  const accounts = new Map<string, string>();
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!provider || typeof value !== "string") return new Map();
    const email = shortEmail(value);
    if (!email || !EMAIL.test(email)) return new Map();
    accounts.set(provider, email);
  }
  return accounts;
}

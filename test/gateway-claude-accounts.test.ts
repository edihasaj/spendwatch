// The account a gateway Claude row is billed to when its provider names no login directory.
//
// Such a row has always gone to the account signed in *now*, which is right while the provider still
// serves and wrong for a retired one: a later login change moves months of settled spend. The operator
// can pin those providers by id instead, in `~/.config/spendwatch/claude-provider-accounts.json`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayIndex, type GatewayLedger } from "../src/gateway";
import { claudeProviderAccounts } from "../src/claude-provider-accounts";
import { claude, stateDir, withEnv, type Api } from "./ledger-fixtures";
import { NO_CLAUDE_PROVIDER_ACCOUNTS } from "./isolate-gateway";
import { tempDir } from "./tmp";

// The account the fallback reads. The suite names it outright, because bun fixes `homedir()` at process
// start and no test can stand in for the real `~/.claude.json` any other way.
const SIGNED_IN = "now-signed-in@example.com";

/** A mapping file holding exactly this text (or JSON), in a directory of its own. */
function mapping(contents: unknown): string {
  const dir = tempDir("spendwatch-provider-accounts-");
  const path = join(dir, "claude-provider-accounts.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

/** A ledger of these rows, read with that mapping declared and this account signed in. */
function ledger(rows: Record<string, unknown>[], file: string): GatewayLedger {
  return withEnv({ SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS: file, SPENDWATCH_CLAUDE_ACCOUNT: SIGNED_IN },
    () => GatewayIndex.load({ sinceMs: 0, stateDir: stateDir(rows) }));
}

/** The request ids each account's stream holds. */
function byAccount(index: GatewayLedger): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of index.files("claude")) {
    out[file.account] = [...file.events!()].filter((e) => e.t === "api").map((e) => (e as Api).requestId);
  }
  return out;
}

const oneRow = [claude({ requestId: "oct", provider: "claude" })];

describe("the declared account of a gateway Claude provider", () => {
  test("moves a retired provider's rows off the account signed in now", () => {
    const index = ledger(oneRow, mapping({ claude: "edi.hasaj@applifyer.com" }));
    expect(byAccount(index)).toEqual({ "edi.hasaj@applifyer.com": ["studio:oct"] });
    // The row is still one row, and it is still the ledger that bills it: only the label moved.
    expect(index.files("claude")).toHaveLength(1);
  });

  test("behaves exactly as before when nothing is declared", () => {
    // The suite's default: a path that never exists (see test/isolate-gateway.ts), so a Mac that
    // pins an account cannot move one here. Deleting the variable reaches the same place by the
    // default path, which no test home has.
    for (const file of [NO_CLAUDE_PROVIDER_ACCOUNTS, join(tempDir("spendwatch-empty-"), "absent.json")]) {
      expect(byAccount(ledger(oneRow, file))).toEqual({ [SIGNED_IN]: ["studio:oct"] });
    }
    // Including the stream key a `watch` tick reads it under.
    expect(ledger(oneRow, NO_CLAUDE_PROVIDER_ACCOUNTS).files("claude")[0]!.key).toBe("gateway:claude");
  });

  test("follows a provider that keeps its own login, whatever was declared for it", () => {
    // The `authDirectory` is evidence about the provider; the mapping is a note about the past, and
    // it is only consulted where no such evidence exists.
    const root = realpathSync(tempDir("spendwatch-provider-auth-"));
    mkdirSync(join(root, "claude-work"), { recursive: true });
    writeFileSync(join(root, "claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
    const state = stateDir([
      claude({ requestId: "work", provider: "claude-work", responseId: "resp_gl_work" }),
      claude({ requestId: "retired", provider: "claude-old" }),
    ]);
    const config = join(root, "gateway.json");
    writeFileSync(config, JSON.stringify({ version: 1, stateDirectory: state, providers: [
      { id: "claude", type: "claude-subscription" },
      { id: "claude-work", type: "claude-subscription", authDirectory: "claude-work" },
    ] }));
    const index = withEnv({
      SPENDWATCH_GATEWAY_CONFIG: config, SPENDWATCH_GATEWAY_STATE: undefined, SPENDWATCH_CLAUDE_ACCOUNT: SIGNED_IN,
      SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS: mapping({ "claude-work": "declared@example.com", "claude-old": "edi.hasaj@applifyer.com" }),
    }, () => GatewayIndex.load({ sinceMs: 0 }));
    expect(byAccount(index)).toEqual({
      "work@example.com": ["studio:work"],
      "edi.hasaj@applifyer.com": ["studio:retired"],
    });
  });

  test("ignores a mapping file it cannot vouch for", () => {
    for (const broken of [
      "{not json", "", "[]", "null", '{"claude":42}', '{"claude":""}', '{"claude":"no-at-sign"}',
      '{"claude":"two@@example.com"}', '{"claude":" a@b.co "}', '{"":"c@d.com"}',
      JSON.stringify({ claude: "x@y.com", pad: "z".repeat(9 * 1024) }),
    ]) {
      expect(byAccount(ledger(oneRow, broken))).toEqual({ [SIGNED_IN]: ["studio:oct"] });
    }
    // A link is not the operator's own file, however well-formed what it points at is.
    const dir = realpathSync(tempDir("spendwatch-provider-link-"));
    const target = join(dir, "real.json");
    writeFileSync(target, JSON.stringify({ claude: "declared@example.com" }));
    const link = join(dir, "claude-provider-accounts.json");
    symlinkSync(target, link);
    expect(byAccount(ledger(oneRow, link))).toEqual({ [SIGNED_IN]: ["studio:oct"] });
  });

  test("reads the default file, and the path the environment names instead of it", () => {
    const home = tempDir("spendwatch-provider-home-");
    mkdirSync(join(home, ".config", "spendwatch"), { recursive: true });
    writeFileSync(join(home, ".config", "spendwatch", "claude-provider-accounts.json"), JSON.stringify({ claude: "default-path@example.com" }));
    const elsewhere = mapping({ claude: "env-path@example.com" });
    // With no path named — the suite always names one, see test/isolate-gateway.ts — the default file decides.
    withEnv({ SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS: undefined }, () => {
      expect(claudeProviderAccounts(home).get("claude")).toBe("default-path@example.com");
      // Nothing to read is not an error, and it changes nothing.
      expect(claudeProviderAccounts(join(home, "nowhere")).size).toBe(0);
      // A path the environment names wins over that default file.
      process.env.SPENDWATCH_CLAUDE_PROVIDER_ACCOUNTS = elsewhere;
      expect(claudeProviderAccounts(home).get("claude")).toBe("env-path@example.com");
    });
  });
});

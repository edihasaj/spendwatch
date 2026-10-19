import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import {
  freshestClaudeKeychainCredential,
  keychainLocatorsFrom,
  persistClaudeKeychainCredentials,
  readClaudeKeychainCredential,
  type ClaudeKeychainCredential,
} from "../src/claude-keychain";
import { tempDir } from "./tmp";

const service = "Claude Code-credentials";
const locator = { service, account: "edi", path: "/tmp/claude-test.keychain-db" };
const wrapper = {
  claudeAiOauth: {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    subscriptionType: "max",
    rateLimitTier: "tier-x",
  },
  unrelated: { preserve: true },
};
const next = {
  accessToken: "new-access",
  refreshToken: "new-refresh",
  expiresAt: 42,
  refreshTokenExpiresAt: 99,
  scopes: ["user:profile"],
};

function credential(value = wrapper): ClaudeKeychainCredential {
  return { locator, wrapper: value, oauth: value.claudeAiOauth };
}

describe("Claude Keychain locators", () => {
  test("keeps the exact account and keychain path from the attribute-only dump", () => {
    const dump = [
      'keychain: "/Users/edi/Library/Keychains/login.keychain-db"',
      '    "acct"<blob>="old"',
      '    "svce"<blob>="Claude Code-credentials"',
      'keychain: "/Volumes/work/keychains/Claude.keychain-db"',
      '    "acct"<blob>="live"',
      '    "svce"<blob>="Claude Code-credentials"',
      'keychain: "/Users/edi/Library/Keychains/login.keychain-db"',
      '    "acct"<blob>="other"',
      '    "svce"<blob>="Other service"',
    ].join("\n");
    expect(keychainLocatorsFrom(dump, service)).toEqual([
      { service, account: "old", path: "/Users/edi/Library/Keychains/login.keychain-db" },
      { service, account: "live", path: "/Volumes/work/keychains/Claude.keychain-db" },
    ]);
  });

  test("chooses a usable newest credential without losing its locator", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const expired = credential({ ...wrapper, claudeAiOauth: { ...wrapper.claudeAiOauth, expiresAt: now - 1 } });
    const fresh = credential({ ...wrapper, claudeAiOauth: { ...wrapper.claudeAiOauth, expiresAt: now + 60_000 } });
    expect(freshestClaudeKeychainCredential([expired, fresh], now)).toBe(fresh);
  });
});

describe("Claude Keychain token rotation", () => {
  test("preserves the full wrapper and keeps credentials out of argv", () => {
    let stored: Record<string, unknown> = structuredClone(wrapper);
    let interactiveInput = "";
    const calls: string[][] = [];
    const runner = (args: string[], input?: string) => {
      calls.push(args);
      if (args[0] === "find-generic-password") return { status: 0, stdout: JSON.stringify(stored) };
      if (args[0] === "-i") {
        interactiveInput = input ?? "";
        const hex = / -X ([0-9a-f]+) /.exec(interactiveInput)?.[1];
        stored = JSON.parse(Buffer.from(hex!, "hex").toString("utf8"));
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    };
    const written = persistClaudeKeychainCredentials(credential(), "old-refresh", next, runner);
    expect(written?.oauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 42,
      subscriptionType: "max",
      rateLimitTier: "tier-x",
    });
    expect(written?.wrapper).toMatchObject({ unrelated: { preserve: true } });
    expect(calls.filter((call) => call[0] === "-i")).toEqual([["-i"]]);
    expect(calls.flat().join(" ")).not.toContain("new-access");
    expect(calls.flat().join(" ")).not.toContain("new-refresh");
    expect(interactiveInput).not.toContain("new-access");
    expect(interactiveInput).not.toContain("new-refresh");
    expect(interactiveInput.endsWith("\n")).toBe(true);
  });

  test("does not create a missing item", () => {
    const calls: string[][] = [];
    const runner = (args: string[]) => {
      calls.push(args);
      return { status: 44, stdout: "" };
    };
    expect(persistClaudeKeychainCredentials(credential(), "old-refresh", next, runner)).toBeUndefined();
    expect(calls).toEqual([[
      "find-generic-password", "-s", service, "-a", "edi", "-w", locator.path,
    ]]);
  });

  test("leaves a concurrent Claude login untouched", () => {
    let calls = 0;
    const runner = (args: string[]) => {
      calls++;
      return {
        status: 0,
        stdout: JSON.stringify({
          ...wrapper,
          claudeAiOauth: { ...wrapper.claudeAiOauth, refreshToken: "newer-login-refresh" },
        }),
      };
    };
    expect(persistClaudeKeychainCredentials(credential(), "old-refresh", next, runner)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("does not claim success when security -i failed internally", () => {
    let reads = 0;
    const runner = (args: string[]) => {
      if (args[0] === "find-generic-password") {
        reads++;
        return { status: 0, stdout: JSON.stringify(wrapper) };
      }
      // `security -i` itself often exits zero even after a failed subcommand.
      return { status: 0, stdout: "" };
    };
    expect(persistClaudeKeychainCredentials(credential(), "old-refresh", next, runner)).toBeUndefined();
    expect(reads).toBe(2);
  });

  test("quotes an unusual locator as one security -i command", () => {
    const unusual = {
      service,
      account: 'edi "primary" \\',
      path: '/tmp/a "quoted" \\ keychain',
    };
    const source = { ...wrapper, claudeAiOauth: { ...wrapper.claudeAiOauth } };
    let stored: Record<string, unknown> = structuredClone(source);
    let command = "";
    const runner = (args: string[], input?: string) => {
      if (args[0] === "find-generic-password") return { status: 0, stdout: JSON.stringify(stored) };
      command = input ?? "";
      const hex = / -X ([0-9a-f]+) /.exec(command)?.[1];
      stored = JSON.parse(Buffer.from(hex!, "hex").toString("utf8"));
      return { status: 0, stdout: "" };
    };
    const result = persistClaudeKeychainCredentials(
      { locator: unusual, wrapper: source, oauth: source.claudeAiOauth },
      "old-refresh",
      next,
      runner,
    );
    expect(result?.locator).toEqual(unusual);
    expect(command).toContain('-a "edi \\"primary\\" \\\\"');
    expect(command).toContain('"/tmp/a \\"quoted\\" \\\\ keychain"');
  });
});

test("rotates an isolated temporary Keychain item without changing the search list", () => {
  if (platform() !== "darwin") return;
  const directory = tempDir("spendwatch-keychain-");
  const path = join(directory, "fixture.keychain-db");
  const run = (args: string[], input?: string) => {
    const result = spawnSync("/usr/bin/security", args, { encoding: "utf8", input });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  try {
    // Fixture-only password via stdin. This isolated Keychain is addressed
    // explicitly; the test never reads or replaces the user's search list.
    expect(run(["-i"], `create-keychain -p "fixture-only-password" "${path}"\n`).status).toBe(0);
    expect(run(["-i"], `unlock-keychain -p "fixture-only-password" "${path}"\n`).status).toBe(0);
    const initial = JSON.stringify(wrapper);
    expect(run(["-i"], [
      `add-generic-password -s "${service}" -a "fixture"`,
      `-X ${Buffer.from(initial, "utf8").toString("hex")} "${path}"`,
      "",
    ].join(" ") + "\n").status).toBe(0);
    const item = readClaudeKeychainCredential({ service, account: "fixture", path });
    expect(item).toBeDefined();
    const written = persistClaudeKeychainCredentials(item!, "old-refresh", next);
    expect(written?.oauth.refreshToken).toBe("new-refresh");
    expect(written?.wrapper).toMatchObject({ unrelated: { preserve: true } });
  } finally {
    // Delete only the explicitly-created fixture; never touch the search list.
    run(["delete-keychain", path]);
  }
});

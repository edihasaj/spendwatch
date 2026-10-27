import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCapacityProfileHomes } from "../src/codex-capacity-profiles";
import { codexClaims, defaultCodexRoots } from "../src/sources";

// A home qualifies on the login it already owns, so the stub carries only the shape
// `codexClaims` reads: `tokens.id_token` as a JWT whose payload holds `email`. The
// signature is filler; nothing here verifies, logs, or moves a real credential.
function stubHome(home: string, name: string, email?: string): string {
  const profileHome = join(home, name);
  mkdirSync(profileHome, { recursive: true });
  if (email) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({ email })}.signature`;
    writeFileSync(join(profileHome, "auth.json"), JSON.stringify({ tokens: { id_token: token } }));
  }
  // The reader reports resolved homes, so the fixtures compare against the same form.
  return realpathSync(profileHome);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "spendwatch-capacity-profiles-"));
}

test("discovers a signed-in profile that has never written a rollout", () => {
  const home = tempHome();
  // No `sessions` and no `archived_sessions`: the account still has a live quota, and
  // the reader must not invent a history directory to see it.
  const secondary = stubHome(home, ".codex-secondary", "alex@example.com");
  expect(codexCapacityProfileHomes(home)).toEqual([secondary]);
  expect(codexClaims(join(secondary, "sessions")).email).toBe("alex@example.com");
});

test("ignores a profile directory with no login of its own", () => {
  const home = tempHome();
  stubHome(home, ".codex-empty");
  mkdirSync(join(home, ".codex-history", "sessions"), { recursive: true });
  expect(codexCapacityProfileHomes(home)).toEqual([]);
});

test("ignores a login that is a directory rather than a file", () => {
  const home = tempHome();
  const profile = stubHome(home, ".codex-dirauth");
  rmSync(join(profile, "auth.json"), { force: true });
  mkdirSync(join(profile, "auth.json"));
  expect(codexCapacityProfileHomes(home)).toEqual([]);
});

test("ignores a login that is a link to another home's credential", () => {
  const home = tempHome();
  const own = stubHome(home, ".codex", "alex@example.com");
  const borrower = stubHome(home, ".codex-borrowed");
  symlinkSync(join(own, "auth.json"), join(borrower, "auth.json"));
  expect(codexCapacityProfileHomes(home)).toEqual([own]);
});

test("ignores a dangling link and a non-directory named like a profile", () => {
  const home = tempHome();
  symlinkSync(join(home, "nowhere"), join(home, ".codex-broken"));
  writeFileSync(join(home, ".codex-file"), "not a profile");
  expect(codexCapacityProfileHomes(home)).toEqual([]);
});

test("reads the default home first and deduplicates a symlinked alias", () => {
  const home = tempHome();
  const named = stubHome(home, ".codex-primary", "alex@example.com");
  symlinkSync(named, join(home, ".codex-alias"));
  // One home is one profile, reported by its real directory rather than the alias.
  expect(codexCapacityProfileHomes(home)).toEqual([named]);
  // The default home keeps priority over a named profile, alias included.
  const defaultHome = stubHome(home, ".codex", "alex@example.com");
  expect(codexCapacityProfileHomes(home)).toEqual([defaultHome, named]);
});

test("leaves history discovery unchanged: a session-less home is still not a rollout root", () => {
  const home = tempHome();
  stubHome(home, ".codex-secondary", "alex@example.com");
  expect(defaultCodexRoots(home).filter((root) => root.agent === "codex")).toEqual([]);
});

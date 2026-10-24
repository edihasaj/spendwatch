import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultClaudeRoots, discover } from "../src/sources";
import { tempDir } from "./tmp";

// A Claude Code transcript line, as `~/.claude*/projects/**/*.jsonl` carries it. The timestamp is
// today's, so a window that starts at the beginning of the month still holds the call.
const at = new Date().toISOString();
const PROJECT = "-Users-edi-Projects-team-app";

function assistant(requestId: string): string {
  return JSON.stringify({
    type: "assistant", requestId, sessionId: requestId, timestamp: at, isSidechain: false,
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 1 }, content: [] },
  }) + "\n";
}

/**
 * One Claude home: its own sign-in, and one transcript under one project. `dir` is `.claude` for the
 * default home and `.claude-<name>` for a profile launched with `CLAUDE_CONFIG_DIR`. The two keep their
 * login in different places, exactly as Claude Code does: the default home's sits beside `.claude`, and a
 * profile launched with `CLAUDE_CONFIG_DIR` keeps it inside that directory.
 */
function profile(home: string, dir: string, email: string, requestId: string): string {
  const root = join(home, dir);
  const project = join(root, "projects", PROJECT);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir === ".claude" ? home : root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  const path = join(project, `${requestId}.jsonl`);
  writeFileSync(path, assistant(requestId));
  return path;
}

/**
 * What default discovery reads in `home`. `homedir()` is fixed when bun starts — the same reason the
 * suite names its accounts (see test/isolate-gateway.ts) — so the reader runs in a fresh process with
 * that home, and with no account named outright: the point is what it resolves on its own.
 */
function discovered(home: string, env: Record<string, string | undefined> = {}): { path: string; account: string }[] {
  const script = 'import { discover } from "./src/sources";'
    + 'const s = discover({ sinceMs: 0, agents: new Set(["claude"]) }).find((x) => x.id === "claude");'
    + 'console.log(JSON.stringify(s.files.map(({ path, account }) => ({ path, account }))));';
  // No `SPENDWATCH_CLAUDE_ACCOUNT`, which would name the account outright and hide what discovery
  // resolved, and no inherited config, which would replace the default roots this test is about.
  const child: Record<string, string | undefined> =
    { ...process.env, HOME: home, SPENDWATCH_CONFIG: undefined, SPENDWATCH_CLAUDE_ACCOUNT: undefined, ...env };
  for (const key of Object.keys(child)) if (child[key] === undefined) delete child[key];
  const run = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: process.cwd(), env: child });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

describe("Claude profile discovery", () => {
  test("finds the default home and every named profile, default first", () => {
    const home = tempDir("spendwatch-claude-home-");
    const main = profile(home, ".claude", "default@example.com", "main");
    const personal = profile(home, ".claude-personal", "personal@example.com", "personal");
    const work = profile(home, ".claude-work", "work@example.com", "work");

    expect(defaultClaudeRoots(home).map((root) => [root.path, root.account])).toEqual([
      [join(home, ".claude", "projects"), undefined],
      [join(home, ".claude-personal", "projects"), "personal@example.com"],
      [join(home, ".claude-work", "projects"), "work@example.com"],
    ]);
    expect(discovered(home).map((file) => file.path).sort()).toEqual([main, personal, work].sort());
  });

  test("credits each profile's transcripts with that profile's own login", () => {
    // The whole point of naming the root: `claudeAccount(dir)` reads `~/.claude.json` before anything
    // else, so without a root account every profile's spend would land on the default account.
    const home = tempDir("spendwatch-claude-home-");
    const main = profile(home, ".claude", "default@example.com", "main");
    const work = profile(home, ".claude-work", "work@example.com", "work");
    const personal = profile(home, ".claude-personal", "personal@example.com", "personal");

    const byPath = Object.fromEntries(discovered(home).map((file) => [file.path, file.account]));
    expect(byPath).toEqual({
      [main]: "default@example.com",
      [personal]: "personal@example.com",
      [work]: "work@example.com",
    });
  });

  test("scans a profile whose projects directory links at another home once", () => {
    const home = tempDir("spendwatch-claude-home-");
    const main = profile(home, ".claude", "default@example.com", "main");
    mkdirSync(join(home, ".claude-mirror"), { recursive: true });
    symlinkSync(join(home, ".claude", "projects"), join(home, ".claude-mirror", "projects"));
    const work = profile(home, ".claude-work", "work@example.com", "work");
    mkdirSync(join(home, ".claude-shadow"), { recursive: true });
    symlinkSync(join(home, ".claude-work", "projects"), join(home, ".claude-shadow", "projects"));

    // One root per real directory: the link at the default home and the link at a sibling profile each
    // repeat transcripts that are already read. Which name of a linked pair is kept is the first sorted.
    const kept = defaultClaudeRoots(home).map((root) => root.path);
    expect(kept).toHaveLength(2);
    expect(kept).toContain(join(home, ".claude", "projects"));
    expect(new Set(kept.map((path) => realpathSync(path)))).toEqual(
      new Set([realpathSync(join(home, ".claude", "projects")), realpathSync(join(home, ".claude-work", "projects"))]),
    );
    const found = discovered(home);
    // A borrowed directory is still billed to whoever owns it, not to the profile that only links at it.
    expect(found.map((file) => file.account).sort()).toEqual(["default@example.com", "work@example.com"].sort());
    expect(found.map((file) => basename(file.path)).sort()).toEqual([basename(main), basename(work)].sort());
  });

  test("ignores files that only look like a profile", () => {
    const home = tempDir("spendwatch-claude-home-");
    const main = profile(home, ".claude", "default@example.com", "main");
    // The backups Claude itself makes of the sign-in file, a dotfile with a profile-like prefix, and a
    // directory of that name that holds no transcripts (a profile that was made but never used).
    writeFileSync(join(home, ".claude.json.backup"), JSON.stringify({ oauthAccount: { emailAddress: "retired@example.com" } }));
    writeFileSync(join(home, ".claude-work.json"), JSON.stringify({ oauthAccount: { emailAddress: "file@example.com" } }));
    mkdirSync(join(home, ".claude-journal"), { recursive: true });

    expect(defaultClaudeRoots(home).map((root) => root.path)).toEqual([join(home, ".claude", "projects")]);
    expect(discovered(home)).toEqual([{ path: main, account: "default@example.com" }]);
  });

  test("an explicit config replaces profile discovery outright", () => {
    const home = tempDir("spendwatch-claude-home-");
    profile(home, ".claude", "default@example.com", "main");
    profile(home, ".claude-work", "work@example.com", "work");
    const elsewhere = join(home, "elsewhere", "projects", PROJECT, "there.jsonl");
    mkdirSync(join(elsewhere, ".."), { recursive: true });
    writeFileSync(elsewhere, assistant("there"));
    const config = join(home, "sources.json");
    writeFileSync(config, JSON.stringify([{ agent: "claude", path: join(home, "elsewhere", "projects"), account: "chosen@example.com" }]));

    // Only the root the config names: the discovered homes are not read, and the label is the config's.
    expect(discovered(home, { SPENDWATCH_CONFIG: config })).toEqual([{ path: elsewhere, account: "chosen@example.com" }]);

    // In this process the same rule holds, which is what `spendwatch report --config` relies on.
    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const claude = discover({ sinceMs: 0, agents: new Set(["claude"]) }).find((s) => s.id === "claude");
      expect(claude?.files.map((file) => file.path)).toEqual([elsewhere]);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });
});


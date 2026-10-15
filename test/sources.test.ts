import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexRoots, discover, pollOrder } from "../src/sources";

// Minimal unsigned JWT: Codex reads the payload of auth.json's id_token only.
function idToken(email: string, plan: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_plan_type: plan } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Codex profile discovery", () => {
  test("finds default and named profiles with session directories", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    mkdirSync(join(home, ".codex-personal", "sessions"), { recursive: true });
    mkdirSync(join(home, ".codex-work", "sessions"), { recursive: true });
    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([
      join(home, ".codex", "sessions"),
      join(home, ".codex-personal", "sessions"),
      join(home, ".codex-work", "sessions"),
    ]);
  });

  test("does not double-count symlinked session roots", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(home, ".codex-shadow"), { recursive: true });
    symlinkSync(sessions, join(home, ".codex-shadow", "sessions"));

    expect(defaultCodexRoots(home)).toHaveLength(1);
  });

  test("bills a rollout once when a profile home is a copy, not a symlink", () => {
    // ~/.codex is a copy-on-write clone of ~/.codex-primary: same rollout file,
    // two distinct real paths, so realpath dedupe cannot see it. The surviving
    // copy must be credited to the named profile, not the playground.
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const rollout = "rollout-2026-08-18T10-00-00-11111111-2222-3333-4444-555555555555.jsonl";
    const roots = [join(home, ".codex", "sessions"), join(home, ".codex-primary", "sessions")];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, rollout), "");
    }
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));

    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files).toHaveLength(1);
      expect(codex?.files[0]?.path).toBe(join(home, ".codex-primary", "sessions", rollout));
      expect(codex?.files[0]?.account).toBe("primary");
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("labels each profile home so duplicate accounts stay distinguishable", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const roots = [".codex", ".codex-tertiary"].map((p) => join(home, p, "sessions"));
    for (const [index, root] of roots.entries()) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `rollout-2026-08-18T10-00-0${index}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${index}.jsonl`), "");
    }
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));

    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files.map((f) => f.account).sort()).toEqual(["main", "tertiary"]);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("skips Codex homes on a free plan, unless SPENDWATCH_INCLUDE_FREE is set", () => {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    const roots: string[] = [];
    for (const [index, [profile, plan]] of [[".codex-paid", "pro"], [".codex-gratis", "free"]].entries()) {
      const sessions = join(home, profile, "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, `rollout-2026-08-18T10-00-0${index}-aaaaaaaa-bbbb-cccc-dddd-ffffffffff0${index}.jsonl`), "");
      writeFileSync(join(home, profile, "auth.json"), JSON.stringify({ tokens: { id_token: idToken(`${plan}@example.com`, plan) } }));
      roots.push(sessions);
    }
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));

    const previousConfig = process.env.SPENDWATCH_CONFIG;
    const previousFree = process.env.SPENDWATCH_INCLUDE_FREE;
    process.env.SPENDWATCH_CONFIG = config;
    delete process.env.SPENDWATCH_INCLUDE_FREE;
    try {
      const paidOnly = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(paidOnly?.files.map((f) => f.account)).toEqual(["pro@example.com (paid)"]);

      process.env.SPENDWATCH_INCLUDE_FREE = "1";
      const withFree = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(withFree?.files.map((f) => f.account).sort()).toEqual(["free@example.com (gratis)", "pro@example.com (paid)"]);
    } finally {
      if (previousConfig === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previousConfig;
      if (previousFree === undefined) delete process.env.SPENDWATCH_INCLUDE_FREE;
      else process.env.SPENDWATCH_INCLUDE_FREE = previousFree;
    }
  });
});

// The gateway ledger is not an agent: its rows join the subscriptions that own
// them, so it reaches a report through the claude and copilot statuses.
describe("gateway source", () => {
  const ROLLOUT = "rollout-2026-10-05T10-00-00-11111111-2222-3333-4444-555555555555.jsonl";

  function homeWith(structure: Record<string, string[]>): string {
    const home = mkdtempSync(join(tmpdir(), "spendwatch-home-"));
    for (const [dir, files] of Object.entries(structure)) {
      mkdirSync(join(home, dir), { recursive: true });
      for (const file of files) writeFileSync(join(home, dir, file), "");
    }
    return home;
  }

  function withEnv(values: Record<string, string | undefined>, run: () => void): void {
    const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.entries(values).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    try {
      run();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** A ledger with one billed call for each subscription. */
  function ledgerDir(): string {
    const state = mkdtempSync(join(tmpdir(), "spendwatch-gateway-"));
    mkdirSync(join(state, "usage"), { recursive: true });
    const at = new Date();
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    const row = (vendor: string, id: string) => JSON.stringify({
      v: 1, at: at.toISOString(), host: "studio", requestId: id, responseId: `resp_gl_${id}`,
      origin: "gateway", providerType: `${vendor}-subscription`, model: "gpt-5.1-codex",
      session: true, inputTokens: 900, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 9,
    });
    writeFileSync(join(state, "usage", `usage-${month}.jsonl`), `${row("claude", "c1")}\n${row("copilot", "p1")}\n`);
    return state;
  }

  test("lists archived rollouts after the live ones", () => {
    const home = homeWith({
      ".codex/sessions": [], ".codex/archived_sessions": [],
      ".codex-work/sessions": [], ".codex-work/archived_sessions": [],
    });
    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([
      join(home, ".codex", "sessions"),
      join(home, ".codex-work", "sessions"),
      join(home, ".codex", "archived_sessions"),
      join(home, ".codex-work", "archived_sessions"),
    ]);
  });

  test("bills an archived rollout once", () => {
    const home = homeWith({ ".codex/sessions": [ROLLOUT], ".codex/archived_sessions": [ROLLOUT] });
    const roots = [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify(roots.map((path) => ({ agent: "codex", path }))));
    withEnv({ SPENDWATCH_CONFIG: config }, () => {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files.map((f) => f.path)).toEqual([join(roots[0]!, ROLLOUT)]);
    });
  });

  test("adds the ledger to the Claude and Copilot sources", () => {
    const home = homeWith({ ".claude/projects": [], ".copilot": [] });
    const state = ledgerDir();
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: join(home, ".claude", "projects") },
      { agent: "copilot", path: join(home, ".copilot", "session-store.db") },
      { agent: "gateway", path: state },
    ]));
    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: undefined }, () => {
      const found = discover({ sinceMs: 0, agents: new Set(["claude", "copilot"]) });
      const claude = found.find((s) => s.id === "claude");
      const copilot = found.find((s) => s.id === "copilot");
      // A subscription with no local transcripts is still present: the ledger saw it.
      expect(claude?.files.map((f) => f.key)).toEqual(["gateway:claude"]);
      expect(copilot?.files.map((f) => f.key)).toEqual(["gateway:copilot"]);
      expect([claude?.present, copilot?.present, copilot?.parseable]).toEqual([true, true, true]);
      expect(claude?.files[0]).toMatchObject({ project: "gateway", source: "claude" });
    });
  });

  test("marks the sources whose reports were read with the ledger", () => {
    const home = homeWith({ ".claude/projects": [], ".codex/sessions": [], ".copilot": [] });
    const state = ledgerDir();
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: join(home, ".claude", "projects") },
      { agent: "codex", path: join(home, ".codex", "sessions") },
      { agent: "copilot", path: join(home, ".copilot", "session-store.db") },
      { agent: "gateway", path: state },
    ]));
    const agents = new Set(["claude", "codex", "copilot"]);
    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: undefined }, () => {
      expect(discover({ sinceMs: 0, agents }).map((s) => [s.id, s.ledger])).toEqual([["claude", true], ["codex", true], ["copilot", true]]);
    });
    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: "off" }, () => {
      expect(discover({ sinceMs: 0, agents }).map((s) => s.ledger)).toEqual([false, false, false]);
    });
  });

  test("reads the ledger only when it is configured or discovered", () => {
    const home = homeWith({ ".claude/projects": [] });
    const state = ledgerDir();
    const config = join(home, "config.json");
    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: undefined, SPENDWATCH_GATEWAY_STATE: state }, () => {
      // An explicit config states where logs live; without a gateway root it
      // deliberately leaves the ledger out.
      writeFileSync(config, JSON.stringify([{ agent: "claude", path: join(home, ".claude", "projects") }]));
      expect(discover({ sinceMs: 0, agents: new Set(["claude"]) })[0]!.files).toEqual([]);

      writeFileSync(config, JSON.stringify([{ agent: "claude", path: join(home, ".claude", "projects") }, { agent: "gateway", path: state }]));
      expect(discover({ sinceMs: 0, agents: new Set(["claude"]) })[0]!.files.map((f) => f.key)).toEqual(["gateway:claude"]);

      // SPENDWATCH_GATEWAY_SOURCE=off skips it either way.
      process.env.SPENDWATCH_GATEWAY_SOURCE = "off";
      expect(discover({ sinceMs: 0, agents: new Set(["claude"]) })[0]!.files).toEqual([]);
    });
  });

  test("polls rollouts before the ledger so claims land first", () => {
    const home = homeWith({ ".codex/sessions": [], ".claude/projects": [], ".copilot": [] });
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: join(home, ".claude", "projects") },
      { agent: "codex", path: join(home, ".codex", "sessions") },
      { agent: "copilot", path: join(home, ".copilot", "session-store.db") },
    ]));
    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    let found: ReturnType<typeof discover>;
    try { found = discover({ sinceMs: 0, agents: new Set(["claude", "codex", "copilot"]) }); }
    finally { if (previous === undefined) delete process.env.SPENDWATCH_CONFIG; else process.env.SPENDWATCH_CONFIG = previous; }
    expect(found.map((s) => s.id)).toEqual(["claude", "codex", "copilot"]);
    expect(pollOrder(found).map((s) => s.id)).toEqual(["codex", "claude", "copilot"]);
    expect(found.map((s) => s.id)).toEqual(["claude", "codex", "copilot"]);
  });
});

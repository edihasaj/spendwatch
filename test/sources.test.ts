import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { defaultCodexRoots, discover, pollOrder } from "../src/sources";
import { tempDir } from "./tmp";

// Minimal unsigned JWT: Codex reads the payload of auth.json's id_token only.
function idToken(email: string, plan: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_plan_type: plan } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Codex profile discovery", () => {
  test("finds default and named profiles with session directories", () => {
    const home = tempDir("spendwatch-home-");
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
    const home = tempDir("spendwatch-home-");
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(home, ".codex-shadow"), { recursive: true });
    symlinkSync(sessions, join(home, ".codex-shadow", "sessions"));

    expect(defaultCodexRoots(home)).toHaveLength(1);
  });

  test("finds current and retained Claude Qwen worker generations once", () => {
    const home = tempDir("spendwatch-home-");
    const worker = join(home, "Library", "Application Support", "Claude-3p", "qwen-worker");
    const first = join(worker, "generations", "first");
    const retained = join(worker, "generations", "retained");
    mkdirSync(join(first, "sessions"), { recursive: true });
    mkdirSync(join(retained, "sessions"), { recursive: true });
    symlinkSync(first, join(worker, "current"));

    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([
      join(worker, "current", "sessions"),
      join(retained, "sessions"),
    ]);
  });

  test("finds an archived-only retained Claude Qwen generation", () => {
    const home = tempDir("spendwatch-home-");
    const archived = join(home, "Library", "Application Support", "Claude-3p", "qwen-worker", "generations", "retained", "archived_sessions");
    mkdirSync(archived, { recursive: true });

    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([archived]);
  });

  test("finds an ordinary profile retained only as Codex archive", () => {
    const home = tempDir("spendwatch-home-");
    const archived = join(home, ".codex-secondary", "archived_sessions");
    mkdirSync(archived, { recursive: true });

    expect(defaultCodexRoots(home).map((root) => root.path)).toEqual([archived]);
  });

  test("bills a rollout once when a profile home is a copy, not a symlink", () => {
    // ~/.codex is a copy-on-write clone of ~/.codex-primary: same rollout file,
    // two distinct real paths, so realpath dedupe cannot see it. The surviving
    // copy must be credited to the named profile, not the playground.
    const home = tempDir("spendwatch-home-");
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

  test("uses an archive's longer complete prefix instead of dropping its newer usage", () => {
    const home = tempDir("spendwatch-home-");
    const rollout = "rollout-2026-08-18T10-00-00-11111111-2222-3333-4444-555555555555.jsonl";
    const live = join(home, ".codex-primary", "sessions");
    const archive = join(home, ".codex-primary", "archived_sessions");
    mkdirSync(live, { recursive: true });
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(live, rollout), "{\"one\":1}\n");
    writeFileSync(join(archive, rollout), "{\"one\":1}\n{\"two\":2}\n");
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([{ agent: "codex", path: live }, { agent: "codex", path: archive }]));

    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files.map((file) => file.path)).toEqual([join(archive, rollout)]);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("labels each profile home so duplicate accounts stay distinguishable", () => {
    const home = tempDir("spendwatch-home-");
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
      expect(codex?.files.map((f) => f.account).sort()).toEqual(["Unknown Codex account", "tertiary"]);
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });

  test("skips Codex homes on a free plan, unless SPENDWATCH_INCLUDE_FREE is set", () => {
    const home = tempDir("spendwatch-home-");
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
      expect(paidOnly?.files.map((f) => f.account)).toEqual(["pro@example.com (paid)", "Local Qwen"]);

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

  test("keeps local Qwen usage but excludes Free ChatGPT cloud usage from a mixed home", () => {
    const home = tempDir("spendwatch-home-");
    const free = join(home, ".codex-free", "sessions");
    const cloudRollout = "rollout-2026-10-18T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    const qwenRollout = "rollout-2026-10-18T10-00-01-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    mkdirSync(free, { recursive: true });
    const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, timestamp: "2026-10-18T10:00:00Z", payload });
    writeFileSync(join(free, cloudRollout), [
      line("session_meta", { id: "cloud", model: "gpt-5.5", model_provider: "openai" }),
      line("token_usage_record", { response_id: "cloud-response", usage: { input_tokens: 1_000, output_tokens: 100 } }),
    ].join("\n") + "\n");
    const qwenLines = [
      line("session_meta", { id: "qwen", model_provider: "spark_qwen" }),
      line("session_meta", { id: "copied-parent", model: "gpt-5.5", model_provider: "openai" }),
      line("turn_context", { model: "codex/qwen/qwen3.8-flash-next" }),
      line("token_usage_record", { response_id: "qwen-response", usage: { input_tokens: 100, output_tokens: 10 } }),
      line("turn_context", { model: "claude/qwen3.8-flash-next" }),
      line("token_usage_record", { response_id: "qwen-response-2", usage: { input_tokens: 20, output_tokens: 2 } }),
    ];
    writeFileSync(join(free, qwenRollout), qwenLines.join("\n") + "\n");
    writeFileSync(join(home, ".codex-free", "auth.json"), JSON.stringify({ tokens: { id_token: idToken("free@example.com", "free") } }));
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([{ agent: "codex", path: free }]));

    const previousConfig = process.env.SPENDWATCH_CONFIG;
    const previousFree = process.env.SPENDWATCH_INCLUDE_FREE;
    process.env.SPENDWATCH_CONFIG = config;
    delete process.env.SPENDWATCH_INCLUDE_FREE;
    try {
      const codex = discover({ sinceMs: 0, agents: new Set(["codex"]) }).find((s) => s.id === "codex");
      expect(codex?.files.map((file) => file.account)).toEqual(["Local Qwen", "Local Qwen"]);
      const aggregate = new Aggregator();
      const reader = new IncrementalReader(aggregate);
      for (const file of codex?.files ?? []) {
        reader.poll(file);
        reader.flush(file);
      }
      expect(aggregate.report()).toMatchObject({ apiCalls: 2, totalTokens: 132 });
      expect(aggregate.report().models.map((model) => model.model).sort()).toEqual([
        "claude/qwen3.8-flash-next",
        "codex/qwen/qwen3.8-flash-next",
      ]);
      const qwenFile = discover({ sinceMs: 0, agents: new Set(["codex"]) })
        .find((source) => source.id === "codex")
        ?.files.find((file) => file.path.endsWith(qwenRollout));
      const events = qwenLines.flatMap((row) => [...qwenFile!.parse(row, qwenFile!.ctx)]);
      expect(events.filter((event) => event.t === "api").map((event) => event.sessionId)).toEqual(["qwen", "qwen"]);
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
    const home = tempDir("spendwatch-home-");
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
    const state = tempDir("spendwatch-gateway-");
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

  test("counts a subscription whose only usage is in the ledger as present", () => {
    const home = homeWith({});
    const state = ledgerDir();
    const config = join(home, "config.json");
    // Neither Claude Code nor Copilot ever ran on this Mac; its gateway billed both.
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: join(home, "no-claude", "projects") },
      { agent: "copilot", path: join(home, "no-copilot", "session-store.db") },
      { agent: "gateway", path: state },
    ]));
    withEnv({ SPENDWATCH_CONFIG: config }, () => {
      const found = discover({ sinceMs: 0, agents: new Set(["claude", "copilot"]) });
      expect(found.map((s) => [s.id, s.present, s.files.length])).toEqual([["claude", true, 1], ["copilot", true, 1]]);
    });
  });

  test("says a ledger was read only when this Mac has one", () => {
    const home = homeWith({ ".claude/projects": [], ".codex/sessions": [] });
    // A gateway root with no usage directory: a client that sends its turns to another Mac's gateway.
    const state = tempDir("spendwatch-client-gateway-");
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: join(home, ".claude", "projects") },
      { agent: "codex", path: join(home, ".codex", "sessions") },
      { agent: "gateway", path: state },
    ]));
    withEnv({ SPENDWATCH_CONFIG: config }, () => {
      expect(discover({ sinceMs: 0, agents: new Set(["claude", "codex"]) }).map((s) => s.ledger)).toEqual([false, false]);
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

describe("Gemini discovery", () => {
  test("follows an explicit config, as for every other agent: named roots are read, and the home directory is not looked in", () => {
    const root = tempDir("spendwatch-gemini-");
    const log = join(root, "logs", "session.jsonl");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(log, "");
    const config = join(root, "config.json");
    const previous = process.env.SPENDWATCH_CONFIG;
    process.env.SPENDWATCH_CONFIG = config;
    try {
      writeFileSync(config, JSON.stringify([{ agent: "gemini", path: root }]));
      const named = discover({ sinceMs: 0, agents: new Set(["gemini"]) }).find((s) => s.id === "gemini");
      expect(named?.present).toBe(true);
      expect(named?.files.map((f) => f.path)).toEqual([log]);

      // A config that names no Gemini root says there is none, whatever the home directory holds.
      writeFileSync(config, JSON.stringify([{ agent: "claude", path: join(root, "none") }]));
      const unnamed = discover({ sinceMs: 0, agents: new Set(["gemini"]) }).find((s) => s.id === "gemini");
      expect(unnamed).toMatchObject({ present: false, files: [] });
    } finally {
      if (previous === undefined) delete process.env.SPENDWATCH_CONFIG;
      else process.env.SPENDWATCH_CONFIG = previous;
    }
  });
});

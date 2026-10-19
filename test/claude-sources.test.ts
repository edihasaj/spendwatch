import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "../src/aggregate";
import { IncrementalReader } from "../src/scan";
import { discover } from "../src/sources";
import { tempDir } from "./tmp";

const at = "2026-10-19T12:00:00.000Z";

function assistant(requestId: string, sessionId: string, input: number, output: number, isSidechain = false): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId,
    timestamp: at,
    isSidechain,
    message: {
      model: "claude-sonnet-4-6",
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [],
    },
  });
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function report(files: ReturnType<typeof discover>[number]["files"]) {
  const aggregate = new Aggregator();
  const reader = new IncrementalReader(aggregate);
  for (const file of files) {
    reader.poll(file);
    reader.flush(file);
  }
  return aggregate.report();
}

describe("Claude source discovery", () => {
  test("reads legacy and known nested subagents once with their parent project/account", () => {
    const home = tempDir("spendwatch-claude-");
    const projects = join(home, ".claude", "projects");
    const project = join(projects, "-Users-edi-Projects-team-app");
    const session = join(project, "session-current", "subagents");
    const legacy = join(project, "legacy.jsonl");
    const first = join(session, "agent-first.jsonl");
    const second = join(session, "agent-second.jsonl");
    const ignored = join(project, "session-current", "untracked.jsonl");
    const stale = join(project, "session-old", "subagents", "agent-stale.jsonl");
    mkdirSync(session, { recursive: true });
    mkdirSync(join(project, "session-old", "subagents"), { recursive: true });
    // The repeated parent request is a streamed rewrite, so the normal parser
    // and aggregator keep its latest usage once.
    writeFileSync(legacy, [
      assistant("parent-request", "parent", 10, 1),
      assistant("parent-request", "parent", 10, 1),
    ].join("\n") + "\n");
    writeFileSync(first, assistant("agent-first-request", "parent", 20, 2, true) + "\n");
    writeFileSync(second, assistant("agent-second-request", "parent", 30, 3, true) + "\n");
    writeFileSync(ignored, assistant("ignored-request", "ignored", 1_000, 100) + "\n");
    writeFileSync(stale, assistant("stale-request", "stale", 1_000, 100) + "\n");
    const old = Date.now() - 120_000;
    utimesSync(stale, old / 1_000, old / 1_000);
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([{ agent: "claude", path: projects, account: "work@example.com" }]));

    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: "off" }, () => {
      const cutoff = Date.now() - 60_000;
      const claude = discover({ sinceMs: cutoff, agents: new Set(["claude"]) }).find((source) => source.id === "claude")!;
      expect(claude.files.map((file) => file.path).sort()).toEqual([first, legacy, second].sort());
      expect(claude.files.every((file) => file.project === "team-app" && file.account === "work@example.com" && file.source === "claude")).toBe(true);

      const firstFile = claude.files.find((file) => file.path === first)!;
      const nestedEvents = [...firstFile.parse(assistant("agent-first-request", "agent-first", 20, 2), firstFile.ctx)];
      expect(nestedEvents.filter((event) => event.t === "api").map((event) => event.requestId)).toEqual(["agent-first-request"]);

      expect(report(claude.files)).toMatchObject({ apiCalls: 3, totalTokens: 66, source: "claude" });
      expect(report(claude.files).projects).toEqual([{ project: "team-app", tokens: 66, cost: expect.any(Number) }]);
      expect(report(claude.files).accounts).toEqual([{
        account: "work@example.com",
        tokens: 66,
        calls: 3,
        sessions: 1,
        cost: expect.any(Number),
      }]);

      expect(discover({ sinceMs: cutoff, project: "team-app", agents: new Set(["claude"]) })[0]?.files).toHaveLength(3);
      expect(discover({ sinceMs: cutoff, project: "other", agents: new Set(["claude"]) })[0]?.files).toHaveLength(0);
    });
  });

  test("uses one reader stream for the same nested subagent copied across profiles", () => {
    const home = tempDir("spendwatch-claude-");
    const firstProjects = join(home, ".claude-first", "projects");
    const secondProjects = join(home, ".claude-second", "projects");
    const firstNested = join(firstProjects, "-Users-edi-Projects-team-app", "session-current", "subagents");
    const secondNested = join(secondProjects, "-Users-edi-Projects-team-app", "session-current", "subagents");
    mkdirSync(firstNested, { recursive: true });
    mkdirSync(secondNested, { recursive: true });
    const copied = assistant("agent-copy-request", "agent-copy", 40, 4) + "\n";
    writeFileSync(join(firstNested, "agent-copy.jsonl"), copied);
    writeFileSync(join(secondNested, "agent-copy.jsonl"), copied);
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([
      { agent: "claude", path: firstProjects, account: "work@example.com" },
      { agent: "claude", path: secondProjects, account: "copied@example.com" },
    ]));

    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: "off" }, () => {
      const claude = discover({ sinceMs: 0, agents: new Set(["claude"]) }).find((source) => source.id === "claude")!;
      expect(claude.files).toHaveLength(2);
      expect(new Set(claude.files.map((file) => file.key)).size).toBe(1);
      expect(report(claude.files)).toMatchObject({ apiCalls: 1, totalTokens: 44 });
    });
  });

  test("keeps same-named subagents from different parent sessions distinct", () => {
    const home = tempDir("spendwatch-claude-");
    const projects = join(home, ".claude", "projects");
    const project = join(projects, "-Users-edi-Projects-team-app");
    const first = join(project, "session-first", "subagents");
    const second = join(project, "session-second", "subagents");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "agent-same.jsonl"), assistant("first-request", "parent-first", 50, 5) + "\n");
    writeFileSync(join(second, "agent-same.jsonl"), assistant("second-request", "parent-second", 60, 6) + "\n");
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify([{ agent: "claude", path: projects, account: "work@example.com" }]));

    withEnv({ SPENDWATCH_CONFIG: config, SPENDWATCH_GATEWAY_SOURCE: "off" }, () => {
      const claude = discover({ sinceMs: 0, agents: new Set(["claude"]) }).find((source) => source.id === "claude")!;
      expect(claude.files.map((file) => file.key).sort()).toEqual([
        "claude:subagent:session-first:agent-same.jsonl",
        "claude:subagent:session-second:agent-same.jsonl",
      ]);
      expect(report(claude.files)).toMatchObject({ apiCalls: 2, totalTokens: 121 });
    });
  });
});

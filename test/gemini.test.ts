// The Gemini CLI's own session records, built by hand from the installed bundle's `ChatRecordingService`
// schema (0.70.0): a metadata record, then one record per message, re-appended whole as that message's
// usage and tool results arrive. There is no real session on this Mac to read, so the fixtures are the
// contract, taken from `recordMessage`, `recordMessageTokens` and `recordToolCalls`.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate";
import { collectGemini, geminiAccountIn, newGeminiCtx, parseGeminiLine, readGeminiProjects, UNKNOWN_GEMINI_ACCOUNT } from "../src/gemini";
import { IncrementalReader } from "../src/scan";
import type { Event } from "../src/parse";
import { tempDir } from "./tmp";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const line = (value: unknown) => JSON.stringify(value) + "\n";

const PROJECT = join(homedir(), "Projects", "alpha");
const HASH = createHash("sha256").update(PROJECT).digest("hex");

/** The records of one turn: a prompt, a model answer whose usage and tool result arrive in later appends. */
function session(projectHash = HASH): string {
  return line({ sessionId: "s-1", projectHash, startTime: iso(NOW - 90_000), lastUpdated: iso(NOW - 10_000), kind: "main" })
    + line({ id: "u1", timestamp: iso(NOW - 80_000), type: "user", content: [{ text: "fix the parser" }] })
    // The CLI records the answer first, then re-pushes it once its usage metadata and its tool results exist.
    // `recordMessageTokens` writes the answer's candidates (`output`) and its thinking (`thoughts`) apart.
    + line({ id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "looking into it", model: "gemini-3.1-pro-preview" })
    + line({ $set: { lastUpdated: iso(NOW - 60_000) } })
    + line({ id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "looking into it", model: "gemini-3.1-pro-preview",
      tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 } })
    + line({ id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "looking into it", model: "gemini-3.1-pro-preview",
      tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 },
      toolCalls: [{ id: "c1", name: "run_shell_command", args: { command: "git status && ls", description: "check" },
        status: "success", timestamp: iso(NOW - 40_000), result: [{ functionResponse: { response: { output: "clean" } } }] }] })
    // The same record again, as a later append repeats every call it already held.
    + line({ id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "looking into it", model: "gemini-3.1-pro-preview",
      tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 },
      toolCalls: [{ id: "c1", name: "run_shell_command", args: { command: "git status && ls", description: "check" },
        status: "success", timestamp: iso(NOW - 40_000), result: [{ functionResponse: { response: { output: "clean" } } }] }] });
}

/** A home laid out as the CLI lays one out, with the registry entry that names the project. */
function home(options: { dirName?: string; registry?: boolean } = {}): string {
  const root = tempDir("spendwatch-gemini-home-");
  const chats = join(root, "tmp", options.dirName ?? "alpha", "chats");
  mkdirSync(chats, { recursive: true });
  // The registry always names the project by its current short id. When the directory is named by a hash,
  // that is the older layout the CLI left behind: the registry says no more than this about where it lives.
  if (options.registry !== false) writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: { [PROJECT]: "alpha" } }));
  writeFileSync(join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl"), session());
  return root;
}

function events(root: string): Event[] {
  const files = collectGemini(root, "", 0);
  expect(files).toHaveLength(1);
  const file = files[0]!;
  return [...file.parse("", file.ctx), ...[...session().split("\n")].flatMap((text) => [...file.parse(text, file.ctx)])];
}

const of = (events: Event[], kind: Event["t"]) => events.filter((event) => event.t === kind) as any[];

describe("a Gemini CLI session", () => {
  test("bills the turn once, with the cache inside the input it was recorded in", () => {
    const apis = of(events(home()), "api");
    expect(apis).toHaveLength(1);
    // 1000 input includes the 400 the cache served; the 50 answer tokens and the 10 thinking tokens are
    // recorded apart by the CLI and billed together, since Google prices thinking at the output rate.
    expect(apis[0]).toMatchObject({
      requestId: "g1", model: "gemini-3.1-pro-preview",
      usage: { input: 600, output: 60, cacheRead: 400, cache5m: 0, cache1h: 0 },
    });
  });

  test("reports the prompt, the tool call, and its result once apiece", () => {
    const all = events(home());
    expect(of(all, "prompt").map((event) => [event.text, event.sidechain])).toEqual([["fix the parser", false]]);
    // The shell command is what the drill-down reads, so it arrives split the way every other agent's does.
    // The CLI re-appends the message as tools finish, so a call is reported once per append and the
    // aggregator folds its rows by call id — which is why the ids, not the raw lines, are the count.
    expect([...new Set(of(all, "tooluse").map((event) => event.id))]).toEqual(["c1"]);
    expect(of(all, "tooluse")[0]).toMatchObject({ id: "c1", name: "run_shell_command", sub: "git", deep: "git status", detail: "git status && ls" });
    expect(of(all, "toolresult")).toHaveLength(1);
    expect(of(all, "toolresult")[0]).toMatchObject({ id: "c1", error: false });
    expect(of(all, "toolresult")[0].chars).toBeGreaterThan(0);
  });

  test("names the project the registry says the session directory belongs to", () => {
    expect(collectGemini(home(), "", 0)[0]).toMatchObject({ project: "alpha", source: "gemini" });
  });

  test("recovers the project of an older directory named by its hash, from the hash the session itself records", () => {
    const file = collectGemini(home({ dirName: HASH }), "", 0)[0]!;
    expect(file.project).toBe("?"); // the directory name is a digest: only the session can say what it hashes
    const metas = of([...session().split("\n")].flatMap((text) => [...file.parse(text, file.ctx)]), "meta");
    expect(metas.map((event) => event.project)).toEqual(["alpha"]);
  });

  test("reads a session once when the CLI kept both the .json and the .jsonl record of it", () => {
    const root = home();
    const chats = join(root, "tmp", "alpha", "chats");
    // What the CLI leaves when it resumes an older session: the same messages, under both names.
    writeFileSync(join(chats, "session-2026-11-20T09-30-ab12cd34.json"),
      JSON.stringify({ sessionId: "s-1", projectHash: HASH, messages: [{ id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "looking into it", model: "gemini-3.1-pro-preview", tokens: { input: 1000, output: 50, cached: 400 } }] }));
    expect(collectGemini(root, "", 0).map((file) => file.path)).toEqual([join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl")]);

    // A .json with no twin is still the only record of an old session, so it is read.
    writeFileSync(join(chats, "session-2026-01-01T09-30-ffffffff.json"), JSON.stringify({ sessionId: "s-0", messages: [] }));
    expect(collectGemini(root, "", 0).map((file) => file.path).sort()).toEqual([
      join(chats, "session-2026-01-01T09-30-ffffffff.json"),
      join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl"),
    ]);
  });

  test("marks a tool that came back `error`, the status the CLI actually writes", () => {
    const root = tempDir("spendwatch-gemini-failed-");
    const chats = join(root, "tmp", "alpha", "chats");
    mkdirSync(chats, { recursive: true });
    // `CoreToolCallStatus` spells a failed call `error`; a parser that watched for `failed` would call every
    // broken tool a good one, and the drill-down would hide the failures the user most wants to see.
    const call = (id: string, status: string) => ({ id, name: "run_shell_command", args: { command: "make test" },
      status, timestamp: iso(NOW - 60_000), result: [{ functionResponse: { response: { output: "exit 2" } } }] });
    const msg = (id: string, toolCalls: unknown[]) => line({ id, timestamp: iso(NOW - 70_000), type: "gemini",
      content: "ran it", model: "gemini-3.1-pro-preview", toolCalls });
    const body = msg("g1", [call("c1", "error")]) + msg("g2", [call("c2", "success")]);
    writeFileSync(join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl"), body);
    const file = collectGemini(root, "", 0)[0]!;
    const results = of(body.split("\n").flatMap((text) => [...file.parse(text, file.ctx)]), "toolresult");
    expect(results.map((event) => [event.id, event.error])).toEqual([["c1", true], ["c2", false]]);
  });

  test("reads a legacy whole-document session end to end, through the reader", () => {
    const root = tempDir("spendwatch-gemini-legacy-");
    const chats = join(root, "tmp", "alpha", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: { [PROJECT]: "alpha" } }));
    // What the CLI left behind before it moved to JSONL: one document, the same message records in a
    // `messages` array. A line-at-a-time parser sees one line and bills nothing.
    writeFileSync(join(chats, "session-2026-01-01T09-30-ffffffff.json"), JSON.stringify({
      sessionId: "s-old", projectHash: HASH, startTime: iso(NOW - 90_000), lastUpdated: iso(NOW - 10_000), kind: "main",
      messages: [
        { id: "u1", timestamp: iso(NOW - 80_000), type: "user", content: [{ text: "the old form" }] },
        { id: "g1", timestamp: iso(NOW - 70_000), type: "gemini", content: "done", model: "gemini-3.1-pro-preview",
          tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 } },
      ] }));
    const file = collectGemini(root, "", 0)[0]!;
    expect(file.path).toBe(join(chats, "session-2026-01-01T09-30-ffffffff.json"));

    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    expect(reader.poll(file)).toBeGreaterThan(0);
    reader.flush(file);
    expect(agg.report()).toMatchObject({ apiCalls: 1, sessions: 1 });

    const all = [...file.events!()];
    expect(of(all, "api")[0]).toMatchObject({ sessionId: "s-old", requestId: "g1",
      usage: { input: 600, output: 60, cacheRead: 400 } });
    expect(of(all, "prompt").map((event) => event.text)).toEqual(["the old form"]);
    expect(file.project).toBe("alpha"); // the registry names the directory, so no record need say it

    // The `.jsonl` twin still wins: one session, one bill, whichever name holds it.
    writeFileSync(join(chats, "session-2026-01-01T09-30-ffffffff.jsonl"), session());
    expect(collectGemini(root, "", 0).map((found) => found.path))
      .toEqual([join(chats, "session-2026-01-01T09-30-ffffffff.jsonl")]);
  });

  test("collects a subagent's own transcript once, and bills its calls as delegated work", () => {
    const root = home();
    const chats = join(root, "tmp", "alpha", "chats");
    // The child's chats sit under the parent session id, named by its agent id. The child runs its own model
    // calls, and the parent's tool record for it carries no usage — these tokens exist nowhere else.
    const kids = join(chats, "s-1");
    mkdirSync(kids, { recursive: true });
    const child = line({ sessionId: "kid-1", projectHash: HASH, startTime: iso(NOW - 60_000), lastUpdated: iso(NOW - 30_000), kind: "subagent" })
      + line({ id: "k1", timestamp: iso(NOW - 50_000), type: "user", content: "search the docs" })
      + line({ id: "k2", timestamp: iso(NOW - 40_000), type: "gemini", content: "found it", model: "gemini-3.1-pro-preview",
        tokens: { input: 400, output: 20, cached: 100, thoughts: 5, tool: 0, total: 525 } });
    writeFileSync(join(kids, "agent-kid-1.jsonl"), child);

    const files = collectGemini(root, "", 0);
    // The parent session and the child transcript, each once — the child is not also read as a session.
    expect(files.map((found) => found.path).sort()).toEqual([join(chats, "s-1", "agent-kid-1.jsonl"), join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl")]);
    const parent = files.find((found) => found.path === join(chats, "session-2026-11-20T09-30-ab12cd34.jsonl"))!;
    const kid = files.find((found) => found.path === join(kids, "agent-kid-1.jsonl"))!;
    expect(kid.key).toBe("gemini:subagent:s-1:agent-kid-1.jsonl");

    const events = child.split("\n").flatMap((text) => [...kid.parse(text, kid.ctx)]);
    const calls = of(events, "api");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "kid-1", requestId: "k2", sidechain: true,
      usage: { input: 300, output: 25, cacheRead: 100 }, // thinking rides with output, as any Gemini call's does
      agent: { role: "subagent", name: "agent-kid-1" },
    });
    expect(of(events, "prompt")).toMatchObject([{ text: "search the docs", sidechain: true }]);

    // The parent's own calls stay undelegated, so the projection shows one subagent and no invented main work.
    const parentCalls = of(session().split("\n").flatMap((text) => [...parent.parse(text, parent.ctx)]), "api");
    expect(parentCalls.every((event) => event.sidechain === false && event.agent === undefined)).toBe(true);

    // End to end through the reader, with a discovery of its own: the parser state above has already reported
    // this transcript, and a reader must not be handed a context that has seen the file.
    const agg = new Aggregator();
    const reader = new IncrementalReader(agg);
    const fresh = collectGemini(root, "", 0).find((found) => found.path === join(kids, "agent-kid-1.jsonl"))!;
    expect(reader.poll(fresh)).toBeGreaterThan(0);
    reader.flush(fresh);
    const subagents = agg.report().subagents;
    expect(subagents?.subagent.calls).toBe(1);
    expect(subagents?.main.calls ?? 0).toBe(0);
    expect(subagents?.roles.map((role) => role.role)).toEqual(["subagent"]);
    expect(subagents?.agents[0]).toMatchObject({ name: "agent-kid-1", role: "subagent" });
  });

  test("names the home by its active Google account, and by a fixed label when none is active", () => {
    // A `~/.gemini` root keeps the sign-in beside its sessions.
    const root = home();
    writeFileSync(join(root, "google_accounts.json"), JSON.stringify({ active: "edi@example.com", activeProject: "some-gcp-project" }));
    expect(geminiAccountIn(root)).toBe("edi@example.com");
    expect(collectGemini(root, "", 0)[0]).toMatchObject({ account: "edi@example.com" });

    // The gateway's private home is a home, not a `.gemini`: the CLI keeps its own sign-in inside it.
    const gatewayHome = tempDir("spendwatch-gemini-private-");
    mkdirSync(join(gatewayHome, ".gemini"), { recursive: true });
    writeFileSync(join(gatewayHome, ".gemini", "google_accounts.json"), JSON.stringify({ active: "user@example.com" }));
    expect(geminiAccountIn(gatewayHome)).toBe("user@example.com");

    for (const missing of [undefined, "some-gcp-project"]) {
      writeFileSync(join(root, "google_accounts.json"), JSON.stringify(missing ? { activeProject: missing } : {}));
      expect(geminiAccountIn(root)).toBe(UNKNOWN_GEMINI_ACCOUNT);
    }
    expect(geminiAccountIn(join(root, "no-such-home"))).toBe(UNKNOWN_GEMINI_ACCOUNT);
  });

  test("ignores the records that carry no message, and a line that is not JSON", () => {
    const ctx = newGeminiCtx("alpha", readGeminiProjects(home()), "alpha");
    const emitted = (text: string) => [...parseGeminiLine(text, ctx)];
    expect(emitted("")).toEqual([]);
    expect(emitted("{not json")).toEqual([]);
    expect(emitted(line({ $set: { lastUpdated: iso(NOW) } }))).toEqual([]);
    expect(emitted(line({ $patch: { id: "g1", content: "rewound" } }))).toEqual([]);
    // A synthetic record (snapshot, summary) has a type but no usage of its own.
    expect(emitted(line({ id: "syn", timestamp: iso(NOW), type: "gemini", content: [{ text: "summary" }] }))).toEqual([]);
  });

  test("keeps its own session name once a record gives it one", () => {
    const ctx = newGeminiCtx("alpha", readGeminiProjects(home()), "alpha");
    [...parseGeminiLine(line({ sessionId: "real-session" }), ctx)];
    expect(ctx.sid).toBe("real-session");
    expect([...parseGeminiLine(line({ id: "u9", timestamp: iso(NOW), type: "user", content: "hello" }), ctx)][0]).toMatchObject({ sessionId: "real-session" });
  });
});

describe("the project registry", () => {
  test("names a directory both by its short id and by the hash the older layout used", () => {
    const root = home();
    const projects = readGeminiProjects(root);
    expect(projects.bySlug.get("alpha")).toBe(PROJECT);
    expect(projects.byHash.get(HASH)).toBe(PROJECT);
  });

  test("reads nothing from a registry that is not there or not shaped like one", () => {
    const root = tempDir("spendwatch-gemini-none-");
    expect(readGeminiProjects(root)).toEqual({ bySlug: new Map(), byHash: new Map() });
    writeFileSync(join(root, "projects.json"), "[]");
    expect(readGeminiProjects(root).bySlug.size).toBe(0);
  });
});

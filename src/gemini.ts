// Reads the Gemini CLI's own session records, and names the Google account behind a Gemini home.
//
// Only a `gemini` run this Mac started itself leaves these files. A conversation a `gemini-subscription`
// provider ran is recorded in a disposable home the gateway deletes when the session ends, so those turns
// are billed from the gateway's ledger instead (gateway.ts) and never appear here.
//
// The record format is the installed bundle's `ChatRecordingService` (checked against 0.70.0): one JSON
// object per line — a metadata record `{ sessionId, projectHash, startTime, lastUpdated, kind, directories }`,
// then one record per message `{ id, timestamp, type, content, model?, tokens?, toolCalls? }`, re-appended
// whole as that message's usage and tool results arrive (the CLI's own loader keeps the last record of an
// id, so this parser keeps the last record of an id too). `tokens` is `{ input, output, cached, thoughts,
// tool, total }` from the response's usage metadata (`recordMessageTokens`): `input` is gross of `cached`,
// while `output` (`candidatesTokenCount`) and `thoughts` (`thoughtsTokenCount`) are recorded apart and
// Google bills thinking at the output rate, so the two together are the call's billable output. Tool calls
// ride on the model's own message, and gain a `result` as each tool finishes; `CoreToolCallStatus` spells a
// failed one `error`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { cmdParts, type Event } from "./parse";
import { projectFromCwd } from "./projects";
import { agentTag, type AgentTag } from "./subagents";
import type { SourceFile } from "./sources";

/** What a home with no readable `google_accounts.json` is called, so its turns still form one account. */
export const UNKNOWN_GEMINI_ACCOUNT = "Unknown Google account";

const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/**
 * The `.gemini` directory of a root: a root is either a home — what the gateway config calls `geminiHome`,
 * which holds a `.gemini/` — or the `.gemini` directory itself, which is what a `~/.gemini` root is.
 */
export function geminiDirOf(root: string): string {
  const nested = join(root, ".gemini");
  if (basename(root) === ".gemini") return root;
  try {
    return statSync(nested).isDirectory() ? nested : root;
  } catch {
    return root;
  }
}

/**
 * The account a Gemini home is signed in as: the active Google account its own `google_accounts.json`
 * names, and a fixed label when it names none. Nothing else in that file is read.
 */
export function geminiAccountIn(root: string): string {
  try {
    const active = str(JSON.parse(readFileSync(join(geminiDirOf(root), "google_accounts.json"), "utf8"))?.active);
    if (active) return active;
  } catch {
    // No home, no file, no active account: the fixed label, never a guess at whoever signed in last.
  }
  return UNKNOWN_GEMINI_ACCOUNT;
}

/**
 * `<home>/.gemini/projects.json` maps every project path the CLI has run in to the short id its sessions
 * live under. Read backwards it names the project of a session directory; hashing its paths the way the CLI
 * does (`sha256(projectRoot)`) also names the project of an older directory named by that hash, and of a
 * session whose own record carries the hash.
 */
export interface GeminiProjects {
  bySlug: Map<string, string>;
  byHash: Map<string, string>;
}

export function readGeminiProjects(geminiDir: string): GeminiProjects {
  const bySlug = new Map<string, string>();
  const byHash = new Map<string, string>();
  let projects: unknown;
  try {
    projects = JSON.parse(readFileSync(join(geminiDir, "projects.json"), "utf8"))?.projects;
  } catch {
    return { bySlug, byHash }; // no registry: every project below must be named by what its records say
  }
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return { bySlug, byHash };
  for (const [path, slug] of Object.entries(projects as Record<string, unknown>)) {
    const id = str(slug);
    if (id) bySlug.set(id, path);
    byHash.set(createHash("sha256").update(path).digest("hex"), path);
  }
  return { bySlug, byHash };
}

/** The project a session belongs to, from its record's hash or the name of the directory holding it. */
function projectOf(dirName: string, projects: GeminiProjects, projectHash?: string): string | undefined {
  const path = (projectHash ? projects.byHash.get(projectHash) : undefined) ?? projects.bySlug.get(dirName);
  return path ? projectFromCwd(path) : undefined;
}

// ---- parser ------------------------------------------------------------------
export interface GeminiCtx {
  sid: string;
  /** Name of the `tmp/<project>` directory the file sits in, which is the registry's short id. */
  dirName: string;
  projects: GeminiProjects;
  /** The latest record of each message id, as the CLI's own loader keeps it. */
  messages: Map<string, Record<string, unknown>>;
  /** Tool calls whose result was already reported: a re-appended message repeats the whole array. */
  results: Set<string>;
  /** Prompts already reported, which a re-appended message repeats verbatim. */
  prompts: Set<string>;
  /** The project, once a record names it; reported once, as `meta`. */
  project?: string;
  model?: string;
  /** Set for a subagent's own transcript: every call it makes is delegated work (see subagents.ts). */
  agent?: AgentTag;
  /** True with `agent`: the aggregator folds a subagent's first prompt as the delegation, not a user turn. */
  sidechain: boolean;
}

/** What makes a transcript a subagent's own: the agent id it is named by, beside its parent's session. */
export interface GeminiSubagent {
  sid: string;
  agent: AgentTag;
}

export function newGeminiCtx(dirName: string, projects: GeminiProjects, project?: string, subagent?: GeminiSubagent): GeminiCtx {
  return { sid: subagent?.sid ?? `gemini-${dirName}`, dirName, projects, messages: new Map(), results: new Set(), prompts: new Set(),
    sidechain: subagent !== undefined, ...(project ? { project } : {}), ...(subagent ? { agent: subagent.agent } : {}) };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A message's stamp, or 0 when it carries none — the same convention the other parsers use. */
function stampOf(record: Record<string, unknown>): number {
  const at = Date.parse(String(record.timestamp ?? ""));
  return Number.isFinite(at) ? at : 0;
}

/** A user message's text: the CLI records parts (`[{ text }]`) or a plain string. */
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const value = (part as Record<string, unknown> | null)?.text;
    if (typeof value === "string") out += value;
  }
  return out;
}

// The CLI's shell tool is `run_shell_command` and its one required argument is the command itself, so the
// bash/deep drill-downs work here the way they do for the other agents.
const SHELL_TOOLS = new Set(["run_shell_command", "ShellTool"]);

function shellCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command ? command : undefined;
}

/** How big a tool result was for the model that had to read it; the CLI stores it as response parts. */
function resultChars(result: unknown): number {
  if (result === null || result === undefined) return 0;
  return typeof result === "string" ? result.length : JSON.stringify(result).length;
}

function* message(ctx: GeminiCtx, record: Record<string, unknown>, id: string, type: string, prior?: Record<string, unknown>): Generator<Event> {
  const at = stampOf(record);
  if (str(record.model)) ctx.model = record.model;
  const model = str(record.model) ?? ctx.model;

  if (type === "user") {
    const body = text(record.content);
    if (body && !ctx.prompts.has(id)) {
      ctx.prompts.add(id);
      yield { t: "prompt", sessionId: ctx.sid, promptId: id, text: body, sidechain: ctx.sidechain, ts: at };
    }
    return;
  }
  if (type !== "gemini") return; // a synthetic record (snapshot, summary) carries no usage of its own

  const tokens = record.tokens as Record<string, unknown> | undefined;
  // The CLI re-appends a message that has not changed — a tool result arriving re-pushes the whole record —
  // and a call the aggregator already holds needs no second figure.
  const unchanged = prior !== undefined && JSON.stringify(prior.tokens ?? null) === JSON.stringify(tokens ?? null);
  if (tokens && typeof tokens === "object" && !unchanged) {
    // `cached` is part of `input`, so it is never added to it. `output` and `thoughts` are recorded apart
    // (`candidatesTokenCount` and `thoughtsTokenCount`) and Google bills thinking at the output rate, so
    // the two together are what the turn costs. One call is one `api` event, whatever the text says.
    const gross = count(tokens.input);
    const cached = Math.min(count(tokens.cached), gross);
    const output = count(tokens.output) + count(tokens.thoughts);
    if (gross || output) {
      yield {
        t: "api", sessionId: ctx.sid, requestId: id, model,
        usage: { input: Math.max(0, gross - cached), output, cacheRead: cached, cache5m: 0, cache1h: 0 },
        sidechain: ctx.sidechain, ts: at, ...(ctx.agent ? { agent: ctx.agent } : {}),
      };
    }
  }

  if (!Array.isArray(record.toolCalls)) return;
  for (const entry of record.toolCalls as unknown[]) {
    const call = entry as Record<string, unknown> | null;
    if (!call || typeof call !== "object") continue;
    const name = str(call.name) ?? str(call.displayName) ?? "?";
    const callId = str(call.id) ?? `${id}:${name}`;
    const command = SHELL_TOOLS.has(name) ? shellCommand(call.args) : undefined;
    yield {
      t: "tooluse", sessionId: ctx.sid, requestId: id, id: callId, name,
      argChars: JSON.stringify(call.args ?? {}).length,
      ...(command ? cmdParts(command) : {}),
      detail: command ?? str(call.description),
      ts: stampOf(call),
    };
    // The CLI re-appends the message as each tool finishes, repeating every call it already held: only a
    // result this read has not reported yet may be tallied, or one result would count once per append.
    if (!("result" in call) || ctx.results.has(callId)) continue;
    ctx.results.add(callId);
    yield { t: "toolresult", sessionId: ctx.sid, id: callId, chars: resultChars(call.result),
      // The CLI's own status enum (`CoreToolCallStatus`) spells a failed call `error`, never `failed`.
      error: str(call.status) === "error", ts: at };
  }
}

/**
 * One line of a `session-*.jsonl`. Metadata records carry no message id: they decide the session name and,
 * when the discovery could not name the project from the directory, the project itself.
 */
export function* parseGeminiLine(line: string, ctx: GeminiCtx): Generator<Event> {
  if (!line || line[0] !== "{") return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  yield* conversationRecord(ctx, record as Record<string, unknown>);
}

/** One record, from either reader: it may name the session and the project, and it may carry a message. */
function* conversationRecord(ctx: GeminiCtx, d: Record<string, unknown>): Generator<Event> {
  const sessionId = str(d.sessionId);
  if (sessionId) ctx.sid = sessionId;
  if (!ctx.project) {
    const directories = d.directories;
    const cwd = Array.isArray(directories) ? str(directories[0]) : undefined;
    const project = projectOf(ctx.dirName, ctx.projects, str(d.projectHash)) ?? (cwd ? projectFromCwd(cwd) : undefined);
    if (project) {
      ctx.project = project;
      yield { t: "meta", sessionId: ctx.sid, project, ts: 0 };
    }
  }

  const id = str(d.id);
  const type = str(d.type);
  if (!id || !type) return; // metadata, `$set`, `$patch` or `$rewindTo`: no message to bill
  const prior = ctx.messages.get(id);
  ctx.messages.set(id, d); // the CLI's loader keeps the last record of an id, and so does this one
  yield* message(ctx, d, id, type, prior);
}

/**
 * A whole `session-*.json`, the form the CLI wrote before it moved to JSONL: one document whose `messages`
 * array holds the very records the JSONL appends one per line. Like the CLI's own loader
 * (`loadConversationRecordSync`, which falls back to `parseLegacyContentFallback`), a file that is not one
 * document — the CLI leaves JSONL under the older name too — is read line by line instead.
 */
export function* parseGeminiDoc(text: string, ctx: GeminiCtx): Generator<Event> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    yield* parseGeminiLines(text, ctx);
    return;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    yield* parseGeminiLines(text, ctx);
    return;
  }
  const d = doc as Record<string, unknown>;
  yield* conversationRecord(ctx, d); // the wrapper is the metadata record: session name, and maybe the project
  const messages = d.messages;
  if (!Array.isArray(messages)) return;
  for (const entry of messages) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) yield* conversationRecord(ctx, entry as Record<string, unknown>);
  }
}

function* parseGeminiLines(text: string, ctx: GeminiCtx): Generator<Event> {
  for (const line of text.split("\n")) yield* parseGeminiLine(line, ctx);
}

// ---- discovery -----------------------------------------------------------------
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function mtimeOk(path: string, sinceMs: number): boolean {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** What an events-backed file owes the reader to say whether it changed since its events were last folded. */
function fileVersion(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "unreadable";
  }
}

/** A session file: `session-*.jsonl`, or the older `session-*.json` the CLI leaves behind. */
const isSession = (name: string): boolean => name.startsWith("session-") && (name.endsWith(".jsonl") || name.endsWith(".json"));

/**
 * Every session of one Gemini home: `<home>/.gemini/tmp/<project>/chats/session-*.jsonl`, and the transcript
 * each of its subagents keeps for itself one level deeper, `chats/<parent session>/<agent id>.jsonl`.
 *
 * A session the CLI resumed exists as `.json` and `.jsonl` at once — the CLI moves the record to the `.jsonl`
 * name and appends every message again — so the `.json` is read only when its `.jsonl` twin is absent. One
 * session is one bill, whichever files hold it. A whole-document `.json` is not a line at a time, so it hands
 * the reader all of its events at once (see `IncrementalReader.poll`).
 *
 * A subagent is not the parent's tool call repeated: the child runs its own model calls and records its own
 * tokens, and the parent's tool record for it carries no usage (`recordCompletedToolCalls` keeps result,
 * status and `agentId` only). So each child transcript is collected once, here and nowhere else, and every
 * call it reports is tagged as delegated work (subagents.ts).
 */
export function collectGemini(root: string, account: string, sinceMs: number): SourceFile[] {
  const files: SourceFile[] = [];
  const geminiDir = geminiDirOf(root);
  const tmp = join(geminiDir, "tmp");
  const projects = readGeminiProjects(geminiDir);
  const acct = account || geminiAccountIn(root);
  for (const dirName of safeReaddir(tmp)) {
    const chats = join(tmp, dirName, "chats");
    if (!existsSync(chats)) continue; // a tmp project folder with no chats holds no session
    const known = projectOf(dirName, projects);
    for (const name of safeReaddir(chats)) {
      if (isSession(name)) {
        const path = join(chats, name);
        if (!statFile(path) || !mtimeOk(path, sinceMs)) continue;
        if (name.endsWith(".json") && existsSync(`${path}l`)) continue;
        const base = { path, project: known ?? "?", source: "gemini", account: acct };
        if (!name.endsWith(".json")) {
          files.push({ ...base, parse: parseGeminiLine, ctx: newGeminiCtx(dirName, projects, known) });
        } else {
          // A fresh parser state per fold: these events are re-offered whole, and a re-read must not inherit
          // what an earlier fold already reported as billed.
          files.push({ ...base, parse: () => [], ctx: null, version: () => fileVersion(path),
            events: () => [...parseGeminiDoc(readFileOrEmpty(path), newGeminiCtx(dirName, projects, known))] });
        }
        continue;
      }
      const children = join(chats, name); // a parent session id, holding its subagents' own transcripts
      if (!isDirectory(children)) continue;
      for (const child of safeReaddir(children)) {
        if (!child.endsWith(".jsonl")) continue; // the CLI writes a child transcript as JSONL, whatever its name
        const path = join(children, child);
        if (!statFile(path) || !mtimeOk(path, sinceMs)) continue;
        const agentId = child.slice(0, -".jsonl".length);
        files.push({ path, key: `gemini:subagent:${name}:${child}`, project: known ?? "?", source: "gemini", account: acct,
          parse: parseGeminiLine,
          ctx: newGeminiCtx(dirName, projects, known, { sid: agentId, agent: agentTag("subagent", agentId) }) });
      }
    }
  }
  return files;
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // gone between discovery and read; the next discovery sees the loss
  }
}

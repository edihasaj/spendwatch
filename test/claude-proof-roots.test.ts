import { describe, expect, test } from "bun:test";
import { Dir, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeFile } from "../src/gateway-sources";
import { UNCONFIRMED } from "../src/codex";
import { claudeModelAliases, claudeProofRootDiscovery, defaultClaudeProofRoots } from "../src/claude-proof-roots";
import { collectClaudeSourceFiles } from "../src/claude-source-files";
import { tempDir } from "./tmp";

const projects = (home: string, branch: string, proof: string, config: string) => {
  const path = join(home, "Library", "Application Support", "Claude-3p", branch, proof, config, "projects");
  mkdirSync(path, { recursive: true });
  return path;
};

describe("isolated Claude proof roots", () => {
  test("discovers only approved non-symlink project roots with an unknown account", () => {
    const home = tempDir("spendwatch-claude-proofs-");
    const native = projects(home, "auto-review-prep/native-proofs", "proof-a", "claude-config");
    const alias = projects(home, "alias-trial/proofs", "proof-b", "claude-home");
    const escaped = join(home, "escaped");
    mkdirSync(escaped);
    const links = join(home, "Library", "Application Support", "Claude-3p", "auto-review-prep", "native-proofs", "link");
    symlinkSync(escaped, links);
    expect(defaultClaudeProofRoots(home).map((root) => [root.path, root.account]).sort()).toEqual([
      [alias, "Unknown isolated account"],
      [native, "Unknown isolated account"],
    ]);
  });

  test("loads only bounded exact opaque aliases and leaves unknown models raw", () => {
    const home = tempDir("spendwatch-claude-aliases-");
    const config = join(home, ".config", "spendwatch");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "claude-model-aliases.json"), JSON.stringify({
      "claude-hg-route-7": "claude-opus-5-5",
    }));
    const aliases = claudeModelAliases(home);
    expect(aliases.get("claude-hg-route-7")).toBe("claude-opus-5-5");
    expect(aliases.get("claude-hg-route-8")).toBeUndefined();
    const file = claudeFile("fixture.jsonl", "project", "Unknown isolated account", undefined, aliases);
    const events = [...file.parse(JSON.stringify({
      type: "assistant", requestId: "r", sessionId: "s", timestamp: "2026-10-20T00:00:00Z",
      message: { model: "claude-hg-route-7", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }), file.ctx)];
    expect(events.find((event) => event.t === "api")?.model).toBe("claude-opus-5-5");
  });

  test("normalizes an unconfirmed gateway model while preserving its suffix", () => {
    const aliases = new Map([["claude-hg-route-7", "claude-opus-5-5"]]);
    const file = claudeFile("fixture.jsonl", "project", "Unknown isolated account", { covers: () => false }, aliases);
    const events = [...file.parse(JSON.stringify({
      type: "assistant", requestId: "r", sessionId: "s", timestamp: "2020-01-01T00:00:00Z",
      message: { id: "msg_gl_7", model: "claude-hg-route-7", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }), file.ctx), ...file.settle!(file.ctx, true)];
    expect(events.find((event) => event.t === "api")?.model).toBe(`claude-opus-5-5 (${UNCONFIRMED})`);
  });

  test("rejects an oversized proof directory and malformed alias input", () => {
    const home = tempDir("spendwatch-claude-bounds-");
    for (let n = 0; n <= 64; n++) projects(home, "auto-review-prep/native-proofs", `p${n}`, "claude-config");
    expect(defaultClaudeProofRoots(home)).toEqual([]);
    expect(claudeProofRootDiscovery(home).unavailable).toBe(true);
    const config = join(home, ".config", "spendwatch");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "claude-model-aliases.json"), JSON.stringify({ "not-an-opaque-alias": "claude-opus-5-5" }));
    expect(claudeModelAliases(home).size).toBe(0);
  });

  test("reads at most 65 proof-directory entries before declaring the root unavailable", () => {
    const home = tempDir("spendwatch-claude-opendir-bound-");
    for (let n = 0; n < 200; n++) mkdirSync(join(home, "Library", "Application Support", "Claude-3p", "auto-review-prep", "native-proofs", `p${n}`), { recursive: true });
    const original = Dir.prototype.readSync;
    let reads = 0;
    Dir.prototype.readSync = function (...args: Parameters<typeof original>) {
      reads++;
      return original.apply(this, args);
    };
    try {
      expect(claudeProofRootDiscovery(home)).toMatchObject({ roots: [], unavailable: true });
    } finally {
      Dir.prototype.readSync = original;
    }
    expect(reads).toBe(65);
  });

  test("rejects a symlinked ancestor and bounds alias-file reads before parsing", () => {
    const home = tempDir("spendwatch-claude-ancestor-");
    const outside = tempDir("spendwatch-claude-outside-");
    mkdirSync(join(outside, "Application Support", "Claude-3p", "auto-review-prep", "native-proofs", "proof", "claude-config", "projects"), { recursive: true });
    mkdirSync(join(home, "Library"), { recursive: true });
    symlinkSync(outside, join(home, "Library", "Application Support"));
    expect(defaultClaudeProofRoots(home)).toEqual([]);
    const config = join(home, ".config", "spendwatch");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "claude-model-aliases.json"), "x".repeat(8 * 1024 + 1));
    expect(claudeModelAliases(home).size).toBe(0);
  });

  test("rejects a FIFO alias file without opening a blocking reader", () => {
    const home = tempDir("spendwatch-claude-alias-fifo-");
    const config = join(home, ".config", "spendwatch");
    mkdirSync(config, { recursive: true });
    const fifo = join(config, "claude-model-aliases.json");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(claudeModelAliases(home).size).toBe(0);
  });

  test("does not follow proof-only project, session, subagent, or transcript links", () => {
    const home = tempDir("spendwatch-claude-descendants-");
    const root = projects(home, "auto-review-prep/native-proofs", "proof", "claude-config");
    const outside = tempDir("spendwatch-claude-descendant-outside-");
    const project = join(root, "-project");
    mkdirSync(project);
    const now = Date.now();
    writeFileSync(join(outside, "outside.jsonl"), JSON.stringify({ type: "assistant" }));
    symlinkSync(outside, join(root, "-linked-project"));
    symlinkSync(outside, join(project, "session"));
    symlinkSync(join(outside, "outside.jsonl"), join(project, "linked.jsonl"));
    expect(collectClaudeSourceFiles(root, "Unknown isolated account", now - 1_000, undefined, undefined, undefined, true)).toEqual([]);
  });

  test("default discovery marks proofs unknown and explicit roots override them", () => {
    const home = tempDir("spendwatch-claude-discovery-");
    const proof = projects(home, "auto-review-prep/native-proofs", "proof", "claude-config");
    const explicit = join(home, "explicit", "projects");
    const write = (root: string, name: string) => {
      const project = join(root, "-project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, name), JSON.stringify({
        type: "assistant", requestId: "r", sessionId: "s", timestamp: "2026-10-20T00:00:00Z",
        message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      }) + "\n");
    };
    write(proof, "proof.jsonl");
    write(explicit, "explicit.jsonl");
    const script = `import { discover } from "./src/sources"; const source=discover({sinceMs:0,agents:new Set(["claude"])}).find(x=>x.id==="claude"); console.log(JSON.stringify(source.files.map(({path,account,accountBasis})=>({path,account,accountBasis}))));`;
    const run = (env: Record<string, string>) => Bun.spawnSync({
      cmd: [process.execPath, "-e", script], cwd: process.cwd(),
      env: { ...process.env, HOME: home, SPENDWATCH_GATEWAY_SOURCE: "off", ...env },
    });
    expect(JSON.parse(run({}).stdout.toString())).toEqual([
      { path: join(proof, "-project", "proof.jsonl"), account: "Unknown isolated account", accountBasis: "unknown" },
    ]);
    const config = join(home, "sources.json");
    writeFileSync(config, JSON.stringify([{ agent: "claude", path: explicit }]));
    const explicitFiles = JSON.parse(run({ SPENDWATCH_CONFIG: config }).stdout.toString());
    expect(explicitFiles).toHaveLength(1);
    expect(explicitFiles[0]).toMatchObject({ path: join(explicit, "-project", "explicit.jsonl") });
    expect(explicitFiles[0].accountBasis).toBeUndefined();
  });

});

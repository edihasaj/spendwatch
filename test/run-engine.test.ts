import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekExecutor, type ExecutionRequest, type ExecutionResult, type ModelExecutor } from "../src/model-executors";
import { executeRoute } from "../src/run-engine";
import { buildRoutePlan } from "../src/routing";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "spendwatch-run-"));
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: {} }));
  return path;
}

class FakeExecutor implements ModelExecutor {
  requests: ExecutionRequest[] = [];
  constructor(private readonly handler: (request: ExecutionRequest) => Partial<ExecutionResult>) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(request);
    return { provider: "codex", model: request.model, ok: true, exitCode: 0, output: "done", ...this.handler(request) };
  }
}

describe("routed execution", () => {
  test("escalates only after observable failure and persists attempts", async () => {
    const path = repo();
    const database = join(path, "routing.db");
    const executor = new FakeExecutor((request) => request.attempt === 1 ? { ok: false, exitCode: 1, error: "tool failed" } : {});
    const plan = buildRoutePlan({ task: "inspect the parser and explain the failure", repo: path }, 0);
    const result = await executeRoute({ plan, provider: "codex", shadow: false, maxAttempts: 3, database, executors: { codex: executor } });

    expect(result.status).toBe("succeeded");
    expect(executor.requests.map((request) => request.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(executor.requests[1]?.priorFailure).toContain("tool failed");
    const db = new Database(database, { readonly: true });
    expect(db.query("SELECT status, attempts, planned_model, actual_model FROM routing_runs").get()).toEqual({
      status: "succeeded", attempts: 2, planned_model: "gpt-5.6-luna", actual_model: "gpt-5.6-terra",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM routing_attempts").get()).toEqual({ count: 2 });
    db.close();
  });

  test("shadow mode records Luna but executes the Sol baseline", async () => {
    const path = repo();
    const executor = new FakeExecutor(() => ({}));
    const plan = buildRoutePlan({ task: "review the package", repo: path }, 0);
    const result = await executeRoute({ plan, provider: "auto", shadow: true, maxAttempts: 3, executors: { codex: executor } });
    expect(result.planned.model).toBe("gpt-5.6-luna");
    expect(executor.requests[0]?.model).toBe("gpt-5.6-sol");
    expect(result.shadow).toBe(true);
  });

  test("verification failure escalates and resumes with evidence", async () => {
    const path = repo();
    const executor = new FakeExecutor((request) => {
      if (request.attempt === 2) writeFileSync(join(path, "verified"), "yes");
      return {};
    });
    const plan = buildRoutePlan({ task: "add the report filter", repo: path }, 0);
    const result = await executeRoute({ plan, provider: "codex", shadow: false, maxAttempts: 2, verify: ["test -f verified"], executors: { codex: executor } });
    expect(result.status).toBe("succeeded");
    expect(result.attempts[0]?.verification[0]).toMatchObject({ ok: false, exitCode: 1 });
    expect(executor.requests[1]?.priorFailure).toBeDefined();
  });

  test("keeps mutation on Codex even when DeepSeek is preferred", async () => {
    const path = repo();
    const codex = new FakeExecutor(() => ({}));
    const deepseek = new FakeExecutor(() => ({ provider: "deepseek" }));
    const plan = buildRoutePlan({ task: "add the report filter", repo: path }, 0);
    const result = await executeRoute({ plan, provider: "deepseek", shadow: false, maxAttempts: 2, executors: { codex, deepseek } });
    expect(result.status).toBe("succeeded");
    expect(codex.requests).toHaveLength(1);
    expect(deepseek.requests).toHaveLength(0);
  });
});

describe("DeepSeek read-only adapter", () => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const oldUrl = process.env.DEEPSEEK_BASE_URL;
  afterEach(() => {
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldUrl;
  });

  test("replays reasoning_content across tool turns", async () => {
    const path = repo();
    writeFileSync(join(path, "README.md"), "routing evidence");
    let calls = 0;
    let replayed = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        calls++;
        const body = await request.json() as any;
        if (calls === 1) return Response.json({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "need file", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] } }] });
        replayed = body.messages.some((message: any) => message.reasoning_content === "need file") && body.messages.some((message: any) => message.role === "tool" && message.content === "routing evidence");
        return Response.json({ choices: [{ message: { role: "assistant", content: "found it", reasoning_content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      },
    });
    process.env.DEEPSEEK_API_KEY = "test-only";
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const result = await new DeepSeekExecutor().execute({ task: "inspect README", repo: path, files: ["README.md"], model: "gpt-5.6-luna", effort: "low", readOnly: true, attempt: 1 });
      expect(result).toMatchObject({ ok: true, provider: "deepseek", model: "deepseek-v4-flash", output: "found it" });
      expect(replayed).toBe(true);
    } finally { server.stop(true); }
  });

  test("never uses DeepSeek for mutations", async () => {
    process.env.DEEPSEEK_API_KEY = "test-only";
    const result = await new DeepSeekExecutor().execute({ task: "edit README", repo: repo(), files: [], model: "gpt-5.6-luna", effort: "low", readOnly: false, attempt: 1 });
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
  });
});

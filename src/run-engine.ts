import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexExecutor, DeepSeekExecutor, type ExecutionProvider, type ModelExecutor } from "./model-executors";
import { RoutingStore, type AttemptRecord } from "./routing-db";
import type { RoutePlan, RoutingEffort, RoutingModel } from "./routing";

export interface RunOptions {
  plan: RoutePlan;
  provider: "auto" | ExecutionProvider;
  shadow: boolean;
  maxAttempts: number;
  verify?: string[];
  database?: string;
  executors?: Partial<Record<ExecutionProvider, ModelExecutor>>;
}

export interface RunSummary {
  taskId: string;
  planned: { model: RoutingModel; effort: RoutingEffort };
  shadow: boolean;
  status: "succeeded" | "failed";
  attempts: AttemptRecord[];
  output: string;
  error?: string;
  database?: string;
  estimatedCost: number;
}

function inferredVerification(plan: RoutePlan): string[] {
  if (plan.contract.kind === "read-only") return [];
  const packagePath = join(plan.repo, "package.json");
  if (!existsSync(packagePath)) return [];
  try {
    const scripts = (JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const runner = existsSync(join(plan.repo, "bun.lock")) || existsSync(join(plan.repo, "bun.lockb")) ? "bun run" : "npm run";
    return ["lint", "typecheck", "test", "build"].filter((name) => scripts[name]).map((name) => `${runner} ${name}`);
  } catch { return []; }
}

async function verify(repo: string, commands: string[]): Promise<AttemptRecord["verification"]> {
  const results: AttemptRecord["verification"] = [];
  for (const command of commands) {
    const started = Date.now();
    const child = Bun.spawn(["zsh", "-lc", command], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `${stdout}${stderr}`.trim().slice(-20_000);
    results.push({ command, ok: exitCode === 0, exitCode, output: output || `completed in ${Date.now() - started}ms` });
    if (exitCode !== 0) break;
  }
  return results;
}

function codexTiers(model: RoutingModel, effort: RoutingEffort): Array<{ provider: ExecutionProvider; model: RoutingModel; effort: RoutingEffort }> {
  if (model === "gpt-5.6-luna") return [
    { provider: "codex", model, effort },
    { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
    { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  ];
  if (model === "gpt-5.6-terra") return [
    { provider: "codex", model, effort },
    { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  ];
  return [{ provider: "codex", model, effort }];
}

export async function executeRoute(options: RunOptions): Promise<RunSummary> {
  const { plan } = options;
  const commands = options.verify ?? inferredVerification(plan);
  const codex = codexTiers(plan.decision.model, plan.decision.effort);
  let tiers = options.shadow
    ? [{ provider: "codex" as const, model: "gpt-5.6-sol" as const, effort: "high" as const }]
    : options.provider === "deepseek" && plan.contract.kind === "read-only"
      ? [{ provider: "deepseek" as const, model: plan.decision.model, effort: plan.decision.effort }, ...codex.filter((tier) => tier.model !== "gpt-5.6-luna")]
      : codex;
  if (options.provider === "codex") tiers = codex;
  tiers = tiers.slice(0, options.maxAttempts);
  const executors: Record<ExecutionProvider, ModelExecutor> = {
    codex: options.executors?.codex ?? new CodexExecutor(),
    deepseek: options.executors?.deepseek ?? new DeepSeekExecutor(),
  };
  const store = options.database ? new RoutingStore(options.database) : undefined;
  const runId = store?.start(plan, options.shadow);
  const attempts: AttemptRecord[] = [];
  let priorFailure: string | undefined;
  let finalOutput = "";
  try {
    for (const [index, tier] of tiers.entries()) {
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      const result = await executors[tier.provider].execute({
        task: plan.task, repo: plan.repo, files: plan.contract.scopedFiles, model: tier.model,
        effort: tier.effort, readOnly: plan.contract.kind === "read-only", attempt: index + 1, priorFailure,
      });
      const verification = result.ok ? await verify(plan.repo, commands) : [];
      const passed = result.ok && verification.every((item) => item.ok);
      finalOutput = result.output;
      const record: AttemptRecord = { attempt: index + 1, model: result.model, effort: tier.effort, startedAt, durationMs: Date.now() - started, result: { ...result, ok: passed }, verification };
      attempts.push(record);
      if (runId) store?.attempt(runId, record);
      if (passed) {
        store?.finish(runId!, "succeeded", attempts, finalOutput);
        return { taskId: plan.taskId, planned: plan.decision, shadow: options.shadow, status: "succeeded", attempts, output: finalOutput, database: options.database, estimatedCost: attempts.reduce((sum, item) => sum + (item.result.estimatedCost ?? 0), 0) };
      }
      priorFailure = result.error || verification.find((item) => !item.ok)?.output || "objective verification failed";
    }
    const error = priorFailure || "no execution tier was available";
    store?.finish(runId!, "failed", attempts, finalOutput, error);
    return { taskId: plan.taskId, planned: plan.decision, shadow: options.shadow, status: "failed", attempts, output: finalOutput, error, database: options.database, estimatedCost: attempts.reduce((sum, item) => sum + (item.result.estimatedCost ?? 0), 0) };
  } finally { store?.close(); }
}

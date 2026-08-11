import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const ROUTING_POLICY_VERSION = "2026-08-11.v1";

export type RoutingRisk = "auto" | "low" | "medium" | "high";
export type EffectiveRisk = Exclude<RoutingRisk, "auto">;
export type TaskKind = "read-only" | "mechanical" | "implementation" | "broad";
export type RoutingModel = "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol";
export type RoutingEffort = "low" | "medium" | "high" | "xhigh";

export interface RouteInput {
  task: string;
  repo?: string;
  files?: string[];
  risk?: RoutingRisk;
}

export interface RoutePhase {
  id: "scout" | "work" | "verify";
  model: RoutingModel;
  effort: RoutingEffort;
  readOnly: boolean;
  purpose: string;
}

export interface RoutePlan {
  schemaVersion: 1;
  policyVersion: string;
  taskId: string;
  generatedAt: string;
  dryRun: true;
  task: string;
  repo: string;
  contract: {
    kind: TaskKind;
    risk: EffectiveRisk;
    uncertainty: "low" | "medium" | "high";
    scopedFiles: string[];
  };
  evidence: {
    gitRepository: boolean;
    dirtyWorktree: boolean | null;
    manifests: string[];
    workspace: boolean;
    riskSignals: string[];
  };
  decision: {
    model: RoutingModel;
    effort: RoutingEffort;
    reasonCodes: string[];
    candidates: Array<{ model: RoutingModel; selected: boolean; reason: string }>;
  };
  phases: RoutePhase[];
  escalationTriggers: string[];
}

const MANIFESTS = [
  "package.json", "bun.lock", "bun.lockb", "pnpm-workspace.yaml", "turbo.json", "nx.json",
  "pyproject.toml", "uv.lock", "Cargo.toml", "go.mod", "Package.swift", "Gemfile",
  "composer.json", "wrangler.toml", "wrangler.jsonc",
];
const WORKSPACE_MANIFESTS = new Set(["pnpm-workspace.yaml", "turbo.json", "nx.json"]);
const FILE_RISK_RULES: Array<[RegExp, string]> = [
  [/(^|\/)(migrations?|schema)(\/|\.|$)/i, "database_migration"],
  [/(^|\/)(auth|authentication|authorization|security)(\/|\.|$)/i, "security_boundary"],
  [/(^|\/)(payments?|billing)(\/|\.|$)/i, "financial_boundary"],
  [/(^|\/)(secrets?|credentials?)(\/|\.|$)/i, "secret_handling"],
  [/(^|\/)(production|deploy|infrastructure|terraform)(\/|\.|$)/i, "production_infrastructure"],
];
const TASK_RISK_RULES: Array<[RegExp, string]> = [
  [/\b(auth|authentication|authorization|security|vulnerability|exploit)\b/i, "security_boundary"],
  [/\b(payment|billing|invoice|financial)\b/i, "financial_boundary"],
  [/\b(database migration|schema migration|drop table|data loss)\b/i, "database_migration"],
  [/\b(production|incident|outage|deploy|release|rollback)\b/i, "production_change"],
  [/\b(secret|credential|api key|private key)\b/i, "secret_handling"],
  [/\b(delete|destroy|purge|wipe)\b/i, "destructive_change"],
];
const READ_ONLY = /\b(analy[sz]e|audit|explain|extract|find|inspect|investigate|list|locate|report|review|search|summari[sz]e)\b/i;
const MUTATING = /\b(add|build|change|create|delete|edit|fix|implement|migrate|remove|rename|replace|ship|update|write)\b/i;
const MECHANICAL = /\b(format|lint|rename|typo|copy change|update docs?|documentation|bump version|generated file)\b/i;
const BROAD = /\b(architecture|across (?:the )?(?:codebase|repo|services)|cross-service|large refactor|monorepo|redesign|rewrite|system-wide)\b/i;

function gitState(repo: string): { gitRepository: boolean; dirtyWorktree: boolean | null } {
  const check = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  if (check.exitCode !== 0) return { gitRepository: false, dirtyWorktree: null };
  const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
  return {
    gitRepository: true,
    dirtyWorktree: status.exitCode === 0 ? new TextDecoder().decode(status.stdout).trim().length > 0 : null,
  };
}

function scopedFiles(repo: string, files: string[]): string[] {
  return [...new Set(files.map((file) => {
    const absolute = resolve(repo, file);
    const local = relative(repo, absolute);
    if (!local || local === ".") throw new Error(`--file must identify a file inside the repository: ${file}`);
    if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`--file escapes the repository: ${file}`);
    }
    return local;
  }))].sort();
}

export function buildRoutePlan(input: RouteInput, now = Date.now()): RoutePlan {
  const task = input.task.trim();
  if (!task) throw new Error("task cannot be empty");
  const repo = resolve(input.repo ?? process.cwd());
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`repository directory not found: ${repo}`);

  const files = scopedFiles(repo, input.files ?? []);
  const entries = new Set(readdirSync(repo));
  const manifests = MANIFESTS.filter((name) => entries.has(name));
  const workspace = manifests.some((name) => WORKSPACE_MANIFESTS.has(name))
    || [...entries].some((name) => name.endsWith(".xcworkspace"));
  const git = gitState(repo);
  const riskSignals = new Set<string>();
  for (const file of files) for (const [pattern, code] of FILE_RISK_RULES) if (pattern.test(file)) riskSignals.add(code);
  for (const [pattern, code] of TASK_RISK_RULES) if (pattern.test(task)) riskSignals.add(code);

  const requestedRisk = input.risk ?? "auto";
  const hardRisk = riskSignals.size > 0;
  let kind: TaskKind = "implementation";
  if (BROAD.test(task) || (workspace && files.length === 0)) kind = "broad";
  else if (READ_ONLY.test(task) && !MUTATING.test(task)) kind = "read-only";
  else if (MECHANICAL.test(task)) kind = "mechanical";

  const risk: EffectiveRisk = hardRisk || requestedRisk === "high"
    ? "high"
    : requestedRisk === "low" || requestedRisk === "medium"
      ? requestedRisk
      : kind === "read-only" || kind === "mechanical" ? "low" : "medium";
  const uncertainty = kind === "broad" || (workspace && files.length === 0)
    ? "high"
    : files.length > 0 || kind === "read-only" || kind === "mechanical" ? "low" : "medium";

  let model: RoutingModel = "gpt-5.6-terra";
  let effort: RoutingEffort = "medium";
  const reasonCodes: string[] = [];
  if (hardRisk) reasonCodes.push("hard_risk_gate");
  if (requestedRisk !== "auto") reasonCodes.push(`explicit_risk_${requestedRisk}`);
  if (files.length) reasonCodes.push("scoped_files");
  if (workspace && files.length === 0) reasonCodes.push("unscoped_workspace");

  if (risk === "high") {
    model = "gpt-5.6-sol";
    effort = "high";
    reasonCodes.push("high_risk_work");
  } else if (kind === "broad" || uncertainty === "high") {
    effort = "high";
    reasonCodes.push("broad_or_uncertain_scope");
  } else if (risk === "low" && kind === "read-only") {
    model = "gpt-5.6-luna";
    effort = "low";
    reasonCodes.push("bounded_read_only_work");
  } else if (risk === "low" && kind === "mechanical") {
    model = "gpt-5.6-luna";
    effort = "medium";
    reasonCodes.push("bounded_mechanical_work");
  } else {
    reasonCodes.push("default_production_work");
  }

  const verifyModel: RoutingModel = risk === "high" ? "gpt-5.6-sol" : "gpt-5.6-terra";
  const candidates: RoutePlan["decision"]["candidates"] = [
    { model: "gpt-5.6-luna", selected: model === "gpt-5.6-luna", reason: model === "gpt-5.6-luna" ? "bounded low-risk phase" : "insufficient scope or risk margin" },
    { model: "gpt-5.6-terra", selected: model === "gpt-5.6-terra", reason: model === "gpt-5.6-terra" ? "balanced default" : risk === "high" ? "blocked by hard risk gate" : "more capability than bounded phase needs" },
    { model: "gpt-5.6-sol", selected: model === "gpt-5.6-sol", reason: model === "gpt-5.6-sol" ? "hard risk gate" : "reserved for high-risk work or escalation" },
  ];
  const taskId = createHash("sha256").update(`${repo}\0${task}`).digest("hex").slice(0, 16);

  return {
    schemaVersion: 1,
    policyVersion: ROUTING_POLICY_VERSION,
    taskId,
    generatedAt: new Date(now).toISOString(),
    dryRun: true,
    task,
    repo,
    contract: { kind, risk, uncertainty, scopedFiles: files },
    evidence: { ...git, manifests, workspace, riskSignals: [...riskSignals].sort() },
    decision: { model, effort, reasonCodes, candidates },
    phases: [
      { id: "scout", model: "gpt-5.6-luna", effort: "low", readOnly: true, purpose: "Collect repository evidence and confirm scope" },
      { id: "work", model, effort, readOnly: kind === "read-only", purpose: "Complete the bounded task contract" },
      { id: "verify", model: verifyModel, effort: risk === "high" ? "high" : "medium", readOnly: true, purpose: "Check tests, build, diff, and required evidence" },
    ],
    escalationTriggers: [
      "deterministic verification fails twice",
      "scope expands beyond the task contract",
      "repository evidence contradicts the initial classification",
      "required tools or context are unavailable",
      "no measurable progress within the phase budget",
    ],
  };
}

export function renderRoutePlan(plan: RoutePlan): string {
  const files = plan.contract.scopedFiles.length ? plan.contract.scopedFiles.join(", ") : "none supplied";
  const signals = plan.evidence.riskSignals.length ? plan.evidence.riskSignals.join(", ") : "none";
  const phases = plan.phases.map((phase, index) =>
    `  ${index + 1}. ${phase.id.padEnd(6)} ${phase.model} · ${phase.effort} · ${phase.purpose}`,
  );
  return [
    "SpendWatch route plan (dry run)",
    `task: ${plan.task}`,
    `repo: ${plan.repo}`,
    `contract: ${plan.contract.kind} · ${plan.contract.risk} risk · ${plan.contract.uncertainty} uncertainty`,
    `scoped files: ${files}`,
    `risk signals: ${signals}`,
    `decision: ${plan.decision.model} · ${plan.decision.effort}`,
    `why: ${plan.decision.reasonCodes.join(", ")}`,
    "phases:",
    ...phases,
    "escalate when:",
    ...plan.escalationTriggers.map((trigger) => `  - ${trigger}`),
    "No model calls made.",
    "",
  ].join("\n");
}

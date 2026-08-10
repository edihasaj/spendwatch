import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AccountProvider = "codex" | "claude" | "copilot";

export interface AccountAddOptions {
  provider: AccountProvider;
  name?: string;
  deviceAuth?: boolean;
  apiKeyEnv?: string;
  home?: string;
}

export interface AccountLoginPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  profileHome?: string;
  inputEnv?: string;
}

export function normalizeProfileName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error("account name must be 1-32 lowercase letters, numbers, or hyphens");
  }
  return name;
}

function validateEnvName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error("--api-key-env must be an environment variable name such as OPENAI_API_KEY");
  }
  return value;
}

export function buildAccountLoginPlan(options: AccountAddOptions): AccountLoginPlan {
  const baseHome = options.home ?? homedir();
  if (options.provider === "copilot") {
    if (options.name || options.deviceAuth || options.apiKeyEnv) {
      throw new Error("Copilot accounts are managed by GitHub CLI; use: spendwatch account add copilot");
    }
    return { command: "gh", args: ["auth", "login", "--hostname", "github.com", "--web"], env: {} };
  }

  if (!options.name) throw new Error(`--name is required for ${options.provider}`);
  const name = normalizeProfileName(options.name);
  if (options.provider === "codex") {
    if (options.deviceAuth && options.apiKeyEnv) {
      throw new Error("choose either ChatGPT device OAuth or an API key, not both");
    }
    const profileHome = join(baseHome, `.codex-${name}`);
    const inputEnv = options.apiKeyEnv ? validateEnvName(options.apiKeyEnv) : undefined;
    return {
      command: "codex",
      args: ["login", ...(options.deviceAuth ? ["--device-auth"] : inputEnv ? ["--with-api-key"] : [])],
      env: { CODEX_HOME: profileHome },
      profileHome,
      inputEnv,
    };
  }

  if (options.deviceAuth || options.apiKeyEnv) {
    throw new Error("Claude account setup uses the official browser OAuth flow");
  }
  const profileHome = join(baseHome, `.claude-${name}`);
  return {
    command: "claude",
    args: ["auth", "login"],
    env: { CLAUDE_CONFIG_DIR: profileHome },
    profileHome,
  };
}

function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function readCodexAccountEmail(profileHome: string): string | undefined {
  const authPath = join(profileHome, "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    return codexAccountEmail(JSON.parse(readFileSync(authPath, "utf8")));
  } catch {}
  return undefined;
}

export function codexAccountEmail(auth: unknown): string | undefined {
  const value = auth as { tokens?: { id_token?: unknown; access_token?: unknown } } | undefined;
  for (const token of [value?.tokens?.id_token, value?.tokens?.access_token]) {
    const email = jwtClaims(token)?.email;
    if (typeof email === "string" && email.includes("@")) return email;
  }
  return undefined;
}

function run(command: string, args: string[], env: Record<string, string>, input?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} was interrupted by ${signal}`));
      else resolve(code ?? 1);
    });
    if (input !== undefined) child.stdin?.end(input.endsWith("\n") ? input : `${input}\n`);
  });
}

export async function addAccount(options: AccountAddOptions): Promise<string> {
  const plan = buildAccountLoginPlan(options);
  if (plan.profileHome) mkdirSync(plan.profileHome, { recursive: true, mode: 0o700 });

  let input: string | undefined;
  if (plan.inputEnv) {
    input = process.env[plan.inputEnv];
    if (!input) throw new Error(`${plan.inputEnv} is empty; export the key first`);
  }

  const code = await run(plan.command, plan.args, plan.env, input);
  if (code !== 0) {
    const retained = plan.profileHome ? ` Profile retained at ${plan.profileHome}; nothing was deleted.` : "";
    throw new Error(`${plan.command} login exited with status ${code}.${retained}`);
  }

  if (options.provider === "codex" && plan.profileHome) {
    const email = readCodexAccountEmail(plan.profileHome);
    return `Codex account connected${email ? `: ${email}` : ""}\nProfile: ${plan.profileHome}\nSpendwatch will discover it automatically.`;
  }
  if (options.provider === "claude") {
    return `Claude account connected\nProfile: ${plan.profileHome}\nThe local collector will include it on its next refresh.`;
  }
  return "Copilot account connected through GitHub CLI. The local collector will include it on its next refresh.";
}

import { describe, expect, test } from "bun:test";
import { buildAccountLoginPlan, codexAccountEmail, normalizeProfileName } from "../src/accounts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("account login", () => {
  test("builds isolated Codex browser OAuth by default", () => {
    const plan = buildAccountLoginPlan({ provider: "codex", name: "Work", home: "/Users/test" });
    expect(plan.command).toBe("codex");
    expect(plan.args).toEqual(["login"]);
    expect(plan.env.CODEX_HOME).toBe("/Users/test/.codex-work");
    expect(plan.inputEnv).toBeUndefined();
  });

  test("supports device OAuth and API keys without putting secrets in argv", () => {
    const device = buildAccountLoginPlan({ provider: "codex", name: "headless", deviceAuth: true, home: "/tmp" });
    expect(device.args).toEqual(["login", "--device-auth"]);
    const key = buildAccountLoginPlan({ provider: "codex", name: "api", apiKeyEnv: "OPENAI_API_KEY", home: "/tmp" });
    expect(key.args).toEqual(["login", "--with-api-key"]);
    expect(key.inputEnv).toBe("OPENAI_API_KEY");
    expect(key.args.join(" ")).not.toContain("sk-");
  });

  test("uses official Claude and GitHub OAuth flows", () => {
    const claude = buildAccountLoginPlan({ provider: "claude", name: "personal", home: "/Users/test" });
    expect(claude.args).toEqual(["auth", "login"]);
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe("/Users/test/.claude-personal");
    const copilot = buildAccountLoginPlan({ provider: "copilot" });
    expect(copilot.args).toEqual(["auth", "login", "--hostname", "github.com", "--web"]);
  });

  test("rejects paths, flags, and ambiguous auth methods as account names", () => {
    expect(() => normalizeProfileName("../work")).toThrow();
    expect(() => normalizeProfileName("work account")).toThrow();
    expect(() => buildAccountLoginPlan({ provider: "codex", name: "work", deviceAuth: true, apiKeyEnv: "OPENAI_API_KEY" })).toThrow();
  });

  test("reads identity from isolated Codex auth data", () => {
    const auth = { tokens: { id_token: jwt({ email: "work@example.com" }) } };
    expect(codexAccountEmail(auth)).toBe("work@example.com");
  });
});

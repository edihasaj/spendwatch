import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCapacitySnapshot } from "../src/capacity-db";
import { tempDir } from "./tmp";

const ROOT = join(import.meta.dir, "..");

function runLimits(args: string[]): string {
  const result = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), "limits", ...args], {
    cwd: ROOT,
    env: { ...process.env },
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

test("limits keeps session-equivalent history forecasts for JSON only", () => {
  const dir = tempDir("spendwatch-cli-limits-forecast-");
  const database = join(dir, "capacity.db");
  const input = join(dir, "limits.json");
  const html = join(dir, "capacity.html");
  const weeklyReset = "2026-10-25T00:00:00Z";
  const account = (sampledAt: string, weeklyUsed: number) => ({
    provider: "codex" as const,
    email: "work@example.com",
    plan: "Pro",
    devices: ["studio"],
    updatedAt: sampledAt,
    session: {
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: new Date(Date.parse(sampledAt) + 5 * 60 * 60_000).toISOString(),
    },
    weekly: { usedPercent: weeklyUsed, windowMinutes: 10_080, resetsAt: weeklyReset },
  });

  for (let index = 0; index < 4; index++) {
    const sampledAt = new Date(Date.parse("2026-10-18T00:00:00Z") + index * 5 * 60 * 60_000).toISOString();
    writeCapacitySnapshot(database, [account(sampledAt, index * 10)], { collectedAt: Date.parse(sampledAt) });
  }

  const current = account("2026-10-18T14:59:00Z", 40);
  writeFileSync(input, JSON.stringify([{
    provider: current.provider,
    account: current.email,
    usage: {
      accountEmail: current.email,
      loginMethod: "pro",
      primary: current.session,
      secondary: current.weekly,
      updatedAt: current.updatedAt,
    },
  }]));

  const output = runLimits(["--input", input, "--sqlite", database, "--json"]);
  const json = output.split("\n\x1b")[0]!;
  const [result] = JSON.parse(json) as Array<{ sessionEquivalent?: { sampleCount: number; estimatedQuotasLeft: number } }>;
  expect(result?.sessionEquivalent).toMatchObject({ sampleCount: 3, estimatedQuotasLeft: 6 });

  const text = runLimits(["--input", input, "--sqlite", database, "--html", html]);
  expect(text).toContain("Codex · work@example.com");
  expect(readFileSync(html, "utf8")).not.toContain("session quotas left");
});

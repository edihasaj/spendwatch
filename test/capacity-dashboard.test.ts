import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapacityDashboard } from "../src/capacity-dashboard";
import { tempDir } from "./tmp";

const account = {
  provider: "codex",
  account: "work@example.com",
  usage: {
    accountEmail: "work@example.com",
    loginMethod: "pro",
    updatedAt: "2026-10-19T10:00:00Z",
    primary: { usedPercent: 20, windowMinutes: 300, resetsAt: "2026-10-19T15:00:00Z" },
  },
};

function dashboardInput(records: unknown[]) {
  const path = join(tempDir("spendwatch-dashboard-"), "capacity.json");
  writeFileSync(path, JSON.stringify([account, ...records]));
  return loadCapacityDashboard([path]);
}

describe("capacity dashboard", () => {
  test("retains authentication for a current source-health device", () => {
    const dashboard = dashboardInput([
      { kind: "source-health", device: "Studio", status: "live", checkedAt: "2026-10-19T10:00:00Z" },
      { kind: "authentication-required", provider: "codex", device: "studio", profile: "work" },
    ]);

    expect(dashboard.authentication).toEqual([
      { provider: "codex", device: "studio", profile: "work" },
    ]);
  });

  test("hides authentication retained only by a historical device after source-health is present", () => {
    const dashboard = dashboardInput([
      { kind: "source-health", device: "studio", status: "live", checkedAt: "2026-10-19T10:00:00Z" },
      { kind: "authentication-required", provider: "codex", device: "studio", profile: "work" },
      { kind: "authentication-required", provider: "copilot", device: "autoreview-prod", profile: "default" },
    ]);

    expect(dashboard.authentication).toEqual([
      { provider: "codex", device: "studio", profile: "work" },
    ]);
  });

  test("retains standalone authentication when source-health was not collected", () => {
    const dashboard = dashboardInput([
      { kind: "authentication-required", provider: "copilot", device: "autoreview-prod", profile: "default" },
    ]);

    expect(dashboard.authentication).toEqual([
      { provider: "copilot", device: "autoreview-prod", profile: "default" },
    ]);
  });

  test("retains authentication when every source-health record is malformed", () => {
    const dashboard = dashboardInput([
      { kind: "source-health", device: "studio", status: "unknown", checkedAt: "not-a-time" },
      { kind: "authentication-required", provider: "copilot", device: "autoreview-prod", profile: "default" },
    ]);

    expect(dashboard.sources).toEqual([]);
    expect(dashboard.authentication).toEqual([
      { provider: "copilot", device: "autoreview-prod", profile: "default" },
    ]);
  });
});

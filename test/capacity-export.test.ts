import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportCapacityHistory } from "../src/capacity-export";
import { tempDir } from "./tmp";

const at = "2026-10-19T12:00:00.000Z";

function quotaLine(sampledAt = at): string {
  return JSON.stringify({
    timestamp: sampledAt,
    payload: {
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 42, window_minutes: 300, resets_at: 1_792_408_000 },
      },
    },
  }) + "\n";
}

async function exported(roots: Array<{ path: string; account?: string }>) {
  const output: string[] = [];
  const stats = await exportCapacityHistory("test-device", { roots, write: (text) => output.push(text) });
  const records = output.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { stats, records };
}

describe("Codex quota history export", () => {
  test("never backfills a default profile's historical quota with the current login", async () => {
    const home = tempDir("spendwatch-capacity-export-");
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "header.eyJlbWFpbCI6IndvcmtAZXhhbXBsZS5jb20ifQ.signature" } }));
    writeFileSync(join(sessions, "rollout.jsonl"), quotaLine());

    const first = await exported([{ path: sessions }]);
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "header.eyJlbWFpbCI6InBlcnNvbmFsQGV4YW1wbGUuY29tIn0.signature" } }));
    const afterLoginChange = await exported([{ path: sessions }]);

    expect(first.records).toMatchObject([{ account: "Unknown Codex account", sampledAt: at }]);
    expect(afterLoginChange.records).toMatchObject([{ account: "Unknown Codex account", sampledAt: at }]);
  });

  test("scans an archive reached through a live and archived root once", async () => {
    const home = tempDir("spendwatch-capacity-export-");
    const sessions = join(home, ".codex", "sessions");
    const archive = join(home, ".codex", "archived_sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "rollout.jsonl"), quotaLine());

    const result = await exported([{ path: sessions }, { path: archive }]);
    expect(result.stats.records).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ account: "Unknown Codex account", sampledAt: at });
  });

  test("deduplicates a symlinked archive root by its canonical path", async () => {
    const home = tempDir("spendwatch-capacity-export-");
    const sessions = join(home, ".codex", "sessions");
    const archive = join(home, ".codex", "archived_sessions");
    const copiedArchive = join(home, ".codex-copy", "archived_sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(archive, { recursive: true });
    mkdirSync(join(home, ".codex-copy"), { recursive: true });
    symlinkSync(archive, copiedArchive);
    writeFileSync(join(archive, "rollout.jsonl"), quotaLine());

    const result = await exported([{ path: sessions }, { path: copiedArchive }]);
    expect(result.stats.records).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  test("keeps a named profile as an explicit unverified label", async () => {
    const home = tempDir("spendwatch-capacity-export-");
    const sessions = join(home, ".codex-primary", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout.jsonl"), quotaLine());

    const result = await exported([{ path: sessions }]);
    expect(result.records).toMatchObject([{ account: "Codex profile: primary (unverified)" }]);
  });
});

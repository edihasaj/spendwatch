import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultCodexRoots } from "./sources";

interface ExportWindow {
  kind: "session" | "weekly";
  usedPercent: number;
  resetsAt?: string;
  windowMinutes: number;
}

interface ExportRecord {
  provider: "codex";
  account: string;
  device: string;
  source: string;
  sampledAt: string;
  plan: string;
  windows: ExportWindow[];
}

interface SessionEvent {
  sampledAt: string;
  plan: string;
  windows: ExportWindow[];
}

function safeJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function accountEmailFromAuth(sessionsPath: string): string | undefined {
  try {
    const auth = safeJson(join(dirname(sessionsPath), "auth.json"));
    const token = auth?.tokens?.id_token;
    if (typeof token !== "string") return undefined;
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof decoded.email === "string" ? decoded.email : undefined;
  } catch {
    return undefined;
  }
}

function isoFromEpoch(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function eventWindows(rateLimits: any): ExportWindow[] {
  const values = [rateLimits?.primary, rateLimits?.secondary, rateLimits?.tertiary];
  const windows: ExportWindow[] = [];
  for (const value of values) {
    const usedPercent = Number(value?.used_percent);
    const windowMinutes = Number(value?.window_minutes);
    if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) continue;
    windows.push({
      kind: windowMinutes >= 7 * 24 * 60 ? "weekly" : "session",
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt: isoFromEpoch(value?.resets_at),
      windowMinutes,
    });
  }
  return windows;
}

function ripgrepBinary(): string | undefined {
  return ["/opt/homebrew/bin/rg", "/usr/local/bin/rg"].find(existsSync);
}

async function sessionEvents(path: string): Promise<SessionEvent[]> {
  const rg = ripgrepBinary();
  if (!rg || !existsSync(path)) return [];
  const process = Bun.spawn([
    rg,
    "--no-heading",
    "--no-filename",
    "--fixed-strings",
    "--glob",
    "*.jsonl",
    '"rate_limits"',
    path,
  ], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(process.stdout).text();
  await process.exited;
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const sampledAt = parsed?.timestamp;
      const rateLimits = parsed?.payload?.rate_limits;
      if (typeof sampledAt !== "string" || !rateLimits || rateLimits.limit_id !== "codex") continue;
      const windows = eventWindows(rateLimits);
      if (!Number.isFinite(Date.parse(sampledAt)) || !windows.length) continue;
      events.push({
        sampledAt,
        plan: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : "unknown",
        windows,
      });
    } catch {}
  }
  return events;
}

function writeRecords(records: ExportRecord[]): void {
  const chunkSize = 2000;
  for (let index = 0; index < records.length; index += chunkSize) {
    const text = records.slice(index, index + chunkSize).map((record) => JSON.stringify(record)).join("\n") + "\n";
    process.stdout.write(text);
  }
}

export async function exportCapacityHistory(device: string): Promise<{ records: number; firstAt?: string; lastAt?: string }> {
  const records: ExportRecord[] = [];

  for (const root of defaultCodexRoots()) {
    const account = accountEmailFromAuth(root.path) ?? basename(dirname(root.path));
    const eventPaths = [root.path, join(dirname(root.path), "archived_sessions")];
    const events = (await Promise.all(eventPaths.map(sessionEvents))).flat();
    for (const event of events) {
      records.push({
        provider: "codex",
        account,
        device,
        source: "codex-session-log",
        sampledAt: event.sampledAt,
        plan: event.plan,
        windows: event.windows,
      });
    }
  }

  records.sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  writeRecords(records);
  return {
    records: records.length,
    firstAt: records[0]?.sampledAt,
    lastAt: records.at(-1)?.sampledAt,
  };
}

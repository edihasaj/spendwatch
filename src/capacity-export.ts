import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultCodexRoots } from "./sources";

const UNKNOWN_CODEX_ACCOUNT = "Unknown Codex account";

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

export interface CapacityExportRoot {
  path: string;
  /** Explicit operator configuration, never inferred from the current auth file. */
  account?: string;
}

export interface CapacityExportOptions {
  roots?: CapacityExportRoot[];
  write?: (text: string) => void;
}

function accountForRoot(root: CapacityExportRoot): string {
  if (root.account?.trim()) return root.account;
  const home = basename(dirname(root.path));
  if (home === ".codex") return UNKNOWN_CODEX_ACCOUNT;
  if (home.startsWith(".codex-")) return `Codex profile: ${home.slice(".codex-".length)} (unverified)`;
  return UNKNOWN_CODEX_ACCOUNT;
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

function writeRecords(records: ExportRecord[], write: (text: string) => void): void {
  const chunkSize = 2000;
  for (let index = 0; index < records.length; index += chunkSize) {
    const text = records.slice(index, index + chunkSize).map((record) => JSON.stringify(record)).join("\n") + "\n";
    write(text);
  }
}

export async function exportCapacityHistory(device: string, options: CapacityExportOptions = {}): Promise<{ records: number; firstAt?: string; lastAt?: string }> {
  const records: ExportRecord[] = [];
  const eventPaths = new Set<string>();
  const roots = options.roots ?? defaultCodexRoots();

  for (const root of roots) {
    const account = accountForRoot(root);
    // `defaultCodexRoots` already includes archived-only homes. Add a sibling
    // archive for live roots, but scan each physical path exactly once.
    for (const path of [root.path, join(dirname(root.path), "archived_sessions")]) {
      if (!existsSync(path)) continue;
      let canonical: string;
      try {
        canonical = realpathSync(path);
      } catch {
        continue;
      }
      if (eventPaths.has(canonical)) continue;
      eventPaths.add(canonical);
      for (const event of await sessionEvents(path)) {
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
  }

  records.sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  writeRecords(records, options.write ?? ((text) => process.stdout.write(text)));
  return {
    records: records.length,
    firstAt: records[0]?.sampledAt,
    lastAt: records.at(-1)?.sampledAt,
  };
}

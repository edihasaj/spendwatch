// Reads AutoReview's job ledger: a JSONL file with one `agent-usage.v1` record per line, the Cloudflare job's own
// account of the tokens it used. Nothing but the usage figures, the attempt, its time and its repository is read.
import { existsSync, readFileSync } from "node:fs";
import { asUsageRecord, entryAccount, inProject, projectName, usageEvents, type AgentUsageRecord } from "./agent-usage";
import type { SourceFile } from "./sources";

/** The ledger's records by attempt: a record repeating an attempt's id replaces the one before it (the totals so far). */
function records(path: string): AgentUsageRecord[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const byAttempt = new Map<string, AgentUsageRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: AgentUsageRecord | undefined;
    try { record = asUsageRecord(JSON.parse(line)); } catch {}
    if (!record || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) continue;
    // Deleted first so a replaced attempt keeps the position of its latest line.
    byAttempt.delete(record.attempt_id);
    byAttempt.set(record.attempt_id, record);
  }
  return [...byAttempt.values()];
}

export function collectAutoreview(path: string, sinceMs: number, account?: string, filter?: string): SourceFile[] {
  if (!existsSync(path)) return [];
  try {
    const files: SourceFile[] = [];
    for (const record of records(path)) {
      const ts = Date.parse(record.updated_at as string);
      if (ts < sinceMs) continue;
      const project = projectName(record.project);
      if (!inProject(project, filter)) continue;
      for (const found of usageEvents(record, { ts, project })) {
        files.push({
          path, key: `autoreview:${record.attempt_id}:${found.id}`, project, source: "autoreview",
          account: entryAccount(found.entry, account), parse: () => [], ctx: null,
          // The file is read whole on every discovery and its events replace the last poll's; the version lets an
          // unchanged record fold nothing again.
          events: () => found.events,
          version: () => `${Bun.hash(JSON.stringify(record.entries[found.index]) + String(record.updated_at))}`,
        });
      }
    }
    return files;
  } catch { return []; }
}

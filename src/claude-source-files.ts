// Claude Code stores legacy transcripts at project level and current child
// agents at project/<session>/subagents/*.jsonl. Keep the search deliberately
// narrow so unrelated project files never become transcript sources.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourceFile } from "./sources";
import { claudeFile } from "./gateway-sources";
import type { GatewayLedger } from "./gateway";
import { humanProject } from "./projects";

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function freshEnough(path: string, sinceMs: number, restricted: boolean): boolean {
  try {
    const stat = restricted ? lstatSync(path) : statSync(path);
    return stat.isFile() && (!restricted || !stat.isSymbolicLink()) && stat.mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function directory(path: string, restricted: boolean): boolean {
  try {
    const stat = restricted ? lstatSync(path) : statSync(path);
    return stat.isDirectory() && (!restricted || !stat.isSymbolicLink());
  } catch {
    return false;
  }
}

export function collectClaudeSourceFiles(
  projectsDir: string,
  account: string,
  sinceMs: number,
  project?: string,
  gateway?: GatewayLedger,
  aliases?: ReadonlyMap<string, string>,
  restricted = false,
): SourceFile[] {
  if (!existsSync(projectsDir) || !directory(projectsDir, restricted)) return [];
  const files: SourceFile[] = [];
  for (const projectEntry of safeReaddir(projectsDir)) {
    const projectName = humanProject(projectEntry);
    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) continue;
    const projectDir = join(projectsDir, projectEntry);
    if (!directory(projectDir, restricted)) continue;
    const add = (path: string, key: string) => {
      if (!freshEnough(path, sinceMs, restricted)) return;
      const file = claudeFile(path, projectName, account, gateway, aliases);
      file.key = key;
      files.push(file);
    };
    for (const entry of safeReaddir(projectDir)) {
      const path = join(projectDir, entry);
      if (entry.endsWith(".jsonl")) {
        add(path, `claude:session:${basename(path)}`); // legacy project-level session
        continue;
      }
      if (!directory(path, restricted)) continue;
      const subagents = join(path, "subagents");
      if (!directory(subagents, restricted)) continue;
      for (const child of safeReaddir(subagents)) {
        // Child IDs are scoped to a parent session. Profile copies retain both
        // suffixes, while same-named children in separate sessions stay apart.
        if (child.endsWith(".jsonl")) add(join(subagents, child), `claude:subagent:${entry}:${child}`);
      }
    }
  }
  return files;
}

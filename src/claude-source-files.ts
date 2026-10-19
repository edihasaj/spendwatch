// Claude Code stores legacy transcripts at project level and current child
// agents at project/<session>/subagents/*.jsonl. Keep the search deliberately
// narrow so unrelated project files never become transcript sources.
import { existsSync, readdirSync, statSync } from "node:fs";
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

function freshEnough(path: string, sinceMs: number): boolean {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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
): SourceFile[] {
  if (!existsSync(projectsDir)) return [];
  const files: SourceFile[] = [];
  for (const projectEntry of safeReaddir(projectsDir)) {
    const projectName = humanProject(projectEntry);
    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) continue;
    const projectDir = join(projectsDir, projectEntry);
    const add = (path: string, key: string) => {
      if (!freshEnough(path, sinceMs)) return;
      const file = claudeFile(path, projectName, account, gateway);
      file.key = key;
      files.push(file);
    };
    for (const entry of safeReaddir(projectDir)) {
      const path = join(projectDir, entry);
      if (entry.endsWith(".jsonl")) {
        add(path, `claude:session:${basename(path)}`); // legacy project-level session
        continue;
      }
      if (!directory(path)) continue;
      const subagents = join(path, "subagents");
      for (const child of safeReaddir(subagents)) {
        // Child IDs are scoped to a parent session. Profile copies retain both
        // suffixes, while same-named children in separate sessions stay apart.
        if (child.endsWith(".jsonl")) add(join(subagents, child), `claude:subagent:${entry}:${child}`);
      }
    }
  }
  return files;
}

// File discovery + incremental JSONL reading (shared by report and watch).
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { Aggregator } from "./aggregate";
import { parseLine } from "./parse";

export interface ScanOpts {
  dir: string; // ~/.claude/projects
  sinceMs: number; // skip files older than this mtime
  project?: string; // substring filter on project dir name
}

export function listTranscripts(opts: ScanOpts): Array<{ path: string; project: string }> {
  const out: Array<{ path: string; project: string }> = [];
  let projDirs: string[] = [];
  try {
    projDirs = readdirSync(opts.dir);
  } catch {
    return out;
  }
  for (const p of projDirs) {
    const project = humanProject(p);
    if (opts.project && !project.toLowerCase().includes(opts.project.toLowerCase())) continue;
    const dir = join(opts.dir, p);
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      try {
        if (statSync(path).mtimeMs >= opts.sinceMs) out.push({ path, project });
      } catch {}
    }
  }
  return out;
}

export function humanProject(dirName: string): string {
  // "-Users-edihasaj-Projects-foo-bar" -> "foo-bar"; bare workspace -> "~/Projects"
  const m = dirName.match(/-Users-[^-]+-(.+)/);
  if (!m) return dirName;
  const rest = m[1];
  if (rest === "Projects") return "~/Projects";
  return rest.replace(/^(Projects|Documents)-/, "");
}

// Tracks per-file read offsets so watch mode only parses appended bytes.
export class IncrementalReader {
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();

  constructor(private agg: Aggregator) {}

  /** Read new bytes from file into the aggregator. Returns bytes consumed. */
  poll(path: string, project: string): number {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return 0;
    }
    let off = this.offsets.get(path) ?? 0;
    if (size <= off) return 0;
    const fd = openSync(path, "r");
    let consumed = 0;
    try {
      const fold = this.agg.stream(`${project}/${basename(path)}`, project);
      const buf = Buffer.alloc(1 << 20);
      let carry = this.partial.get(path) ?? "";
      while (off < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
        if (n <= 0) break;
        off += n;
        consumed += n;
        const chunk = carry + buf.toString("utf8", 0, n);
        const lines = chunk.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) for (const e of parseLine(line)) fold(e);
      }
      this.partial.set(path, carry);
      this.offsets.set(path, off);
    } finally {
      closeSync(fd);
    }
    return consumed;
  }

  /** Flush a trailing line with no newline (end-of-scan for report mode). */
  flush(path: string, project: string) {
    const carry = this.partial.get(path);
    if (!carry) return;
    const fold = this.agg.stream(`${project}/${basename(path)}`, project);
    for (const e of parseLine(carry)) fold(e);
    this.partial.set(path, "");
  }
}

// File discovery helpers + incremental JSONL reading (shared by report and watch).
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Aggregator } from "./aggregate";
import type { SourceFile } from "./sources";

export function humanProject(dirName: string): string {
  // "-Users-edihasaj-Projects-foo-bar" -> "foo-bar"; bare workspace -> "~/Projects"
  const m = dirName.match(/-Users-[^-]+-(.+)/);
  if (!m) return dirName;
  const rest = m[1];
  if (rest === "Projects") return "~/Projects";
  return rest.replace(/^(Projects|Documents)-/, "");
}

export function humanCodexProject(cwd: string): string {
  // "/Users/edihasaj/Projects/foo" -> "foo"; home -> "~"
  const m = cwd.match(/\/(?:Projects|Documents)\/(.+)$/);
  if (m) return m[1];
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

// Recursively yield every *.jsonl under a directory.
export function* walkJsonl(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkJsonl(p);
    else if (e.endsWith(".jsonl")) yield p;
  }
}

// Tracks per-file read offsets so watch mode only parses appended bytes.
// Parser is supplied per-file via SourceFile, so one reader serves all sources.
export class IncrementalReader {
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();

  constructor(private agg: Aggregator) {}

  /** Read new bytes from a file into the aggregator. Returns bytes consumed. */
  poll(file: SourceFile): number {
    const { path, project, source, account, parse, ctx } = file;
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
      const fold = this.agg.stream(path, project, source, account);
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
        for (const line of lines) for (const ev of parse(line, ctx)) fold(ev);
      }
      this.partial.set(path, carry);
      this.offsets.set(path, off);
    } finally {
      closeSync(fd);
    }
    return consumed;
  }

  /** Flush a trailing line with no newline (end-of-scan for report mode). */
  flush(file: SourceFile) {
    const carry = this.partial.get(file.path);
    if (!carry) return;
    const fold = this.agg.stream(file.path, file.project, file.source, file.account);
    for (const ev of file.parse(carry, file.ctx)) fold(ev);
    this.partial.set(file.path, "");
  }
}

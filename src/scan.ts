// File discovery helpers + incremental JSONL reading (shared by report and watch).
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { EventSink } from "./monthly";
import type { SourceFile } from "./sources";

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
  /** The parser state of each file, from the first time it was seen: the offset only makes sense with it. */
  private contexts = new Map<string, unknown>();

  constructor(private agg: EventSink) {}

  /** Read new bytes from a file into the aggregator. Returns bytes consumed. */
  poll(file: SourceFile): number {
    const { path, project, source, account, parse } = file;
    if (file.events) {
      const fold = this.agg.stream(file.key ?? path, project, source, account);
      let count = 0;
      for (const event of file.events()) { fold(event); count++; }
      return count;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return 0;
    }
    let off = this.offsets.get(path) ?? 0;
    // A file found again keeps its first context: a new one has not seen the lines before the offset.
    const ctx = this.context(file);
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

  private context(file: SourceFile): unknown {
    if (!this.contexts.has(file.path)) this.contexts.set(file.path, file.ctx);
    const kept = this.contexts.get(file.path);
    if (kept !== file.ctx) file.renew?.(kept);
    return kept;
  }

  /** Flush a trailing line with no newline (end-of-scan for report mode). */
  flush(file: SourceFile) {
    if (file.events) return;
    const carry = this.partial.get(file.path);
    if (!carry) return;
    const fold = this.agg.stream(file.path, file.project, file.source, file.account);
    for (const ev of file.parse(carry, this.context(file))) fold(ev);
    this.partial.set(file.path, "");
  }
}

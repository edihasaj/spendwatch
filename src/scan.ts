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
  // Everything below is keyed by `identity(file)`, not by where the file sits now.
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();
  /** The parser state of each file, from the first time it was seen: the offset only makes sense with it. */
  private contexts = new Map<string, unknown>();

  constructor(private agg: EventSink) {}

  /**
   * A file moves (Codex files a finished rollout under archived_sessions) but its offset, parser state and
   * stream belong to the file, so a source that names its files gives them a stable `key`.
   */
  private identity(file: SourceFile): string {
    return file.key ?? file.path;
  }

  /** Read new bytes from a file into the aggregator. Returns bytes consumed. */
  poll(file: SourceFile): number {
    const { path, project, source, account, parse } = file;
    const id = this.identity(file);
    if (file.events) {
      const fold = this.agg.stream(id, project, source, account);
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
    let off = this.offsets.get(id) ?? 0;
    // A file found again keeps its first context: a new one has not seen the lines before the offset.
    const ctx = this.context(file);
    if (size <= off) return 0;
    const fd = openSync(path, "r");
    let consumed = 0;
    try {
      const fold = this.agg.stream(id, project, source, account);
      const buf = Buffer.alloc(1 << 20);
      let carry = this.partial.get(id) ?? "";
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
      this.partial.set(id, carry);
      this.offsets.set(id, off);
    } finally {
      closeSync(fd);
    }
    return consumed;
  }

  private context(file: SourceFile): unknown {
    const id = this.identity(file);
    if (!this.contexts.has(id)) this.contexts.set(id, file.ctx);
    const kept = this.contexts.get(id);
    if (kept !== file.ctx) file.renew?.(kept);
    return kept;
  }

  /** Flush a trailing line with no newline (end-of-scan for report mode). */
  flush(file: SourceFile) {
    if (file.events) return;
    const id = this.identity(file);
    const carry = this.partial.get(id);
    if (!carry) return;
    const fold = this.agg.stream(id, file.project, file.source, file.account);
    for (const ev of file.parse(carry, this.context(file))) fold(ev);
    this.partial.set(id, "");
  }
}

// File discovery helpers + incremental JSONL reading (shared by report and watch).
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { EventSink } from "./monthly";
import type { Event } from "./parse";
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

/** The part of a file that identifies it and settles what its parser left waiting; it keeps nothing of one discovery. */
type Settling = Pick<SourceFile, "path" | "key" | "project" | "source" | "account" | "settle">;

// Tracks per-file read offsets so watch mode only parses appended bytes.
// Parser is supplied per-file via SourceFile, so one reader serves all sources.
export class IncrementalReader {
  // Everything below is keyed by `identity(file)`, not by where the file sits now.
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();
  /** The parser state of each file, from the first time it was seen: the offset only makes sense with it. */
  private contexts = new Map<string, unknown>();
  /** The `version` each events-backed file had when it was last folded. */
  private versions = new Map<string, string>();
  /** What is needed to settle each file that has parser state if `watch` stops discovering it (see `renewAbsent`). */
  private seen = new Map<string, Settling>();

  constructor(private agg: EventSink) {}

  /**
   * A file moves (Codex files a finished rollout under archived_sessions) but its offset, parser state and
   * stream belong to the file, so a source that names its files gives them a stable `key`.
   */
  private identity(file: Pick<SourceFile, "path" | "key">): string {
    return file.key ?? file.path;
  }

  /** Read new bytes from a file into the aggregator. Returns bytes consumed, plus events settled with no new bytes. */
  poll(file: SourceFile): number {
    const { path, project, source, account, parse } = file;
    const id = this.identity(file);
    if (file.events || file.snapshot) {
      const snapshot = file.snapshot?.();
      if (file.snapshot && !snapshot) return 0;
      const version = snapshot ? snapshot.version : file.version?.();
      if (version !== undefined && this.versions.get(id) === version) return 0;
      // These events are all the file has, not what is new: they replace what the last poll folded, so a row that has
      // stopped billing (a ledger row a rollout's bill now covers) is not counted from the earlier poll.
      this.agg.reset(id);
      const fold = this.agg.stream(id, project, source, account);
      let count = 0;
      for (const event of snapshot ? snapshot.events : file.events!()) { fold(event); count++; }
      if (version !== undefined) this.versions.set(id, version);
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
    // What earlier lines left undecided may be decidable now, against what this discovery found (a reloaded ledger).
    const settled = this.settle(file, ctx, false);
    if (size <= off) return settled;
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
    return consumed + settled;
  }

  private settle(file: Settling, ctx: unknown, final: boolean): number {
    if (!file.settle) return 0;
    // The stream opens only for an event: an empty file must not become a session.
    let fold: ((event: Event) => void) | undefined;
    let count = 0;
    for (const event of file.settle(ctx, final)) {
      fold ??= this.agg.stream(this.identity(file), file.project, file.source, file.account);
      fold(event);
      count++;
    }
    return count;
  }

  /**
   * Hands a file found again its kept parser state, without reading it. `watch` does this for every file before it
   * reads any, so a reloaded ledger has every rollout's earlier decisions before the first new one is made.
   */
  renew(file: SourceFile): void {
    if (!file.events && !file.snapshot) this.context(file);
  }

  private context(file: SourceFile): unknown {
    const id = this.identity(file);
    this.seen.set(id, { path: file.path, key: file.key, project: file.project, source: file.source, account: file.account, settle: file.settle });
    if (!this.contexts.has(id)) this.contexts.set(id, file.ctx);
    const kept = this.contexts.get(id);
    if (kept !== file.ctx) file.renew?.(kept);
    return kept;
  }

  /**
   * The files this reader has parser state for that `found` does not hold: ones the agent moved out of every root
   * (Codex files a finished rollout under archived_sessions, which a config may leave out) or deleted. What they
   * decided about the gateway ledger, and the calls they left waiting for a row, still count.
   */
  private absent(found: SourceFile[]): Array<{ file: Settling; ctx: unknown }> {
    const here = new Set(found.map((file) => this.identity(file)));
    return [...this.seen].filter(([id]) => !here.has(id)).map(([id, file]) => ({ file, ctx: this.contexts.get(id) }));
  }

  /** Hands each absent file's kept state what this discovery decided afresh, as `renew` does for a file found again. */
  renewAbsent(found: SourceFile[], carry: (kept: any) => void): void {
    for (const { ctx } of this.absent(found)) carry(ctx);
  }

  /** Decides what each absent file left waiting, against this discovery (see `SourceFile.settle`). */
  settleAbsent(found: SourceFile[]): number {
    let count = 0;
    for (const { file, ctx } of this.absent(found)) count += this.settle(file, ctx, false);
    return count;
  }

  /**
   * End of a read: a trailing line with no newline is parsed, and what the parser left undecided is decided now
   * (see `SourceFile.settle`), because a report has no later tick to wait for. `watch` has later ticks, so its first
   * read passes `final = false` and leaves a routed call younger than the claim window waiting for its ledger row.
   */
  flush(file: SourceFile, final = true) {
    if (file.events || file.snapshot) return;
    const id = this.identity(file);
    const carry = this.partial.get(id);
    const ctx = this.context(file);
    // A line the agent is still writing is not a line yet. `watch` keeps polling after this first read, and the
    // next poll must see the rest of it joined to its start, not a torn fragment followed by an orphan tail.
    if (carry && wholeJson(carry)) {
      const fold = this.agg.stream(id, file.project, file.source, file.account);
      for (const ev of file.parse(carry, ctx)) fold(ev);
      this.partial.set(id, "");
    }
    this.settle(file, ctx, final);
  }
}

function wholeJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// Older Codex wrote a subagent's rollout by copying its parent's whole history into the child
// file. Those copied parent turns are already billed by the parent's own rollout, so a reader that
// counts the child file whole bills them twice. Turn ids are unique per turn: a turn whose id the
// actual parent rollout also opened is the parent's work, replayed. Only those turns are skipped;
// child-only turns and rows outside any turn keep counting, so nothing is subtracted on a guess.
//
// Codex later rewrote some of these files into native paginated form. That rewrite keeps only the
// copied context (every row sits below its ownership boundary) and drops the child's own turns, so
// when both copies exist the original legacy file is the complete one.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import type { CodexCtx, CodexHistoryAdmission } from "./codex";

const CHUNK = 1 << 20;
const MAX_LINE = 16 * 1024 * 1024;
const MAX_SCAN = 1024 * 1024 * 1024;
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

interface Header {
  id?: string;
  parent?: string;
  boundary?: number;
  paginated: boolean;
}

/** Reads complete lines until `visit` returns false. Returns false when the file could not be read. */
function eachLine(path: string, visit: (line: string) => boolean): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_SCAN) return false;
    const buffer = Buffer.alloc(CHUNK);
    let pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (count <= 0) return false;
      offset += count;
      let start = 0;
      for (let i = 0; i < count; i++) {
        if (buffer[i] !== 0x0a) continue;
        const line = (pending.length ? Buffer.concat([pending, buffer.subarray(start, i)]) : buffer.subarray(start, i)).toString("utf8");
        pending = Buffer.alloc(0);
        start = i + 1;
        if (!visit(line)) return true;
      }
      pending = Buffer.concat([pending, buffer.subarray(start, count)]);
      if (pending.length > MAX_LINE) return false;
    }
    if (pending.length) visit(pending.toString("utf8"));
    return true;
  } finally {
    closeSync(fd);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function header(path: string): Header | undefined {
  let found: Header | undefined;
  eachLine(path, (line) => {
    if (!line.trim()) return true;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "session_meta") return false;
      const p = row.payload ?? {};
      const refs = [p.forked_from_id, p.parent_thread_id, p.source?.subagent?.parent_thread_id,
        p.source?.subagent?.thread_spawn?.parent_thread_id].map(text).filter((ref): ref is string => !!ref);
      const boundary = p.subagent_history_start_ordinal;
      found = {
        id: text(p.id),
        // Conflicting parent references leave the lineage unproven.
        parent: new Set(refs).size === 1 ? refs[0] : undefined,
        boundary: Number.isSafeInteger(boundary) && boundary >= 0 ? boundary : undefined,
        paginated: p.history_mode === "paginated",
      };
    } catch {}
    return false;
  });
  return found;
}

/** True when every row of a paginated rollout lies below its ownership boundary (inherited context only). */
function contextOnly(path: string, boundary: number): boolean {
  let ok = true;
  const read = eachLine(path, (line) => {
    if (!line.trim()) return true;
    try {
      const ordinal = JSON.parse(line)?.ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal >= boundary) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  });
  return read && ok;
}

const turnCache = new Map<string, Set<string> | undefined>();

/** Every turn id the rollout opened, or undefined when it could not be read whole. */
function turnIds(path: string): Set<string> | undefined {
  let key: string;
  try {
    const fd = openSync(path, "r");
    try {
      const s = fstatSync(fd);
      key = [path, s.dev, s.ino, s.size, s.mtimeMs].join("\0");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (turnCache.has(key)) return turnCache.get(key);
  const ids = new Set<string>();
  const ok = eachLine(path, (line) => {
    if (!line.includes("\"turn_id\"")) return true;
    try {
      const row = JSON.parse(line);
      const p = row?.payload;
      if ((row?.type === "turn_context" || (row?.type === "event_msg" && p?.type === "task_started")) && text(p?.turn_id)) {
        ids.add(p.turn_id);
      }
    } catch {}
    return true;
  });
  const result = ok ? ids : undefined;
  if (turnCache.size > 512) turnCache.clear();
  turnCache.set(key, result);
  return result;
}

export interface LegacyForkFile {
  path: string;
  ctx: unknown;
  semanticCtx?: () => any;
}

export interface LegacyForkSummary {
  /** Legacy child rollouts whose parent turns are now skipped. */
  linked: number;
  /** Legacy child rollouts whose parent rollout is missing or unreadable; counted whole, as before. */
  unlinked: number;
  /** Paginated context-only rewrites dropped in favour of their complete legacy original. */
  replaced: number;
}

/**
 * Links each legacy fork to its parent's turn ids and drops paginated context-only rewrites that
 * duplicate a legacy original. Mutates only the given parser contexts and semantic factories.
 */
export function prepareLegacyForks<T extends { path: string; value: LegacyForkFile }>(copies: T[]): { copies: T[]; summary: LegacyForkSummary } {
  const summary: LegacyForkSummary = { linked: 0, unlinked: 0, replaced: 0 };
  const headers = new Map<string, Header | undefined>();
  const headerOf = (path: string) => {
    if (!headers.has(path)) headers.set(path, header(path));
    return headers.get(path);
  };
  const byId = new Map<string, string[]>();
  const groups = new Map<string, T[]>();
  for (const copy of copies) {
    const name = basename(copy.path);
    const id = ROLLOUT_ID.exec(name)?.[1];
    if (id) byId.set(id, [...(byId.get(id) ?? []), copy.path]);
    groups.set(name, [...(groups.get(name) ?? []), copy]);
  }
  const dropped = new Set<T>();
  for (const group of groups.values()) {
    const legacy = group.filter((copy) => {
      const h = headerOf(copy.path);
      return !!h?.parent && h.boundary === undefined;
    });
    if (!legacy.length) continue;
    const own = headerOf(legacy[0]!.path)!;
    for (const copy of group) {
      const h = headerOf(copy.path);
      if (!h || h.boundary === undefined || !h.paginated) continue;
      if (h.id === own.id && h.parent === own.parent && contextOnly(copy.path, h.boundary)) {
        dropped.add(copy);
        summary.replaced++;
      }
    }
    for (const copy of legacy) {
      const parents = byId.get(headerOf(copy.path)!.parent!) ?? [];
      const turns = new Set<string>();
      let readable = parents.length > 0;
      for (const path of parents) {
        const ids = turnIds(path);
        if (!ids) readable = false;
        else for (const id of ids) turns.add(id);
      }
      if (!readable || !turns.size) {
        summary.unlinked++;
        continue;
      }
      summary.linked++;
      (copy.value.ctx as CodexCtx).inheritedTurns = turns;
      const semantic = copy.value.semanticCtx;
      if (semantic) copy.value.semanticCtx = () => Object.assign(semantic(), { inheritedTurns: turns });
    }
  }
  return { copies: copies.filter((copy) => !dropped.has(copy)), summary };
}

/**
 * Admission for a row of a rollout without a native ownership boundary. A legacy fork linked to its
 * parent skips every row inside a turn the parent itself opened, before any parser state changes.
 */
export function legacyTurnAdmission(record: any, ctx: CodexCtx): CodexHistoryAdmission {
  const turns = ctx.inheritedTurns;
  if (!turns) return { record, inherited: false, seedMetadata: false };
  const p = record?.payload ?? {};
  const opens = record?.type === "turn_context" || (record?.type === "event_msg" && p.type === "task_started");
  const closes = record?.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted");
  if (opens && text(p.turn_id)) ctx.activeTurn = p.turn_id;
  const inherited = ctx.activeTurn !== undefined && turns.has(ctx.activeTurn);
  if (closes && (p.turn_id === undefined || p.turn_id === ctx.activeTurn)) ctx.activeTurn = undefined;
  return { record, inherited, seedMetadata: false };
}

// Folds parse events into per-tool / per-prompt / per-model / per-project spend.
import type { Event } from "./parse";
import { contextCost, estTokens, usageCost, type Usage } from "./pricing";

interface StreamState {
  project: string;
  source: string;
  account: string;
  sessionId: string;
  sidechain: boolean;
  model?: string;
  nCalls: number;
  callIdx: Map<string, number>; // requestId -> 0-based call index
  currentPromptKey?: string;
  toolUse: Map<string, { name: string; argChars: number; idx: number; promptKey?: string; sub?: string; deep?: string; detail?: string }>;
  results: Array<{ name: string; tokens: number; idx: number; promptKey?: string; sub?: string; deep?: string; detail?: string; error?: boolean; exit?: number }>;
  usage: Map<string, { model?: string; usage: Usage; promptKey?: string; lastTs: number }>;
  firstUserText?: string;
}

export interface SampleRow {
  detail: string;
  count: number;
  resultTok: number;
}
export interface ToolRow {
  name: string;
  calls: number;
  argTok: number;
  resultTok: number;
  ctxCost: number;
  resultCalls: number; // calls that produced a result (denominator for err%)
  errCalls: number; // results flagged error / nonzero exit
  exit127: number; // command-not-found (agent guessing at a tool)
  samples?: SampleRow[]; // top distinct invocations (drill-down)
}
export interface TargetRow {
  command: string;
  calls: number;
  ctxCost: number;
  errPct: number;
  reason: string;
  score: number;
}
export interface AccountRow {
  account: string;
  tokens: number;
  cost: number;
  calls: number;
  sessions: number;
}
export interface PromptRow {
  key: string;
  text: string;
  project: string;
  tokens: number;
  cost: number;
  toolCalls: number;
  outTok: number;
  ts: number;
}
export interface ModelRow {
  model: string;
  calls: number;
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheWriteTok: number;
  cost: number;
}
export interface Report {
  totalTokens: number;
  totalCost: number;
  apiCalls: number;
  sessions: number;
  tools: ToolRow[];
  bash: ToolRow[];
  deep: ToolRow[];
  targets: TargetRow[]; // ranked "what to automate" shortlist (cost × frequency × friction)
  prompts: PromptRow[];
  models: ModelRow[];
  projects: Array<{ project: string; tokens: number; cost: number }>;
  accounts: AccountRow[];
  source: string;
  sinceTs: number;
}

export class Aggregator {
  private streams = new Map<string, StreamState>();
  private promptText = new Map<string, { text: string; project: string; ts: number }>();

  stream(fileKey: string, project: string, source = "claude", account = "default"): (e: Event) => void {
    let s = this.streams.get(fileKey);
    if (!s) {
      s = {
        project,
        source,
        account,
        sessionId: "?",
        sidechain: fileKey.includes("agent-"),
        nCalls: 0,
        callIdx: new Map(),
        toolUse: new Map(),
        results: [],
        usage: new Map(),
      };
      this.streams.set(fileKey, s);
    }
    return (e: Event) => this.fold(s!, e);
  }

  private fold(s: StreamState, e: Event) {
    s.sessionId = e.sessionId;
    switch (e.t) {
      case "meta": {
        if (e.project) s.project = e.project;
        if (e.model) s.model = e.model;
        return;
      }
      case "prompt": {
        if (e.sidechain || s.sidechain) {
          // Subagent task — synthesize a labelled prompt once per stream.
          if (!s.firstUserText) {
            s.firstUserText = e.text;
            const key = `${e.sessionId}:agent:${e.promptId}`;
            s.currentPromptKey = key;
            this.promptText.set(key, { text: `⑂ ${e.text}`, project: s.project, ts: e.ts });
          }
          break;
        }
        const key = `${e.sessionId}:${e.promptId}`;
        s.currentPromptKey = key;
        if (!this.promptText.has(key)) this.promptText.set(key, { text: e.text, project: s.project, ts: e.ts });
        break;
      }
      case "api": {
        s.model = e.model ?? s.model;
        if (!s.callIdx.has(e.requestId)) s.callIdx.set(e.requestId, s.nCalls++);
        // Streamed responses rewrite the same requestId with growing usage — keep latest.
        s.usage.set(e.requestId, { model: e.model, usage: e.usage, promptKey: s.currentPromptKey, lastTs: e.ts });
        break;
      }
      case "tooluse": {
        const idx = s.callIdx.get(e.requestId) ?? s.nCalls;
        s.toolUse.set(e.id, { name: e.name, argChars: e.argChars, idx, promptKey: s.currentPromptKey, sub: e.sub, deep: e.deep, detail: e.detail });
        break;
      }
      case "toolresult": {
        const tu = s.toolUse.get(e.id);
        if (tu) s.results.push({ name: tu.name, tokens: estTokens(e.chars), idx: tu.idx, promptKey: tu.promptKey, sub: tu.sub, deep: tu.deep, detail: tu.detail, error: e.error, exit: e.exit });
        break;
      }
    }
  }

  report(topN = 15): Report {
    const tools = new Map<string, ToolRow>();
    const bash = new Map<string, ToolRow>();
    const deep = new Map<string, ToolRow>();
    const sources = new Set<string>();
    const prompts = new Map<string, PromptRow>();
    const models = new Map<string, ModelRow>();
    const projects = new Map<string, { tokens: number; cost: number }>();
    const sessions = new Set<string>();
    const accounts = new Map<string, { tokens: number; cost: number; calls: number; sessions: Set<string> }>();
    // detail samples per (table, key): map key -> map detail -> {count, resultTok}
    const samp = { tools: new Map<string, Map<string, SampleRow>>(), bash: new Map<string, Map<string, SampleRow>>(), deep: new Map<string, Map<string, SampleRow>>() };
    const SAMP_CAP = 1500; // max distinct details per key (bounds memory)
    const bumpSample = (store: Map<string, Map<string, SampleRow>>, key: string, detail: string, count: number, resultTok: number) => {
      let m = store.get(key);
      if (!m) store.set(key, (m = new Map()));
      let row = m.get(detail);
      if (!row) {
        if (m.size >= SAMP_CAP) return; // keep existing; drop new rare details
        m.set(detail, (row = { detail, count: 0, resultTok: 0 }));
      }
      row.count += count;
      row.resultTok += resultTok;
    };
    let totalCost = 0;
    let totalTokens = 0;
    let apiCalls = 0;
    let sinceTs = Infinity;

    for (const s of this.streams.values()) {
      sessions.add(s.sessionId);
      sources.add(s.source);
      let acc = accounts.get(s.account);
      if (!acc) accounts.set(s.account, (acc = { tokens: 0, cost: 0, calls: 0, sessions: new Set() }));
      acc.sessions.add(s.sessionId);
      for (const [, u] of s.usage) {
        apiCalls++;
        const tokens = u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cache5m + u.usage.cache1h;
        const cost = usageCost(u.model, u.usage);
        totalTokens += tokens;
        totalCost += cost;
        acc.tokens += tokens;
        acc.cost += cost;
        acc.calls++;
        if (u.lastTs && u.lastTs < sinceTs) sinceTs = u.lastTs;
        const project = projects.get(s.project) ?? { tokens: 0, cost: 0 };
        project.tokens += tokens;
        project.cost += cost;
        projects.set(s.project, project);
        const mk = u.model ?? "unknown";
        let m = models.get(mk);
        if (!m) models.set(mk, (m = { model: mk, calls: 0, inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, cost: 0 }));
        m.calls++;
        m.inTok += u.usage.input;
        m.outTok += u.usage.output;
        m.cacheReadTok += u.usage.cacheRead;
        m.cacheWriteTok += u.usage.cache5m + u.usage.cache1h;
        m.cost += cost;
        if (u.promptKey) {
          const p = this.promptRow(prompts, u.promptKey);
          if (p) {
            p.tokens += tokens;
            p.cost += cost;
            p.outTok += u.usage.output;
          }
        }
      }
      for (const [, tu] of s.toolUse) {
        const targets: Array<[Map<string, ToolRow>, Map<string, Map<string, SampleRow>>, string]> = [[tools, samp.tools, tu.name]];
        if (tu.sub) targets.push([bash, samp.bash, tu.sub]);
        if (tu.deep) targets.push([deep, samp.deep, tu.deep]);
        for (const [map, store, key] of targets) {
          let t = map.get(key);
          if (!t) map.set(key, (t = { name: key, calls: 0, argTok: 0, resultTok: 0, ctxCost: 0, resultCalls: 0, errCalls: 0, exit127: 0 }));
          t.calls++;
          t.argTok += estTokens(tu.argChars);
          if (tu.detail) bumpSample(store, key, tu.detail, 1, 0);
        }
        if (tu.promptKey) {
          const p = this.promptRow(prompts, tu.promptKey);
          if (p) p.toolCalls++;
        }
      }
      for (const r of s.results) {
        const cost = contextCost(r.tokens, s.model, s.nCalls - r.idx - 1);
        const targets: Array<[Map<string, ToolRow>, Map<string, Map<string, SampleRow>>, string]> = [[tools, samp.tools, r.name]];
        if (r.sub) targets.push([bash, samp.bash, r.sub]);
        if (r.deep) targets.push([deep, samp.deep, r.deep]);
        for (const [map, store, key] of targets) {
          const t = map.get(key);
          if (!t) continue;
          t.resultTok += r.tokens;
          t.ctxCost += cost;
          t.resultCalls++;
          if (r.error) t.errCalls++;
          if (r.exit === 127) t.exit127++;
          if (r.detail) bumpSample(store, key, r.detail, 0, r.tokens);
        }
      }
    }

    // Attach top samples (by result tokens then count) to each row.
    const attach = (rows: Map<string, ToolRow>, store: Map<string, Map<string, SampleRow>>) => {
      for (const [key, t] of rows) {
        const m = store.get(key);
        if (!m) continue;
        t.samples = [...m.values()].sort((a, b) => b.resultTok - a.resultTok || b.count - a.count).slice(0, 40);
      }
    };
    attach(tools, samp.tools);
    attach(bash, samp.bash);
    attach(deep, samp.deep);

    // AUTOMATE shortlist: rank deep commands by cost × friction, then make sure
    // any "command not found" (exit 127 — the agent guessing) is surfaced even
    // if cheap. Frequency is already baked into ctxCost (more calls → more cost).
    const targetRows: TargetRow[] = [...deep.values()]
      .filter((t) => t.name.includes(" ")) // executable + subcommand only
      .map((t) => {
        const errPct = t.resultCalls ? t.errCalls / t.resultCalls : 0;
        // "agent guessing" only when command-not-found is a real share, not a one-off in a huge bucket
        const cnf = t.exit127 >= 2 && t.exit127 / Math.max(1, t.resultCalls) >= 0.1;
        const score = t.ctxCost * (1 + 2 * errPct) + (cnf ? 0.5 : 0);
        let reason: string;
        if (cnf) reason = `exit-127 ×${t.exit127} · agent guessing`;
        else if (errPct >= 0.5 && t.resultCalls >= 3) reason = `fails ${Math.round(errPct * 100)}% · flaky`;
        else if (errPct >= 0.15) reason = `flaky (${Math.round(errPct * 100)}% err)`;
        else if (t.calls >= 150) reason = "frequent + costly";
        else reason = "costly";
        return { command: t.name, calls: t.calls, ctxCost: t.ctxCost, errPct, reason, score, cnf };
      });
    targetRows.sort((a, b) => b.score - a.score);
    const top: TargetRow[] = targetRows.slice(0, 12).map(({ cnf, ...t }) => t);
    // ensure a few significant command-not-found offenders are visible even if low-cost
    for (const t of targetRows.filter((t) => t.cnf)) {
      if (top.length >= 16) break;
      const { cnf, ...row } = t;
      if (!top.some((x) => x.command === row.command)) top.push(row);
    }

    const by = <T>(arr: T[], f: (x: T) => number) => arr.sort((a, b) => f(b) - f(a));
    return {
      totalTokens,
      totalCost,
      apiCalls,
      sessions: sessions.size,
      tools: by([...tools.values()], (t) => t.ctxCost),
      bash: by([...bash.values()], (t) => t.ctxCost),
      deep: by([...deep.values()], (t) => t.ctxCost),
      targets: top,
      prompts: by([...prompts.values()], (p) => p.cost).slice(0, topN),
      models: by([...models.values()], (m) => m.cost),
      projects: by([...projects.entries()].map(([project, usage]) => ({ project, ...usage })), (p) => p.tokens),
      accounts: by([...accounts.entries()].map(([account, a]) => ({ account, tokens: a.tokens, cost: a.cost, calls: a.calls, sessions: a.sessions.size })), (a) => a.tokens),
      source: sources.size === 1 ? [...sources][0] : "all",
      sinceTs: sinceTs === Infinity ? 0 : sinceTs,
    };
  }

  private promptRow(map: Map<string, PromptRow>, key: string): PromptRow | undefined {
    let p = map.get(key);
    if (!p) {
      const meta = this.promptText.get(key);
      if (!meta) return undefined;
      map.set(key, (p = { key, text: meta.text, project: meta.project, tokens: 0, cost: 0, toolCalls: 0, outTok: 0, ts: meta.ts }));
    }
    return p;
  }
}

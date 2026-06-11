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
  results: Array<{ name: string; tokens: number; idx: number; promptKey?: string; sub?: string; deep?: string; detail?: string }>;
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
  samples?: SampleRow[]; // top distinct invocations (drill-down)
}
export interface AccountRow {
  account: string;
  cost: number;
  calls: number;
  sessions: number;
}
export interface PromptRow {
  key: string;
  text: string;
  project: string;
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
  totalCost: number;
  apiCalls: number;
  sessions: number;
  tools: ToolRow[];
  bash: ToolRow[];
  deep: ToolRow[];
  prompts: PromptRow[];
  models: ModelRow[];
  projects: Array<{ project: string; cost: number }>;
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
        if (tu) s.results.push({ name: tu.name, tokens: estTokens(e.chars), idx: tu.idx, promptKey: tu.promptKey, sub: tu.sub, deep: tu.deep, detail: tu.detail });
        break;
      }
    }
  }

  report(top = 15): Report {
    const tools = new Map<string, ToolRow>();
    const bash = new Map<string, ToolRow>();
    const deep = new Map<string, ToolRow>();
    const sources = new Set<string>();
    const prompts = new Map<string, PromptRow>();
    const models = new Map<string, ModelRow>();
    const projects = new Map<string, number>();
    const sessions = new Set<string>();
    const accounts = new Map<string, { cost: number; calls: number; sessions: Set<string> }>();
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
    let apiCalls = 0;
    let sinceTs = Infinity;

    for (const s of this.streams.values()) {
      sessions.add(s.sessionId);
      sources.add(s.source);
      let acc = accounts.get(s.account);
      if (!acc) accounts.set(s.account, (acc = { cost: 0, calls: 0, sessions: new Set() }));
      acc.sessions.add(s.sessionId);
      for (const [, u] of s.usage) {
        apiCalls++;
        const cost = usageCost(u.model, u.usage);
        totalCost += cost;
        acc.cost += cost;
        acc.calls++;
        if (u.lastTs && u.lastTs < sinceTs) sinceTs = u.lastTs;
        projects.set(s.project, (projects.get(s.project) ?? 0) + cost);
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
          if (!t) map.set(key, (t = { name: key, calls: 0, argTok: 0, resultTok: 0, ctxCost: 0 }));
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

    const by = <T>(arr: T[], f: (x: T) => number) => arr.sort((a, b) => f(b) - f(a));
    return {
      totalCost,
      apiCalls,
      sessions: sessions.size,
      tools: by([...tools.values()], (t) => t.ctxCost),
      bash: by([...bash.values()], (t) => t.ctxCost),
      deep: by([...deep.values()], (t) => t.ctxCost),
      prompts: by([...prompts.values()], (p) => p.cost).slice(0, top),
      models: by([...models.values()], (m) => m.cost),
      projects: by([...projects.entries()].map(([project, cost]) => ({ project, cost })), (p) => p.cost),
      accounts: by([...accounts.entries()].map(([account, a]) => ({ account, cost: a.cost, calls: a.calls, sessions: a.sessions.size })), (a) => a.cost),
      source: sources.size === 1 ? [...sources][0] : "all",
      sinceTs: sinceTs === Infinity ? 0 : sinceTs,
    };
  }

  private promptRow(map: Map<string, PromptRow>, key: string): PromptRow | undefined {
    let p = map.get(key);
    if (!p) {
      const meta = this.promptText.get(key);
      if (!meta) return undefined;
      map.set(key, (p = { key, text: meta.text, project: meta.project, cost: 0, toolCalls: 0, outTok: 0, ts: meta.ts }));
    }
    return p;
  }
}

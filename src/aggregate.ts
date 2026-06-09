// Folds parse events into per-tool / per-prompt / per-model / per-project spend.
import type { Event } from "./parse";
import { contextCost, estTokens, usageCost, type Usage } from "./pricing";

interface StreamState {
  project: string;
  sessionId: string;
  sidechain: boolean;
  model?: string;
  nCalls: number;
  callIdx: Map<string, number>; // requestId -> 0-based call index
  currentPromptKey?: string;
  toolUse: Map<string, { name: string; argChars: number; idx: number; promptKey?: string; sub?: string }>;
  results: Array<{ name: string; tokens: number; idx: number; promptKey?: string; sub?: string }>;
  usage: Map<string, { model?: string; usage: Usage; promptKey?: string; lastTs: number }>;
  firstUserText?: string;
}

export interface ToolRow {
  name: string;
  calls: number;
  argTok: number;
  resultTok: number;
  ctxCost: number;
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
  prompts: PromptRow[];
  models: ModelRow[];
  projects: Array<{ project: string; cost: number }>;
  sinceTs: number;
}

export class Aggregator {
  private streams = new Map<string, StreamState>();
  private promptText = new Map<string, { text: string; project: string; ts: number }>();

  stream(fileKey: string, project: string): (e: Event) => void {
    let s = this.streams.get(fileKey);
    if (!s) {
      s = {
        project,
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
        s.toolUse.set(e.id, { name: e.name, argChars: e.argChars, idx, promptKey: s.currentPromptKey, sub: e.sub });
        break;
      }
      case "toolresult": {
        const tu = s.toolUse.get(e.id);
        if (tu) s.results.push({ name: tu.name, tokens: estTokens(e.chars), idx: tu.idx, promptKey: tu.promptKey, sub: tu.sub });
        break;
      }
    }
  }

  report(top = 15): Report {
    const tools = new Map<string, ToolRow>();
    const bash = new Map<string, ToolRow>();
    const prompts = new Map<string, PromptRow>();
    const models = new Map<string, ModelRow>();
    const projects = new Map<string, number>();
    const sessions = new Set<string>();
    let totalCost = 0;
    let apiCalls = 0;
    let sinceTs = Infinity;

    for (const s of this.streams.values()) {
      sessions.add(s.sessionId);
      for (const [, u] of s.usage) {
        apiCalls++;
        const cost = usageCost(u.model, u.usage);
        totalCost += cost;
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
        for (const [map, key] of [[tools, tu.name], tu.sub ? [bash, tu.sub] : null].filter(Boolean) as Array<[Map<string, ToolRow>, string]>) {
          let t = map.get(key);
          if (!t) map.set(key, (t = { name: key, calls: 0, argTok: 0, resultTok: 0, ctxCost: 0 }));
          t.calls++;
          t.argTok += estTokens(tu.argChars);
        }
        if (tu.promptKey) {
          const p = this.promptRow(prompts, tu.promptKey);
          if (p) p.toolCalls++;
        }
      }
      for (const r of s.results) {
        const cost = contextCost(r.tokens, s.model, s.nCalls - r.idx - 1);
        for (const [map, key] of [[tools, r.name], r.sub ? [bash, r.sub] : null].filter(Boolean) as Array<[Map<string, ToolRow>, string]>) {
          const t = map.get(key);
          if (!t) continue;
          t.resultTok += r.tokens;
          t.ctxCost += cost;
        }
      }
    }

    const by = <T>(arr: T[], f: (x: T) => number) => arr.sort((a, b) => f(b) - f(a));
    return {
      totalCost,
      apiCalls,
      sessions: sessions.size,
      tools: by([...tools.values()], (t) => t.ctxCost),
      bash: by([...bash.values()], (t) => t.ctxCost),
      prompts: by([...prompts.values()], (p) => p.cost).slice(0, top),
      models: by([...models.values()], (m) => m.cost),
      projects: by([...projects.entries()].map(([project, cost]) => ({ project, cost })), (p) => p.cost),
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

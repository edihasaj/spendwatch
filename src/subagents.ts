// Subagent spend: how much of a report's usage ran in delegated agents, by role and by individual agent.
//
// It is a projection of calls the report already counts, so it never adds to any total. A Codex rollout names its
// own role in session_meta (thread_source "subagent", agent_role, agent_nickname, agent_path); a Claude Code
// sidechain transcript is a subagent too, though it records no role. Nothing here reads anything the collectors
// did not already read, so it costs no extra I/O, calls or latency.
import { isLocalQwenModel } from "./local-qwen-model";

/** Who ran a call when it was not the main thread. */
export interface AgentTag {
  role: string;
  name?: string;
  path?: string;
}

export interface SubagentTotals { tokens: number; cost: number; calls: number }
export interface SubagentRole extends SubagentTotals {
  role: string;
  sessions: number;
  /** Largest models first; the share on a self-hosted model is what shows how far work moved off paid ones. */
  models: Array<{ model: string; tokens: number; calls: number }>;
}
export interface SubagentAgent extends SubagentTotals {
  name: string;
  role: string;
  path?: string;
  models: string[];
}
export interface SubagentUsage {
  version: 1;
  main: SubagentTotals;
  subagent: SubagentTotals & { sessions: number };
  roles: SubagentRole[];
  /** The largest individual agents only; the roles above carry every call. */
  agents: SubagentAgent[];
}

export const MAX_SUBAGENT_AGENTS = 30;
const MAX_ROLES = 40;
const MAX_MODELS = 8;

const clean = (value: unknown, limit = 80): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;

export function agentTag(role: unknown, name?: unknown, path?: unknown): AgentTag {
  const tag: AgentTag = { role: clean(role, 40) ?? "subagent" };
  const n = clean(name); if (n) tag.name = n;
  const p = clean(path, 160); if (p) tag.path = p;
  return tag;
}

const empty = (): SubagentTotals => ({ tokens: 0, cost: 0, calls: 0 });
const add = (to: SubagentTotals, tokens: number, cost: number, calls = 1) => { to.tokens += tokens; to.cost += cost; to.calls += calls; };

export class SubagentAccumulator {
  private main = empty();
  private sub = empty();
  private sessions = new Set<string>();
  private roles = new Map<string, SubagentTotals & { sessions: Set<string>; models: Map<string, { tokens: number; calls: number }> }>();
  private agents = new Map<string, SubagentTotals & { name: string; role: string; path?: string; models: Map<string, number> }>();

  add(agent: AgentTag | undefined, sessionId: string, model: string, tokens: number, cost: number): void {
    if (!agent) { add(this.main, tokens, cost); return; }
    add(this.sub, tokens, cost);
    this.sessions.add(sessionId);
    let role = this.roles.get(agent.role);
    if (!role) this.roles.set(agent.role, (role = { ...empty(), sessions: new Set(), models: new Map() }));
    add(role, tokens, cost);
    role.sessions.add(sessionId);
    const m = role.models.get(model) ?? { tokens: 0, calls: 0 };
    m.tokens += tokens; m.calls++; role.models.set(model, m);
    const key = `${agent.role}\0${agent.path ?? ""}\0${agent.name ?? sessionId}`;
    let one = this.agents.get(key);
    if (!one) this.agents.set(key, (one = { ...empty(), name: agent.name ?? sessionId.slice(0, 8), role: agent.role, ...(agent.path ? { path: agent.path } : {}), models: new Map() }));
    add(one, tokens, cost);
    one.models.set(model, (one.models.get(model) ?? 0) + tokens);
  }

  snapshot(): SubagentUsage | undefined {
    if (!this.sub.calls) return undefined;
    return {
      version: 1,
      main: { ...this.main },
      subagent: { ...this.sub, sessions: this.sessions.size },
      roles: [...this.roles].map(([role, r]) => ({
        role, tokens: r.tokens, cost: r.cost, calls: r.calls, sessions: r.sessions.size,
        models: [...r.models].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_MODELS),
      })).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_ROLES),
      agents: [...this.agents.values()].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_SUBAGENT_AGENTS).map((a) => ({
        name: a.name, role: a.role, ...(a.path ? { path: a.path } : {}), tokens: a.tokens, cost: a.cost, calls: a.calls,
        models: [...a.models].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([model]) => model),
      })),
    };
  }
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function totals(value: any): SubagentTotals | undefined {
  const tokens = finite(value?.tokens), cost = finite(value?.cost), calls = finite(value?.calls);
  return tokens === undefined || cost === undefined || calls === undefined ? undefined : { tokens, cost, calls };
}

/** Optional archived metadata: malformed input is dropped, never allowed to change trusted totals or reach HTML. */
export function validateSubagentUsage(value: unknown): SubagentUsage | undefined {
  const v = value as any;
  if (!v || typeof v !== "object" || v.version !== 1 || !Array.isArray(v.roles) || !Array.isArray(v.agents)) return undefined;
  const main = totals(v.main), sub = totals(v.subagent), sessions = finite(v.subagent?.sessions);
  if (!main || !sub || sessions === undefined) return undefined;
  const roles: SubagentRole[] = [];
  for (const r of v.roles.slice(0, MAX_ROLES)) {
    const t = totals(r), role = clean(r?.role, 40), rs = finite(r?.sessions);
    if (!t || !role || rs === undefined || !Array.isArray(r.models)) return undefined;
    const models: SubagentRole["models"] = [];
    for (const m of r.models.slice(0, MAX_MODELS)) {
      const model = clean(m?.model, 120), tk = finite(m?.tokens), c = finite(m?.calls);
      if (!model || tk === undefined || c === undefined) return undefined;
      models.push({ model, tokens: tk, calls: c });
    }
    roles.push({ role, ...t, sessions: rs, models });
  }
  const agents: SubagentAgent[] = [];
  for (const a of v.agents.slice(0, MAX_SUBAGENT_AGENTS)) {
    const t = totals(a), name = clean(a?.name), role = clean(a?.role, 40);
    if (!t || !name || !role || !Array.isArray(a.models)) return undefined;
    const path = clean(a.path, 160);
    agents.push({ name, role, ...(path ? { path } : {}), ...t, models: a.models.slice(0, 3).flatMap((m: unknown) => clean(m, 120) ?? []) });
  }
  return { version: 1, main, subagent: { ...sub, sessions }, roles, agents };
}

/** Sums several machines' projections. Agents stay separate rows; only the largest are kept. */
export function mergeSubagentUsage(values: Array<SubagentUsage | undefined>): SubagentUsage | undefined {
  const present = values.filter((v): v is SubagentUsage => !!v);
  if (!present.length) return undefined;
  const main = empty(), sub = { ...empty(), sessions: 0 };
  const roles = new Map<string, SubagentRole>();
  const agents: SubagentAgent[] = [];
  for (const v of present) {
    add(main, v.main.tokens, v.main.cost, v.main.calls);
    add(sub, v.subagent.tokens, v.subagent.cost, v.subagent.calls);
    sub.sessions += v.subagent.sessions;
    for (const r of v.roles) {
      const cur = roles.get(r.role) ?? { role: r.role, tokens: 0, cost: 0, calls: 0, sessions: 0, models: [] };
      cur.tokens += r.tokens; cur.cost += r.cost; cur.calls += r.calls; cur.sessions += r.sessions;
      for (const m of r.models) {
        const hit = cur.models.find((x) => x.model === m.model);
        if (hit) { hit.tokens += m.tokens; hit.calls += m.calls; } else cur.models.push({ ...m });
      }
      roles.set(r.role, cur);
    }
    agents.push(...v.agents);
  }
  return {
    version: 1, main, subagent: sub,
    roles: [...roles.values()].map((r) => ({ ...r, models: r.models.sort((a, b) => b.tokens - a.tokens).slice(0, MAX_MODELS) }))
      .sort((a, b) => b.tokens - a.tokens),
    agents: agents.sort((a, b) => b.tokens - a.tokens).slice(0, MAX_SUBAGENT_AGENTS),
  };
}

/**
 * Gateway settlement moves a billed call to the Mac whose ledger holds it. Take the same calls out of this projection,
 * so a call is never counted by two machines. Per-agent rows are not adjusted (they are an approximate top list).
 */
export function withoutSubagentCalls(
  usage: SubagentUsage | undefined,
  calls: Array<{ agent?: AgentTag; model: string; tokens: number; cost: number }>,
): SubagentUsage | undefined {
  if (!usage) return undefined;
  const out = structuredClone(usage);
  const less = (to: SubagentTotals, tokens: number, cost: number) => {
    to.tokens = Math.max(0, to.tokens - tokens); to.cost = Math.max(0, to.cost - cost); to.calls = Math.max(0, to.calls - 1);
  };
  for (const call of calls) {
    if (!call.agent) { less(out.main, call.tokens, call.cost); continue; }
    less(out.subagent, call.tokens, call.cost);
    const role = out.roles.find((r) => r.role === call.agent!.role);
    if (!role) continue;
    less(role, call.tokens, call.cost);
    const m = role.models.find((x) => x.model === call.model);
    if (m) { m.tokens = Math.max(0, m.tokens - call.tokens); m.calls = Math.max(0, m.calls - 1); }
  }
  out.roles = out.roles.filter((r) => r.calls > 0);
  return out.subagent.calls > 0 ? out : undefined;
}

/** Share of the subagents' tokens that ran on the self-hosted model: the figure for pushing work off paid models. */
export function localShare(usage: SubagentUsage): number {
  const local = usage.roles.reduce((sum, r) => sum + r.models.filter((m) => isLocalQwenModel(m.model)).reduce((n, m) => n + m.tokens, 0), 0);
  return usage.subagent.tokens > 0 ? Math.min(1, local / usage.subagent.tokens) : 0;
}

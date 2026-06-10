// Renders a standalone, self-contained HTML report from spendwatch reports.
import type { Report, ToolRow, PromptRow } from "./aggregate";
import { fmtTok, fmtUsd } from "./render";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot", gemini: "Gemini" };

interface Col {
  head: string;
  num?: boolean;
  bar?: boolean; // draw a heat bar behind this cell
}

function dataTable(cols: Col[], rows: string[][], barValues?: number[]): string {
  const max = barValues ? Math.max(1, ...barValues) : 1;
  const head = cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.head)}</th>`).join("");
  const body = rows
    .map((r, ri) => {
      const cells = r
        .map((cell, ci) => {
          const c = cols[ci];
          const pct = c.bar && barValues ? Math.round((barValues[ri] / max) * 100) : 0;
          const bar = c.bar ? `<span class="bar" style="width:${pct}%"></span>` : "";
          return `<td class="${c.num ? "num" : ""} ${c.bar ? "barcell" : ""}">${bar}<span class="v">${esc(cell)}</span></td>`;
        })
        .join("");
      return `<tr style="--i:${ri}">${cells}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function toolTable(rows: ToolRow[], firstHead: string, limit: number): string {
  const r = rows.slice(0, limit);
  return dataTable(
    [{ head: firstHead, bar: true }, { head: "calls", num: true }, { head: "arg tok", num: true }, { head: "result tok", num: true }, { head: "ctx $", num: true }],
    r.map((t) => [t.name, String(t.calls), fmtTok(t.argTok), fmtTok(t.resultTok), fmtUsd(t.ctxCost)]),
    r.map((t) => t.ctxCost),
  );
}

function promptTable(rows: PromptRow[]): string {
  return dataTable(
    [{ head: "$", num: true, bar: true }, { head: "tools", num: true }, { head: "out tok", num: true }, { head: "project" }, { head: "prompt" }],
    rows.map((p) => [fmtUsd(p.cost), String(p.toolCalls), fmtTok(p.outTok), p.project, p.text.replace(/\s+/g, " ").trim().slice(0, 160)]),
    rows.map((p) => p.cost),
  );
}

function section(title: string, sub: string, body: string): string {
  return `<section class="block"><h3>${esc(title)}<span class="sub">${esc(sub)}</span></h3>${body}</section>`;
}

function agentPanel(r: Report, idx: number): string {
  const stat = (label: string, val: string) => `<div class="stat"><span class="n">${val}</span><span class="l">${esc(label)}</span></div>`;
  const stats = `<div class="stats">${stat("est spend", fmtUsd(r.totalCost))}${stat("API calls", r.apiCalls.toLocaleString())}${stat("sessions", String(r.sessions))}</div>`;
  const parts: string[] = [stats];
  if (r.tools.length) parts.push(section("By tool", "ctx $ = cost results impose via cache write + rereads", toolTable(r.tools, "tool", 20)));
  if (r.bash.length) parts.push(section("By command", "shell calls split by executable", toolTable(r.bash, "command", 14)));
  const deep = r.deep.filter((t) => t.name.includes(" "));
  if (deep.length) parts.push(section("By command — deep", "executable + subcommand / ssh remote — what to build a CLI for", toolTable(deep, "command", 20)));
  if (r.prompts.length) parts.push(section("By prompt", "spend attributed to the active prompt (⑂ = subagent / task)", promptTable(r.prompts)));
  if (r.models.length)
    parts.push(
      section(
        "By model",
        "",
        dataTable(
          [{ head: "model", bar: true }, { head: "calls", num: true }, { head: "in", num: true }, { head: "out", num: true }, { head: "cache rd", num: true }, { head: "cache wr", num: true }, { head: "$", num: true }],
          r.models.map((m) => [m.model, String(m.calls), fmtTok(m.inTok), fmtTok(m.outTok), fmtTok(m.cacheReadTok), fmtTok(m.cacheWriteTok), fmtUsd(m.cost)]),
          r.models.map((m) => m.cost),
        ),
      ),
    );
  if (r.projects.length)
    parts.push(
      section(
        "By project",
        "",
        dataTable(
          [{ head: "project", bar: true }, { head: "$", num: true }],
          r.projects.slice(0, 16).map((p) => [p.project, fmtUsd(p.cost)]),
          r.projects.slice(0, 16).map((p) => p.cost),
        ),
      ),
    );
  return `<div class="panel${idx === 0 ? " active" : ""}" data-panel="${esc(r.source)}">${parts.join("")}</div>`;
}

export function renderHtml(reports: Report[], opts: { generatedAt: number; days: number }): string {
  const live = reports.filter((r) => r.apiCalls > 0).sort((a, b) => b.totalCost - a.totalCost);
  const total = live.reduce((s, r) => s + r.totalCost, 0);
  const since = Math.min(...live.map((r) => r.sinceTs).filter(Boolean));
  const sinceStr = since && isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "?";
  const genStr = new Date(opts.generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const overviewBars = live
    .map((r) => {
      const pct = total ? (r.totalCost / total) * 100 : 0;
      return `<div class="ov-row"><span class="ov-name">${esc(LABEL[r.source] ?? r.source)}</span><div class="ov-track"><div class="ov-fill" style="width:${pct.toFixed(1)}%"></div></div><span class="ov-val">${fmtUsd(r.totalCost)} <em>${pct.toFixed(0)}%</em></span></div>`;
    })
    .join("");

  const tabs = live.map((r, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${esc(r.source)}">${esc(LABEL[r.source] ?? r.source)} <em>${fmtUsd(r.totalCost)}</em></button>`).join("");
  const panels = live.map((r, i) => agentPanel(r, i)).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>spendwatch — agent spend report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0c0d11;--panel:#13151b;--panel2:#171a21;--line:#23262f;--ink:#e9ebf0;--dim:#8b909c;
  --amber:#ffb454;--amber2:#f0883e;--ember:#e85d4e;--green:#86e07a;--violet:#9a7bff;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;line-height:1.5;
  background-image:radial-gradient(1100px 520px at 12% -8%,rgba(255,180,84,.10),transparent 60%),radial-gradient(900px 480px at 100% 0%,rgba(154,123,255,.08),transparent 55%);}
.wrap{max-width:1120px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3{font-family:"Space Grotesk",sans-serif;letter-spacing:-.02em}
header{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px 28px;margin-bottom:30px;
  border-bottom:1px solid var(--line);padding-bottom:26px}
.brand{font-size:30px;font-weight:700;line-height:1}
.brand b{color:var(--amber)}
.brand .tag{display:block;font-family:"JetBrains Mono";font-size:12px;color:var(--dim);font-weight:400;margin-top:8px;letter-spacing:0}
.head-total{margin-left:auto;text-align:right}
.head-total .big{font-family:"Space Grotesk";font-size:38px;font-weight:700;color:var(--amber);line-height:1}
.head-total .meta{color:var(--dim);font-size:12px;margin-top:6px}
.overview{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:30px}
.overview h2{margin:0 0 16px;font-size:14px;color:var(--dim);font-weight:500;text-transform:uppercase;letter-spacing:.14em}
.ov-row{display:flex;align-items:center;gap:16px;margin:11px 0}
.ov-name{width:120px;flex:none;font-weight:500}
.ov-track{flex:1;height:12px;background:#0a0b0e;border-radius:7px;overflow:hidden;border:1px solid var(--line)}
.ov-fill{height:100%;border-radius:7px;background:linear-gradient(90deg,var(--amber2),var(--amber));box-shadow:0 0 18px rgba(255,180,84,.35);animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
.ov-val{width:130px;flex:none;text-align:right;color:var(--ink)}
.ov-val em{color:var(--dim);font-style:normal}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.tab{font-family:"JetBrains Mono";font-size:13px;color:var(--dim);background:var(--panel);border:1px solid var(--line);
  padding:9px 15px;border-radius:10px;cursor:pointer;transition:.15s}
.tab em{font-style:normal;color:var(--amber);margin-left:5px}
.tab:hover{color:var(--ink);border-color:#33414f}
.tab.active{color:var(--ink);background:var(--panel2);border-color:var(--amber2);box-shadow:0 0 0 1px rgba(240,136,62,.25)}
.panel{display:none}.panel.active{display:block}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px}
.stat{flex:1;min-width:150px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.stat .n{display:block;font-family:"Space Grotesk";font-size:26px;font-weight:700}
.stat .l{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin-top:4px}
.block{margin-top:26px}
.block h3{font-size:15px;margin:0 0 12px;display:flex;align-items:baseline;gap:12px}
.block h3 .sub{font-family:"JetBrains Mono";font-size:11px;color:var(--dim);font-weight:400;letter-spacing:0}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
thead th{text-align:left;font-weight:500;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  padding:11px 14px;border-bottom:1px solid var(--line);background:var(--panel2)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
tbody td{padding:9px 14px;border-bottom:1px solid rgba(35,38,47,.6);position:relative}
tbody tr:last-child td{border-bottom:none}
tbody tr{animation:rise .5s both;animation-delay:calc(var(--i)*22ms)}
tbody tr:hover td{background:rgba(255,180,84,.04)}
td.barcell{position:relative}
td.barcell .bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(240,136,62,.22),rgba(255,180,84,.05));border-left:2px solid var(--amber2);z-index:0}
td .v{position:relative;z-index:1}
td.num .v{color:var(--ink)}
footer{margin-top:48px;color:var(--dim);font-size:11px;border-top:1px solid var(--line);padding-top:18px;line-height:1.8}
footer b{color:var(--amber)}
@keyframes grow{from{width:0}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(max-width:640px){.head-total{margin-left:0;text-align:left}.ov-name{width:84px}.ov-val{width:96px}}
</style></head>
<body><div class="wrap">
<header>
  <div><div class="brand"><b>spend</b>watch<span class="tag">coding-agent token &amp; cost report · last ${opts.days}d · since ${sinceStr}</span></div></div>
  <div class="head-total"><div class="big">${fmtUsd(total)}</div><div class="meta">est across ${live.length} agent${live.length === 1 ? "" : "s"} · generated ${esc(genStr)}</div></div>
</header>

<div class="overview"><h2>Spend by agent</h2>${overviewBars || '<div class="ov-row">no data</div>'}</div>

<div class="tabs">${tabs}</div>
${panels}

<footer>
<b>$</b> from real per-request usage fields. Prices/MTok — Fable $10/$50, Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, gpt-5 tier $1.25/$10 (Codex is largely subscription-billed, so its $ is an estimate). Cache: write 1.25×/2×, read 0.1×.<br>
<b>ctx $</b> estimates the cost a call's results impose on the rest of its session (result tokens × cache write + 0.1× reread per later request). <b>deep</b> commands = executable + subcommand / ssh remote — the build-a-CLI shortlist.
</footer>
</div>
<script>
const tabs=[...document.querySelectorAll('.tab')],panels=[...document.querySelectorAll('.panel')];
tabs.forEach(t=>t.addEventListener('click',()=>{
  const k=t.dataset.tab;
  tabs.forEach(x=>x.classList.toggle('active',x===t));
  panels.forEach(p=>p.classList.toggle('active',p.dataset.panel===k));
}));
</script>
</body></html>`;
}

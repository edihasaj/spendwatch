// Renders a standalone, self-contained HTML report from spendwatch reports.
import type { Report, ToolRow, PromptRow } from "./aggregate";
import { fmtTok, fmtUsd } from "./render";
import { mergeReports, reportBreakdowns, sourceLabel, type SpendBreakdown } from "./reports";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

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

// Tool/command table with a click-to-expand drill-down of actual invocations.
function toolTable(rows: ToolRow[], firstHead: string, limit: number): string {
  const r = rows.slice(0, limit);
  const max = Math.max(1, ...r.map((t) => t.ctxCost));
  const body = r
    .map((t, ri) => {
      const pct = Math.round((t.ctxCost / max) * 100);
      const samples = (t.samples ?? []).filter((s) => s.detail && s.detail.trim()).slice(0, 30);
      const has = samples.length > 0;
      const cells =
        `<td class="barcell ${has ? "expand" : ""}"><span class="bar" style="width:${pct}%"></span><span class="v">${has ? '<span class="caret">▸</span>' : ""}${esc(t.name)}</span></td>` +
        `<td class="num"><span class="v">${t.calls}</span></td>` +
        `<td class="num"><span class="v">${fmtTok(t.argTok)}</span></td>` +
        `<td class="num"><span class="v">${fmtTok(t.resultTok)}</span></td>` +
        `<td class="num"><span class="v">${fmtUsd(t.ctxCost)}</span></td>`;
      const main = `<tr class="trow ${has ? "has-drill" : ""}" style="--i:${ri}">${cells}</tr>`;
      if (!has) return main;
      const drillRows = samples
        .map(
          (s) =>
            `<div class="drow"><span class="dcmd">${esc(s.detail.length > 160 ? s.detail.slice(0, 159) + "…" : s.detail)}</span><span class="dn">×${s.count}</span><span class="dt">${fmtTok(s.resultTok)} tok</span></div>`,
        )
        .join("");
      const drill = `<tr class="drill"><td colspan="5"><div class="drillbox"><div class="dhead">top invocations by result tokens — what to automate</div>${drillRows}</div></td></tr>`;
      return main + drill;
    })
    .join("");
  return `<table><thead><tr><th>${esc(firstHead)}</th><th class="num">calls</th><th class="num">arg tok</th><th class="num">result tok</th><th class="num">ctx $</th></tr></thead><tbody>${body}</tbody></table>`;
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

function breakdownTable(rows: SpendBreakdown[], total: number): string {
  return dataTable(
    [{ head: "name", bar: true }, { head: "$", num: true }, { head: "share", num: true }, { head: "calls", num: true }, { head: "sessions", num: true }],
    rows.map((row) => [
      row.label,
      fmtUsd(row.cost),
      total ? `${((row.cost / total) * 100).toFixed(0)}%` : "0%",
      row.calls.toLocaleString(),
      row.sessions.toLocaleString(),
    ]),
    rows.map((row) => row.cost),
  );
}

function agentPanel(r: Report, idx: number): string {
  const stat = (label: string, val: string) => `<div class="stat"><span class="n">${val}</span><span class="l">${esc(label)}</span></div>`;
  const stats = `<div class="stats">${stat("est spend", fmtUsd(r.totalCost))}${stat("API calls", r.apiCalls.toLocaleString())}${stat("sessions", String(r.sessions))}</div>`;
  const parts: string[] = [stats];
  if (r.accounts.length > 1)
    parts.push(
      section(
        "By account",
        `same agent — summed above (${fmtUsd(r.totalCost)})`,
        dataTable(
          [{ head: "account", bar: true }, { head: "$", num: true }, { head: "calls", num: true }, { head: "sessions", num: true }],
          r.accounts.map((x) => [x.account, fmtUsd(x.cost), x.calls.toLocaleString(), String(x.sessions)]),
          r.accounts.map((x) => x.cost),
        ),
      ),
    );
  if (r.targets.length)
    parts.push(
      section(
        "Automate — top targets",
        "cost × frequency × friction — build a CLI/MCP for these",
        dataTable(
          [{ head: "command", bar: true }, { head: "calls", num: true }, { head: "ctx $", num: true }, { head: "err%", num: true }, { head: "why" }],
          r.targets.map((t) => [t.command, t.calls.toLocaleString(), fmtUsd(t.ctxCost), t.errPct >= 0.01 ? `${Math.round(t.errPct * 100)}%` : "·", t.reason]),
          r.targets.map((t) => t.score),
        ),
      ),
    );
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
  const sources = reports.filter((r) => r.apiCalls > 0).sort((a, b) => b.totalCost - a.totalCost);
  const combined = mergeReports(sources);
  const live = sources.length > 1 ? [combined, ...sources] : sources;
  const total = combined.totalCost;
  const since = combined.sinceTs;
  const sinceStr = since && isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "?";
  const genStr = new Date(opts.generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const dimensions = reportBreakdowns(sources);

  const overview = [
    section("By machine", "where the usage happened", breakdownTable(dimensions.machines, total)),
    section("By account", "same identity merged across machines and agents", breakdownTable(dimensions.accounts, total)),
    section("By agent", "same agent merged across machines", breakdownTable(dimensions.agents, total)),
  ].join("");

  const tabs = live.map((r, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${esc(r.source)}">${esc(sourceLabel(r.source))} <em>${fmtUsd(r.totalCost)}</em></button>`).join("");
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
.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:30px}
.overview .block{margin-top:0;min-width:0}
.overview table{height:100%}
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
td.expand{cursor:pointer}
.caret{display:inline-block;color:var(--amber);margin-right:7px;transition:transform .15s;font-size:10px}
tr.has-drill.open .caret{transform:rotate(90deg)}
tr.has-drill:hover td{background:rgba(255,180,84,.06)}
tr.drill{display:none}tr.drill.open{display:table-row}
tr.drill td{padding:0;background:#0b0c10}
.drillbox{padding:10px 14px 12px 30px;border-left:2px solid var(--amber2);margin:0 0 2px}
.dhead{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.drow{display:flex;align-items:baseline;gap:12px;padding:3px 0;border-bottom:1px solid rgba(35,38,47,.5)}
.drow:last-child{border-bottom:none}
.dcmd{flex:1;color:#cfd3da;white-space:pre-wrap;word-break:break-word;font-size:12px}
.dn{color:var(--amber);flex:none;width:64px;text-align:right;font-variant-numeric:tabular-nums}
.dt{color:var(--dim);flex:none;width:90px;text-align:right;font-variant-numeric:tabular-nums}
footer{margin-top:48px;color:var(--dim);font-size:11px;border-top:1px solid var(--line);padding-top:18px;line-height:1.8}
footer b{color:var(--amber)}
@keyframes grow{from{width:0}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(max-width:900px){.overview{grid-template-columns:1fr}}
@media(max-width:640px){.head-total{margin-left:0;text-align:left}}
</style></head>
<body><div class="wrap">
<header>
  <div><div class="brand"><b>spend</b>watch<span class="tag">coding-agent token &amp; cost report · last ${opts.days}d · since ${sinceStr}</span></div></div>
  <div class="head-total"><div class="big">${fmtUsd(total)}</div><div class="meta">est across ${sources.length} machine-agent source${sources.length === 1 ? "" : "s"} · generated ${esc(genStr)}</div></div>
</header>

<div class="overview">${overview}</div>

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
// drill-down: click a tool/command row to reveal its actual invocations
document.querySelectorAll('tr.has-drill').forEach(row=>{
  row.addEventListener('click',()=>{
    const drill=row.nextElementSibling;
    if(drill&&drill.classList.contains('drill')){row.classList.toggle('open');drill.classList.toggle('open');}
  });
});
</script>
</body></html>`;
}

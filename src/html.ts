// Renders a standalone, self-contained HTML report from spendwatch reports.
import type { Report, ToolRow, PromptRow } from "./aggregate";
import { fmtTok, fmtUsd } from "./render";
import {
  mergeReports,
  reportBreakdowns,
  sourceLabel,
  type AccountGrouping,
  type SpendBreakdown,
} from "./reports";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

interface Col {
  head: string;
  num?: boolean;
  bar?: boolean; // draw a heat bar behind this cell
  html?: boolean;
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
          return `<td class="${c.num ? "num" : ""} ${c.bar ? "barcell" : ""}">${bar}<span class="v">${c.html ? cell : esc(cell)}</span></td>`;
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
  return `<section class="block"><h3>${esc(title)}<span class="sub">${esc(sub)}</span></h3><div class="section-body">${body}</div></section>`;
}

function serviceName(source: string): string {
  const split = source.lastIndexOf(":");
  return sourceLabel(split > 0 ? source.slice(split + 1) : source);
}

function accountKey(source: string, account: string, grouping: AccountGrouping): string {
  return grouping === "email" ? account : `${serviceName(source)} · ${account}`;
}

function accountChipNumbers(reports: Report[], grouping: AccountGrouping): Map<string, number> {
  const identities = new Map<string, Set<string>>();
  for (const report of reports) {
    const scope = grouping === "email" ? "all" : serviceName(report.source);
    const accounts = identities.get(scope) ?? new Set<string>();
    for (const account of report.accounts) accounts.add(account.account);
    identities.set(scope, accounts);
  }
  const numbers = new Map<string, number>();
  for (const [scope, accounts] of identities) {
    [...accounts].sort((a, b) => a.localeCompare(b)).forEach((account, index) => {
      const key = grouping === "email" ? account : `${scope} · ${account}`;
      numbers.set(key, index + 1);
    });
  }
  return numbers;
}

function accountIdentity(label: string, number?: number): string {
  const chip = number
    ? `<span class="account-chip" aria-label="Account ${number}">Account ${number}</span>`
    : "";
  return `<span class="account-identity">${chip}<span class="account-name">${esc(label)}</span></span>`;
}

function breakdownTable(
  rows: SpendBreakdown[],
  total: number,
  accountNumbers?: Map<string, number>,
): string {
  const max = Math.max(1, ...rows.map((row) => row.cost));
  return `<div class="break-list">${rows.map((row, index) => {
    const share = total ? (row.cost / total) * 100 : 0;
    const width = (row.cost / max) * 100;
    return `<div class="break-row" style="--i:${index}">
      <div class="break-main"><span class="break-name">${accountNumbers ? accountIdentity(row.label, accountNumbers.get(row.label)) : esc(row.label)}</span><span class="break-value">${fmtUsd(row.cost)} <em>${share.toFixed(0)}%</em></span></div>
      <div class="break-track"><span style="width:${width.toFixed(1)}%"></span></div>
      <div class="break-meta">${row.calls.toLocaleString()} calls · ${row.sessions.toLocaleString()} sessions</div>
    </div>`;
  }).join("")}</div>`;
}

function agentPanel(
  r: Report,
  idx: number,
  accountGrouping: AccountGrouping,
  accountNumbers: Map<string, number>,
  combinedAccountTitle?: string,
): string {
  const stat = (label: string, val: string) => `<div class="stat"><span class="n">${val}</span><span class="l">${esc(label)}</span></div>`;
  const stats = `<div class="stats">${stat("est spend", fmtUsd(r.totalCost))}${stat("API calls", r.apiCalls.toLocaleString())}${stat("sessions", String(r.sessions))}</div>`;
  const parts: string[] = [stats];
  if (r.accounts.length > 1)
    parts.push(
      section(
        combinedAccountTitle ?? "By account",
        combinedAccountTitle
          ? `merged across machines (${fmtUsd(r.totalCost)})`
          : `same service · summed above (${fmtUsd(r.totalCost)})`,
        dataTable(
          [{ head: "account", bar: true, html: true }, { head: "$", num: true }, { head: "calls", num: true }, { head: "sessions", num: true }],
          r.accounts.map((x) => {
            const key = combinedAccountTitle ? x.account : accountKey(r.source, x.account, accountGrouping);
            return [accountIdentity(x.account, accountNumbers.get(key)), fmtUsd(x.cost), x.calls.toLocaleString(), String(x.sessions)];
          }),
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

export function renderHtml(
  reports: Report[],
  opts: { generatedAt: number; days: number; accountGrouping?: AccountGrouping; limitsHref?: string; historyHref?: string },
): string {
  const sources = reports.filter((r) => r.apiCalls > 0).sort((a, b) => b.totalCost - a.totalCost);
  const accountGrouping = opts.accountGrouping ?? "service";
  const accountTitle = accountGrouping === "service" ? "By service & account" : "By account email";
  const combined = mergeReports(sources, "all", accountGrouping);
  const live = sources.length > 1 ? [combined, ...sources] : sources;
  const total = combined.totalCost;
  const since = combined.sinceTs;
  const sinceStr = since && isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "?";
  const genStr = new Date(opts.generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const dimensions = reportBreakdowns(sources, accountGrouping);
  const accountNumbers = accountChipNumbers(sources, accountGrouping);

  const overview = [
    section("By machine", "where the usage happened", breakdownTable(dimensions.machines, total)),
    section(
      accountTitle,
      accountGrouping === "service"
        ? "same service and identity merged across machines"
        : "same email merged across machines and services",
      breakdownTable(dimensions.accounts, total, accountNumbers),
    ),
    section("By agent", "same agent merged across machines", breakdownTable(dimensions.agents, total)),
  ].join("");

  const tabs = live.map((r, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${esc(r.source)}">${esc(sourceLabel(r.source))} <em>${fmtUsd(r.totalCost)}</em></button>`).join("");
  const panels = live
    .map((r, i) => agentPanel(r, i, accountGrouping, accountNumbers, r.source === "all" ? accountTitle : undefined))
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>spendwatch — agent spend report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono:ital@0;1&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0c0f;--panel:#11151a;--panel2:#151a20;--line:#29313a;--ink:#f2f5f7;--dim:#89939d;
  --amber:#68d5dc;--amber2:#2aa7b3;--ember:#f27b70;--green:#75d598;--violet:#8ea9ff;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:"Manrope",sans-serif;font-size:13px;line-height:1.5;
  background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px),radial-gradient(800px 500px at 50% -180px,rgba(104,213,220,.13),transparent 70%);background-size:38px 38px,38px 38px,auto}
.wrap{width:min(1120px,calc(100% - 36px));margin:0 auto;padding:30px 0 80px}
h1,h2,h3{font-family:"Manrope",sans-serif;letter-spacing:-.025em}
.topbar{display:flex;align-items:center;gap:20px;padding-bottom:26px;border-bottom:1px solid var(--line)}
.brand{font-family:"Fragment Mono",monospace;font-size:14px;letter-spacing:-.04em}.brand b{color:var(--amber);font-weight:400}
.nav{display:flex;gap:5px;margin-left:18px;padding:4px;background:#0d1014;border:1px solid #20262d;border-radius:9px}.nav a{padding:7px 11px;border-radius:6px;color:var(--dim);text-decoration:none;font-size:12px;font-weight:600}.nav a.active{color:var(--ink);background:var(--panel2)}
.top-actions{margin-left:auto;display:flex;gap:8px}.button{appearance:none;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:9px 12px;font:600 12px "Manrope",sans-serif;cursor:pointer;text-decoration:none;transition:border-color .15s,transform .15s}.button:hover{border-color:#52606d;transform:translateY(-1px)}.button.primary{border-color:rgba(104,213,220,.5);background:rgba(104,213,220,.09);color:#bdf5f7}
.report-hero{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;padding:44px 0 30px}.eyebrow{margin:0 0 8px;color:var(--amber);font:12px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.12em}.report-hero h1{font-size:clamp(34px,6vw,58px);line-height:.98;letter-spacing:-.055em;margin:0}.report-hero h1 span{color:#75808a}.hero-copy{margin:16px 0 0;color:var(--dim);font-size:14px;max-width:680px}.head-total{text-align:right;padding-bottom:4px}.head-total .big{font:24px "Fragment Mono",monospace;color:var(--amber)}.head-total .meta{color:var(--dim);font:10px "Fragment Mono",monospace;margin-top:6px;max-width:330px}
.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:30px}
.overview .block{margin-top:0;min-width:0}
.break-list{height:calc(100% - 27px);background:linear-gradient(145deg,rgba(21,26,32,.98),rgba(15,19,24,.98));border:1px solid var(--line);border-radius:12px;overflow:hidden}
.break-row{padding:12px 14px;border-bottom:1px solid var(--line);animation:rise .5s both;animation-delay:calc(var(--i)*35ms)}
.break-row:last-child{border-bottom:none}
.break-main{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.break-name{font-weight:500;min-width:0;overflow-wrap:anywhere}
.account-identity{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.account-chip{flex:none;padding:2px 7px;border:1px solid rgba(104,213,220,.32);border-radius:6px;background:rgba(104,213,220,.08);
  color:var(--amber);font:9px "Fragment Mono",monospace;line-height:1.5;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.account-name{min-width:0;overflow-wrap:anywhere}
.break-value{flex:none;font-variant-numeric:tabular-nums}
.break-value em{color:var(--dim);font-style:normal}
.break-track{height:5px;background:#0a0b0e;border-radius:4px;overflow:hidden;margin:8px 0 6px}
.break-track span{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--amber2),var(--amber));animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
.break-meta{color:var(--dim);font-size:10px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.tab{font-family:"Fragment Mono";font-size:12px;color:var(--dim);background:var(--panel);border:1px solid var(--line);
  padding:9px 15px;border-radius:10px;cursor:pointer;transition:.15s}
.tab em{font-style:normal;color:var(--amber);margin-left:5px}
.tab:hover{color:var(--ink);border-color:#33414f}
.tab.active{color:var(--ink);background:var(--panel2);border-color:var(--amber2);box-shadow:0 0 0 1px rgba(240,136,62,.25)}
.panel{display:none}.panel.active{display:block}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px}
.stat{flex:1;min-width:150px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.stat .n{display:block;font-family:"Fragment Mono";font-size:24px;font-weight:400}
.stat .l{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin-top:4px}
.block{margin-top:26px;min-width:0;max-width:100%}
.block h3{font-size:15px;margin:0 0 12px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.block h3 .sub{font-family:"Fragment Mono";font-size:10px;color:var(--dim);font-weight:400;letter-spacing:0}
.section-body{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-family:"Fragment Mono",monospace;font-size:11px}
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
@media(max-width:900px){.overview{grid-template-columns:1fr}.report-hero{grid-template-columns:1fr}.head-total{text-align:left}}
@media(max-width:640px){
  .wrap{width:min(100% - 24px,1120px);padding-top:16px}.topbar{flex-wrap:wrap}.nav{order:3;width:100%;margin:0}.nav a{flex:1;text-align:center}.top-actions{margin-left:auto}.report-hero{padding-top:34px}
  td .account-identity{align-items:flex-start;flex-direction:column;gap:4px;min-width:180px}
}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head>
<body><div class="wrap">
<div class="topbar"><div class="brand"><b>spend</b>watch</div>${opts.limitsHref ? `<nav class="nav"><a href="${esc(opts.limitsHref)}">Capacity</a><a href="${esc(opts.historyHref ?? "history.html")}">History</a><a class="active" href="./spend.html">Spend detail</a></nav>` : ""}<div class="top-actions"><button class="button" id="refresh">Refresh</button>${opts.limitsHref ? `<a class="button primary" href="${esc(opts.limitsHref)}#setup">Add account</a>` : ""}</div></div>
<section class="report-hero"><div><p class="eyebrow">Spend detail</p><h1>Understand where <span>usage goes.</span></h1><p class="hero-copy">Token and API-equivalent cost detail across every machine, account, agent, tool, and project for the last ${opts.days} days.</p></div><div class="head-total"><div class="big">${fmtUsd(total)} estimated</div><div class="meta">${sources.length} machine-agent source${sources.length === 1 ? "" : "s"} · since ${esc(sinceStr)} · generated ${esc(genStr)}</div></div></section>

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
document.querySelector('#refresh').addEventListener('click',()=>location.reload());
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

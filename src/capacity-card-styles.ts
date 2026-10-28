export const CAPACITY_CARD_CSS = `
.accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));align-items:start;gap:10px;margin-top:16px}
.account-card{min-width:0;display:flex;flex-direction:column;padding:12px;border:1px solid var(--line);border-top:2px solid color-mix(in srgb,var(--accent) 55%,var(--line));border-radius:10px;background:var(--card-fill,linear-gradient(145deg,#151a20,#0f1318));animation:enter .25s both;animation-delay:var(--delay)}
.account-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.identity{min-width:0;flex:1}
.provider-label{display:block;margin-bottom:2px;color:var(--accent);font:9px "Fragment Mono",monospace;text-transform:uppercase;letter-spacing:.06em}
.identity h2{margin:0;font-size:13px;line-height:1.3;letter-spacing:-.02em;overflow-wrap:anywhere}
.account-email{display:block;margin-top:3px;color:var(--muted);font:10px/1.4 "Fragment Mono",monospace;overflow-wrap:anywhere}
.account-meta{flex:0 1 auto;max-width:45%;text-align:right}
.account-meta strong{display:block;color:var(--muted);font:10px/1.4 "Fragment Mono",monospace;overflow-wrap:anywhere}
.account-credits{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:7px}
.account-credits:empty{display:none}
.credits{color:var(--accent);font:10px/1.4 "Fragment Mono",monospace;overflow-wrap:anywhere}
.updated{display:block;margin-top:3px;color:var(--muted);font:9px/1.4 "Fragment Mono",monospace}
.limits{display:grid;grid-template-columns:1fr;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.limit-head,.limit-meta,.pace{display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap}
.limit-head span{color:var(--secondary,#b9c1c8);font-size:10px;font-weight:600}
.limit-head strong{font:13px "Fragment Mono",monospace}
.track{position:relative;height:5px;margin:6px 0;background:var(--track-bg,#080a0d);border:1px solid var(--line);border-radius:99px}
.track>i{display:block;max-width:100%;height:100%;background:var(--accent,var(--cyan));border-radius:99px;animation:fill .6s both}
.limit.warn .track>i{background:var(--warn)}.limit.danger .track>i{background:var(--danger)}
.pace-marker{--marker-color:var(--marker-good,#a8ffb9);position:absolute;z-index:2;top:50%;left:var(--pace-position);display:flex;height:9px;gap:2px;transform:translate(-50%,-50%);pointer-events:none}
.pace-marker b{display:block;width:2px;height:100%;border-radius:2px;background:var(--marker-color);box-shadow:0 0 0 1px var(--marker,#020304),0 0 7px var(--marker-color)}
.pace-marker.deficit{--marker-color:var(--marker-danger,#ff776d)}
.limit-meta{color:var(--muted);font:10px/1.4 "Fragment Mono",monospace;justify-content:flex-end}
.limit-meta.split{justify-content:space-between}
.pace{margin-top:3px;color:var(--secondary,#aab3ba);font:10px/1.4 "Fragment Mono",monospace}
.pace strong{color:var(--accent);font-weight:400}
.limit.unreadable .limit-head strong{color:var(--warn);font-size:11px}
.limit.unreadable .pace{color:var(--muted)}
.track.stale>i{background:var(--muted);opacity:.4}
.limit.balance .limit-meta,.copilot-usage .limit-meta,.copilot-pool .limit-meta,.limit.spend .limit-meta{margin-top:4px}
.capacity-plan{margin-top:10px;border-top:1px solid var(--line)}
.capacity-plan>summary{display:flex;align-items:center;gap:8px;min-height:34px;padding-top:4px;cursor:pointer;list-style:none;font:10px "Fragment Mono",monospace}
.capacity-plan>summary::-webkit-details-marker{display:none}
.capacity-plan>summary:after{content:"⌄";color:var(--muted);transition:transform .15s}
.capacity-plan[open]>summary:after{transform:rotate(180deg)}
.capacity-plan>summary:focus-visible{outline:2px solid var(--cyan);outline-offset:2px;border-radius:4px}
.plan-action{color:var(--good)}.action-more .plan-action{color:var(--danger)}
.action-less .plan-action,.action-rebalance .plan-action{color:var(--warn)}
.action-measure .plan-action{color:var(--muted)}
.plan-projection{margin-left:auto;color:var(--muted)}
.plan-body{padding:4px 0 2px;color:var(--muted);font-size:11px;line-height:1.5}
.plan-target{display:flex;flex-wrap:wrap;gap:4px 8px;font:9px/1.5 "Fragment Mono",monospace}
.plan-target strong{color:var(--ink);font-weight:400;margin-left:auto}
.plan-body p{margin:8px 0 0}
@media(max-width:640px){.capacity-plan>summary{min-height:44px}}
`;

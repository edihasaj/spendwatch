// Embedded in every standalone dashboard so no asset server is required.
export const THEME_CONTROL_HTML = `<button type="button" class="theme-toggle" aria-label="Color theme" title="Change color theme">
<svg class="theme-system" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>
<svg class="theme-light" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
<svg class="theme-dark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 13.2A9 9 0 0 1 10.8 3.5a9 9 0 1 0 9.7 9.7Z"/></svg>
</button>`;

export const THEME_HEAD_HTML = `<meta name="color-scheme" content="light dark">
<script>
(()=>{
  const key='spendwatch.theme',root=document.documentElement;
  const media=window.matchMedia('(prefers-color-scheme: dark)');
  const modes=['system','light','dark'];
  const valid=value=>modes.includes(value)?value:'system';
  let preference='system';
  try{preference=valid(localStorage.getItem(key))}catch{}
  function apply(){
    const theme=preference==='system'?(media.matches?'dark':'light'):preference;
    root.dataset.theme=theme;
    root.dataset.themePreference=preference;
    root.style.colorScheme=theme;
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.content=theme==='dark'?'#11151a':'#f4f7f8';
    const next=modes[(modes.indexOf(preference)+1)%modes.length];
    const label='Theme: '+preference+'. Switch to '+next;
    document.querySelectorAll('.theme-toggle').forEach(button=>{button.title=label;button.setAttribute('aria-label',label)});
  }
  apply();
  media.addEventListener('change',apply);
  addEventListener('storage',event=>{if(event.key===key||event.key===null){preference=valid(event.newValue);apply()}});
  document.addEventListener('DOMContentLoaded',()=>{
    apply();
    document.querySelectorAll('.theme-toggle').forEach(button=>button.addEventListener('click',()=>{
      preference=modes[(modes.indexOf(preference)+1)%modes.length];
      try{localStorage.setItem(key,preference)}catch{}
      apply();
    }));
  });
})();
</script>`;

export const THEME_CSS = `
:root[data-theme="light"]{
  --bg:#f4f7f8;--surface:#fff;--panel:#fff;--raised:#eaf0f2;--panel2:#eaf0f2;
  --line:#cbd6dc;--ink:#172c35;--muted:#526873;--dim:#526873;
  --cyan:#087784;--cyan2:#096874;--amber:#087784;--amber2:#096874;
  --good:#237341;--green:#237341;--warn:#895600;--danger:#b33c32;--ember:#b33c32;
  --violet:#5265bd;--session:#087784;--weekly:#a65128;--credits:#5265bd;
  --nav-bg:#e9eff2;--inset:#eaf0f2;--input-bg:#fff;
  --secondary:#354e5b;--subtle:#586e79;--notice:#92502a;
  --track-bg:#dce6eb;--marker:#172c35;--marker-good:#237341;--marker-danger:#b33c32;
  --grid:rgba(35,71,85,.045);--divider:rgba(70,101,115,.18);
  --card-fill:linear-gradient(145deg,#fff,#f8fbfc);
  --control-fill:rgba(244,247,248,.94);
  --accent-text:#086b77;--positive-text:#237341;--measure-text:#5265bd;
}
.theme-toggle{appearance:none;display:grid;place-items:center;flex:none;width:38px;height:38px;border:1px solid var(--line);border-radius:8px;padding:0;background:var(--surface,var(--panel));color:var(--ink);font:600 12px "Manrope",sans-serif;cursor:pointer;color-scheme:inherit}
.theme-toggle:focus-visible{outline:2px solid var(--cyan,var(--amber));outline-offset:3px}
.theme-toggle svg{display:none;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
:root[data-theme-preference="system"] .theme-system,:root[data-theme-preference="light"] .theme-light,:root[data-theme-preference="dark"] .theme-dark{display:block}
.top-actions{align-items:center}.history-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.history-actions .refresh{margin-left:0}
:root[data-theme="light"] :is(.provider-label,.provider,.credits,.pace strong,.setup-label b,.copy,.util-card header span){color:color-mix(in srgb,var(--accent,var(--item-accent,var(--cyan))) 55%,#172c35)}
:root[data-theme="light"] .line{stroke:color-mix(in srgb,var(--tone) 55%,#172c35)}
:root[data-theme="light"] .legend i{background:color-mix(in srgb,var(--tone) 55%,#172c35)}
:root[data-theme="light"] .auth-required a{background:#f2bd64}
@media(max-width:760px){.theme-toggle{width:44px;height:44px}.history-actions{margin:0;gap:6px}}
`;

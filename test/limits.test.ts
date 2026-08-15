import { describe, expect, test } from "bun:test";
import { copilotBusinessCreditsPerSeat, normalizeCodexLimits, predictWindow, renderLimitsHtml, renderLimitsText } from "../src/limits";
import { normalizeSourceHealth } from "../src/capacity-dashboard";
import { recommendAccount } from "../src/capacity-planner";

const sample = [
  {
    account: "work@example.com",
    provider: "codex",
    usage: {
      accountEmail: "work@example.com",
      accountOrganization: "Personal",
      loginMethod: "pro",
      primary: {
        usedPercent: 23,
        resetsAt: "2026-08-09T22:00:00Z",
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 14,
        resetsAt: "2026-08-15T20:29:49Z",
        windowMinutes: 10080,
      },
      updatedAt: "2026-08-09T20:49:38Z",
    },
    devices: ["studio"],
    pace: {
      primary: {
        deltaPercent: -5,
        expectedUsedPercent: 28,
        etaSeconds: 12_000,
        willLastToReset: true,
      },
      secondary: {
        deltaPercent: 3,
        expectedUsedPercent: 11,
        etaSeconds: 7200,
        willLastToReset: false,
      },
    },
  },
  {
    account: "personal@example.com",
    provider: "codex",
    usage: {
      accountEmail: "personal@example.com",
      loginMethod: "plus",
      primary: null,
      secondary: {
        usedPercent: 60,
        resetsAt: "2026-08-14T20:00:00Z",
        windowMinutes: 10080,
      },
      updatedAt: "2026-08-09T20:50:00Z",
    },
  },
];

describe("Codex limits", () => {
  test("normalizes and sorts accounts by weekly headroom", () => {
    const accounts = normalizeCodexLimits(sample);
    expect(accounts.map((account) => account.email)).toEqual([
      "work@example.com",
      "personal@example.com",
    ]);
    expect(accounts[0].plan).toBe("Pro");
    expect(accounts[0].session?.windowMinutes).toBe(300);
    expect(accounts[0].weekly?.usedPercent).toBe(14);
  });

  test("keeps the freshest duplicate account snapshot", () => {
    const accounts = normalizeCodexLimits([
      sample[0],
      {
        ...sample[0],
        usage: {
          ...sample[0].usage,
          secondary: { ...sample[0].usage.secondary, usedPercent: 18 },
          updatedAt: "2026-08-09T20:55:00Z",
        },
        devices: ["macbook"],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].weekly?.usedPercent).toBe(18);
    expect(accounts[0].devices).toEqual(["macbook", "studio"]);
  });

  test("renders only planning limits and clear onboarding", () => {
    const accounts = normalizeCodexLimits(sample);
    const html = renderLimitsHtml(accounts, {
      generatedAt: Date.parse("2026-08-09T21:00:00Z"),
      spendHref: "spend.html",
      historyHref: "history.html",
    });
    expect(html).toContain("5-hour window");
    expect(html).toContain("Weekly window");
    expect(html).toContain("86% left");
    expect(html).toContain("Connect another account");
    expect(html).toContain("spendwatch account add codex --name new-account");
    expect(html).toContain("spendwatch account add codex --name new-account --device-auth");
    expect(html).toContain("spendwatch account add codex --name new-account --api-key-env OPENAI_API_KEY");
    expect(html).toContain("spendwatch account add claude --name new-account");
    expect(html).toContain("spendwatch account add copilot");
    expect(html).toContain("ChatGPT OAuth");
    expect(html).toContain("GitHub OAuth");
    expect(html).toContain(".setup-item{min-width:0");
    expect(html).toContain(".command code{flex:1;min-width:0");
    expect(html).toContain("lokai-router check");
    expect(html).toContain('href="spend.html"');
    expect(html).toContain('href="history.html">History</a>');
    expect(html.indexOf("Spend detail")).toBeLessThan(html.indexOf(">History</a>"));
    expect(html).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(html).toContain("@media(max-width:900px){.accounts,.util-grid{grid-template-columns:1fr}");
    expect(html).toContain("@media(max-width:480px){.topbar{grid-template-columns:1fr}");
    expect(html).toContain("min-height:44px");
    expect(html).toContain('.limit-meta{justify-content:flex-end;color:var(--muted);font:12px/1.35 "Fragment Mono",monospace}');
    expect(html).toContain('.pace{margin-top:6px;color:#aab3ba;font:12px/1.35 "Fragment Mono",monospace}');
    expect(html).toContain('class="pace-marker reserve" style="--pace-left:72%"');
    expect(html).toContain('class="pace-marker deficit" style="--pace-left:89%"');
    expect(html).toContain("--marker-color:#a8ffb9");
    expect(html).toContain("box-shadow:0 0 0 1px #020304,0 0 7px var(--marker-color)");
    expect(html).toContain('aria-label="Expected pace: 89% left, 3% over"');
    expect(html).toContain("3% over pace");
    expect(html).not.toContain("Learned ·");
    expect(html).toContain("data-exhaust=\"2026-08-09T22:49:38.000Z\"");
    expect(html).toContain("studio");
    expect(html).toContain("auto 15s");
    expect((html.match(/<div class="limit-head"><span>5-hour window/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Not active");
    expect(html).not.toContain("No current limit reported");
    expect(html).toContain("14% used");
    expect(html).not.toContain("Comfortable");
    expect(html).not.toContain("Know what you can");
    expect(html).not.toContain("account-number");
    expect(html).toContain("Current capacity");
    expect(html).toContain("2 accounts · 1 service");
    expect(html).toContain("grid-template-columns:repeat(auto-fit,minmax(220px,1fr))");
    expect(html).toContain("data-account-key=");
    expect(html).toContain("patchNode(card,nextCard)");
    expect(html).toContain("['.summary','.planning','.utilization']");
    expect(html).toContain("90% utilization plan");
    expect(html).toContain("Target 90% · buffer 10%");
    expect(html.indexOf('<section class="accounts">')).toBeLessThan(html.indexOf('<section class="utilization">'));
    expect(html).toContain('data-utilization-key="codex:work@example.com"');
    expect(html).toContain("pts / day");
    expect(html).toContain("More capacity");
    expect(html).toContain("setInterval(()=>refreshValues(false),15000)");
    expect(html).toContain("Enable alerts");
    expect(html).toContain("navigator.serviceWorker.register('/sw.js'");
    expect(html).toContain('id="install" hidden>Install app</button>');
    expect(html).toContain("beforeinstallprompt");
    expect(html).toContain("appinstalled");
    expect(html).toContain("subscriptionRequest('/api/push/status',subscription)");
    expect(html).toContain("status.verified){alertButton.hidden=true");
    expect(html).toContain("if(result.testSent)alertButton.hidden=true");
    expect(html).toContain("Send one test alert to verify background delivery");
    expect(html).not.toContain("spendwatch.capacity-alert-state");
    expect(html).toContain("Math.floor(totalMinutes / 1440)");
    expect(html).toContain("compactDuration(abs)");
    expect(html).not.toContain("hours<48");
    expect(html).not.toContain("card.innerHTML=nextCard.innerHTML");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("location.reload()");
    expect(html).not.toContain("token cost");
  });

  test("shows source freshness and recommends the strongest fresh account", () => {
    const now = Date.parse("2026-08-09T20:52:00Z");
    const accounts = normalizeCodexLimits(sample);
    const sources = normalizeSourceHealth([
      { kind: "source-health", device: "studio", status: "live", checkedAt: "2026-08-09T20:52:00Z", lastSuccessAt: "2026-08-09T20:52:00Z" },
      { kind: "source-health", device: "macbook", status: "offline", checkedAt: "2026-08-09T20:52:00Z", lastSuccessAt: "2026-08-09T20:43:00Z" },
    ]);
    const recommendation = recommendAccount(accounts, sources, now);
    expect(recommendation?.account).toBe("work@example.com");
    const html = renderLimitsHtml(accounts, { generatedAt: now, sources });
    expect(html).toContain("Best now");
    expect(html).toContain("Codex · work@example.com");
    expect(html).toContain('class="source live"');
    expect(html).toContain('class="source offline"');
    expect(html).toContain("data-source-status");
  });

  test("shows provider-aware sign-in links only for authentication-required sources", () => {
    const html = renderLimitsHtml(normalizeCodexLimits(sample), {
      generatedAt: Date.parse("2026-08-09T20:52:00Z"),
      authentication: [
        { provider: "codex", device: "studio", profile: "work" },
        { provider: "claude", device: "macbook", account: "claude@example.com", profile: "default" },
        { provider: "copilot", device: "studio", profile: "default" },
      ],
    });
    expect(html).toContain("Authentication required");
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('data-auth-profile="work"');
  });

  test("falls back to live linear pace when a provider has no learned forecast", () => {
    const prediction = predictWindow({
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt: "2026-08-10T05:00:00Z",
    }, Date.parse("2026-08-10T02:00:00Z"));
    expect(prediction?.source).toBe("linear");
    expect(Math.round(prediction?.expectedUsedPercent ?? 0)).toBe(40);
    expect(prediction?.willLastToReset).toBe(true);
  });

  test("keeps a visible green marker when Codex is on pace", () => {
    const html = renderLimitsHtml([{
      provider: "codex",
      email: "steady@example.com",
      plan: "Pro",
      devices: ["studio"],
      weekly: {
        usedPercent: 8,
        resetsAt: "2026-08-17T00:00:00Z",
        windowMinutes: 10080,
        prediction: {
          deltaPercent: 1,
          expectedUsedPercent: 9,
          willLastToReset: true,
          source: "reported",
        },
      },
    }], { generatedAt: Date.parse("2026-08-11T17:00:00Z") });
    expect(html).toContain('class="pace-marker steady" style="--pace-left:91%"');
    expect(html).toContain('aria-label="Expected pace: 91% left, on pace"');
  });

  test("shows Claude pace immediately after a weekly reset", () => {
    const html = renderLimitsHtml([{
      provider: "claude",
      email: "fresh@example.com",
      plan: "Max",
      devices: ["macbook"],
      weekly: {
        usedPercent: 1,
        resetsAt: "2026-08-19T10:00:00Z",
        windowMinutes: 10080,
      },
    }], { generatedAt: Date.parse("2026-08-12T12:00:00Z") });
    expect(html).toContain('class="pace-marker steady"');
    expect(html).toContain('aria-label="Expected pace: 99% left, on pace"');
    expect(html).toContain("Lasts until reset");
  });

  test("calls an exhausted limit ran out instead of running out now", () => {
    const accounts = normalizeCodexLimits({
      provider: "claude",
      account: "claude@example.com",
      usage: {
        accountEmail: "claude@example.com",
        loginMethod: "max",
        primary: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: "2026-08-10T05:00:00Z",
        },
        updatedAt: "2026-08-10T02:00:00Z",
      },
    });
    const html = renderLimitsHtml(accounts, { generatedAt: Date.parse("2026-08-10T02:00:00Z") });
    expect(html).toContain("0% left");
    expect(html).toContain("<strong>Ran out</strong>");
    expect(html).not.toContain("Running out now");
  });

  test("renders a compact terminal summary", () => {
    const text = renderLimitsText(normalizeCodexLimits(sample));
    expect(text).toContain("Codex · work@example.com\t5h 77% left\tweekly 86% left");
    expect(text).toContain("Codex · personal@example.com\t5h not active\tweekly 40% left");
  });

  test("renders Claude, Copilot, and Lokai with provider-specific capacity", () => {
    const accounts = normalizeCodexLimits([
      {
        provider: "claude",
        account: "claude@example.com",
        usage: {
          accountEmail: "claude@example.com",
          loginMethod: "max",
          primary: { usedPercent: 0, windowMinutes: 300 },
          secondary: { usedPercent: 100, windowMinutes: 10080 },
          updatedAt: "2026-08-09T21:00:00Z",
        },
      },
      {
        provider: "copilot",
        account: "dev (Business)",
        usage: { accountEmail: "dev (Business)", loginMethod: "business", updatedAt: "2026-08-09T21:00:00Z" },
        copilot: {
          chatUnlimited: true,
          completionsUnlimited: true,
          premiumUnlimited: true,
          premiumCreditsUsed: 186179,
          overagePermitted: true,
          tokenBasedBilling: true,
          resetsAt: "2026-09-01T00:00:00Z",
          seatAssignedAt: "2026-05-13T12:12:57Z",
        },
      },
      {
        provider: "lokai",
        account: "Kimi K3 Cloud",
        usage: {
          accountEmail: "Kimi K3 Cloud",
          accountOrganization: "kimi-k3:cloud",
          loginMethod: "Moonshot API",
          updatedAt: "2026-08-09T21:00:00Z",
        },
        route: {
          ready: true,
          detail: "LiteLLM · 1M context",
          available: true,
          balances: [{ currency: "USD", total: 7.80625, granted: 2.80625, toppedUp: 5 }],
        },
      },
      {
        provider: "lokai",
        account: "DeepSeek V4 Flash",
        usage: {
          accountEmail: "DeepSeek V4 Flash",
          accountOrganization: "deepseek-v4-flash:cloud",
          loginMethod: "DeepSeek API",
          updatedAt: "2026-08-09T21:00:00Z",
        },
        route: {
          ready: true,
          detail: "LiteLLM · 1M context",
          available: true,
          balances: [{ currency: "USD", total: 4.6, granted: 0, toppedUp: 4.6 }],
        },
      },
    ]);
    const html = renderLimitsHtml(accounts, { generatedAt: Date.parse("2026-08-09T21:00:00Z") });
    expect(html).toContain("Claude");
    expect(html).toContain("0% left");
    expect(html).toContain("Copilot");
    expect(html).toContain("AI credits used");
    expect(html).toContain("186,179");
    expect(html).toContain("$1,861.79 usage value");
    expect(html).toContain("3,000 / seat");
    expect(html).toContain("Shared pool contribution");
    expect(html).toContain("August promotion");
    expect(html).toContain("Paid overflow on");
    expect(html).toContain("Token-based billing");
    expect(html).toContain('data-reset="2026-09-01T00:00:00Z"');
    expect(html).toContain("Lokai");
    expect(html).toContain("Kimi K3 Cloud");
    expect(html).toContain("$7.81 left");
    expect(html).toContain("DeepSeek V4 Flash");
    expect(html).toContain("API balance");
    expect(html).toContain("$4.60 left");
    expect(html).toContain("LiteLLM · 1M context");
    expect(html).not.toContain("Cloud route");
    expect(renderLimitsText(accounts)).toContain("$4.60 left");
    expect(renderLimitsText(accounts)).toContain("3000 credits/seat shared pool");
    expect(html.indexOf("Kimi K3 Cloud")).toBeLessThan(html.indexOf("DeepSeek V4 Flash"));
    expect(html).not.toContain("Ollama Cloud");
    expect(html).not.toContain("Premium interactions");
    expect(html).not.toContain("Unlimited");
    expect(html).not.toContain("5-hour session");
    expect(html).not.toContain("DeepSeek V4 Flash\t5h not active");
  });

  test("uses the standard Business contribution after the existing-customer promotion", () => {
    const account = normalizeCodexLimits({
      provider: "copilot",
      account: "dev (Business)",
      usage: { accountEmail: "dev (Business)", loginMethod: "business" },
      copilot: { premiumCreditsUsed: 10, seatAssignedAt: "2026-05-13T12:12:57Z" },
    })[0];
    expect(copilotBusinessCreditsPerSeat(account, Date.parse("2026-08-31T23:59:59Z"))).toBe(3000);
    expect(copilotBusinessCreditsPerSeat(account, Date.parse("2026-09-01T00:00:00Z"))).toBe(1900);
  });

  test("never calls a reachable API route unlimited when balance is missing", () => {
    const accounts = normalizeCodexLimits({
      provider: "lokai",
      account: "DeepSeek V4 Flash",
      usage: {
        accountEmail: "DeepSeek V4 Flash",
        loginMethod: "DeepSeek API",
        updatedAt: "2026-08-09T21:00:00Z",
      },
      route: { ready: true, detail: "LiteLLM · 1M context" },
    });
    const html = renderLimitsHtml(accounts, { generatedAt: Date.parse("2026-08-09T21:00:00Z") });
    expect(html).toContain("Balance unavailable");
    expect(html).not.toContain("Unlimited");
  });
});

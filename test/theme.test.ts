import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { THEME_HEAD_HTML } from "../src/theme";
import { renderHtml } from "../src/html";
import { renderLimitsHtml } from "../src/limits";
import { renderHistoryHtml } from "../src/history";

function browser(saved: string | null = null, dark = false, blocked = false) {
  const events = new Map<string, (event?: { key: string | null; newValue: string | null }) => void>();
  const attributes = new Map<string, string>();
  const button = { title: "", setAttribute: (name: string, value: string) => attributes.set(name, value), addEventListener: (name: string, fn: () => void) => events.set(name, fn) };
  const root = { dataset: { theme: "", themePreference: "" }, style: { colorScheme: "" } };
  const meta = { content: "" };
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => events.set("media", fn) };
  const storage = new Map(saved === null ? [] : [["spendwatch.theme", saved]]);
  runInNewContext(THEME_HEAD_HTML.match(/<script>([\s\S]*)<\/script>/)![1], {
    window: { matchMedia: () => media },
    localStorage: {
      getItem: (key: string) => { if (blocked) throw Error("blocked"); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw Error("blocked"); storage.set(key, value); },
    },
    document: {
      documentElement: root,
      querySelector: () => meta,
      querySelectorAll: () => [button],
      addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    },
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
  });
  return { events, button, attributes, root, meta, media, storage };
}

describe("dashboard appearance", () => {
  test("resolves system appearance before the body loads and follows changes", () => {
    const page = browser(null, true);
    expect(page.root.dataset.theme).toBe("dark");
    page.media.matches = false;
    page.events.get("media")!();
    expect(page.root.dataset.theme).toBe("light");
    expect(page.root.style.colorScheme).toBe("light");
    expect(page.meta.content).toBe("#f4f7f8");
  });

  test("persists explicit choices, syncs other tabs, and can return to system", () => {
    const page = browser("light", true);
    page.events.get("DOMContentLoaded")!();
    expect(page.root.dataset.themePreference).toBe("light");
    page.events.get("click")!();
    expect(page.storage.get("spendwatch.theme")).toBe("dark");
    expect(page.attributes.get("aria-label")).toBe("Theme: dark. Switch to system");
    page.media.matches = false;
    page.events.get("media")!();
    expect(page.root.dataset.theme).toBe("dark");
    page.events.get("click")!();
    expect(page.root.dataset.themePreference).toBe("system");
    expect(page.root.dataset.theme).toBe("light");
    page.events.get("storage")!({ key: "spendwatch.theme", newValue: "light" });
    expect(page.root.dataset.theme).toBe("light");
    expect(page.root.dataset.themePreference).toBe("light");
    page.events.get("storage")!({ key: null, newValue: null });
    expect(page.root.dataset.themePreference).toBe("system");
    page.media.matches = true;
    page.events.get("media")!();
    expect(page.root.dataset.theme).toBe("dark");
  });

  test("invalid or unavailable storage still allows switching", () => {
    expect(browser("unknown").root.dataset.theme).toBe("light");
    const page = browser(null, false, true);
    page.events.get("DOMContentLoaded")!();
    page.events.get("click")!();
    page.events.get("click")!();
    expect(page.root.dataset.theme).toBe("dark");
  });

  test("all standalone pages embed the theme before content and expose the control", () => {
    const pages = [
      renderHtml([], { generatedAt: 1, days: 30 }),
      renderLimitsHtml([], { generatedAt: 1 }),
      renderHistoryHtml({ generatedAt: 1, sampleCount: 0, series: [] }),
    ];
    for (const html of pages) {
      expect(html).toContain('aria-label="Color theme"');
      expect(html.indexOf(THEME_HEAD_HTML)).toBeLessThan(html.indexOf("<body>"));
      expect(html).toContain(':root[data-theme="light"]');
    }
  });
});

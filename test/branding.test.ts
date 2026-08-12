import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { BRAND_HEAD_HTML, NOTIFICATION_BADGE, NOTIFICATION_ICON } from "../src/branding";
import { SERVICE_WORKER_SOURCE } from "../src/service-worker";

describe("Spendwatch identity", () => {
  test("ships browser, installed-app, and notification icons", () => {
    expect(BRAND_HEAD_HTML).toContain('rel="manifest" href="/manifest.json"');
    expect(BRAND_HEAD_HTML).toContain('rel="apple-touch-icon"');
    expect(SERVICE_WORKER_SOURCE).toContain(`icon:data.icon||'${NOTIFICATION_ICON}'`);
    expect(SERVICE_WORKER_SOURCE).toContain(`badge:data.badge||'${NOTIFICATION_BADGE}'`);
    for (const path of [
      "assets/icons/favicon.ico",
      "assets/icons/favicon-32x32.png",
      "assets/icons/android-icon-192x192.png",
      "assets/icons/apple-icon-180x180.png",
      "assets/icons/manifest.json",
    ]) expect(existsSync(path)).toBe(true);
  });

  test("ships a configurable private-dashboard new-tab extension", () => {
    const manifest = JSON.parse(readFileSync("chrome-extension/manifest.json", "utf8"));
    const page = readFileSync("chrome-extension/newtab.html", "utf8");
    const script = readFileSync("chrome-extension/newtab.js", "utf8");
    const stylesheet = readFileSync("chrome-extension/newtab.css", "utf8");

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe("1.4.0");
    expect(manifest.chrome_url_overrides.newtab).toBe("newtab.html");
    expect(manifest.permissions).toEqual(["bookmarks", "favicon", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(manifest.options_ui.page).toBe("options.html");
    expect(page).toContain("<title>New Tab</title>");
    expect(page).toContain('<link rel="icon" href="chrome-new-tab.svg">');
    expect(readFileSync("chrome-extension/chrome-new-tab.svg", "utf8")).toContain("#bdc1c6");
    expect(page).not.toContain("<a ");
    expect(page).toContain('id="configure"');
    expect(script).toContain("loadDashboardUrl");
    expect(script).toContain("saveDashboardUrl");
    expect(script).toContain("RETRY_INTERVAL_MS");
    expect(script).toContain("CONNECT_TIMEOUT_MS");
    expect(script).toContain("chrome.bookmarks.getTree");
    expect(script).toContain("positionMenu");
    expect(script).toContain('menu.dataset.positioned = "true"');
    expect(script).toContain('addEventListener("pointerenter"');
    expect(script).toContain('empty.textContent = "(empty)"');
    expect(script).toContain("AbortController");
    expect(script).toContain("method: \"HEAD\"");
    expect(stylesheet).toContain("--chrome-toolbar: #3c3c3c");
    expect(stylesheet).toContain("--chrome-menu: #1f1f1f");
    expect(stylesheet).toContain("--chrome-menu-edge: #4c4c4c");
    expect(stylesheet).toContain("--chrome-toolbar-hover: #6c6b6b");
    expect(stylesheet).toContain("flex: 0 0 34px");
    expect(stylesheet).toContain('font: 400 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
    expect(script).toContain('outline.setAttribute("stroke-width", "1.25")');
    expect(stylesheet).toContain("min-width: 220px");
    expect(stylesheet).toContain("max-width: 400px");
    expect(stylesheet).toContain("height: 28px");
    expect(stylesheet).toContain("height: 32px");
    expect(stylesheet).toContain(".bookmark-folder[open] > .bookmark-menu:not([data-positioned])");
    for (const content of [JSON.stringify(manifest), page, script, stylesheet]) {
      expect(content).not.toMatch(/\.ts\.net/);
      expect(content).not.toContain("/Users/");
    }
  });
});

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

  test("ships a private dashboard new-tab extension", () => {
    const manifest = JSON.parse(readFileSync("chrome-extension/manifest.json", "utf8"));
    const page = readFileSync("chrome-extension/newtab.html", "utf8");
    const script = readFileSync("chrome-extension/newtab.js", "utf8");

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.chrome_url_overrides.newtab).toBe("newtab.html");
    expect(manifest.permissions).toEqual(["bookmarks", "favicon"]);
    expect(manifest.host_permissions).toContain(
      "https://basevm-clean-20260724.tail5ea051.ts.net:8899/*",
    );
    expect(page).toContain("<title>New Tab</title>");
    expect(page).toContain('<link rel="icon" href="chrome-new-tab.svg">');
    expect(readFileSync("chrome-extension/chrome-new-tab.svg", "utf8")).toContain("#bdc1c6");
    expect(page).not.toContain("<a ");
    expect(script).toContain("RETRY_INTERVAL_MS");
    expect(script).toContain("CONNECT_TIMEOUT_MS");
    expect(script).toContain("chrome.bookmarks.getTree");
    expect(script).toContain("positionSubmenu");
    expect(script).toContain("AbortController");
    expect(script).toContain("method: \"HEAD\"");
  });
});

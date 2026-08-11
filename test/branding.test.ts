import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
});

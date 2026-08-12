import { describe, expect, test } from "bun:test";
import { dashboardOriginPattern, normalizeDashboardUrl } from "../chrome-extension/dashboard-config.js";

describe("dashboard URL configuration", () => {
  test("normalizes supported dashboard URLs and permission origins", () => {
    expect(normalizeDashboardUrl(" https://spendwatch.example.com:8899/dashboard#capacity "))
      .toBe("https://spendwatch.example.com:8899/dashboard");
    expect(dashboardOriginPattern("http://127.0.0.1:8899/path"))
      .toBe("http://127.0.0.1:8899/*");
  });

  test("rejects unsupported protocols and embedded credentials", () => {
    expect(() => normalizeDashboardUrl("file:///tmp/index.html")).toThrow("HTTPS or HTTP");
    expect(() => normalizeDashboardUrl("https://user:secret@example.com/")).toThrow("cannot contain credentials");
    expect(() => normalizeDashboardUrl(" ")).toThrow("Enter a dashboard URL");
  });
});

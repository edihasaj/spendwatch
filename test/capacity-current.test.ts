import { expect, test } from "bun:test";
import { capacityResultFromAppServer, paceFor } from "../src/capacity-current";

const HOUR = 3_600_000;

test("maps the official Codex rate-limit response to dashboard capacity", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "edihasaj@gmail.com", planType: "pro" },
    {
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: now / 1000 + 4 * 24 * 3600 } },
        codex_bengalfox: {
          primary: { usedPercent: 99, windowDurationMins: 300 },
          secondary: { usedPercent: 0, windowDurationMins: 10080 },
        },
      },
    },
    now,
  );
  expect(result?.account).toBe("edihasaj@gmail.com");
  expect(result?.usage.primary?.usedPercent).toBe(12);
  expect(result?.usage.primary?.windowMinutes).toBe(10080);
  expect(result?.usage.secondary?.usedPercent).toBe(99);
  expect(result?.usage.secondary?.windowMinutes).toBe(300);
  expect(result?.usage.updatedAt).toBe("2026-08-16T10:00:00.000Z");
});

test("keeps a returned five-hour Codex window alongside the weekly window", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const result = capacityResultFromAppServer(
    { type: "chatgpt", email: "edi@example.com", planType: "pro" },
    {
      rateLimitsByLimitId: {
        codex: {
          // Codex currently returns the weekly window as primary. If the
          // five-hour window is enabled, it arrives as secondary.
          primary: { usedPercent: 12, windowDurationMins: 10080 },
          secondary: { usedPercent: 24, windowDurationMins: 300 },
        },
      },
    },
    now,
  );
  expect(result?.usage.primary?.windowMinutes).toBe(10080);
  expect(result?.usage.secondary?.windowMinutes).toBe(300);
  expect(result?.usage.secondary?.usedPercent).toBe(24);
});

test("does not treat API-key auth or missing windows as subscription capacity", () => {
  expect(capacityResultFromAppServer({ type: "apiKey" }, { rateLimits: {} })).toBeUndefined();
  expect(capacityResultFromAppServer(
    { type: "chatgpt", email: "edi@example.com", planType: "pro" },
    { rateLimits: {} },
  )).toBeUndefined();
});

test("halfway through a window, usage at 50% is exactly on pace", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  const pace = paceFor(
    { usedPercent: 50, windowMinutes: 7 * 24 * 60, resetsAt: new Date(now + 84 * HOUR).toISOString() },
    now,
  )!;
  expect(pace.expectedUsedPercent).toBeCloseTo(50, 5);
  expect(pace.deltaPercent).toBeCloseTo(0, 5);
  expect(pace.willLastToReset).toBe(true);
});

test("a reset further away than the window itself is rejected as inconsistent", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  expect(paceFor({ usedPercent: 10, windowMinutes: 60, resetsAt: new Date(now + 5 * HOUR).toISOString() }, now)).toBeNull();
});

test("purchased credits ride along with the rate-limit snapshot", () => {
  const now = Date.parse("2026-08-16T10:00:00Z");
  const read = (credits: unknown) => capacityResultFromAppServer(
    { type: "chatgpt", email: "edihasaj@gmail.com", planType: "pro" },
    { rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 10080 }, credits } } },
    now,
  )?.usage.credits;

  // The balance stays a string so a large purchase never loses precision.
  expect(read({ hasCredits: true, unlimited: false, balance: "2000" })).toEqual({ balance: "2000", unlimited: false });
  expect(read({ hasCredits: false, unlimited: true, balance: "0" })).toEqual({ balance: "0", unlimited: true });
  // An empty balance is not worth a card of its own.
  expect(read({ hasCredits: false, unlimited: false, balance: "0" })).toBeNull();
  expect(read(undefined)).toBeNull();
});

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COVERAGE_GUARD_REASON, guardStoredStatus, loadCaptureGuards, sha256Hex,
  type CaptureGuard,
} from "../src/report-coverage";
import { tempDir } from "./tmp";

const json = JSON.stringify({ source: "studio:codex", totalTokens: 100 });
const guard: CaptureGuard = {
  source: "studio:codex", month: "2026-08", installationId: "old-installation",
  timeZone: null, baselineSha256: sha256Hex(json), reason: COVERAGE_GUARD_REASON,
};

test("explicit null pins only a baseline with no recorded timezone, without changing its bytes", () => {
  const stored = { reportJson: json, installationId: "old-installation" };
  expect(guardStoredStatus(guard, stored)).toBe("match");
  expect(stored.reportJson).toBe(json);
  expect(() => guardStoredStatus(guard, { ...stored, timeZone: "UTC" })).toThrow();
  expect(() => guardStoredStatus(guard, { ...stored, timeZone: null as any })).toThrow();
  expect(() => guardStoredStatus({ ...guard, timeZone: "UTC" }, stored)).toThrow();
  expect(() => guardStoredStatus(guard, { ...stored, reportJson: json + " " })).toThrow();
});

test("guard JSON requires an explicit null or a valid timezone string; omission stays invalid", () => {
  const path = join(tempDir("legacy-guard-zone-"), "guards.json");
  const read = (entry: object) => {
    writeFileSync(path, JSON.stringify({ version: 1, guards: [entry] }));
    return loadCaptureGuards({ SPENDWATCH_CAPTURE_GUARDS: path })!;
  };
  expect(read(guard)[0]?.timeZone).toBeNull();
  expect(read({ ...guard, timeZone: "UTC" })[0]?.timeZone).toBe("UTC");
  const { timeZone: _, ...missing } = guard;
  expect(() => read(missing)).toThrow();
  for (const timeZone of ["", false, 0, [], {}]) expect(() => read({ ...guard, timeZone })).toThrow();
});

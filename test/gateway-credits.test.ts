import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRows } from "../src/gateway-ledger-files";
import { copilot, NOW } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// The credit figure of a row is read as it is only when the gateway could have written it. This reads the ledger file
// itself: the report prices an out-of-range figure as unpriced too, so a report alone would not show the reader's guard.
const credits = (nanoAiu: unknown): number | null => {
  const path = join(tempDir("spendwatch-credits-"), "usage-2026-10.jsonl");
  writeFileSync(path, JSON.stringify({ v: 1, host: "studio", ...copilot({ at: NOW, nanoAiu }) }) + "\n");
  const { rows } = readRows(path, {});
  expect(rows).toHaveLength(1);
  return rows[0]!.nanoAiu;
};

test("a credit figure that is a whole or fractional number from 0 up to what a double counts exactly is kept", () => {
  expect([credits(0), credits(250_000_000), credits(0.5), credits(Number.MAX_SAFE_INTEGER)]).toEqual([0, 250_000_000, 0.5, Number.MAX_SAFE_INTEGER]);
});

test("a figure that is negative, past what a double counts exactly, or not a number leaves the row with none", () => {
  expect([credits(-1), credits(-0.5), credits(Number.MAX_SAFE_INTEGER + 2), credits(1e300), credits("250000000"), credits(null), credits(undefined), credits(true)])
    .toEqual([null, null, null, null, null, null, null, null]);
});

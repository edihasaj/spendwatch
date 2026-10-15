import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_WINDOW_MS, GatewayIndex } from "../src/gateway";
import { readRows } from "../src/gateway-ledger-files";
import { apiEvents, copilot, load, NOW, stateDir, telemetry } from "./ledger-fixtures";

// Guards the ledger documents, each pinned from both sides: a change that loosens or drops one must fail a test.

describe("the claim window", () => {
  // A telemetry row only counts once a transcript line with the same model and tokens claims it, "within 30 seconds".
  const claimedAt = (offsetMs: number): boolean => load([telemetry({ session: true, at: NOW + offsetMs })]).claim("gpt-5.1-codex", 1000, 50, NOW);

  test("takes a row up to 30 seconds after the transcript line, the side ledger rows land on", () => {
    expect(claimedAt(1000)).toBe(true);
    expect(claimedAt(29_000)).toBe(true);
    expect(claimedAt(CLAIM_WINDOW_MS)).toBe(true);
  });

  test("leaves a row 31 seconds after the transcript line unclaimed", () => {
    expect(claimedAt(CLAIM_WINDOW_MS + 1000)).toBe(false);
    expect(claimedAt(10 * CLAIM_WINDOW_MS)).toBe(false);
  });

  test("takes a row up to 30 seconds before the transcript line, and not one 31 seconds before", () => {
    expect(claimedAt(-29_000)).toBe(true);
    expect(claimedAt(-CLAIM_WINDOW_MS)).toBe(true);
    expect(claimedAt(-(CLAIM_WINDOW_MS + 1000))).toBe(false);
  });

  test("applies to the ledger's billed rows a token_count may take, on both sides as well", () => {
    const billed = (offsetMs: number) => load([copilot({ at: NOW + offsetMs })]).claim("gpt-5.1-codex", 1000, 50, NOW, { gatewayRows: true });
    expect([billed(29_000), billed(31_000), billed(-29_000), billed(-31_000)]).toEqual([true, false, true, false]);
  });
});

describe("a ledger line the gateway is still appending", () => {
  const request = (id: string, at: number) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });
  const open = () => {
    const dir = stateDir([request("g1", NOW - 10_000)]);
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    ledger.files("copilot");
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    const ids = () => apiEvents(ledger, "copilot").map((e) => e.gateway?.id);
    return { ledger, file, ids };
  };
  const text = (id: string, at: number) => JSON.stringify({ v: 1, host: "studio", ...request(id, at) });

  test("is read again next time, whole, and bills once", () => {
    const { ledger, file, ids } = open();
    const full = text("g2", NOW - 5000);
    appendFileSync(file, full.slice(0, 60));
    ledger.refresh();
    expect(ids()).toEqual(["g1"]);
    appendFileSync(file, full.slice(60) + "\n");
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2"]);
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2"]);
  });

  test("does not hold back the whole lines before it", () => {
    const { ledger, file, ids } = open();
    const torn = text("g3", NOW - 4000);
    appendFileSync(file, text("g2", NOW - 5000) + "\n" + torn.slice(0, 40));
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2"]);
    appendFileSync(file, torn.slice(40) + "\n");
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2", "g3"]);
  });

  test("starts the next read right after the last complete line", () => {
    const { file } = open();
    appendFileSync(file, text("g2", NOW - 5000) + "\n" + text("g3", NOW - 4000).slice(0, 30));
    const { rows, end } = readRows(file, {});
    // Two whole lines (g1 and g2) and a torn third: the read ends where the torn one begins.
    expect(rows).toHaveLength(2);
    const body = readFileSync(file, "utf8");
    expect(end).toBe(Buffer.byteLength(body.slice(0, body.lastIndexOf("\n") + 1)));
  });
});

describe("a row the ledger already holds", () => {
  const request = (id: string, at: number) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });
  const row = (id: string, at: number) => JSON.stringify({ v: 1, host: "studio", ...request(id, at) }) + "\n";
  const open = (...rows: Array<[string, number]>) => {
    const dir = stateDir(rows.map(([id, at]) => request(id, at)));
    const ledger = GatewayIndex.load({ sinceMs: NOW - 86_400_000, stateDir: dir });
    ledger.files("copilot");
    const file = join(dir, "usage", readdirSync(join(dir, "usage"))[0]!);
    return { ledger, file, ids: () => apiEvents(ledger, "copilot").map((e) => e.gateway?.id) };
  };

  test("is not added again when a refresh reads the file from the top", () => {
    const { ledger, file, ids } = open(["g1", NOW - 10_000], ["g2", NOW - 9000]);
    // The gateway pruned and rewrote its month file: shorter than what was read, so the next read starts over.
    writeFileSync(file, row("g1", NOW - 10_000));
    ledger.refresh();
    appendFileSync(file, row("g3", NOW - 8000));
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2", "g3"]);
  });

  test("is not added twice when one refresh reads the same call on two lines", () => {
    const { ledger, file, ids } = open(["g1", NOW - 10_000]);
    appendFileSync(file, row("g2", NOW - 5000) + row("g2", NOW - 5000));
    ledger.refresh();
    expect(ids()).toEqual(["g1", "g2"]);
  });
});

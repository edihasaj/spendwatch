import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, reportsByPeriod } from "../src/build";
import { newCodexCtx, parseCodexLine, settleRouted } from "../src/codex";
import { settleAcrossMacs } from "../src/gateway-settle";
import { rollingDays } from "../src/periods";
import { primaryPeriod } from "../src/report-window";
import { copilotRow, iso, routedLine } from "./fuzz-world";
import { apiEvents, copilot, openLedger, telemetry } from "./ledger-fixtures";
import { tempDir } from "./tmp";

// What the README says no ledger can tell apart without an id on the call. These tests state it as it is, so that a
// change which fixes one of them has to change the README with it.
afterEach(() => { setSystemTime(); delete process.env.SPENDWATCH_CONFIG; });

const MODEL = "gpt-5.1-codex";

// The time of the test, taken when it starts: a call is newer than a ledger read only if both are about now.
let NOW = Date.now();
beforeEach(() => { NOW = Date.now(); });
const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 };
const meta = () => JSON.stringify({ timestamp: iso(NOW - 60_000), type: "session_meta", payload: { id: "s", model_provider: "subscription_gateway", model: MODEL } });
const countLine = (at: number, total: number) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { input_tokens: total, output_tokens: 50 } } } });
const recordLine = (id: string, at: number) => JSON.stringify({ timestamp: iso(at), type: "token_usage_record", payload: { response_id: `resp_gl_${id}`, usage } });
const billed = (id: string, at = NOW) => copilot({ requestId: id, responseId: `resp_gl_${id}`, at });

describe("a token_count whose own row is not in this Mac's ledger", () => {
  test("stands on the row of an alike call whose record has not been read, which is short by one until it is", () => {
    const { ledger } = openLedger([billed("x")]);
    const ctx = newCodexCtx(ledger);
    const codexBills = () => [...settleRouted(ctx, true)].filter((event) => event.t === "api").length;
    // Two calls were made; the count is another Mac's, the row is the record's. Only the count has been read.
    for (const text of [meta(), countLine(NOW + 1_000, 1000)]) [...parseCodexLine(text, ctx)];
    expect([codexBills(), apiEvents(ledger, "copilot").length]).toEqual([0, 1]);
    // The record is read, finds its row taken, and is billed as the plain call it is.
    const rest = [...parseCodexLine(recordLine("x", NOW), ctx), ...settleRouted(ctx, true)].filter((event) => event.t === "api");
    expect([rest.length, apiEvents(ledger, "copilot").length]).toEqual([1, 1]);
  });

  test("is billed twice when another Mac in the set served it: its client counts it, and the serving ledger bills its row", () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const mac = (name: string, lines: string, rows: string) => {
      const root = tempDir(`spendwatch-limits-${name}-`);
      const sessions = join(root, "codex", "sessions");
      const state = join(root, "state");
      mkdirSync(sessions, { recursive: true });
      mkdirSync(join(state, "usage"), { recursive: true });
      writeFileSync(join(state, "usage", `usage-${iso(start).slice(0, 7)}.jsonl`), rows);
      writeFileSync(join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), lines);
      writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "none.db") }, { agent: "gateway", path: state }]));
      return join(root, "config.json");
    };
    const head = JSON.stringify({ timestamp: iso(start - 90_000), type: "session_meta", payload: { id: "c", model_provider: "subscription_gateway" } }) + "\n"
      + JSON.stringify({ timestamp: iso(start - 90_000), type: "turn_context", payload: { model: "copilot/gpt" } }) + "\n";
    // Mac A served the call and holds its row; Mac B ran the client, which wrote only a token_count, and holds none.
    const server = mac("server", head, copilotRow("served", start - 10_000, 100));
    const client = mac("client", head + routedLine("counts", "n/a", start - 10_200, 100, 100) + "\n", copilotRow("other", start - 600_000, 7));
    const period = rollingDays(start, 1);
    const reports = [server, client].flatMap((config) => {
      process.env.SPENDWATCH_CONFIG = config;
      return reportsByPeriod(build({ top: 5 }, [period]), { top: 5 }).get(primaryPeriod([period]).key) ?? [];
    });
    const counts = settleAcrossMacs(reports).filter((report) => report.apiCalls).map((report) => [report.source, report.apiCalls]);
    // One call was made. The server's ledger bills it, the client's rollout bills it again, and the client's older row is its own.
    expect(counts.sort()).toEqual([["codex", 1], ["copilot", 1], ["copilot", 1]]);
  });
});

describe("a new ledger's history import", () => {
  // The import writes a telemetry row for each earlier request. A token_count whose own row is written a moment later
  // can stand on one before that, in a read that spans the moment.

  test("lets a token_count bill its call by an imported row and by its own row, in the one read that spans the row", () => {
    const { ledger, append } = openLedger([telemetry({ requestId: "history", at: NOW - 5_000, session: true })]);
    expect(ledger.claim(MODEL, 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    append(billed("own", NOW + 200));
    ledger.refresh();
    expect(apiEvents(ledger, "copilot").map((event) => event.requestId).sort()).toEqual(["studio:history", "studio:own"]);
  });

  test("bills it once in the next read, which finds its own row", () => {
    const { ledger } = openLedger([telemetry({ requestId: "history", at: NOW - 5_000, session: true }), billed("own", NOW + 200)]);
    expect(ledger.claim(MODEL, 1000, 50, NOW, { gatewayRows: true })).toBe(true);
    expect(apiEvents(ledger, "copilot").map((event) => event.requestId)).toEqual(["studio:own"]);
  });
});

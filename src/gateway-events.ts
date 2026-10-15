// What a gateway ledger row bills, and the events that bill it: the part of the ledger that turns rows into report
// events, kept apart from the index that decides which rows count (gateway.ts).
import type { Event } from "./parse";
import type { GatewayVendor } from "./gateway-config";
import { callKey, GATEWAY_ORIGIN, MARKER, TELEMETRY_ORIGIN, type LedgerRow } from "./gateway-ledger-files";

/** A gateway-origin row the gateway marked: the record that carries the charge. */
export const billedRow = (row: LedgerRow): boolean => row.origin === GATEWAY_ORIGIN && row.responseId.startsWith(MARKER);

/** Rows the ledger is responsible for billing; see the module header. */
export function counts(row: LedgerRow): boolean {
  if (row.rolloutBilled) return false;
  if (row.origin === GATEWAY_ORIGIN) return billedRow(row);
  return row.claimed || row.session === false;
}

export function* eventsFor(vendor: GatewayVendor, account: string, rows: LedgerRow[]): Generator<Event> {
  const sessionId = account ? `gateway-${vendor}:${account}` : `gateway-${vendor}`;
  yield { t: "meta", sessionId, project: "gateway", ts: 0 };
  for (const row of rows) {
    if (!counts(row)) continue;
    const { model, costUsd } = price(vendor, row);
    const requestId = callKey(row);
    // The archive keeps how many calls a report took over from the rollouts; see `routedCalls`.
    yield { t: "routed", sessionId, id: requestId, ts: row.at };
    // A client Mac's Codex report may hold this call too, when this Mac's gateway served it (gateway-settle.ts).
    const gateway = billedRow(row) ? { gateway: { id: row.responseId.slice(MARKER.length), role: "billed" as const } } : {};
    yield {
      t: "api",
      sessionId,
      requestId,
      model,
      usage: {
        input: Math.max(0, row.input - row.cached - row.cacheWrite),
        output: row.output,
        cacheRead: row.cached,
        cache5m: row.cacheWrite,
        cache1h: 0,
      },
      costUsd,
      sidechain: false,
      ts: row.at,
      ...gateway,
    };
  }
}

// Copilot reports what a call actually cost in AI credits, so that figure wins
// and the model keeps its plain alias. Where credits ran short or never arrived,
// the row is labelled as what it is instead of priced from a token table. A
// telemetry-origin row is priced the same way when it carries credits (the gateway
// copies them in its one-time import) and says it came from telemetry.
// Claude rows carry no credit figure at all, so the alias is priced from tokens.
function price(vendor: GatewayVendor, row: LedgerRow): { model: string; costUsd?: number } {
  const alias = row.model;
  const telemetry = row.origin === TELEMETRY_ORIGIN;
  if (vendor !== "copilot") return { model: telemetry ? `${alias} (telemetry backfill)` : alias };
  const credits = row.nanoAiu !== null && row.nanoAiu >= 0 ? row.nanoAiu / 1e11 : undefined;
  const tags = [
    ...(telemetry ? ["telemetry backfill"] : []),
    ...(credits === undefined ? ["unpriced"] : row.nanoAiuStatus === "partial" ? ["partial credits"] : []),
  ];
  return { model: tags.length ? `${alias} (${tags.join(", ")})` : alias, costUsd: credits ?? 0 };
}

// Which ledger row a rollout call stands on. A call is matched to a row by model, tokens and time alone, so several
// alike rows and calls are interchangeable, and the first call to ask would take a row another call needs. A call that
// finds every alike row taken therefore asks the calls standing on them to move to another free alike row, as far as
// that chain goes, so no call is left without a row while a rearrangement would give it one: otherwise its row bills
// a call and its rollout bills the call again.
import { callKey, type LedgerRow, type RowHolder } from "./gateway-ledger-files";

const occupied = (row: LedgerRow): boolean => row.claimed || row.rolloutBilled;

/** The rows one search looks at before it gives up: alike rows are a handful, so only a pathological ledger gets here. */
const SEARCH_LIMIT = 100;

/** Puts `holder` on `row`, which must be free. */
function stand(row: LedgerRow, holder: RowHolder): void {
  if (holder.kind === "claim") row.claimed = true;
  else row.rolloutBilled = true;
  row.holder = holder;
  holder.moved?.(callKey(row));
}

function leave(row: LedgerRow): void {
  row.claimed = false;
  row.rolloutBilled = false;
  row.holder = undefined;
}

/**
 * Puts `holder` on a row among its candidates (`candidatesOf`, nearest first): the nearest free one, else one a
 * holder there can leave. False when no arrangement gives it a row. A row taken with no holder (a call billed by its
 * response id) stays where it is.
 */
export function place(holder: RowHolder, candidatesOf: (holder: RowHolder) => LedgerRow[]): boolean {
  return seek(holder, candidatesOf, new Set());
}

/** Puts a holder that had a row before on it again, when the row is free. */
export function stayOn(row: LedgerRow, holder: RowHolder): boolean {
  if (occupied(row)) return false;
  stand(row, holder);
  return true;
}

function seek(holder: RowHolder, candidatesOf: (holder: RowHolder) => LedgerRow[], tried: Set<LedgerRow>): boolean {
  if (tried.size >= SEARCH_LIMIT) return false;
  const rows = candidatesOf(holder).filter((row) => !tried.has(row));
  const free = rows.find((row) => !occupied(row));
  if (free) {
    stand(free, holder);
    return true;
  }
  for (const row of rows) {
    const other = row.holder;
    if (!other || tried.has(row)) continue;
    tried.add(row);
    leave(row);
    if (seek(other, candidatesOf, tried)) {
      stand(row, holder);
      return true;
    }
    stand(row, other);
  }
  return false;
}

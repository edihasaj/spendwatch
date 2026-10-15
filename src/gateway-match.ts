// Which ledger row a rollout call stands on. A call is matched to a row by model, tokens and time alone, so several
// alike rows and calls are interchangeable, and the first call to ask would take a row another call needs. A call that
// finds every alike row taken therefore asks the calls standing on them to move to another free alike row, as far as
// that chain goes, so no call is left without a row while a rearrangement would give it one: otherwise its row bills
// a call and its rollout bills the call again.
//
// The search is the augmenting-path search of bipartite matching: each row is looked at once per search, so it ends,
// and it is exhaustive, so a call is left without a row only when no rearrangement gives it one. It keeps its own
// stack rather than recursing, because a chain of alike calls can be as long as the run. A search that fails has
// looked at every row reachable from the call, and none of them leads to a free row; the matcher keeps those rows
// until the ledger gains a row, so the next call that finds no row does not walk the same chain again.
import { callKey, type LedgerRow, type RowHolder } from "./gateway-ledger-files";

const occupied = (row: LedgerRow): boolean => row.claimed || row.rolloutBilled;

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
 * Puts holders on rows, and remembers what its failed searches found: the rows from which no free row can be reached
 * stay known as `dead` until the ledger gains a row (`rowsChanged`), so a call that finds no row does not walk the
 * same chain again.
 */
export class RowMatcher {
  private readonly dead = new Set<LedgerRow>();

  /**
   * Puts `holder` on a row among its candidates (`candidatesOf`, nearest first): the nearest free one, else one a
   * holder there can leave. False when no arrangement gives it a row, and then every row is as it was. A row taken
   * with no holder stays where it is.
   */
  place(holder: RowHolder, candidatesOf: (holder: RowHolder) => LedgerRow[]): boolean {
    return seek(holder, candidatesOf, this.dead);
  }

  /** The ledger gained or swapped a row: a row that led nowhere may lead to it. */
  rowsChanged(): void {
    this.dead.clear();
  }
}

/** Puts a holder that had a row before on it again, when the row is free. */
export function stayOn(row: LedgerRow, holder: RowHolder): boolean {
  if (occupied(row)) return false;
  stand(row, holder);
  return true;
}

/** A holder looking for a row, and the row it asked the holder there to vacate. */
interface Step {
  holder: RowHolder;
  rows: LedgerRow[];
  next: number;
  /** The row being vacated for `holder`, with how it was held: a fork's row is both claimed and billed by a rollout. */
  vacated?: { row: LedgerRow; claimed: boolean; rolloutBilled: boolean; holder: RowHolder };
}

function seek(first: RowHolder, candidatesOf: (holder: RowHolder) => LedgerRow[], dead: Set<LedgerRow>): boolean {
  const tried = new Set<LedgerRow>();
  const path: Step[] = [];
  /** True when `holder` found a free row and stands on it; otherwise it joins the path to try the rows it could vacate. */
  const open = (holder: RowHolder): boolean => {
    const rows = candidatesOf(holder).filter((row) => !tried.has(row) && !dead.has(row));
    const free = rows.find((row) => !occupied(row));
    if (free) {
      stand(free, holder);
      return true;
    }
    path.push({ holder, rows, next: 0 });
    return false;
  };
  if (open(first)) return true;
  while (path.length) {
    const step = path[path.length - 1]!;
    // The holder just above gave up: its row goes back exactly as it was, for the next row of this step to try.
    if (step.vacated) {
      const { row, claimed, rolloutBilled, holder } = step.vacated;
      row.claimed = claimed;
      row.rolloutBilled = rolloutBilled;
      row.holder = holder;
    }
    let advanced = false;
    while (step.next < step.rows.length) {
      const row = step.rows[step.next++]!;
      const other = row.holder;
      if (!other || tried.has(row)) continue;
      tried.add(row);
      step.vacated = { row, claimed: row.claimed, rolloutBilled: row.rolloutBilled, holder: other };
      leave(row);
      if (open(other)) {
        // `other` stands on a free row: every holder on the path takes the row it asked the next one to vacate.
        for (const step of path) stand(step.vacated!.row, step.holder);
        return true;
      }
      advanced = true;
      break;
    }
    if (!advanced) path.pop();
  }
  for (const row of tried) dead.add(row);
  return false;
}

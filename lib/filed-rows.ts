import type { Item } from './planner-types';

/**
 * filed-rows — the slot planner-store tells about the rows each bulk add
 * (addTasksBulk) filed, with the account it filed them under.
 *
 * lib/held-captures.ts installs the one listener there is: until the account's
 * data has landed (over a failed load, or while a load or its Retry is in
 * flight) it keeps those rows until a landing confirms them or files them
 * again, as it keeps a quick capture. A pasted list is typed text with no other
 * copy, the same as a capture.
 *
 * A module of its own so neither side imports the other: held-captures already
 * imports the store, and a unit test that mocks the store still loads this.
 */
type BulkFiledListener = (userId: string, rows: readonly Item[]) => void;

let listener: BulkFiledListener | null = null;

export function setBulkFiledListener(fn: BulkFiledListener | null): void {
  listener = fn;
}

/** Never throws into the add that filed the rows: the rows are already on screen and written. */
export function reportBulkFiled(userId: string, rows: readonly Item[]): void {
  if (rows.length === 0) return;
  try {
    listener?.(userId, rows);
  } catch (err) {
    console.error('[filed-rows] a listener failed', err);
  }
}

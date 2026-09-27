/**
 * sweep-grace — the resume grace for suppressions that leave no trace.
 *
 * Plan decision 9 says the auto-age sweep must be pause-aware in BOTH
 * directions: suppressed items are excluded while they are hidden, AND they get
 * the trailing window to be dealt with once they come back. Excluding alone
 * only defers the mass-unschedule, because `daysOverdue` counts from startDate
 * and a suppression never moves it — so age accrues through the whole hidden
 * period and everything resurfaces already past the line.
 *
 * Most of the grace is answerable from stored data, and where it is, it stays
 * there: `pausedUntil` records an item's or a routine's resume, and a season's
 * `startsOn` / `updatedAt` cover its range opening and its manual flips. Those
 * arms are strictly better than this module, because a row travels — resume on
 * your phone and the laptop's sweep still sees it tomorrow.
 *
 * This module exists for the causes that leave NO row behind:
 *
 *   - Deleting a container that was suppressing its members. The container
 *     leaves the store's array entirely (soft-deleted rows are filtered out of
 *     resolution by design), so there is nothing left to read a resume date
 *     from — and its members reappear carrying every day of accrued age.
 *   - Removing an item from a container that was suppressing it. The join row
 *     is gone; the same problem, one row smaller.
 *   - Pulling a routine out of the season that was holding it off.
 *
 * All three are ordinary tidying gestures, and all three currently end with the
 * item visible, ancient, and one overnight sweep away from being unscheduled.
 *
 * DEVICE-LOCAL, and that is a real limitation rather than a shrug: delete a
 * routine on your phone and your laptop's sweep will not know. It is the same
 * trade the sweep's own once-per-day stamp already makes
 * (`morningAutoAgeLastRunByUser`), for the same reason — this is a "do not
 * bother the user about these yet" flag, not account state. Closing the gap
 * properly means a column on `items`, which decision 8 forbids container
 * operations from writing.
 *
 * Written as plain functions over localStorage rather than a zustand store:
 * nothing renders from it, `lib/morning-store.ts` (its natural neighbour)
 * already imports planner-store so putting it there would make a cycle, and the
 * one reader is inside an effect that is deliberately not reactive.
 */

import { daysOverdue, toDateOnly } from './overdue';

const KEY = 'dsul-sweep-grace';

/**
 * The largest `morningAutoAgeDays` the settings UI offers. Entries older than
 * this can never grace anything again, so they are dropped on the next write —
 * which keeps the map at roughly "containers you edited this quarter" instead
 * of growing for the lifetime of the browser profile.
 */
const MAX_WINDOW_DAYS = 90;

type ReleaseMap = Record<string, string>;

function read(): ReleaseMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ReleaseMap) : {};
  } catch {
    // A corrupt or unreadable entry must not take the app down, and losing the
    // grace fails in the direction of sweeping — visible, undoable, not silent.
    return {};
  }
}

/**
 * Record that these items stopped being suppressed on `dateStr`.
 *
 * Called with the items whose suppression a container edit actually ENDED, not
 * with every member — granting grace to work that was never hidden would quietly
 * switch the sweep off for it.
 */
export function recordReleased(itemIds: readonly string[], dateStr: string): void {
  if (typeof window === 'undefined' || itemIds.length === 0) return;
  const next: ReleaseMap = {};
  for (const [id, when] of Object.entries(read())) {
    if (daysOverdue({ startDate: toDateOnly(when) }, dateStr) <= MAX_WINDOW_DAYS) next[id] = when;
  }
  for (const id of itemIds) next[id] = dateStr;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or a disabled store. Same fail direction as above.
  }
}

/** The day this item's suppression ended, if this device saw it happen. */
export function releasedOn(itemId: string): string | undefined {
  return read()[itemId];
}

/**
 * Drop the whole map.
 *
 * Two callers. The suite, which has no localStorage isolation between cases;
 * and the sign-out / account-switch clear (lib/local-state.ts), because the
 * entries are keyed by ITEM ID — one account's row ids, sitting under a
 * browser-global key where the next account can read them, and where a
 * (vanishingly unlikely) id collision would hand them a grace they never
 * earned. Losing the map costs at most one early unschedule, which is visible
 * and undoable; that is the same fail direction the reads above already take.
 */
export function clearReleased(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

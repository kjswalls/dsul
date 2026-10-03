import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { selectPlannerLoaded } from './planner-ready';

/**
 * held-captures — a quick capture typed before the planner has loaded, kept
 * until it can land.
 *
 * Quick capture (the braindump's QuickAddRow, the omnibar's `+`) is the one
 * write a person makes without looking at a row first, so it is the one most
 * likely to be typed while the planner is still loading or only previewing. A
 * write there is refused during the look-only preview, and on a plain cold load
 * it used to be added optimistically and then erased from view by the landing
 * set(). Neither is acceptable for text somebody typed. So a capture that
 * cannot land yet waits here and is added the moment fresh data does.
 *
 * Held per ACCOUNT. An entry is bound to the userId it was typed under and is
 * dropped the moment the store answers for anyone else, sign-out (null)
 * included: text typed into one account must never be filed into another.
 *
 * A module, not component state, so it outlives the field it was typed into:
 * the launcher closes on Enter, and the phone remounts the dock per tab.
 *
 * Title-only on purpose. Only a capture is held; a verb decided on cached rows
 * (a toggle, an order, a move) is never queued, because by landing it may mean
 * something else.
 */

type HeldCapture = { userId: string; title: string };

export const useHeldCaptures = create<{ held: HeldCapture[] }>(() => ({ held: [] }));

export type CaptureResult = 'added' | 'held' | 'dropped';

/** File a quick capture now if the planner has loaded, else hold it for the landing. */
export function captureTask(title: string): CaptureResult {
  // Optional-called, as planner-ready's non-reactive readers: some unit-test
  // mocks of planner-store have no getState.
  const s = usePlannerStore.getState?.();
  if (!s) return 'dropped';
  if (selectPlannerLoaded(s)) {
    s.addTask({ title });
    return 'added';
  }
  const userId = s.userId;
  if (!userId) return 'dropped';
  useHeldCaptures.setState(({ held }) => ({ held: [...held, { userId, title }] }));
  ensureReleaser();
  return 'held';
}

/** How many captures are waiting for the CURRENT account. */
export function useHeldCount(): number {
  const userId = usePlannerStore((s) => s.userId);
  return useHeldCaptures((s) => (userId ? s.held.filter((e) => e.userId === userId).length : 0));
}

let unsubscribe: (() => void) | null = null;
let releaseQueued = false;

/**
 * The items the release filed, for the account it filed them under, kept for
 * the page's lifetime. One reader: the first-run seed (supabase-provider),
 * which runs after the release and must decide on what the account HAD. A
 * capture typed while the planner loaded is the user's text, not evidence the
 * account has data; before this queue the landing erased it from the store and
 * the seed never saw it. Seen, it reads a brand-new account as one to adopt
 * from, which latches it with no starter set.
 */
let released: { userId: string; ids: Set<string> } | null = null;

/** `items` without the captures the release filed for `userId`. */
export function withoutReleasedCaptures<T extends { id: string }>(
  userId: string | null,
  items: readonly T[]
): readonly T[] {
  if (!userId || released?.userId !== userId) return items;
  const { ids } = released;
  return items.filter((item) => !ids.has(item.id));
}

/**
 * One planner subscription, made on the first hold and dropped once the queue
 * drains, so nothing listens while nothing waits.
 */
function ensureReleaser(): void {
  if (unsubscribe) return;
  unsubscribe =
    usePlannerStore.subscribe?.((s) => {
      try {
        const { held } = useHeldCaptures.getState();
        const mine = held.filter((e) => e.userId === s.userId);
        if (mine.length !== held.length) useHeldCaptures.setState({ held: mine });
        if (mine.length === 0) {
          stopReleaser();
          return;
        }
        if (selectPlannerLoaded(s) && !releaseQueued) {
          releaseQueued = true;
          // A microtask, not now: this runs INSIDE the landing set(), and
          // initializeStore holds the history suppressor until the statement
          // after it. Once released, each capture is its own undo entry.
          queueMicrotask(release);
        }
      } catch {
        // Inside someone else's set(): a throw here must never escape into it.
      }
    }) ?? null;
}

function stopReleaser(): void {
  unsubscribe?.();
  unsubscribe = null;
}

/** Idempotent: the queue is emptied before anything is added, so a second run finds nothing. */
function release(): void {
  releaseQueued = false;
  const s = usePlannerStore.getState?.();
  // Asked again: a set() between the landing and this microtask may have
  // started another load or switched the account.
  if (!s || !selectPlannerLoaded(s) || !s.userId) return;
  const userId = s.userId;
  const { held } = useHeldCaptures.getState();
  const mine = held.filter((e) => e.userId === userId);
  useHeldCaptures.setState({ held: [] });
  stopReleaser();
  if (mine.length > 0 && released?.userId !== userId) released = { userId, ids: new Set() };
  // In the order typed, one undo entry each — exactly as if each Enter had landed.
  for (const { title } of mine) {
    try {
      const id = s.addTask({ title });
      if (id) released?.ids.add(id);
    } catch (err) {
      console.error('[held-captures] a held capture failed to land', err);
    }
  }
}

/** Test-only: forget every held capture and the subscription. */
export function __resetHeldCapturesForTests(): void {
  stopReleaser();
  releaseQueued = false;
  released = null;
  useHeldCaptures.setState({ held: [] });
}

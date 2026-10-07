import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { selectPlannerLoaded, selectPlannerSettled } from './planner-ready';

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
 * cannot land yet waits here and is added the moment the load finishes.
 *
 * Held ONLY while a load is in flight (the preview included). A FAILED load
 * has finished: a capture typed after it is added at once, and what was waiting
 * is added the moment it fails. Holding past a failure kept the text in this
 * module and nowhere else for as long as the failure lasted, so a reload, a
 * closed tab or a sign-out lost it, where the plain add had already written
 * the row (when only the read had failed).
 *
 * Its write is ATTEMPTED, not guaranteed. An outage fails the insert too
 * (persistNewItem only logs it), and the Retry's landing replaces the failed
 * load's store, row and all. So every capture filed over a failed load is kept
 * here, with its id, until a landing for its account settles it: a row the
 * landing brought back is confirmed, and one it did not is filed again under
 * the SAME id, so an insert that committed after the Retry read fails on the
 * primary key instead of making a second row. Until then it still counts
 * toward "Adds once synced". One the person removes over the failed load (a
 * delete, an undo) is theirs to remove and is not filed again; one they rename
 * is filed again under the new title.
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

type HeldCapture = {
  userId: string;
  title: string;
  /** Set once filed over a FAILED load: the row's id, kept until a landing confirms it. */
  id?: string;
};

export const useHeldCaptures = create<{ held: HeldCapture[] }>(() => ({ held: [] }));

export type CaptureResult = 'added' | 'held' | 'dropped';

/**
 * File a quick capture now if the planner's load has finished (landed or
 * failed), else hold it until it does.
 */
export function captureTask(title: string): CaptureResult {
  // Optional-called, as planner-ready's non-reactive readers: some unit-test
  // mocks of planner-store have no getState.
  const s = usePlannerStore.getState?.();
  if (!s) return 'dropped';
  if (selectPlannerSettled(s)) {
    const id = s.addTask({ title });
    // Over a failed load the account's data never arrived, so this row is no
    // more evidence of what the account had than a released capture is, and
    // its write may have failed with the load.
    if (!selectPlannerLoaded(s) && s.userId) {
      noteFiledBeforeLanding(s.userId, id);
      if (id) keepUntilConfirmed([{ userId: s.userId, title, id }]);
    }
    return 'added';
  }
  const userId = s.userId;
  if (!userId) return 'dropped';
  useHeldCaptures.setState(({ held }) => ({ held: [...held, { userId, title }] }));
  ensureReleaser();
  return 'held';
}

/** How many captures are waiting (or filed but unconfirmed) for the CURRENT account. */
export function useHeldCount(): number {
  const userId = usePlannerStore((s) => s.userId);
  return useHeldCaptures((s) => (userId ? s.held.filter((e) => e.userId === userId).length : 0));
}

let unsubscribe: (() => void) | null = null;
let releaseQueued = false;

/**
 * The items filed before the account's data had landed (the release, and any
 * capture typed over a failed load), for the account they were filed under,
 * kept for the page's lifetime. One reader: the first-run seed
 * (supabase-provider), which runs after the release and must decide on what
 * the account HAD. A capture typed while the planner loaded is the user's
 * text, not evidence the account has data; before this queue the landing
 * erased it from the store and the seed never saw it. Seen, it reads a
 * brand-new account as one to adopt from, which latches it with no starter set.
 */
let released: { userId: string; ids: Set<string> } | null = null;

function noteFiledBeforeLanding(userId: string, id: string | undefined): void {
  if (released?.userId !== userId) released = { userId, ids: new Set() };
  if (id) released.ids.add(id);
}

/** `items` without the captures the release filed for `userId`. */
export function withoutReleasedCaptures<T extends { id: string }>(
  userId: string | null,
  items: readonly T[]
): readonly T[] {
  if (!userId || released?.userId !== userId) return items;
  const { ids } = released;
  return items.filter((item) => !ids.has(item.id));
}

function keepUntilConfirmed(entries: HeldCapture[]): void {
  useHeldCaptures.setState(({ held }) => ({ held: [...held, ...entries] }));
  ensureReleaser();
}

/**
 * Over a failed load, a filed row is the person's: removed, it is not filed
 * again; renamed, it is filed again under the new title. The same array when
 * nothing changed.
 */
function followFiledRows(
  entries: HeldCapture[],
  items: readonly { id: string; title: string }[]
): HeldCapture[] {
  let changed = false;
  const next: HeldCapture[] = [];
  for (const e of entries) {
    const row = e.id ? items.find((i) => i.id === e.id) : undefined;
    if (e.id && !row) {
      changed = true;
      continue;
    }
    if (row && row.title !== e.title) {
      changed = true;
      next.push({ ...e, title: row.title });
      continue;
    }
    next.push(e);
  }
  return changed ? next : entries;
}

/**
 * One planner subscription, made on the first entry and dropped once none is
 * left, so nothing listens while nothing waits.
 */
function ensureReleaser(): void {
  if (unsubscribe) return;
  unsubscribe =
    usePlannerStore.subscribe?.((s) => {
      try {
        const { held } = useHeldCaptures.getState();
        let mine = held.filter((e) => e.userId === s.userId);
        const settled = selectPlannerSettled(s);
        const landed = selectPlannerLoaded(s);
        if (settled && !landed) mine = followFiledRows(mine, s.items);
        if (mine.length !== held.length || mine.some((e, i) => e !== held[i])) {
          useHeldCaptures.setState({ held: mine });
        }
        if (mine.length === 0) {
          stopReleaser();
          return;
        }
        // A landing settles everything; a failure files only what is still held.
        const due = landed || (settled && mine.some((e) => !e.id));
        if (due && !releaseQueued) {
          releaseQueued = true;
          // A microtask, not now: this runs INSIDE the landing (or failure)
          // set(), and initializeStore holds the history suppressor until the
          // statement after it. Once released, each capture is its own undo entry.
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

/** Idempotent: the queue is settled before anything is added, so a second run finds nothing to do. */
function release(): void {
  releaseQueued = false;
  const s = usePlannerStore.getState?.();
  // Asked again: a set() between the landing and this microtask may have
  // started another load or switched the account.
  if (!s || !selectPlannerSettled(s) || !s.userId) return;
  const userId = s.userId;
  const landed = selectPlannerLoaded(s);
  const mine = useHeldCaptures.getState().held.filter((e) => e.userId === userId);
  // What is still held, and, on a landing, every filed row it did not bring back.
  const onStore = new Set(s.items.map((i) => i.id));
  const toFile = mine.filter((e) => !e.id || (landed && !onStore.has(e.id)));
  // Over a failed load the rows already filed stay to be confirmed; a landing settles all of them.
  const unconfirmed = landed ? [] : mine.filter((e) => e.id);
  useHeldCaptures.setState({ held: unconfirmed });
  if (unconfirmed.length === 0) stopReleaser();
  const filed: HeldCapture[] = [];
  // In the order typed, one undo entry each — exactly as if each Enter had landed.
  for (const e of toFile) {
    try {
      const id = s.addTask({ title: e.title }, undefined, e.id ? { id: e.id } : undefined);
      noteFiledBeforeLanding(userId, id);
      if (!landed && id) filed.push({ userId, title: e.title, id });
    } catch (err) {
      console.error('[held-captures] a held capture failed to land', err);
    }
  }
  if (filed.length > 0) keepUntilConfirmed(filed);
}

/** Test-only: forget every held capture and the subscription. */
export function __resetHeldCapturesForTests(): void {
  stopReleaser();
  releaseQueued = false;
  released = null;
  useHeldCaptures.setState({ held: [] });
}

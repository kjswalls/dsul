import { create } from 'zustand';
import { awaitItemCreates, getHistoryInfo, usePlannerStore } from './planner-store';
import { selectPlannerLoaded, selectPlannerSettled } from './planner-ready';
import { fetchItemsAnyState } from './db';
import { setBulkFiledListener } from './filed-rows';
import type { Item } from './planner-types';

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
 * (persistNewItem only logs it), and a landing replaces the store it was filed
 * on, row and all. So every row filed before its account's data has landed,
 * by a capture or by a bulk add (a pasted list, reported through
 * lib/filed-rows.ts), is kept here as the person last left it, notes, dates,
 * type, project and order included, until a landing for its account settles
 * it, and it still counts toward "Adds once synced" until then. That is over a
 * failed load, and while a load is in flight: a Retry leaves the failed load's
 * rows on screen to edit and add to, and a list (unlike a capture) is filed
 * there at once. The entry also keeps the row as first filed, so a landing can
 * tell what the person changed since: their change is laid over the
 * database's copy, and a field they never touched keeps the database's value
 * (an edit made on another device). A landing settles each one:
 *   - one the person removed before it (a delete, an undone add) is theirs to
 *     remove. Its entry is marked, never dropped, while the row is off the
 *     store, so a restore (the undo strip, ⌘Z, a redo of the add) puts it back
 *     in line: the restore's own write is an UPDATE that finds nothing when the
 *     insert never committed. Not filed again; brought back by the landing (its
 *     delete failed), it is deleted again;
 *   - a row the landing brought back takes what the person changed since
 *     filing, written over it: an edit whose UPDATE failed with the load is
 *     only here;
 *   - for any other, the database is asked first, once this tab's own first
 *     insert of it has settled, for a few seconds at most. With no row at all
 *     it is filed again, whole, under the SAME id, so an insert that commits
 *     late fails on the primary key instead of making a second row, and is
 *     then settled as a row the database holds. A row in the bin was deleted on
 *     another device and stays there, its subtasks with it. A live row the
 *     landing missed (its insert committed after the Retry's read began) is not
 *     inserted again, but what the person changed since is written over it,
 *     dates included after a type switch: an UPDATE sent while that insert was
 *     in flight found nothing. When the question fails or goes unanswered,
 *     every one is filed again: the id still guards against a duplicate.
 * None of this adds an undo entry, except the re-file of a row the landing
 * missed, as the add it was, and only if the person has not acted since the
 * landing: on top of their action it would take their next ⌘Z.
 *
 * Held per ACCOUNT. An entry is bound to the userId it was typed under and is
 * dropped the moment the store answers for anyone else, sign-out (null)
 * included: text typed into one account must never be filed into another.
 *
 * A module, not component state, so it outlives the field it was typed into:
 * the launcher closes on Enter, and the phone remounts the dock per tab.
 *
 * Only typed text is held: a capture's title while a load is in flight, and
 * until a landing the rows a capture or a list filed. A verb decided on
 * cached rows (a toggle, an order, a move) is never queued, because by landing
 * it may mean something else.
 */

type HeldCapture = {
  userId: string;
  /** What was typed; once filed, the row's current title. */
  title: string;
  /**
   * Set once filed before a landing: the row as the person last left it, kept
   * until a landing settles it.
   */
  item?: Item;
  /** Set with `item`: the row as first filed, so a landing can tell what the person changed since. */
  filed?: Item;
  /** Filed by one add with the entries sharing it (a pasted list), and filed again as one. */
  batch?: number;
  /** Its row is off the failed load's store. Recomputed on every pass, so a restore clears it. */
  gone?: boolean;
  /** A landing is asking the database about its row. */
  asking?: boolean;
};

type FiledCapture = HeldCapture & { item: Item; filed: Item };

const isFiled = (e: HeldCapture): e is FiledCapture => !!e.item && !!e.filed;

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
    if (s.userId) keepUntilLanded(s.userId, rowsOf([id]));
    return 'added';
  }
  const userId = s.userId;
  if (!userId) return 'dropped';
  useHeldCaptures.setState(({ held }) => ({ held: [...held, { userId, title }] }));
  ensureReleaser();
  return 'held';
}

/**
 * How many captures are waiting (or filed but unconfirmed) for the CURRENT
 * account. A row the person removed is not.
 */
export function useHeldCount(): number {
  const userId = usePlannerStore((s) => s.userId);
  return useHeldCaptures((s) =>
    userId ? s.held.filter((e) => e.userId === userId && !e.gone).length : 0
  );
}

let unsubscribe: (() => void) | null = null;
let releaseQueued = false;

/**
 * The items filed before the account's data had landed (the release, and any
 * capture or list kept until a landing), for the account they were filed
 * under, kept for the page's lifetime. One reader: the first-run seed
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

/** The rows `ids` name on the store now, in that order. */
function rowsOf(ids: readonly (string | undefined)[]): Item[] {
  const items = usePlannerStore.getState?.()?.items ?? [];
  return ids.flatMap((id) => items.find((i) => i.id === id) ?? []);
}

let batches = 0;

/**
 * Rows just filed for `userId`, kept until a landing settles them when the
 * account's data has not landed: over a FAILED load, or while any load is in
 * flight (a Retry leaves the failed load's rows on screen to add to). The
 * landing replaces the store they were filed on, and their writes may have
 * failed with the load. Nor are they any more evidence of what the account had
 * than a released capture is. Never during the preview, which refuses the add.
 * `asOne`: one add filed them all.
 */
function keepUntilLanded(userId: string, rows: readonly Item[], asOne = false): void {
  const s = usePlannerStore.getState?.();
  if (!s || s.userId !== userId || s.isPreview || selectPlannerLoaded(s)) return;
  if (rows.length === 0) return;
  const batch = asOne && rows.length > 1 ? ++batches : undefined;
  for (const row of rows) noteFiledBeforeLanding(userId, row.id);
  const entries: HeldCapture[] = rows.map((item) => ({ userId, title: item.title, item, filed: item, batch }));
  useHeldCaptures.setState(({ held }) => ({ held: [...held, ...entries] }));
  ensureReleaser();
}

// A list filed before a landing is the same typed text as a capture.
setBulkFiledListener((userId, rows) => keepUntilLanded(userId, rows, true));

/**
 * Until the landing a filed row is the person's, and its entry follows it:
 * their latest edit is what a landing files again, and while the row is off
 * the store it is marked gone. The same array when nothing changed.
 */
function followFiledRows(entries: HeldCapture[], items: readonly Item[]): HeldCapture[] {
  if (!entries.some(isFiled)) return entries;
  const byId = new Map(items.map((i) => [i.id, i]));
  let changed = false;
  const next = entries.map((e) => {
    if (!isFiled(e)) return e;
    const row = byId.get(e.item.id);
    if (!row) {
      if (e.gone) return e;
      changed = true;
      return { ...e, gone: true };
    }
    if (row === e.item && !e.gone) return e;
    changed = true;
    return { ...e, title: row.title, item: row, gone: false };
  });
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
        // Up to the landing set() itself, a Retry's window included: no preview
        // is offered on a retry, so the failed load's rows stay on the store,
        // and an edit or a delete made in that window is the person's latest.
        if (!landed) mine = followFiledRows(mine, s.items);
        if (mine.length !== held.length || mine.some((e, i) => e !== held[i])) {
          useHeldCaptures.setState({ held: mine });
        }
        if (mine.length === 0) {
          stopReleaser();
          return;
        }
        // A landing settles all it is not already asking about; a failure
        // files only what is still held.
        const due = landed ? mine.some((e) => !e.asking) : settled && mine.some((e) => !e.item);
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
  const typed = mine.filter((e) => !isFiled(e));
  let kept: HeldCapture[];
  let ask: FiledCapture[] = [];
  let back: FiledCapture[] = [];
  if (landed) {
    // A filed row the landing brought back is settled against the landed
    // copy, and one removed before the landing is not filed again. The rest
    // wait on the database.
    const onStore = new Set(s.items.map((i) => i.id));
    const filed = mine.filter(isFiled).filter((e) => !e.asking);
    back = filed.filter((e) => onStore.has(e.item.id));
    ask = filed.filter((e) => !e.gone && !onStore.has(e.item.id)).map((e) => ({ ...e, asking: true }));
    kept = [...mine.filter((e) => e.asking), ...ask];
  } else {
    // Over a failed load the rows already filed stay to be confirmed.
    kept = mine.filter(isFiled);
  }
  useHeldCaptures.setState({ held: kept });
  if (kept.length === 0) stopReleaser();
  // Before the captures below add entries of their own: what this settles is
  // what the person had before the landing, folded into the history as such.
  if (back.length > 0) {
    try {
      s.settleLandedRows(back.map((e) => ({ row: e.item, filed: e.filed, gone: !!e.gone })));
    } catch (err) {
      console.error('[held-captures] rows the landing brought back failed to settle', err);
    }
  }
  // In the order typed, one undo entry each: exactly as if each Enter had landed.
  const filed: string[] = [];
  for (const e of typed) {
    try {
      const id = s.addTask({ title: e.title });
      noteFiledBeforeLanding(userId, id);
      filed.push(id);
    } catch (err) {
      console.error('[held-captures] a held capture failed to land', err);
    }
  }
  if (!landed) keepUntilLanded(userId, rowsOf(filed));
  if (ask.length > 0) void refileAfterAsking(userId, ask);
}

/**
 * How long a landing waits on the database before filing every row again
 * anyway. Until it answers the rows are off the planner and only here, where a
 * reload loses them, and supabase-js sets no timeout of its own.
 */
const ASK_TIMEOUT_MS = 4000;

/**
 * The filed rows a landing did not bring back, filed again once the database
 * has said which of them it holds (see the header). Each pasted list is filed
 * again as the one undo entry it was, and each capture as its own, unless the
 * person has acted since the landing: then the rows are folded in with no entry,
 * so the next undo is still theirs.
 */
async function refileAfterAsking(userId: string, asked: FiledCapture[]): Promise<void> {
  const ids = asked.map((e) => e.item.id);
  const mark = historyMark();
  let saved: Map<string, { item: Item; deleted: boolean }> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      // This tab's own first inserts of these rows settle first: asked while
      // one is still in flight, the answer is "no row", and the insert sent
      // again races it on the primary key.
      awaitItemCreates(ids).then(() => fetchItemsAnyState(userId, ids)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ASK_TIMEOUT_MS}ms`)), ASK_TIMEOUT_MS);
      }),
    ]);
    saved = new Map(found.map((r) => [r.item.id, r]));
  } catch (err) {
    console.error('[held-captures] could not ask which rows were saved', err);
  } finally {
    clearTimeout(timer);
  }
  // A late answer finds nothing to do: its entries have left the queue.
  const { held } = useHeldCaptures.getState();
  const still = asked.filter((e) => held.includes(e));
  const s = usePlannerStore.getState?.();
  // Only an account change ends a landing (initializeStore never reloads a
  // landed account), and that has dropped them already.
  if (still.length === 0 || !s || s.userId !== userId || !selectPlannerLoaded(s)) return;
  const settled = new Set<HeldCapture>(still);
  const rest = held.filter((e) => !settled.has(e));
  useHeldCaptures.setState({ held: rest });
  if (rest.length === 0) stopReleaser();
  const live = new Map<string, Item>();
  for (const [id, row] of saved ?? []) if (!row.deleted) live.set(id, row.item);
  // A row in the bin was deleted elsewhere and stays there. So does a subtask
  // whose parent will not exist: not on the planner, not filed again here,
  // and not live (in the bin, its delete would have taken the subtask with
  // it; with no row at all, the insert would fail on its parent).
  const filing = new Set(still.filter((e) => !saved?.get(e.item.id)?.deleted).map((e) => e.item.id));
  if (saved) {
    const onStore = new Set(s.items.map((i) => i.id));
    for (let dropped = true; dropped; ) {
      dropped = false;
      for (const { item } of still) {
        const parent = parentOf(item);
        if (!filing.has(item.id) || !parent || onStore.has(parent) || filing.has(parent) || live.has(parent)) continue;
        filing.delete(item.id);
        dropped = true;
      }
    }
  }
  const groups = byBatch(still).map((group) => group.flatMap(({ item }) => (filing.has(item.id) ? [item] : [])));
  const filed = new Map(still.map((e) => [e.item.id, e.filed]));
  try {
    s.refileItems(groups, { saved: live, filed, quiet: historyMark() !== mark });
  } catch (err) {
    console.error('[held-captures] rows failed to file again', err);
  }
}

const parentOf = (item: Item): string | undefined => ('parentItemId' in item ? item.parentItemId : undefined);

/** Where the undo history stands: changed by any entry pushed, undone or redone. */
function historyMark(): string {
  const { currentIndex, actionLog } = getHistoryInfo();
  return `${currentIndex}:${actionLog[0]?.id ?? ''}`;
}

/** Runs of entries one add filed together, as groups; every other entry alone. */
function byBatch<T extends HeldCapture>(entries: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (e.batch !== undefined && last?.[0].batch === e.batch) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

/** Test-only: forget every held capture and the subscription. */
export function __resetHeldCapturesForTests(): void {
  stopReleaser();
  releaseQueued = false;
  released = null;
  useHeldCaptures.setState({ held: [] });
}

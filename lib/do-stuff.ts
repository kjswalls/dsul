import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { ITEM_VERBS, occurrenceOn, type VerbContext } from './item-verbs';
import { milestoneItemIds } from './goals';
import { toDateStr } from './recurrence';
import type { ItemSize } from './item-size';
import type { Item } from './planner-types';

/**
 * Do stuff mode: the braindump sorted by size and walked quick-first
 * (lib/item-size.ts holds the sizes; components/sidebar/do-stuff.tsx draws it).
 *
 * The mode is MEMORY ONLY, never persisted: it is something you do for a while,
 * not a setting, and a reload that lands back in a half-finished walk would
 * read as the app having an opinion about what you should be doing. The same
 * goes for what you skipped.
 */

/**
 * How many open rows the braindump needs before the "do stuff" row shows at
 * all. Below it the list is short enough to read, and a fresh account's
 * braindump draws exactly as it did before the extension existed. A list with
 * anything already sized shows the row at any length: the user has used it.
 */
export const DO_STUFF_MIN_OPEN = 6;

interface DoStuffState {
  on: boolean;
  /** Ids skipped this session, oldest first. Skipped means later, never gone. */
  skipped: string[];
  /**
   * A section the user opened by hand. Null follows the walk: the section the
   * next item is in (or the unsized ones, while there are any).
   */
  opened: ItemSize | 'new' | null;
  /** How many things were done in this run, for the row's progress. */
  doneCount: number;
  start: () => void;
  stop: () => void;
  skip: (id: string) => void;
  open: (section: ItemSize | 'new' | null) => void;
  countDone: () => void;
}

export const useDoStuffStore = create<DoStuffState>((set) => ({
  on: false,
  skipped: [],
  opened: null,
  doneCount: 0,
  start: () => set({ on: true, skipped: [], opened: null, doneCount: 0 }),
  stop: () => set({ on: false, skipped: [], opened: null, doneCount: 0 }),
  skip: (id) => set((s) => ({ skipped: [...s.skipped.filter((x) => x !== id), id] })),
  open: (section) => set((s) => ({ opened: s.opened === section ? null : section })),
  countDone: () => set((s) => ({ doneCount: s.doneCount + 1 })),
}));

/* ── writes ───────────────────────────────────────────────────────────── */

const planner = () => usePlannerStore.getState();

/** One item's size; `null` clears it. */
export function setSize(id: string, size: ItemSize | null): void {
  planner().setItemsSize(new Map([[id, size ?? undefined]]));
}

/** Several at once, one undo ("keep all guesses"). */
export function setSizes(sizes: ReadonlyMap<string, ItemSize>): void {
  if (sizes.size > 0) planner().setItemsSize(sizes);
}

function todayContext(item: Item): VerbContext {
  const state = planner();
  const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);
  return {
    dateStr: today,
    date: new Date(),
    todayStr: today,
    tz,
    milestoneIds: milestoneItemIds(state.goals ?? []),
    occurrence: occurrenceOn(item, today, today, tz),
  };
}

/** Re-read at click time: the row may have been painted from a snapshot. */
function fresh(id: string): Item | undefined {
  return planner().items.find((i) => i.id === id);
}

/** Done: the shared COMPLETE verb, asked at click time like every surface. */
export function doneNext(id: string): void {
  const item = fresh(id);
  if (!item) return;
  const ctx = todayContext(item);
  if (!ITEM_VERBS.complete.eligible(item, ctx)) return;
  ITEM_VERBS.complete.run(item, ctx);
  useDoStuffStore.getState().countDone();
}

/** Put on today: the shared RESCHEDULE verb, landing on today. */
export function putOnToday(id: string): void {
  const item = fresh(id);
  if (!item) return;
  const ctx = todayContext(item);
  if (!ITEM_VERBS.reschedule.eligible(item, ctx)) return;
  ITEM_VERBS.reschedule.run(item, ctx, ctx.todayStr);
}

export function skipNext(id: string): void {
  useDoStuffStore.getState().skip(id);
}

import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { ITEM_VERBS, occurrenceOn, type VerbContext } from './item-verbs';
import { milestoneItemIds } from './goals';
import { toDateStr } from './recurrence';
import type { Lane } from './do-stuff-plan';
import { handOffItem } from './agent-handoff';
import type { Item } from './planner-types';

/**
 * Do stuff mode: the braindump sorted into a plan in lanes, then walked
 * (lib/do-stuff-plan.ts holds the lanes and their rules;
 * components/sidebar/do-stuff.tsx draws it).
 *
 * The mode is MEMORY ONLY, never persisted: it is something you do for a while,
 * not a setting, and a reload that lands back in a half-finished walk would
 * read as the app having an opinion about what you should be doing. The same
 * goes for what you skipped and the lanes you moved things to: only "make it
 * so" writes anything.
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
  /** Lanes the user moved rows to this run, by id. The rules decide the rest. */
  moved: Record<string, Lane>;
  /** How many things were done in this run, for the row's progress. */
  doneCount: number;
  start: () => void;
  stop: () => void;
  skip: (id: string) => void;
  move: (id: string, lane: Lane) => void;
  countDone: () => void;
  /**
   * Who the handed-off lane goes to (an assignee, lib/agent-assignees.ts), as
   * last picked. Kept across runs, memory only; null, or someone no longer
   * connected, means the first agent offered.
   */
  handTo: string | null;
  setHandTo: (assignee: string) => void;
}

export const useDoStuffStore = create<DoStuffState>((set) => ({
  on: false,
  skipped: [],
  moved: {},
  doneCount: 0,
  start: () => {
    snapshotRows();
    set({ on: true, skipped: [], moved: {}, doneCount: 0 });
  },
  stop: () => set({ on: false, skipped: [], moved: {}, doneCount: 0 }),
  skip: (id) => set((s) => ({ skipped: [...s.skipped.filter((x) => x !== id), id] })),
  move: (id, lane) => set((s) => ({ moved: { ...s.moved, [id]: lane } })),
  countDone: () => set((s) => ({ doneCount: s.doneCount + 1 })),
  handTo: null,
  setHandTo: (assignee) => set({ handTo: assignee }),
}));

/* ── the shuffle ──────────────────────────────────────────────────────── */

/**
 * Where each braindump row stood the moment the mode started, so the plan can
 * shuffle them from there into their lanes. Taken once, read once.
 */
let shuffleFrom: Map<string, number> | null = null;

function snapshotRows(): void {
  if (typeof document === 'undefined') return;
  const from = new Map<string, number>();
  for (const el of document.querySelectorAll<HTMLElement>('[data-braindump-list] [data-item-id]')) {
    const id = el.dataset.itemId;
    if (id && !from.has(id)) from.set(id, el.getBoundingClientRect().top);
  }
  shuffleFrom = from.size > 0 ? from : null;
}

/** The tops the rows started from, once; null when there is nothing to play. */
export function takeShuffleFrom(): Map<string, number> | null {
  const from = shuffleFrom;
  shuffleFrom = null;
  return from;
}

/* ── writes ───────────────────────────────────────────────────────────── */

const planner = () => usePlannerStore.getState();

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

/**
 * Make it so: every calendar row onto its day (one undo per day, the bulk
 * carry), and every row in the handed-off lane that the agent does not hold
 * yet handed to it. "Do now" and "left alone" write nothing. Re-checked at
 * click time against the store, like every verb.
 */
export function makeItSo(plan: {
  days: ReadonlyMap<string, string>;
  handOff: readonly string[];
  /** Who the handed-off lane goes to; OpenClaw when not said. */
  to?: string;
}): void {
  const byDay = new Map<string, string[]>();
  for (const [id, day] of plan.days) {
    const item = fresh(id);
    if (!item) continue;
    if (!ITEM_VERBS.reschedule.eligible(item, todayContext(item))) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), id]);
  }
  for (const [day, ids] of byDay) planner().moveTasksToDate(ids, day);
  for (const id of plan.handOff) {
    const item = fresh(id);
    if (item && !('assignee' in item && item.assignee)) handOffItem(item, plan.to);
  }
}

export function skipNext(id: string): void {
  useDoStuffStore.getState().skip(id);
}

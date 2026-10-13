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
  /**
   * Whether the braindump wants the key at all (components/sidebar/do-stuff.tsx
   * wantsDoStuffRow), published by the braindump for the dock, which has no
   * rows of its own.
   */
  available: boolean;
  /**
   * Whether the sidebar dock is carrying the key (and make it so) in place of
   * the capture bar, published by the dock. While it is, the braindump's header
   * draws no key and the list draws no strip.
   */
  docked: boolean;
  /** Bumped by every start: the dock's relay field ripples out from the key. */
  starts: number;
  /** What "make it so" would do right now, published by the plan while it is drawn. */
  commit: Commit | null;
  /**
   * Where each planned row is going, for the grid's rows while doing stuff
   * (components/primitives/task-row.tsx): its lane and, for another day, the
   * day. Published by the plan; cleared by stop().
   */
  marks: ReadonlyMap<string, Mark>;
  /** Do it now's next row, for the up-next card on today (components/sidebar/do-stuff-today.tsx). */
  next: { id: string; title: string } | null;
  /** Braindump rows coming onto today: the card's ghost "+" rows. */
  arriving: readonly { id: string; title: string }[];
}

/** Where one row is going. */
export interface Mark {
  lane: Lane;
  day?: string;
  onToday: boolean;
}

const NO_MARKS: ReadonlyMap<string, Mark> = new Map();

/** The plan's writes, as the dock's make it so key needs them. */
export interface Commit {
  days: ReadonlyMap<string, string>;
  /** Rows going onto today. */
  today: readonly string[];
  /** Rows let go ("whatever"). */
  letGo: readonly string[];
  /** Today's rows sent back to the braindump ("later"). */
  unschedule: readonly string[];
  handOff: readonly string[];
  /** Who the handed-off lane goes to: its assignee and its name. */
  to: { assignee: string; name: string } | null;
  /** Open rows left in "do now". */
  left: number;
}

export const useDoStuffStore = create<DoStuffState>((set) => ({
  on: false,
  skipped: [],
  moved: {},
  doneCount: 0,
  start: () => {
    snapshotRows();
    set((s) => ({ on: true, skipped: [], moved: {}, doneCount: 0, starts: s.starts + 1 }));
  },
  stop: () => set({ on: false, skipped: [], moved: {}, doneCount: 0, commit: null, marks: NO_MARKS, next: null, arriving: [] }),
  skip: (id) => set((s) => ({ skipped: [...s.skipped.filter((x) => x !== id), id] })),
  move: (id, lane) => set((s) => ({ moved: { ...s.moved, [id]: lane } })),
  countDone: () => set((s) => ({ doneCount: s.doneCount + 1 })),
  handTo: null,
  setHandTo: (assignee) => set({ handTo: assignee }),
  available: false,
  docked: false,
  starts: 0,
  commit: null,
  marks: NO_MARKS,
  next: null,
  arriving: [],
}));

/** How many things make it so would move: today, the other days, the hand-offs and the let-go. */
export function commitCount(c: Commit | null): number {
  return c ? c.days.size + c.today.length + c.handOff.length + c.letGo.length + c.unschedule.length : 0;
}

/** What make it so will do, a line each, for its tooltip and its name. */
export function commitLines(c: Commit | null): string[] {
  if (!c) return [];
  return [
    c.today.length > 0 && `${c.today.length} onto today`,
    c.days.size > 0 && `${c.days.size} onto days`,
    c.handOff.length > 0 && c.to && `${c.handOff.length} to ${c.to.name}`,
    c.unschedule.length > 0 && `${c.unschedule.length} back to the braindump`,
    c.letGo.length > 0 && `${c.letGo.length} let go`,
  ].filter((l): l is string => !!l);
}

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
 * Make it so: "today" onto today and every "another day" row onto its day (one
 * undo per day, the bulk carry), every row in "do it for me" that the agent
 * does not hold yet handed to it, and "whatever" let go (one undo). "Do it
 * now" and "later" write nothing. Re-checked at click time against the store,
 * like every verb.
 */
export function makeItSo(plan: {
  days: ReadonlyMap<string, string>;
  today?: readonly string[];
  handOff: readonly string[];
  letGo?: readonly string[];
  unschedule?: readonly string[];
  /** Who the handed-off lane goes to; OpenClaw when not said. */
  to?: string;
}): void {
  const byDay = new Map<string, string[]>();
  const all = new Map(plan.days);
  if (plan.today?.length) {
    const first = fresh(plan.today[0]);
    const todayStr = first ? todayContext(first).todayStr : undefined;
    if (todayStr) for (const id of plan.today) all.set(id, todayStr);
  }
  for (const [id, day] of all) {
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
  if (plan.unschedule?.length) planner().unscheduleTasks([...plan.unschedule]);
  if (plan.letGo?.length) planner().letGoItems([...plan.letGo]);
}

export function skipNext(id: string): void {
  useDoStuffStore.getState().skip(id);
}

/**
 * The key's second press (and its chord's): make it so with the plan as the
 * list last published it, then stop. With nothing to move it only stops.
 */
export function finishRun(): void {
  const { commit, stop } = useDoStuffStore.getState();
  if (commit && commitCount(commit) > 0) {
    makeItSo({ ...commit, to: commit.to?.assignee });
  }
  stop();
}

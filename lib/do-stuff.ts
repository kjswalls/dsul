import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { ITEM_VERBS, occurrenceOn, type VerbContext } from './item-verbs';
import { milestoneItemIds } from './goals';
import { toDateStr } from './recurrence';
import { isRowCompletedOn, type SortableRow } from './sort-rows';
import { prefersReducedMotion } from './zen-transition';
import { SPRINT_LEAD_MIN } from './do-stuff-walk';
import type { Energy, Lane } from './do-stuff-plan';
import { handOffItem } from './agent-handoff';
import type { Item } from './planner-types';

/**
 * Do stuff mode: the braindump (and today's anytime rows) sorted into a plan
 * in seven lanes, then walked (lib/do-stuff-plan.ts holds the lanes and their
 * rules; components/sidebar/do-stuff.tsx draws it; the walk itself is
 * components/sidebar/do-stuff-slot.tsx, the desk and the up-next card).
 *
 * The mode is MEMORY ONLY, never persisted: it is something you do for a while,
 * not a setting, and a reload that lands back in a half-finished walk would
 * read as the app having an opinion about what you should be doing. The same
 * goes for what you skipped and the lanes you moved things to. What writes at
 * once is what you did to one thing with your own hands (done, the Desk's T key,
 * first steps, fit it in; skip writes nothing, it is memory like the lanes); the plan's moves (another day, do it for me, later,
 * whatever) wait for "make it so".
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
  /**
   * How many things were done in this run, for the row's progress: the length
   * of `doneIds`, kept as a number for its many readers.
   */
  doneCount: number;
  /**
   * The rows done this run, in the walked lanes (do it now, today), whichever
   * surface ticked them: the card, the slot, the desk, the pocket, the row's
   * own checkbox or the grid. Counted from the planner store's own changes
   * (watchCompletions below), never by the surface that asked, so every way
   * of finishing a thing counts once. A row unticked again leaves the list.
   * The plan also keeps a today-origin row in these on the list once it is
   * done, so "N done here" can count it: a done row leaving `tasks`' pending
   * set is a row the plan never saw finish.
   */
  doneIds: readonly string[];
  /**
   * How the person said they feel this run (lib/do-stuff-plan.ts
   * `energyOrder`): low walks the small things first, high the big ones. Null
   * until they say, and the walk goes as the rules lay it out. Memory only,
   * asked again each run: energy is today's, not a setting.
   */
  energy: Energy | null;
  setEnergy: (energy: Energy | null) => void;
  start: () => void;
  stop: () => void;
  skip: (id: string) => void;
  move: (id: string, lane: Lane) => void;
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
  /** The row after `next`: what done or skip brings up, for the desk's bar. */
  then: { id: string; title: string } | null;
  /** Braindump rows coming onto today: the card's ghost "+" rows. */
  arriving: readonly { id: string; title: string }[];
  /**
   * The item whose first steps are open (components/sidebar/first-steps.tsx),
   * from the up-next card, the F key or the item menu. Memory only.
   */
  firstSteps: string | null;
  /**
   * Whether today's schedule is showing the walk's slot ("In the day",
   * components/sidebar/do-stuff-slot.tsx), published by the slot. While it is,
   * the current item lives there: the header drops its up-next card and the
   * list's card becomes a row with a lime notch.
   */
  slot: boolean;
  /** When the run started (performance.now()), for the slot to arrive after the sort. */
  startedAt: number;
  /**
   * Whether the canvas is the Desk (components/sidebar/do-stuff-desk.tsx): the
   * current item set large beside today's day column, with its notes, steps,
   * a jot box and its conversation. Memory only, like the mode; stop() closes it.
   */
  desk: boolean;
  /**
   * Live desk hosts: the canvas views that mount the Desk in a view's place
   * (the desktop ViewRouter, through useDeskHost). The phone's router never
   * does, so with no host openDesk() is a no-op and the ⤢ and "desk" keys are
   * not drawn: a desk set with nobody to draw it stranded the phone, the slot
   * hiding its actions for a room that never opened. A count, not a flag, so
   * StrictMode's mount → cleanup → mount cannot leave it stuck at none.
   */
  deskHosts: number;
  /**
   * The running sprint (components/sidebar/sprint-ring.tsx): a ring sized to
   * the gap before the next block, as epoch ms. Memory only; stop() ends it.
   */
  sprint: Sprint | null;
  /**
   * Missed blocks already offered (components/sidebar/do-stuff-slot.tsx), by
   * id: each is offered once, fitted in or let go, and never asked about again
   * this session. Memory only, and kept across runs, so stopping and starting
   * the mode doesn't bring the question back.
   */
  missedSeen: readonly string[];
}

export interface Sprint {
  startedAt: number;
  endsAt: number;
  /** The block it stops ahead of; null for an open one. */
  until: string | null;
  /**
   * The item it was started for. Done or skip on that item ends the sprint:
   * the ring was for the thing, not the clock. The pocket never sees it
   * (electron/lib/pocket.cjs shapePocket keeps the three fields above).
   */
  forItem?: string;
}

/**
 * When a sprint that has ended clears itself, with no tap: SPRINT_LEAD_MIN
 * after it ends. A sprint run to a block stops that long before the block, so
 * this is the block's start (lib/do-stuff-walk.ts sprintFor); an open one gets
 * the same five minutes. Until then it says "time's up" and waits (Kirby's
 * rule: no sound, no red); after it, a stale "time's up · Lunch next" over a
 * lunch that already happened would be the app not noticing the time.
 */
export function sprintClearsAt(sprint: Sprint): number {
  return sprint.endsAt + SPRINT_LEAD_MIN * 60_000;
}

/**
 * How long the sort takes to land, from the start of a run: the column's widen,
 * the rows' glide and the lane labels (components/sidebar/do-stuff.tsx useSort).
 * The current item arrives after it, never during: a card drawn at full size
 * while the rows are still moving was the start's weirdness.
 */
export const SORT_SETTLE_MS = 1100;

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
  doneIds: [],
  start: () => {
    snapshotRows();
    watchCompletionsWhileOn();
    const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
    set((s) => ({ on: true, skipped: [], moved: {}, doneCount: 0, doneIds: [], energy: null, starts: s.starts + 1, startedAt }));
  },
  // Everything the run held goes with it: a First steps dialog left open, the
  // slot's flag and the sort clock included, so nothing of a run outlives it.
  stop: () => {
    disarmSprintClear();
    unwatchCompletions();
    set({
      on: false,
      skipped: [],
      moved: {},
      doneCount: 0,
      doneIds: [],
      commit: null,
      marks: NO_MARKS,
      next: null,
      then: null,
      arriving: [],
      firstSteps: null,
      slot: false,
      startedAt: 0,
      desk: false,
      sprint: null,
      energy: null,
    });
  },
  energy: null,
  setEnergy: (energy) => set({ energy }),
  skip: (id) => set((s) => ({ skipped: [...s.skipped.filter((x) => x !== id), id] })),
  move: (id, lane) => set((s) => ({ moved: { ...s.moved, [id]: lane } })),
  handTo: null,
  setHandTo: (assignee) => set({ handTo: assignee }),
  available: false,
  docked: false,
  starts: 0,
  commit: null,
  marks: NO_MARKS,
  next: null,
  then: null,
  arriving: [],
  firstSteps: null,
  slot: false,
  startedAt: 0,
  desk: false,
  deskHosts: 0,
  sprint: null,
  missedSeen: [],
}));

/**
 * Called by the canvas view that mounts the Desk (components/views/view-router.tsx),
 * and by nothing else, for as long as it is mounted. The last host leaving
 * closes the desk with it: nothing is left set that nothing can draw.
 */
export function useDeskHost(): void {
  useEffect(() => {
    useDoStuffStore.setState((s) => ({ deskHosts: s.deskHosts + 1 }));
    return () => {
      useDoStuffStore.setState((s) => {
        const deskHosts = Math.max(0, s.deskHosts - 1);
        return deskHosts === 0 ? { deskHosts, desk: false } : { deskHosts };
      });
    };
  }, []);
}

/** Whether something on screen can draw the Desk right now. */
export function useDeskHosted(): boolean {
  return useDoStuffStore((s) => s.deskHosts > 0);
}

/** The one timer that clears a finished sprint (sprintClearsAt); armed by startSprint. */
let sprintClearTimer: ReturnType<typeof setTimeout> | null = null;

function disarmSprintClear(): void {
  if (sprintClearTimer !== null) clearTimeout(sprintClearTimer);
  sprintClearTimer = null;
}

/**
 * Start a sprint of `minutes` from now, stopping ahead of `until`, for the
 * item `forItem`. It clears itself at sprintClearsAt unless a tap, done or
 * skip on its item, or stop() gets there first. The timer is the store's, not
 * a ring's: the ring is not drawn at the desk's slot, and nothing should
 * depend on a component being mounted to let go of a sprint that is over.
 */
export function startSprint(minutes: number, until: string | null, forItem?: string): void {
  const startedAt = Date.now();
  const sprint: Sprint = { startedAt, endsAt: startedAt + minutes * 60_000, until, ...(forItem ? { forItem } : {}) };
  disarmSprintClear();
  sprintClearTimer = setTimeout(() => {
    sprintClearTimer = null;
    if (useDoStuffStore.getState().sprint === sprint) useDoStuffStore.setState({ sprint: null });
  }, sprintClearsAt(sprint) - startedAt);
  useDoStuffStore.setState({ sprint });
}

export function stopSprint(): void {
  disarmSprintClear();
  useDoStuffStore.setState({ sprint: null });
}

/** Done or skip on the item a sprint was started for ends it; another item's leaves it. */
function endSprintFor(id: string): void {
  if (useDoStuffStore.getState().sprint?.forItem === id) stopSprint();
}

/**
 * Open the Desk on the current item. The desk is always today (its day column
 * is today's, as Zen's room is), so the canvas comes back to today first.
 * Nothing happens with no host mounted (useDeskHost): the phone has none.
 */
export function openDesk(): void {
  const { on, next, deskHosts } = useDoStuffStore.getState();
  if (!on || !next || deskHosts === 0) return;
  const state = planner();
  const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (toDateStr(state.selectedDate, tz) !== toDateStr(new Date(), tz)) state.setSelectedDate(new Date());
  useDoStuffStore.setState({ desk: true });
}

export function closeDesk(): void {
  useDoStuffStore.setState({ desk: false });
}

/** How long the current item still waits for the sort to land. */
export function sortDelay(): number {
  if (typeof performance === 'undefined') return 0;
  const since = performance.now() - useDoStuffStore.getState().startedAt;
  return Math.max(0, SORT_SETTLE_MS - since);
}

/**
 * The current item arrives after the sort has landed (sortDelay), wherever it
 * is drawn: the slot, the header's up-next card. A clip from the top edge and
 * a short drop, never an opacity, since the slot's notch is lime. Once, on
 * mount; off under reduced motion, and where there is no `animate` (jsdom).
 */
export function useSortArrival(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { clipPath: 'inset(0 0 100% 0)', transform: 'translate(0, -4px)' },
        { clipPath: 'inset(0)', transform: 'none' },
      ],
      { duration: 320, delay: sortDelay(), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    );
  }, [ref]);
}

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

/** Today, in the user's own zone: the day the plan was made for. */
function todayStrNow(): string {
  const tz = planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return toDateStr(new Date(), tz);
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

/**
 * Done: the shared COMPLETE verb, asked at click time like every surface. The
 * count is not bumped here: watchCompletions sees the store change, as it
 * does for a checkbox or the grid.
 */
export function doneNext(id: string): void {
  const item = fresh(id);
  if (!item) return;
  const ctx = todayContext(item);
  if (!ITEM_VERBS.complete.eligible(item, ctx)) return;
  ITEM_VERBS.complete.run(item, ctx);
  endSprintFor(id);
}

/** The walked lanes: a row done in one of these counts for the run. */
const WALKED: ReadonlySet<Lane> = new Set<Lane>(['now', 'today']);

/**
 * Counts what gets done during a run, from the planner store's own changes:
 * a row in a walked lane that goes from open to done joins `doneIds`, one
 * unticked again leaves it, whichever surface did it. Watched from start()
 * to stop(), and only for rows the plan has marked (the plan's `marks` still
 * hold the row at the moment it changes, since the plan recomputes after).
 */
function watchCompletions(items: readonly Item[], prev: readonly Item[]): void {
  const ds = useDoStuffStore.getState();
  if (!ds.on || items === prev) return;
  const todayStr = todayStrNow();
  const before = new Map(prev.map((i) => [i.id, i]));
  const done = new Set(ds.doneIds);
  let changed = false;
  for (const item of items) {
    const was = before.get(item.id);
    if (!was || was === item) continue;
    const lane = ds.marks.get(item.id)?.lane;
    if (!lane || !WALKED.has(lane)) continue;
    // The walked lanes hold task-likes (a habit is left alone by the rules),
    // and the item is the ITEM shape the row carries, so the row is built here.
    const itemType = item.type === 'habit' ? 'habit' : 'task';
    const wasDone = isRowCompletedOn({ itemType, item: was as SortableRow['item'] }, todayStr);
    const isDone = isRowCompletedOn({ itemType, item: item as SortableRow['item'] }, todayStr);
    if (isDone === wasDone) continue;
    if (isDone) {
      done.add(item.id);
      // Ticked on the grid or the row's own checkbox: the sprint started for
      // it is over too, the same as done in the slot.
      endSprintFor(item.id);
    } else done.delete(item.id);
    changed = true;
  }
  if (!changed) return;
  const doneIds = [...done];
  useDoStuffStore.setState({ doneIds, doneCount: doneIds.length });
}

let unwatch: (() => void) | null = null;

function watchCompletionsWhileOn(): void {
  unwatch ??= usePlannerStore.subscribe((s, prev) => watchCompletions(s.items, prev.items));
}

function unwatchCompletions(): void {
  unwatch?.();
  unwatch = null;
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
  // Today is the clock's, not the first row's: a row gone since the plan was
  // drawn must not keep the rest of the lane off the day.
  if (plan.today?.length) {
    const todayStr = todayStrNow();
    for (const id of plan.today) all.set(id, todayStr);
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

/**
 * "let it go": a missed block is not asked about again, and nothing is
 * written. `alsoSeen` are the other blocks missed right now: answering one
 * answers the run's question, so they are not asked about either (the plan
 * promises one offer, not a chain).
 */
export function letMissedGo(id: string, alsoSeen: readonly string[] = []): void {
  const ids = [id, ...alsoSeen];
  useDoStuffStore.setState((s) => ({ missedSeen: [...s.missedSeen.filter((x) => !ids.includes(x)), ...ids] }));
}

/**
 * "fit it in": a missed one-off block moves to `startMin` today, `duration`
 * long (its own length, or what fits before the next block: lib/do-stuff-walk.ts
 * fitIn), in one undo. Never a habit or a series (WalkBlock.movable): their
 * time is every day's. Gated like every other write here, on the shared
 * RESCHEDULE verb's eligibility, re-read at click time.
 */
export function fitMissedIn(id: string, at: { startMin: number; duration: number }, alsoSeen: readonly string[] = []): void {
  letMissedGo(id, alsoSeen);
  const item = fresh(id);
  if (!item || !ITEM_VERBS.reschedule.eligible(item, todayContext(item))) return;
  const h = Math.floor(at.startMin / 60);
  const startTime = `${String(h).padStart(2, '0')}:${String(at.startMin % 60).padStart(2, '0')}`;
  const timeBucket = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  planner().updateTask(id, { startTime, duration: at.duration, timeBucket }, { label: 'Fit it in' });
}

export function skipNext(id: string): void {
  useDoStuffStore.getState().skip(id);
  endSprintFor(id);
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

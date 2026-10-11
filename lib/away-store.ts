import { create } from 'zustand';
import {
  claimAwaySettle,
  createAwayPeriod,
  deleteAwayPeriod,
  fetchAwayPeriods,
  updateAwayPeriod,
} from './db';
import {
  EMPTY_KEEP,
  currentAway,
  easingAway,
  planReturns,
  tripTasks,
  upcomingAway,
  type AwayKeep,
  type AwayPeriod,
} from './away';
import type { Item, Routine } from './planner-types';

/**
 * away-store.ts — vacation mode's trips, and the verbs that change them.
 *
 * The rule itself is pure and lives in lib/away.ts; every surface reads the
 * trips through its ActivationContext (`away: useAwayStore(s => s.periods)`),
 * so this store only loads them and writes them. It is kept apart from
 * planner-store on purpose: a trip is not an item and has no place in undo,
 * and the planner's history snapshot must never carry one.
 *
 * Callers pass the items and routines a verb needs, so this module never
 * imports planner-store (which reads `periods` back through getState()).
 */

/** What the planner must supply for a verb that plans the comeback. */
export interface AwayInputs {
  items: readonly Item[];
  routines: readonly Routine[];
  todayStr: string;
}

interface AwayStore {
  periods: AwayPeriod[];
  /** The load has answered (true even when it failed). Gates the auto-age sweep. */
  loaded: boolean;
  /** Migration 071 is reachable. False hides every vacation control. */
  available: boolean;
  userId: string | null;

  load: (userId: string) => Promise<void>;
  reset: () => void;

  /** Start (or schedule) a trip. One trip at a time: an existing current or upcoming one is replaced. */
  start: (trip: { startsOn: string; endsOn: string; keep: AwayKeep }, inputs: AwayInputs) => void;
  /** "I'm back": end today, re-planning the waves from today. A trip that has not started is removed. */
  end: (inputs: AwayInputs) => void;
  /** Change what keeps going on the current or upcoming trip. */
  setKeep: (keep: AwayKeep, inputs: AwayInputs) => void;
  /** Add one item to the current trip's keep list (anything you add in the app while away). */
  keepItem: (itemId: string, todayStr: string) => void;
  /** Skip the easing waves: everything back now. */
  bringEverythingBack: (todayStr: string) => void;
  /**
   * Move the tasks that came due while away to the braindump, once.
   * `unschedule` moves the ids it is given and returns the ones it moved (a
   * milestone keeps its target date, so it may move fewer).
   */
  settle: (inputs: AwayInputs, unschedule: (ids: string[]) => string[]) => Promise<void>;
}

const replace = (periods: AwayPeriod[], next: AwayPeriod) =>
  periods.map((p) => (p.id === next.id ? next : p));

const fail = (what: string) => (err: unknown) => console.error(`vacation mode: ${what} failed`, err);

export const useAwayStore = create<AwayStore>()((set, get) => ({
  periods: [],
  loaded: false,
  available: false,
  userId: null,

  load: async (userId) => {
    set({ userId });
    let periods: AwayPeriod[] | null = null;
    try {
      periods = await fetchAwayPeriods(userId);
    } catch (err) {
      // A failed read must not wake every held habit as if no trip existed,
      // but nor may it fail the planner. It hides the controls (so no second
      // trip is started over an unseen one) and the server still honours the
      // trip for reminders and stakes, which read it on their own.
      console.error('vacation mode: load failed', err);
    }
    if (get().userId !== userId) return;
    set({ periods: periods ?? [], available: periods !== null, loaded: true });
  },

  reset: () => set({ periods: [], loaded: false, available: false, userId: null }),

  start: ({ startsOn, endsOn, keep }, { items, routines, todayStr }) => {
    const { userId, periods } = get();
    if (!userId) return;
    const existing = currentAway(periods, todayStr) ?? upcomingAway(periods, todayStr);
    const returns = planReturns(items, { startsOn, keep }, endsOn, routines);
    if (existing) {
      const next = { ...existing, startsOn, endsOn, keep, returns };
      set({ periods: replace(periods, next) });
      updateAwayPeriod(userId, existing.id, { startsOn, endsOn, keep, returns }).catch(fail('edit'));
      return;
    }
    const trip: AwayPeriod = { id: crypto.randomUUID(), startsOn, endsOn, keep, returns, fromTrip: {} };
    set({ periods: [trip, ...periods] });
    createAwayPeriod(userId, trip).catch((err) => {
      fail('start')(err);
      set({ periods: get().periods.filter((p) => p.id !== trip.id) });
    });
  },

  end: ({ items, routines, todayStr }) => {
    const { userId, periods } = get();
    if (!userId) return;
    const trip = currentAway(periods, todayStr) ?? upcomingAway(periods, todayStr);
    if (!trip) return;
    // Not started yet, or started today: there is nothing to come back from.
    if (trip.startsOn >= todayStr) {
      set({ periods: periods.filter((p) => p.id !== trip.id) });
      deleteAwayPeriod(userId, trip.id).catch(fail('cancel'));
      return;
    }
    const returns = planReturns(items, trip, todayStr, routines);
    set({ periods: replace(periods, { ...trip, endsOn: todayStr, returns }) });
    updateAwayPeriod(userId, trip.id, { endsOn: todayStr, returns }).catch(fail('end'));
  },

  setKeep: (keep, { items, routines, todayStr }) => {
    const { userId, periods } = get();
    if (!userId) return;
    const trip = currentAway(periods, todayStr) ?? upcomingAway(periods, todayStr);
    if (!trip) return;
    const returns = trip.endsOn ? planReturns(items, { ...trip, keep }, trip.endsOn, routines) : {};
    set({ periods: replace(periods, { ...trip, keep, returns }) });
    updateAwayPeriod(userId, trip.id, { keep, returns }).catch(fail('keep'));
  },

  keepItem: (itemId, todayStr) => {
    const { userId, periods } = get();
    if (!userId) return;
    const trip = currentAway(periods, todayStr);
    if (!trip || trip.keep.itemIds.includes(itemId)) return;
    const keep = { ...trip.keep, itemIds: [...trip.keep.itemIds, itemId] };
    set({ periods: replace(periods, { ...trip, keep }) });
    updateAwayPeriod(userId, trip.id, { keep }).catch(fail('keep'));
  },

  bringEverythingBack: (todayStr) => {
    const { userId, periods } = get();
    if (!userId) return;
    const trip = easingAway(periods, todayStr);
    if (!trip) return;
    set({ periods: replace(periods, { ...trip, returns: {} }) });
    updateAwayPeriod(userId, trip.id, { returns: {} }).catch(fail('bring back'));
  },

  settle: async ({ items, routines, todayStr }, unschedule) => {
    const { userId, periods } = get();
    if (!userId) return;
    const trip = periods.find((p) => !!p.endsOn && p.endsOn <= todayStr && !p.settledAt);
    if (!trip) return;
    const tasks = tripTasks(items, trip, routines);
    const fromTrip: Record<string, string> = {};
    for (const t of tasks) fromTrip[t.id] = (t as { startDate?: string }).startDate!.slice(0, 10);
    const nowIso = new Date().toISOString();
    // Claim first. Marking it settled locally before the await keeps a second
    // call in this tab from racing the first.
    set({ periods: replace(periods, { ...trip, settledAt: nowIso, fromTrip }) });
    let won = false;
    try {
      won = await claimAwaySettle(userId, trip.id, fromTrip, nowIso);
    } catch (err) {
      fail('settle')(err);
      set({ periods: replace(get().periods, trip) });
      return;
    }
    if (!won || tasks.length === 0) return;
    const moved = new Set(unschedule(Object.keys(fromTrip)));
    if (moved.size === Object.keys(fromTrip).length) return;
    // Some were not movable (a milestone keeps its target date). Say only what moved.
    const kept: Record<string, string> = {};
    for (const [id, d] of Object.entries(fromTrip)) if (moved.has(id)) kept[id] = d;
    const current = get().periods.find((p) => p.id === trip.id);
    if (current) set({ periods: replace(get().periods, { ...current, fromTrip: kept }) });
    updateAwayPeriod(userId, trip.id, { fromTrip: kept }).catch(fail('settle'));
  },
}));

export { EMPTY_KEEP };

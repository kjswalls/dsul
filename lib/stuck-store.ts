import { create } from 'zustand';
import { fetchMoveEvents } from './db';
import { moveCounts, STUCK_WINDOW_DAYS } from './stuck';

/**
 * How many days each item was moved on, lately (lib/stuck.ts). Memory only,
 * read from the activity feed at most once an hour; the open page draws from
 * it, prep reads it.
 */

const FRESH_MS = 60 * 60 * 1000;

interface StuckState {
  userId: string | null;
  moves: Record<string, number>;
  loadedAt: number;
  load: (userId: string) => Promise<void>;
}

export const useStuckStore = create<StuckState>((set, get) => ({
  userId: null,
  moves: {},
  loadedAt: 0,
  load: async (userId) => {
    if (get().userId !== userId) set({ userId, moves: {}, loadedAt: 0 });
    else if (Date.now() - get().loadedAt < FRESH_MS) return;
    set({ loadedAt: Date.now() });
    const since = new Date(Date.now() - STUCK_WINDOW_DAYS * 86_400_000).toISOString();
    let events: Awaited<ReturnType<typeof fetchMoveEvents>> = [];
    try {
      events = await fetchMoveEvents(since);
    } catch {
      // A trace that can't be read is no moves: prep asks as it always has.
    }
    if (get().userId !== userId) return;
    const counts = moveCounts(events.map((e) => ({ itemId: e.itemId, day: e.createdAt.slice(0, 10) })));
    set({ moves: Object.fromEntries(counts) });
  },
}));

/** The moves of one item, for prep. */
export const movesOf = (itemId: string): number => useStuckStore.getState().moves[itemId] ?? 0;

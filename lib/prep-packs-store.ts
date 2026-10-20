import { create } from 'zustand';
import { PREP_BATCH, type PrepPack } from './prep-packs';

/** How long Not needed can be undone before the pack is deleted for good. */
export const UNDO_MS = 6000;

/**
 * The prep packs the account has, and the asks in flight (lib/prep-packs.ts;
 * /api/ai/prep is the one reader and writer). Memory only: the packs live in
 * the database, and this is the copy the open page draws from.
 *
 * Asked by Do stuff when it starts, while the person's own model answers
 * (`canPrep`). An item is asked about at most once a session, whether or not
 * a pack came back, so starting the mode again never pays twice for the same
 * "nothing to prepare here".
 */

export interface PrepItem {
  id: string;
  title: string;
  notes?: string;
}

interface PrepPacksState {
  /** Whose packs these are; a different account starts over. */
  userId: string | null;
  packs: Record<string, PrepPack>;
  /** False once the server said the table is not there yet (074 unapplied). */
  available: boolean | null;
  loaded: boolean;
  /** Items being prepared right now. */
  preparing: Record<string, true>;
  /** Items asked about this session. */
  tried: Record<string, true>;
  /** The last ask's failure, in our own words, until the next ask. */
  error: string | null;
  load: (userId: string) => Promise<void>;
  prepare: (items: readonly PrepItem[]) => Promise<void>;
  /** Lets a pack go; returns its undo, or null when there was none. */
  dismiss: (itemId: string) => (() => void) | null;
}

const EMPTY = {
  packs: {},
  available: null,
  loaded: false,
  preparing: {},
  tried: {},
  error: null,
};

function byItem(list: readonly PrepPack[]): Record<string, PrepPack> {
  return Object.fromEntries(list.map((p) => [p.itemId, p]));
}

export const usePrepPacksStore = create<PrepPacksState>((set, get) => ({
  userId: null,
  ...EMPTY,

  load: async (userId) => {
    if (get().userId !== userId) set({ userId, ...EMPTY });
    else if (get().loaded) return;
    try {
      const res = await fetch('/api/ai/prep', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { packs?: PrepPack[]; available?: boolean };
      if (get().userId !== userId) return;
      set((s) => ({
        loaded: true,
        available: body.available ?? true,
        packs: { ...byItem(body.packs ?? []), ...s.packs },
      }));
    } catch {
      // Offline or signed out: no packs, and the next start asks again.
    }
  },

  prepare: async (items) => {
    const s = get();
    if (s.available === false) return;
    const ask = items.filter((i) => !s.tried[i.id] && !s.packs[i.id] && !s.preparing[i.id]).slice(0, PREP_BATCH);
    if (ask.length === 0) return;
    const ids = Object.fromEntries(ask.map((i) => [i.id, true as const]));
    set((st) => ({ preparing: { ...st.preparing, ...ids }, tried: { ...st.tried, ...ids }, error: null }));
    const done = () =>
      set((st) => ({
        preparing: Object.fromEntries(Object.entries(st.preparing).filter(([id]) => !ids[id])),
      }));
    try {
      const res = await fetch('/api/ai/prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ask }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        packs?: PrepPack[];
        error?: string;
        available?: boolean;
      };
      if (!res.ok) {
        set({ error: body.error ?? "Couldn't get things ready.", ...(body.available === false ? { available: false } : {}) });
        return;
      }
      set((st) => ({ packs: { ...st.packs, ...byItem(body.packs ?? []) } }));
    } catch {
      set({ error: "Couldn't get things ready." });
    } finally {
      done();
    }
  },

  dismiss: (itemId) => {
    const was = get().packs[itemId];
    if (!was) return null;
    set((s) => {
      const packs = { ...s.packs };
      delete packs[itemId];
      return { packs };
    });
    // The delete waits out the undo: until it goes, Undo only has to put the
    // pack back in memory, and nothing is ever re-written to the server.
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      void (async () => {
        try {
          const res = await fetch(`/api/ai/prep?item=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(String(res.status));
        } catch {
          // Put it back: a pack that comes back on the next load reads as a ghost.
          set((s) => ({ packs: { ...s.packs, [itemId]: was } }));
        }
      })();
    }, UNDO_MS);
    return () => {
      undone = true;
      clearTimeout(timer);
      set((s) => ({ packs: { ...s.packs, [itemId]: was } }));
    };
  },
}));

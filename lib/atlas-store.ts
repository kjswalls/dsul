import { create } from 'zustand';
import { toast } from 'sonner';
import {
  atlasPlaceKey,
  clearAtlasLocalState,
  deleteAtlasPlace,
  fetchAtlasPlaces,
  readLocalPlaces,
  upsertAtlasPlaces,
  writeLocalPlaces,
  type AtlasBand,
  type AtlasFields,
  type AtlasPlace,
} from './atlas-positions';
import { ATLAS_COPY } from './atlas-copy';
import type { AtlasKind } from './atlas-model';

/**
 * Where each Atlas card sits, and Momentum's pins (design D4, PR1b).
 *
 * Positions are not item edits: no planner history, no undo, no
 * syncContainers. So this store is kept apart from planner-store (the
 * away-store pattern), and it is NOT `persist()`ed: the per-device fallback is
 * a raw blob in lib/atlas-positions.ts, cleared with the account through
 * lib/local-state.ts's RAW_CLEARERS, and this memory is reset on SIGNED_OUT by
 * the provider.
 *
 * `mode` says where places live:
 *   - 'unknown': nothing has answered yet (or the first read threw);
 *   - 'account': 087 is applied, places are rows in `atlas_positions`;
 *   - 'device': 087 is missing (42P01 / PGRST205), places are this device's
 *     blob. Latched for the session: a retry would only 404 again, and the
 *     next page load asks again.
 *
 * The rules (design 1.3, map-db §4):
 *   - `load` runs on the first Atlas mount, never at sign-in, and is memoised
 *     per account (one promise in flight), so two mounts never both run the
 *     one-time upload of device places.
 *   - In account mode the first load uploads the device's places the server
 *     lacks, once, then clears the blob: the "087 landed" hand-over.
 *   - A load that THROWS keeps the places and the mode and sets `failed`; it
 *     never drops to device mode on a blip, which would fork the layout.
 *     AtlasView retries on window focus only then.
 *   - A write answering 'unavailable' in account mode latches device mode and
 *     writes the blob (mods-store's writeFailed pattern).
 *   - Every await re-checks that the account (and the store's generation) is
 *     the one it started for.
 *   - No debounce: a drag calls `place` once, on pointerup. Writes go out in
 *     order on one chain, so two quick drags of one card land in order.
 */

export type AtlasMode = 'unknown' | 'account' | 'device';

interface AtlasStore {
  userId: string | null;
  /** By card key, `${kind}:${id}`. */
  places: Record<string, AtlasPlace>;
  mode: AtlasMode;
  /** The first load has answered (true even when it threw). */
  loaded: boolean;
  /** The last load threw. Places are kept; AtlasView retries on focus. */
  failed: boolean;
  load: (userId: string) => Promise<void>;
  /** A card dropped on Your map: optimistic, one write. */
  place: (kind: AtlasKind, id: string, x: number, y: number) => void;
  /** Seeding: the cards Atlas sees for the first time, in one write. */
  placeMany: (places: readonly AtlasPlace[]) => void;
  /** Momentum's pin (PR2). Null on a card with no place forgets the row. */
  pin: (kind: AtlasKind, id: string, band: AtlasBand | null) => void;
  reset: () => void;
}

const INITIAL = {
  userId: null,
  places: {},
  mode: 'unknown',
  loaded: false,
  failed: false,
} satisfies Partial<AtlasStore>;

const index = (list: readonly AtlasPlace[]): Record<string, AtlasPlace> => {
  const out: Record<string, AtlasPlace> = {};
  for (const p of list) out[atlasPlaceKey(p.kind, p.id)] = p;
  return out;
};

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);

/** Bumped by reset(), so an answer for a store that was reset is dropped. */
let generation = 0;
let inflight: { userId: string; generation: number; promise: Promise<void> } | null = null;
let chain: Promise<void> = Promise.resolve();
let fullToastShown = false;

let pending = 0;

/**
 * One write after another. With nothing in flight the request leaves at once
 * (in this tick, so a tab closed right after a drop still sent it); otherwise
 * it waits for the one ahead, so two quick drags of a card land in order.
 */
const enqueue = (job: () => Promise<void>): Promise<void> => {
  pending += 1;
  const start = (): Promise<void> => {
    try {
      return job();
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const run = (pending === 1 ? start() : chain.then(start))
    .catch((err) => console.error('atlas: write failed', err))
    .finally(() => {
      pending -= 1;
    });
  chain = run;
  return run;
};

/** Resolves when every write sent so far has answered (tests; there is nothing queued to flush). */
export function atlasWritesSettled(): Promise<void> {
  return chain;
}

function sayFull() {
  if (fullToastShown) return;
  fullToastShown = true;
  toast(ATLAS_COPY.placesFull);
}

export const useAtlasStore = create<AtlasStore>()((set, get) => {
  const current = (userId: string, gen: number) => get().userId === userId && generation === gen;

  /** Into device mode for the rest of the session, with every place in the blob. */
  const latchDevice = (userId: string) => {
    set({ mode: 'device' });
    writeLocalPlaces(userId, Object.values(get().places));
  };

  /** Send what changed to wherever places live now. */
  const send = (changed: readonly AtlasPlace[], fields: AtlasFields) => {
    const { userId, mode } = get();
    // No account (signed out, a test): the places live in memory only.
    if (!userId || changed.length === 0) return;
    if (mode === 'device') {
      writeLocalPlaces(userId, Object.values(get().places));
      return;
    }
    const gen = generation;
    void enqueue(async () => {
      const res = await upsertAtlasPlaces(changed, undefined, fields);
      if (!current(userId, gen)) return;
      if (res === 'unavailable') latchDevice(userId);
      else if (res === 'full') sayFull();
      else if (res === 'failed') console.error('atlas: saving a place failed');
    });
  };

  const forget = (kind: AtlasKind, id: string) => {
    const { userId, mode } = get();
    if (!userId) return;
    if (mode === 'device') {
      writeLocalPlaces(userId, Object.values(get().places));
      return;
    }
    const gen = generation;
    void enqueue(async () => {
      const res = await deleteAtlasPlace(kind, id);
      if (!current(userId, gen)) return;
      if (res === 'unavailable') latchDevice(userId);
      else if (res === 'failed') console.error('atlas: forgetting a place failed');
    });
  };

  const run = async (userId: string, gen: number): Promise<void> => {
    let rows: AtlasPlace[] | 'unavailable';
    try {
      rows = await fetchAtlasPlaces();
    } catch (err) {
      if (!current(userId, gen)) return;
      console.error('atlas: loading places failed', err);
      set({ failed: true, loaded: true });
      return;
    }
    if (!current(userId, gen)) return;

    const local = readLocalPlaces(userId);
    if (rows === 'unavailable') {
      // 087 is not applied: this device's blob, with anything placed in
      // memory before the answer on top.
      const memory = get().places;
      set({ mode: 'device', loaded: true, failed: false, places: { ...index(local), ...memory } });
      if (Object.keys(memory).length > 0) writeLocalPlaces(userId, Object.values(get().places));
      return;
    }

    const server = index(rows);
    const upload = local.filter((p) => !server[atlasPlaceKey(p.kind, p.id)]);
    // The server is the truth; a device place it lacks is still this
    // person's layout, so it shows while it goes up.
    set({
      mode: 'account',
      loaded: true,
      failed: false,
      places: { ...index(upload), ...get().places, ...server },
    });
    if (local.length === 0) return;
    if (upload.length === 0) {
      clearAtlasLocalState();
      return;
    }
    const res = await upsertAtlasPlaces(upload, undefined, 'all');
    if (!current(userId, gen)) return;
    if (res === 'ok') clearAtlasLocalState();
    else if (res === 'unavailable') latchDevice(userId);
    else if (res === 'full') sayFull();
    // 'failed': the blob stays, and the next page load uploads it again.
  };

  return {
    ...INITIAL,

    load: (userId) => {
      if (inflight && inflight.userId === userId && inflight.generation === generation) return inflight.promise;
      const s = get();
      if (s.userId === userId && s.loaded && !s.failed) return Promise.resolve();
      if (s.mode === 'device' && s.userId === userId) return Promise.resolve();
      if (s.userId !== userId) {
        // Another account's places never show for this one.
        generation += 1;
        set({ ...INITIAL, userId });
      }
      const gen = generation;
      const promise = run(userId, gen).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { userId, generation: gen, promise };
      return promise;
    },

    place: (kind, id, x, y) => {
      if (!finite(x) || !finite(y)) return;
      const key = atlasPlaceKey(kind, id);
      const next: AtlasPlace = { kind, id, x, y, band: get().places[key]?.band ?? null };
      set((s) => ({ places: { ...s.places, [key]: next } }));
      send([next], 'xy');
    },

    placeMany: (list) => {
      const changed: AtlasPlace[] = [];
      const places = { ...get().places };
      for (const p of list) {
        if (p.x === null || p.y === null || !finite(p.x) || !finite(p.y)) continue;
        const key = atlasPlaceKey(p.kind, p.id);
        const next: AtlasPlace = { kind: p.kind, id: p.id, x: p.x, y: p.y, band: places[key]?.band ?? null };
        places[key] = next;
        changed.push(next);
      }
      if (changed.length === 0) return;
      set({ places });
      send(changed, 'xy');
    },

    pin: (kind, id, band) => {
      const key = atlasPlaceKey(kind, id);
      const prev = get().places[key];
      if (band === null && (prev?.x == null || prev?.y == null)) {
        // Nothing left in the row: forget it rather than keep an empty one.
        if (!prev) return;
        set((s) => {
          const places = { ...s.places };
          delete places[key];
          return { places };
        });
        forget(kind, id);
        return;
      }
      const next: AtlasPlace = { kind, id, x: prev?.x ?? null, y: prev?.y ?? null, band };
      set((s) => ({ places: { ...s.places, [key]: next } }));
      send([next], 'band');
    },

    reset: () => {
      generation += 1;
      inflight = null;
      fullToastShown = false;
      set({ ...INITIAL });
    },
  };
});

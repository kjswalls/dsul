import { create } from 'zustand';
import type { AtlasCamera, Point } from './atlas-camera';
import type { AtlasKind } from './atlas-model';

/**
 * Atlas's memory-only UI state (design D3): the camera, the focus sheet, which
 * cards are expanded, and where cards were seeded this session. Not persisted: nothing here outlives the tab. It is still keyed by
 * container ids and remembers whether the map was fitted, so lib/local-state.ts
 * clears it with the account (a raw clearer, {@link clearAtlasUiState}).
 *
 * The focus sheet lives here, never in ui-store's `activeDialog`: that slot is
 * one slot and the open item lives in it, so a sheet there would close the
 * item, and opening a row from the sheet would close the sheet.
 *
 * Where a card was PUT lives in lib/atlas-store.ts (the positions table, or
 * this device's blob until 087 is applied), not here.
 */

/**
 * Walk Atlas (atlas-walk.tsx): where the walk is, and the camera it started
 * from. `key` is the card it stands on, so a layout switch or a filter
 * mid-walk keeps it on that card; `step` is the fallback when the card has
 * gone (and equals the order's length on the closing stop). `returnTo` is
 * the camera as the walk started, re-framed if the layout switches mid-walk.
 */
export interface AtlasWalk {
  step: number;
  key: string | null;
  returnTo: AtlasCamera;
}

export interface AtlasSheet {
  kind: AtlasKind;
  id: string;
  from: { x: number; y: number; width: number; height: number };
}

interface AtlasUiStore {
  camera: AtlasCamera;
  /** False until the first fit; a fresh mount fits to the cards once. */
  fitted: boolean;
  setCamera: (camera: AtlasCamera) => void;
  /**
   * A click's fly-in plays the far zoom handoff as a timed flourish
   * (lib/atlas-motion.ts `flourishAt`): while it runs this holds the handoff
   * shown, 0 to 1, in place of the zoom's own; null otherwise. Memory only.
   */
  flourish: number | null;
  /** One frame of a fly-in: the camera and the flourish in one set. */
  setFlight: (camera: AtlasCamera, flourish: number | null) => void;
  markFitted: () => void;
  /**
   * Bumped by the toolbar's Fit (it lives in the header capsule, away from the
   * view that knows the cards and the viewport); AtlasView fits when it moves.
   */
  fitToken: number;
  requestFit: () => void;
  sheet: AtlasSheet | null;
  openSheet: (kind: AtlasKind, id: string, from: AtlasSheet['from']) => void;
  closeSheet: () => void;
  expanded: Record<string, true>;
  toggleExpanded: (key: string) => void;
  /**
   * Where each card was first seeded this session (lib/atlas-seed.ts). Kept,
   * so a card is seeded once and never jumps when another is dragged near it.
   * With an account that has answered, each seed is also written once
   * (atlas-store `placeMany`), and the stored place wins from then on.
   */
  seeded: Record<string, Point>;
  addSeeded: (places: Record<string, Point>) => void;
  /**
   * The lane a dragged card would land in (PR2), so the lane layer lights it
   * before release without the drag re-rendering any card.
   */
  hotLane: string | null;
  setHotLane: (id: string | null) => void;
  /**
   * The minimap stays on screen (PR3; M, the toggle_atlas_minimap command).
   * Memory only: a session's choice (design Q5).
   */
  minimapPinned: boolean;
  toggleMinimapPinned: () => void;
  /** Walk Atlas, memory only; null while no walk is on. */
  walk: AtlasWalk | null;
  /**
   * A walk that ended asking to go back where it started: AtlasView flies the
   * camera there and clears it. Null otherwise.
   */
  walkHome: AtlasCamera | null;
  /** Starts a walk from the camera as it is now (and closes the focus sheet). */
  startWalk: () => void;
  walkTo: (step: number, key: string | null) => void;
  /** A layout switch mid-walk: Done and Escape go back to the new layout's frame. */
  setWalkReturn: (camera: AtlasCamera) => void;
  /** Ends the walk; with `restore`, asks for the camera it started from. */
  endWalk: (restore: boolean) => void;
  clearWalkHome: () => void;
  reset: () => void;
}

const INITIAL = {
  camera: { x: 0, y: 0, z: 1 },
  flourish: null,
  fitted: false,
  fitToken: 0,
  sheet: null,
  expanded: {},
  seeded: {},
  hotLane: null,
  minimapPinned: false,
  walk: null,
  walkHome: null,
} satisfies Partial<AtlasUiStore>;

export const useAtlasUiStore = create<AtlasUiStore>()((set) => ({
  ...INITIAL,
  // Any other camera move (a pinch, a pan, a fit) ends a flourish at once:
  // the hand takes the handoff back.
  setCamera: (camera) => set((s) => (s.flourish === null ? { camera } : { camera, flourish: null })),
  setFlight: (camera, flourish) => set((s) => (s.camera === camera && s.flourish === flourish ? s : { camera, flourish })),
  markFitted: () => set({ fitted: true }),
  requestFit: () => set((s) => ({ fitToken: s.fitToken + 1 })),
  openSheet: (kind, id, from) => set({ sheet: { kind, id, from } }),
  closeSheet: () => set({ sheet: null }),
  toggleExpanded: (key) =>
    set((s) => {
      const next = { ...s.expanded };
      if (next[key]) delete next[key];
      else next[key] = true;
      return { expanded: next };
    }),
  addSeeded: (places) =>
    set((s) => (Object.keys(places).length === 0 ? s : { seeded: { ...s.seeded, ...places } })),
  setHotLane: (hotLane) => set((s) => (s.hotLane === hotLane ? s : { hotLane })),
  toggleMinimapPinned: () => set((s) => ({ minimapPinned: !s.minimapPinned })),
  startWalk: () => set((s) => ({ walk: { step: 0, key: null, returnTo: s.camera }, walkHome: null, sheet: null })),
  walkTo: (step, key) =>
    set((s) => (!s.walk || (s.walk.step === step && s.walk.key === key) ? s : { walk: { ...s.walk, step, key } })),
  setWalkReturn: (camera) => set((s) => (s.walk ? { walk: { ...s.walk, returnTo: camera } } : s)),
  endWalk: (restore) => set((s) => (s.walk ? { walk: null, walkHome: restore ? s.walk.returnTo : null } : s)),
  clearWalkHome: () => set((s) => (s.walkHome === null ? s : { walkHome: null })),
  reset: () => set({ ...INITIAL }),
}));

/** lib/local-state.ts's raw clearer: sign-out, an account switch, another tab's switch. */
export function clearAtlasUiState(): void {
  useAtlasUiStore.getState().reset();
}

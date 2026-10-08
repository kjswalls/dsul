import { create } from 'zustand';
import { getItemTypeConfig, ALL_ITEM_TYPES } from './item-registry';
import { getBucketForTime } from './time-bucket';
import { repeatPatch } from './item-edit';
import { usePlannerStore } from './planner-store';
import { keepCanvasAdd } from './held-captures';
import { openEditFor, useUIStore } from './ui-store';
import { useSelectionStore } from './selection-store';
import type { ItemTypeDef, Priority } from '@dsul/types';
import { fieldApplies } from './filters';
import type { TimeBucket } from './planner-types';

/**
 * Adding from the planner canvas: a slot on a schedule grid, an Anytime strip,
 * a day in a list. Every surface opens the same composer (a title field drawn
 * in place, components/planner/slot-composer.tsx) and every composer commits
 * through {@link addAt}, so "what does a click at 3:30 on Thursday make" has
 * one answer.
 *
 * The grid's own gesture lives in components/planner/slot-layer.tsx; this file
 * is the part that has no DOM: the geometry, the payload, and the one open
 * composer.
 */

/** The grid's step: a slot starts on a quarter hour, and a sweep moves in quarters. */
export const SLOT_STEP_MIN = 15;

export const floorTo = (min: number, step = SLOT_STEP_MIN) => Math.floor(min / step) * step;
export const ceilTo = (min: number, step = SLOT_STEP_MIN) => Math.ceil(min / step) * step;

/** Minutes since midnight → the stored `HH:mm`. */
export function hhmm(min: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A y offset inside a grid (px from the first hour's top) → minutes since midnight. */
export function minAtY(y: number, gridStartHour: number, hourPx: number): number {
  return gridStartHour * 60 + (y / hourPx) * 60;
}

/**
 * The slot a press at `min` names: the quarter hour it falls in, kept inside
 * the grid so a press on the last row can't start a block past its end.
 */
export function slotStart(min: number, gridStartHour: number, gridEndHour: number): number {
  return Math.max(gridStartHour * 60, Math.min(gridEndHour * 60 - SLOT_STEP_MIN, floorTo(min)));
}

/**
 * The range a drag from `a` to `b` paints, in whole quarters, at least one
 * quarter long, inside the grid. Either direction: dragging up from 5 to 3 is
 * the same 3–5 as dragging down.
 */
export function sweepRange(
  a: number,
  b: number,
  gridStartHour: number,
  gridEndHour: number,
): { startMin: number; duration: number } {
  const lo = Math.max(gridStartHour * 60, floorTo(Math.min(a, b)));
  const hi = Math.min(gridEndHour * 60, Math.max(lo + SLOT_STEP_MIN, ceilTo(Math.max(a, b))));
  return { startMin: lo, duration: hi - lo };
}

/** Where a composer adds. `scope` names the surface that draws it. */
export type SlotTarget =
  | {
      kind: 'grid';
      scope: string;
      dateStr: string;
      startMin: number;
      duration: number;
      /** The lane the slot sits in, when the grid is split into lanes. */
      lane?: { key: string; leftPct: number; rightPct: number };
      /** A container the lane names, seeded onto the new item. */
      project?: string;
      /** A priority the lane names, seeded onto a type that carries one. */
      priority?: Priority;
      /** The type it opens on (the right-click menu picks one). */
      type?: string;
    }
  | {
      kind: 'row';
      scope: string;
      dateStr: string;
      bucket: TimeBucket;
      type?: string;
    };

/**
 * The surface key of a grid and of an Anytime / list row, so each draws only
 * its own composer. A grid's names its view too: Day's grid has lanes and a
 * Week column's does not, so a slot from one must never open in the other.
 */
export const gridScope = (view: 'day' | 'week', dateStr: string) => `grid:${view}:${dateStr}`;
export const rowScope = (where: string, dateStr: string) => `row:${where}:${dateStr}`;

/** The types a composer offers: the built-ins, then the user's own. */
export function addableTypes(itemTypes: ItemTypeDef[]): Array<{ name: string; label: string }> {
  return [...ALL_ITEM_TYPES, ...itemTypes.map((t) => t.name)].map((name) => ({
    name,
    label: getItemTypeConfig(name).label,
  }));
}

/**
 * Create the item a composer was opened for. Returns its id, or undefined when
 * nothing was made (an empty title, an unknown type).
 *
 * The placement rules, in one place:
 *   - A grid slot writes a start time, a length and the bucket that TIME is in,
 *     never 'anytime' — `autoCorrectBucket` leaves 'anytime' alone, so an item
 *     carrying both would sit in Anytime with a time it never shows.
 *   - A row writes its bucket and no time.
 *   - The date goes on only for a type the registry anchors to a date. A habit
 *     is date-blind: made from Thursday's column it lands on every day it
 *     repeats, which is why the composer says "every day" when one is chosen.
 *   - A task without a date is a braindump item, so a dated surface always
 *     passes its date.
 *
 * Until the account's data has landed (over a failed load, where these fields
 * are live), the row is kept by lib/held-captures.ts as a capture's is.
 */
export function addAt(target: SlotTarget, typeName: string, rawTitle: string): string | undefined {
  const title = rawTitle.trim();
  if (!title) return undefined;
  const config = getItemTypeConfig(typeName);
  const store = usePlannerStore.getState();

  const placement =
    target.kind === 'grid'
      ? {
          startTime: hhmm(target.startMin),
          timeBucket: getBucketForTime(hhmm(target.startMin)),
          duration: target.duration,
        }
      : { timeBucket: target.bucket };
  const project = target.kind === 'grid' ? target.project : undefined;
  const priority = target.kind === 'grid' && fieldApplies(typeName, 'priority') ? target.priority : undefined;

  let id: string | undefined;
  if (typeName === 'habit') {
    id = store.addHabit({
      title,
      project,
      ...placement,
      ...repeatPatch('habit', config.defaultFrequency, [], 1),
      timesPerDay: 1,
    });
  } else {
    const fields = {
      title,
      project,
      priority,
      ...placement,
      startDate: config.dateAnchored ? target.dateStr : undefined,
    };
    id = typeName === 'task' ? store.addTask(fields) : store.addItem(typeName, fields);
  }
  // Typed text, like a quick capture: filed over a failed load (or by the blur
  // a click on its Retry makes), the row is kept until a landing settles it,
  // or the Retry's landing would replace the store it was filed on.
  keepCanvasAdd(id);
  return id;
}

/** Open what was just made in the item panel (⇧↵, "add it, then the details"). */
export function openAdded(id: string) {
  const item = usePlannerStore.getState().items.find((i) => i.id === id);
  if (!item) return;
  openEditFor(item as never, item.type === 'habit' ? 'habit' : 'task');
}

/**
 * Is the planner holding something a plain click on empty space should let go
 * of first? A selected row or the open item panel. Then a click on the grid
 * does only that (lib/click-away.ts), and the NEXT click adds.
 */
export function isHolding(): boolean {
  return useSelectionStore.getState().selectedIds.size > 0 || useUIStore.getState().activeDialog?.type === 'edit-item';
}

/**
 * Is a composer open, so a press elsewhere only puts it away? The store's one
 * target, or a persistent add row (which lets the store go as soon as it is
 * focused) holding a typed title: its blur adds that title, and the same click
 * must not also open a second composer.
 */
export function composerIsOpen(): boolean {
  if (useSlotComposer.getState().target) return true;
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  return el instanceof HTMLInputElement && !!el.closest('[data-add-row]') && el.value.trim() !== '';
}

/* ── the one open composer ───────────────────────────────────────────────── */

interface SlotComposerState {
  target: SlotTarget | null;
  open: (target: SlotTarget) => void;
  close: () => void;
}

/**
 * At most one composer is open on the canvas. Opening another closes the
 * first, which is what its own blur does anyway (a typed title is added, an
 * empty one goes).
 */
export const useSlotComposer = create<SlotComposerState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/* ── the slot under the pointer, for the n key ───────────────────────────── */

/**
 * Written by the grid layers and the Anytime strips as the pointer moves, and
 * read only when `n` is pressed. Module state, not a store, for the reason
 * lib/hovered-item.ts gives: a store write per pointer move would re-render
 * every subscriber.
 */
let hoveredSlot: SlotTarget | null = null;

export function setHoveredSlot(target: SlotTarget | null) {
  hoveredSlot = target;
}

/** A surface going away lets go of the slot it wrote, if it is still the hovered one. */
export function clearHoveredSlot(scope: string) {
  if (hoveredSlot?.scope === scope) hoveredSlot = null;
}

/** `n` over a slot or a strip: open the composer there. False when the pointer is over neither. */
export function openHoveredSlot(): boolean {
  // Only while the surface that wrote it is still on the page: a view switch
  // under a resting pointer never fires its pointerleave.
  if (hoveredSlot && typeof document !== 'undefined') {
    const drawn = document.querySelector(`[data-slot-scope="${CSS.escape(hoveredSlot.scope)}"]`);
    if (!drawn) hoveredSlot = null;
  }
  if (!hoveredSlot) return false;
  useSlotComposer.getState().open(hoveredSlot);
  return true;
}

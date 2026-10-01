/**
 * Catalog of LAYOUTS — how the desktop shell is put together.
 *
 * A colour theme (lib/theme-looks.ts) changes how dsul LOOKS; a layout changes
 * where its pieces SIT: it can move one, hide one, or add one. It is a single
 * pick that stays put in light and dark — a per-mode layout would rearrange the
 * screen at sunset for anyone on System — and it only suggests the colour
 * theme it was designed with (`pairsWith`), it never sets it.
 *
 * A layout is config, not code paths, the same way an item type is a registry
 * entry (lib/item-registry.ts). The screen is cut into named SLOTS, and each
 * slot has a short, CLOSED list of variants in LAYOUT_SLOTS. A layout picks one
 * variant per slot; the component that owns a slot asks `useLayoutSlots()`
 * which one to draw. Adding a variant is a deliberate design change, made here
 * and in the one component that draws it — tests/unit/layout-themes.test.ts
 * fails if a layout names a variant that does not exist.
 *
 * Two kinds of slot:
 *   - STRUCTURAL ones (sidebar, capture, canvas) change what mounts where, so
 *     the desktop shell reads them and lays out accordingly.
 *   - STYLED ones (header, buckets, rows, relay) are stamped on the desktop shell's
 *     root as `data-layout-<slot>` (layoutAttributes) and drawn by rules in
 *     app/globals.css. Stamped on the SHELL, not on <html>: that is what keeps
 *     every layout desktop-only for free — the mobile shell is another tree
 *     and never sees the attributes.
 *
 * What no layout may touch: adding, ticking, the item panel, ⌘K, navigation
 * and drag targets. No slot exists for them, so there is nothing to hide them
 * with; a variant that moves a drop target keeps registering the same one.
 */

import type { DarkLook, LightLook } from '@/lib/theme-looks';

/**
 * Every slot, every variant it can take, default first. Planned variants from
 * the design (a drawer sidebar, a top-centre capture bar, ruled rows…) join
 * these lists when a layout that draws them ships — never ahead of it.
 */
export const LAYOUT_SLOTS = {
  /** Where the braindump lives: the resizable left column, or a narrow pane on the right. */
  sidebar: ['left', 'pane-right'],
  /**
   * Where the capture bar lives: the sidebar dock, a prompt across the bottom,
   * or a bare "write a line…" at the foot of the braindump's page.
   */
  capture: ['dock', 'prompt-bottom', 'page-foot'],
  /**
   * The canvas: a rounded plate on the backdrop, flat with hairline seams, or
   * one page of a two-page spread whose other page is the braindump.
   */
  canvas: ['plate', 'flat', 'spread'],
  /** The date and view controls: the capsule, or a serif masthead with no chrome. */
  header: ['capsule', 'masthead'],
  /** A bucket: a card holding its rows, a `## heading` over bare rows, or a small-caps label. */
  buckets: ['cards', 'headings', 'labels'],
  /** A row's tick: the checkbox, a text `[ ]` / `[x]`, or an inked box with a hand-drawn tick on ruled paper. */
  rows: ['rows', 'text', 'ruled'],
  /** The RelayField's motion in the shell. */
  relay: ['on', 'off'],
} as const;

export type LayoutSlot = keyof typeof LAYOUT_SLOTS;
export type SlotVariant<S extends LayoutSlot> = (typeof LAYOUT_SLOTS)[S][number];
export type LayoutSlots = { [S in LayoutSlot]: SlotVariant<S> };

/** Slots drawn by CSS off a `data-layout-<slot>` stamp rather than by a component. */
export const STYLED_SLOTS = ['header', 'buckets', 'rows', 'relay'] as const satisfies readonly LayoutSlot[];

/** Named additions — the only things a layout may add. Closed, like the slots. */
export const LAYOUT_ORNAMENTS = [
  /** A one-line terminal status bar across the top (components/shell/status-line.tsx). */
  'status-line',
  /** Day / Week tabs standing off the right page's edge (components/shell/page-tabs.tsx). */
  'page-tabs',
  /** A ribbon bookmark hanging over the page while it shows today (same file). */
  'ribbon',
] as const;
export type LayoutOrnament = (typeof LAYOUT_ORNAMENTS)[number];

export type LayoutTheme = 'classic' | 'console' | 'notebook';

export interface LayoutDef {
  value: LayoutTheme;
  label: string;
  description: string;
  /** The colour themes it was designed with. Offered on pick, never imposed. */
  pairsWith: { light?: LightLook; dark?: DarkLook };
  slots: LayoutSlots;
  ornaments: readonly LayoutOrnament[];
}

const CLASSIC_SLOTS: LayoutSlots = {
  sidebar: 'left',
  capture: 'dock',
  canvas: 'plate',
  header: 'capsule',
  buckets: 'cards',
  rows: 'rows',
  relay: 'on',
};

export const LAYOUTS: LayoutDef[] = [
  {
    value: 'classic',
    label: 'Classic',
    description: 'Braindump on the left, the day on a plate. The shipped layout.',
    pairsWith: {},
    slots: CLASSIC_SLOTS,
    ornaments: [],
  },
  {
    value: 'console',
    label: 'Console',
    description: 'The planner as a terminal: a status line, a prompt at the bottom, text rows.',
    pairsWith: { dark: 'terminal' },
    slots: {
      sidebar: 'pane-right',
      capture: 'prompt-bottom',
      canvas: 'flat',
      header: 'capsule',
      buckets: 'headings',
      rows: 'text',
      relay: 'off',
    },
    ornaments: ['status-line'],
  },
  {
    value: 'notebook',
    label: 'Notebook',
    description: 'A paper planner open on the desk: the braindump on the left page, the day on the right.',
    pairsWith: { light: 'paper' },
    slots: {
      sidebar: 'left',
      capture: 'page-foot',
      canvas: 'spread',
      header: 'masthead',
      buckets: 'labels',
      rows: 'ruled',
      relay: 'off',
    },
    ornaments: ['page-tabs', 'ribbon'],
  },
];

export const DEFAULT_LAYOUT: LayoutTheme = 'classic';

/**
 * Raw localStorage key — a bare string, same reason as LOOK_STORAGE_KEYS: the
 * `?reset-theme` escape hatch in app/layout.tsx clears it before hydration.
 */
export const LAYOUT_STORAGE_KEY = 'dsul-layout';

export function isLayoutTheme(value: unknown): value is LayoutTheme {
  return typeof value === 'string' && LAYOUTS.some((l) => l.value === value);
}

export function layoutDef(value: LayoutTheme): LayoutDef {
  return LAYOUTS.find((l) => l.value === value) ?? LAYOUTS[0];
}

/**
 * The stamps for the desktop shell's root: `data-layout` names the layout (for
 * tests and devtools — no CSS keys on it), and one `data-layout-<slot>` per
 * styled slot that is off its default. A default variant is the absence of its
 * attribute, so Classic stamps nothing but its name.
 */
export function layoutAttributes(def: LayoutDef): Record<string, string> {
  const attrs: Record<string, string> = { 'data-layout': def.value };
  for (const slot of STYLED_SLOTS) {
    const variant = def.slots[slot];
    if (variant !== LAYOUT_SLOTS[slot][0]) attrs[`data-layout-${slot}`] = variant;
  }
  return attrs;
}

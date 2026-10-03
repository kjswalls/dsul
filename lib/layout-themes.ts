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
 *   - STRUCTURAL ones (sidebar, capture, canvas, tabs) change what mounts where,
 *     so the desktop shell reads them and lays out accordingly.
 *   - STYLED ones (header, buckets, rows, relay, type, skin) are stamped on the desktop shell's
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
   * a bare "write a line…" at the foot of the braindump's page, or the same
   * line drawn as a text editor's caret.
   */
  capture: ['dock', 'prompt-bottom', 'page-foot', 'caret'],
  /**
   * The canvas: a rounded plate on the backdrop, flat with hairline seams,
   * one page of a two-page spread whose other page is the braindump, or one
   * document holding both, framed by the window's chrome.
   */
  canvas: ['plate', 'flat', 'spread', 'sheet'],
  /**
   * A strip of day tabs across the top of the window (components/shell/day-tabs.tsx):
   * none, plain dates, or dates written as `.md` or `.txt` file names.
   */
  tabs: ['none', 'days', 'md', 'txt'],
  /**
   * The date and view controls: the capsule, a serif masthead with no chrome,
   * or the same controls as plain monospaced text.
   */
  header: ['capsule', 'masthead', 'plain'],
  /**
   * A bucket: a card holding its rows, a `## heading` over bare rows, a
   * small-caps label, a `── Morning ───` rule, a markdown `## Morning` with no
   * glyph, or a bold all-caps line.
   */
  buckets: ['cards', 'headings', 'labels', 'rules', 'markdown', 'caps', 'focus'],
  /**
   * A row's tick: the checkbox, a text `[ ]` / `[x]`, an inked box with a
   * hand-drawn tick on ruled paper, a markdown task `- [ ]`, or a hairline
   * circle that fills with the accent.
   */
  rows: ['rows', 'text', 'ruled', 'tasks', 'round'],
  /** The RelayField's motion in the shell. */
  relay: ['on', 'off'],
  /**
   * The shell's typeface: the colour theme's own, or one monospace face for
   * everything — IBM Plex Mono, JetBrains Mono, or the system's.
   */
  type: ['ui', 'plex', 'jetbrains', 'mono', 'dm'],
  /**
   * The shell's colours: the colour theme's, or the layout's own — `retro` is
   * white paper on light grey chrome with a blue accent, in both modes.
   */
  skin: ['theme', 'retro'],
  /** The canvas's reading width: the usual 1100px cap, or one narrow column. */
  measure: ['full', 'narrow'],
  /**
   * What sits on the closed braindump's edge (the sidebar's expand zone): the
   * small grip, or a `braindump` tab standing off the edge like a drawer pull.
   */
  edge: ['grip', 'tab'],
} as const;

export type LayoutSlot = keyof typeof LAYOUT_SLOTS;
export type SlotVariant<S extends LayoutSlot> = (typeof LAYOUT_SLOTS)[S][number];
export type LayoutSlots = { [S in LayoutSlot]: SlotVariant<S> };

/** Slots drawn by CSS off a `data-layout-<slot>` stamp rather than by a component. */
export const STYLED_SLOTS = [
  'header',
  'buckets',
  'rows',
  'relay',
  'type',
  'skin',
  'measure',
  'edge',
] as const satisfies readonly LayoutSlot[];

/** Named additions — the only things a layout may add. Closed, like the slots. */
export const LAYOUT_ORNAMENTS = [
  /** A one-line terminal status bar across the top (components/shell/status-line.tsx). */
  'status-line',
  /** Day / Week tabs standing off the right page's edge (components/shell/page-tabs.tsx). */
  'page-tabs',
  /** A ribbon bookmark hanging over the page while it shows today (same file). */
  'ribbon',
  /** An editor's status bar across the bottom, counting the day (components/shell/status-bar.tsx). */
  'status-bar',
  /** The day's count as one quiet centred line at the foot of the page (same file). */
  'page-count',
] as const;
export type LayoutOrnament = (typeof LAYOUT_ORNAMENTS)[number];

export type LayoutTheme =
  | 'classic'
  | 'console'
  | 'notebook'
  | 'notepad'
  | 'notepad-markdown'
  | 'notepad-retro'
  | 'writer';

/**
 * A layout can come in STYLES: the same arrangement drawn a few ways (Notepad's
 * Quiet, Markdown and Retro). Each style is a layout of its own here, with its
 * own slots and its own slug in user_settings.layout, so nothing downstream
 * learns a second concept; `family` only groups them for Settings, which lists
 * one Layout per family and puts the styles under Style.
 */
export interface LayoutDef {
  value: LayoutTheme;
  label: string;
  description: string;
  /** The family's lead layout — its own value for a lead. The lead comes first in LAYOUTS. */
  family: LayoutTheme;
  /** The style's name under Style. Every member of a family with styles has one. */
  styleLabel?: string;
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
  tabs: 'none',
  type: 'ui',
  skin: 'theme',
  measure: 'full',
  edge: 'grip',
};

/**
 * Notepad: the braindump and the day as two plain-text documents side by side
 * in one sheet, the days as tabs across the top, an editor's status bar along
 * the bottom. Its styles differ only in how the text is drawn.
 */
const NOTEPAD_SLOTS: LayoutSlots = {
  sidebar: 'left',
  capture: 'caret',
  canvas: 'sheet',
  tabs: 'days',
  header: 'plain',
  buckets: 'rules',
  rows: 'text',
  relay: 'off',
  type: 'plex',
  skin: 'theme',
  measure: 'full',
  edge: 'grip',
};

export const LAYOUTS: LayoutDef[] = [
  {
    value: 'classic',
    label: 'Classic',
    description: 'Braindump on the left, the day on a plate. The shipped layout.',
    family: 'classic',
    pairsWith: {},
    slots: CLASSIC_SLOTS,
    ornaments: [],
  },
  {
    value: 'console',
    label: 'Console',
    description: 'The planner as a terminal: a status line, a prompt at the bottom, text rows.',
    family: 'console',
    pairsWith: { dark: 'terminal' },
    slots: {
      sidebar: 'pane-right',
      capture: 'prompt-bottom',
      canvas: 'flat',
      tabs: 'none',
      header: 'capsule',
      buckets: 'headings',
      rows: 'text',
      relay: 'off',
      type: 'ui',
      skin: 'theme',
      measure: 'full',
      edge: 'grip',
    },
    ornaments: ['status-line'],
  },
  {
    value: 'notebook',
    label: 'Notebook',
    description: 'A paper planner open on the desk: the braindump on the left page, the day on the right.',
    family: 'notebook',
    pairsWith: { light: 'paper' },
    slots: {
      sidebar: 'left',
      capture: 'page-foot',
      canvas: 'spread',
      tabs: 'none',
      header: 'masthead',
      buckets: 'labels',
      rows: 'ruled',
      relay: 'off',
      type: 'ui',
      skin: 'theme',
      measure: 'full',
      edge: 'grip',
    },
    ornaments: ['page-tabs', 'ribbon'],
  },
  {
    value: 'notepad',
    label: 'Notepad',
    description: 'Your day as plain text: the braindump and today side by side, days as tabs.',
    family: 'notepad',
    styleLabel: 'Quiet',
    pairsWith: {},
    slots: NOTEPAD_SLOTS,
    ornaments: ['status-bar'],
  },
  {
    value: 'notepad-markdown',
    label: 'Notepad, Markdown',
    description: 'Buckets as ## headings, items as - [ ] tasks, days as .md files.',
    family: 'notepad',
    styleLabel: 'Markdown',
    pairsWith: {},
    slots: { ...NOTEPAD_SLOTS, tabs: 'md', buckets: 'markdown', rows: 'tasks', type: 'jetbrains' },
    ornaments: ['status-bar'],
  },
  {
    value: 'notepad-retro',
    label: 'Notepad, Retro',
    description: 'White paper, grey chrome and a blue caret, with days as .txt files.',
    family: 'notepad',
    styleLabel: 'Retro',
    pairsWith: {},
    slots: { ...NOTEPAD_SLOTS, tabs: 'txt', buckets: 'caps', type: 'mono', skin: 'retro' },
    ornaments: ['status-bar'],
  },
  {
    value: 'writer',
    label: 'Writer',
    description: 'One quiet column of type. The bucket you are in stays in ink, the braindump is a drawer.',
    family: 'writer',
    pairsWith: {},
    slots: {
      sidebar: 'left',
      capture: 'caret',
      canvas: 'sheet',
      tabs: 'none',
      header: 'plain',
      buckets: 'focus',
      rows: 'round',
      relay: 'off',
      type: 'dm',
      skin: 'theme',
      measure: 'narrow',
      edge: 'tab',
    },
    ornaments: ['page-count'],
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

/** One entry per family, its lead: what Settings → Look → Layout lists. */
export const LAYOUT_FAMILIES: LayoutDef[] = LAYOUTS.filter((l) => l.family === l.value);

/** A family's styles, lead first. One entry for a layout without styles. */
export function layoutStyles(family: LayoutTheme): LayoutDef[] {
  return LAYOUTS.filter((l) => l.family === family);
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

/**
 * The top padding of the canvas header row, and of the rail's header beside
 * it: 31px lines the date capsule up with the left column's braindump header;
 * with the braindump elsewhere there is nothing to meet. Shared, so both rows
 * start at the same y; railHeaderRowOffset then puts the rail's controls on
 * the date's line.
 */
export function canvasHeaderPad(slots: Pick<LayoutSlots, 'sidebar'>): string {
  return slots.sidebar === 'left' ? 'pt-[31px]' : 'pt-4';
}

/**
 * Where the rail header's 32px row starts under that shared padding, so its
 * centre is the date's: the capsule's date row sits under the capsule's own
 * p-2 (components/canvas/header-capsule.tsx), and the masthead and plain
 * headers zero that padding (app/globals.css), putting the date at the top.
 */
export function railHeaderRowOffset(slots: Pick<LayoutSlots, 'header'>): string {
  return slots.header === 'capsule' ? 'mt-2' : 'mt-0';
}

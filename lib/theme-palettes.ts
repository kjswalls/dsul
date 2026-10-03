/**
 * Catalog of the preset ground palettes ("Look → Palette" in settings).
 *
 * Each entry is backed by a pair of mode-scoped CSS blocks in app/globals.css
 * (`:root[data-theme='slug']:not(.dark)` / `:root[data-theme='slug'].dark`) —
 * tests/unit/theme-palettes.test.ts fails if this list and those blocks drift.
 * Palettes re-tint the GROUND only (paper/ink ramps + ground-hued literals);
 * the lime accent is deliberately not part of a palette — it is the brand, and
 * its never-dim contract lives in the base theme blocks.
 *
 * 'default' is the absence of a stamp: applying it removes data-theme so the
 * bare :root / .dark blocks answer. This is dsul's shipped look, so it never
 * needs its own CSS block.
 */

export type ThemePalette = 'default' | 'slate' | 'dune' | 'iris';

export interface ThemePaletteDef {
  value: ThemePalette;
  label: string;
  description: string;
  /**
   * <meta name="theme-color"> values per mode — hex approximations of the
   * palette's --paper-0, because browser chrome does not reliably parse oklch.
   * The default pair mirrors the static values in app/layout.tsx viewport.
   */
  themeColor: { light: string; dark: string };
}

export const THEME_PALETTES: ThemePaletteDef[] = [
  {
    value: 'default',
    label: 'dsul',
    description: 'Warm paper and cool ink. The shipped look.',
    themeColor: { light: '#fbfaf9', dark: '#0e1014' },
  },
  {
    value: 'slate',
    label: 'Slate',
    description: 'A cool blue-gray ground.',
    themeColor: { light: '#f3f5f8', dark: '#0f1420' },
  },
  {
    value: 'dune',
    label: 'Dune',
    description: 'Warm sand; the paper leans into its own hue.',
    themeColor: { light: '#f8f4eb', dark: '#161210' },
  },
  {
    value: 'iris',
    label: 'Iris',
    description: 'A faint violet ground.',
    themeColor: { light: '#f7f3f9', dark: '#151021' },
  },
];

export const DEFAULT_PALETTE: ThemePalette = 'default';

/**
 * The raw localStorage key the pre-hydration script in app/layout.tsx reads.
 * Stored as a bare string (not a zustand blob) so that script stays a
 * three-line try/catch. `?reset-theme` in the URL clears it before first paint.
 */
export const PALETTE_STORAGE_KEY = 'dsul-palette';

export function isThemePalette(value: unknown): value is ThemePalette {
  return (
    typeof value === 'string' && THEME_PALETTES.some((palette) => palette.value === value)
  );
}

export function paletteDef(value: ThemePalette): ThemePaletteDef {
  return THEME_PALETTES.find((palette) => palette.value === value) ?? THEME_PALETTES[0];
}

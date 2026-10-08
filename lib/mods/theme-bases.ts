import type { ColorKey, ThemeMode, ThemeTokens } from './theme-grammar';

/**
 * The six built-in themes as token values: what a user theme falls back to for
 * every token it leaves unset (memory/plans/mods.md, "Themes and Looks").
 *
 * Each value is the one app/globals.css gives that theme: its own block, else
 * the mode's base block (`:root` for light, `.dark` over `:root` for dark).
 * tests/unit/theme-bases.test.ts reads the CSS and fails on any drift.
 *
 * A token missing from `tokens` is one the CSS writes as a var() or
 * color-mix() chain (Paper's `--primary-foreground: var(--lime-ink)`). The
 * grammar cannot print those, and does not need to: left unprinted, the
 * shipped chain resolves through the theme's own values. `same` is the one
 * chain worth keeping by name, an Ask ink that is its partner colour.
 */

export type ThemeBaseId = 'paper' | 'studio' | 'sorbet' | 'night' | 'terminal' | 'dusk';

export interface ThemeBase {
  mode: ThemeMode;
  tokens: ThemeTokens;
  same: Partial<Record<ColorKey, ColorKey>>;
  /**
   * The waiting shimmer's contrast floor for this theme, as a percentage of
   * full ink mixed into the muted ink (`--planner-shimmer-level`, app/globals.css,
   * "The floor"). MEASURED from pixels in every view, not computed — so a user
   * theme, which nobody measured, inherits it (shimmerLevelFor in
   * theme-grammar.ts). The light and dark mode defaults are Paper's and
   * Night's, since those are the mode base blocks.
   */
  shimmerLevel: number;
}

/** The theme whose block IS the mode's base block: `:root` for light, `.dark` for dark. */
export const MODE_BASE = { light: 'paper', dark: 'night' } as const satisfies Record<ThemeMode, ThemeBaseId>;

/** What a palette (a tint) re-tints. A user theme always prints these, so no tint shows through. */
export const TINT_GROUND_KEYS = [
  'paper0',
  'paper1',
  'paper2',
  'paper3',
  'paperWell',
  'ink0',
  'ink1',
  'ink2',
  'accent',
  'border',
  'input',
  'rowSelected',
  'scrim',
  'sidebarBorder',
] as const satisfies readonly ColorKey[];

const STUDIO_FG = 'oklch(0.99 0 0)';
const SORBET_FG = 'oklch(0.28 0.08 0)';
const DARK_SCRIM = 'oklch(0 0 0 / 30%)';

export const THEME_BASES: Record<ThemeBaseId, ThemeBase> = {
  paper: {
    mode: 'light',
    tokens: {
      paper0: 'oklch(0.986 0.0012 90)',
      paper1: 'oklch(0.99 0.001 90)',
      paper2: 'oklch(0.996 0 0)',
      paper3: 'oklch(1 0 0)',
      paperWell: 'oklch(0.945 0.0015 90)',
      ink0: 'oklch(0.24 0.01 272)',
      ink1: 'oklch(0.5 0.02 272)',
      ink2: 'oklch(0.66 0.03 272)',
      limeSolid: 'oklch(0.86 0.17 125)',
      limeInk: 'oklch(0.32 0.07 130)',
      limeTint: 'oklch(0.95 0.05 125)',
      accent: 'oklch(0.22 0.012 272 / 4%)',
      border: 'oklch(0.9 0.008 272)',
      input: 'oklch(0.86 0.012 272)',
      rowSelected: 'oklch(0.22 0.012 272 / 9%)',
      scrim: 'oklch(0.22 0.012 272 / 12%)',
      sidebarBorder: 'oklch(0.915 0.005 85)',
      askIconPair: 'oklch(0.64 0.1 195)',
      radius: 16,
      shadows: 'paper',
      font: 'inter',
    },
    same: {},
    shimmerLevel: 30,
  },
  studio: {
    mode: 'light',
    tokens: {
      paper0: 'oklch(0.975 0 0)',
      paper1: 'oklch(0.98 0 0)',
      paper2: 'oklch(1 0 0)',
      paper3: 'oklch(1 0 0)',
      paperWell: 'oklch(0.955 0 0)',
      ink0: 'oklch(0.17 0 0)',
      ink1: 'oklch(0.43 0 0)',
      ink2: 'oklch(0.6 0 0)',
      limeSolid: 'oklch(0.55 0.2 262)',
      limeInk: 'oklch(0.46 0.19 262)',
      limeTint: 'oklch(0.95 0.03 262)',
      primaryForeground: STUDIO_FG,
      successForeground: STUDIO_FG,
      priorityLowForeground: STUDIO_FG,
      sidebarPrimaryForeground: STUDIO_FG,
      accent: 'oklch(0.17 0 0 / 4%)',
      border: 'oklch(0.9 0 0)',
      input: 'oklch(0.85 0 0)',
      rowSelected: 'oklch(0.55 0.2 262 / 9%)',
      scrim: 'oklch(0.17 0 0 / 12%)',
      sidebarBorder: 'oklch(0.91 0 0)',
      askIconPair: 'oklch(0.65 0.13 225)',
      radius: 8,
      shadows: 'studio',
      font: 'geist',
      relayLight: [
        'oklch(0.55 0.2 262)',
        'oklch(0.55 0.2 262)',
        'oklch(0.62 0.16 250)',
        'oklch(0.48 0.18 270)',
        'oklch(0.4 0 0)',
        'oklch(0.55 0 0)',
        'oklch(0.65 0.13 225)',
        'oklch(0.5 0 0)',
        'oklch(0.58 0.18 262)',
      ],
      relayLightQuiet: [
        'oklch(0.42 0 0)',
        'oklch(0.5 0 0)',
        'oklch(0.58 0 0)',
        'oklch(0.46 0 0)',
        'oklch(0.54 0 0)',
        'oklch(0.55 0.2 262)',
        'oklch(0.55 0.2 262)',
        'oklch(0.65 0.13 225)',
        'oklch(0.48 0.18 270)',
      ],
    },
    same: { askIconPairInk: 'askIconPair' },
    shimmerLevel: 13,
  },
  sorbet: {
    mode: 'light',
    tokens: {
      paper0: 'oklch(0.965 0.018 50)',
      paper1: 'oklch(0.972 0.016 50)',
      paper2: 'oklch(0.985 0.01 55)',
      paper3: 'oklch(0.997 0.004 55)',
      paperWell: 'oklch(0.935 0.026 45)',
      ink0: 'oklch(0.3 0.04 20)',
      ink1: 'oklch(0.5 0.05 25)',
      ink2: 'oklch(0.64 0.05 30)',
      limeSolid: 'oklch(0.72 0.15 0)',
      limeInk: 'oklch(0.5 0.16 0)',
      limeTint: 'oklch(0.94 0.04 0)',
      primaryForeground: SORBET_FG,
      successForeground: SORBET_FG,
      priorityLowForeground: SORBET_FG,
      sidebarPrimaryForeground: SORBET_FG,
      accent: 'oklch(0.4 0.08 20 / 5%)',
      border: 'oklch(0.9 0.025 40)',
      input: 'oklch(0.86 0.03 35)',
      rowSelected: 'oklch(0.72 0.15 0 / 12%)',
      scrim: 'oklch(0.35 0.05 20 / 14%)',
      sidebarBorder: 'oklch(0.91 0.02 40)',
      askIconPair: 'oklch(0.64 0.15 18)',
      radius: 20,
      shadows: 'sorbet',
      font: 'nunito',
      relayLight: [
        'oklch(0.72 0.15 0)',
        'oklch(0.72 0.15 0)',
        'oklch(0.78 0.12 50)',
        'oklch(0.8 0.12 85)',
        'oklch(0.72 0.1 170)',
        'oklch(0.7 0.11 300)',
        'oklch(0.76 0.12 340)',
        'oklch(0.78 0.1 140)',
        'oklch(0.74 0.13 30)',
      ],
      relayLightQuiet: [
        'oklch(0.8 0.04 40)',
        'oklch(0.74 0.05 35)',
        'oklch(0.84 0.03 45)',
        'oklch(0.78 0.04 30)',
        'oklch(0.72 0.15 0)',
        'oklch(0.72 0.15 0)',
        'oklch(0.78 0.12 50)',
        'oklch(0.72 0.1 170)',
        'oklch(0.7 0.11 300)',
      ],
    },
    same: {},
    shimmerLevel: 30,
  },
  night: {
    mode: 'dark',
    tokens: {
      paper0: 'oklch(0.173 0.009 264)',
      paper1: 'oklch(0.178 0.008 268)',
      paper2: 'oklch(0.21 0.006 286)',
      paper3: 'oklch(0.278 0.006 286)',
      paperWell: 'oklch(0.245 0.006 286)',
      ink0: 'oklch(0.955 0.002 286)',
      ink1: 'oklch(0.8 0.005 286)',
      ink2: 'oklch(0.7 0.008 286)',
      limeSolid: 'oklch(0.87 0.19 125)',
      limeInk: 'oklch(0.26 0.06 130)',
      limeTint: 'oklch(0.32 0.05 125)',
      accent: 'oklch(1 0 0 / 6%)',
      border: 'oklch(1 0 0 / 10%)',
      input: 'oklch(1 0 0 / 8%)',
      rowSelected: 'oklch(1 0 0 / 12%)',
      scrim: DARK_SCRIM,
      sidebarBorder: 'oklch(1 0 0 / 8%)',
      askIconPair: 'oklch(0.84 0.12 190)',
      radius: 16,
      shadows: 'night',
      font: 'inter',
    },
    same: { askIconPairInk: 'askIconPair' },
    shimmerLevel: 45,
  },
  terminal: {
    mode: 'dark',
    tokens: {
      paper0: 'oklch(0 0 0)',
      paper1: 'oklch(0.04 0 0)',
      paper2: 'oklch(0.11 0 0)',
      paper3: 'oklch(0.18 0 0)',
      paperWell: 'oklch(0.15 0 0)',
      ink0: 'oklch(0.9 0.07 75)',
      ink1: 'oklch(0.77 0.08 72)',
      ink2: 'oklch(0.63 0.07 70)',
      limeSolid: 'oklch(0.8 0.15 70)',
      limeInk: 'oklch(0.2 0.04 70)',
      limeTint: 'oklch(0.27 0.05 70)',
      accent: 'oklch(0.8 0.15 70 / 8%)',
      border: 'oklch(0.8 0.15 70 / 22%)',
      input: 'oklch(0.8 0.15 70 / 18%)',
      rowSelected: 'oklch(0.8 0.15 70 / 14%)',
      scrim: DARK_SCRIM,
      sidebarBorder: 'oklch(0.8 0.15 70 / 18%)',
      askIconPair: 'oklch(0.86 0.12 90)',
      radius: 4,
      shadows: 'terminal',
      font: 'jetbrains',
      relayDark: [
        'oklch(0.8 0.15 70)',
        'oklch(0.8 0.15 70)',
        'oklch(0.8 0.15 70)',
        'oklch(0.72 0.14 60)',
        'oklch(0.68 0.15 45)',
        'oklch(0.86 0.12 90)',
        'oklch(0.62 0.12 55)',
        'oklch(0.75 0.13 80)',
        'oklch(0.7 0.14 65)',
      ],
    },
    same: { askIconPairInk: 'askIconPair' },
    shimmerLevel: 24,
  },
  dusk: {
    mode: 'dark',
    tokens: {
      paper0: 'oklch(0.17 0.04 285)',
      paper1: 'oklch(0.18 0.042 285)',
      paper2: 'oklch(0.215 0.045 285)',
      paper3: 'oklch(0.29 0.045 288)',
      paperWell: 'oklch(0.255 0.045 286)',
      ink0: 'oklch(0.95 0.015 300)',
      ink1: 'oklch(0.82 0.03 295)',
      ink2: 'oklch(0.7 0.04 290)',
      limeSolid: 'oklch(0.8 0.12 55)',
      limeInk: 'oklch(0.25 0.05 40)',
      limeTint: 'oklch(0.33 0.06 50)',
      accent: 'oklch(1 0 0 / 6%)',
      border: 'oklch(1 0 0 / 10%)',
      input: 'oklch(1 0 0 / 9%)',
      rowSelected: 'oklch(0.8 0.12 55 / 14%)',
      scrim: DARK_SCRIM,
      sidebarBorder: 'oklch(1 0 0 / 8%)',
      askIconPair: 'oklch(0.76 0.12 350)',
      radius: 18,
      shadows: 'dusk',
      font: 'inter',
      relayDark: [
        'oklch(0.8 0.12 55)',
        'oklch(0.8 0.12 55)',
        'oklch(0.76 0.13 30)',
        'oklch(0.75 0.12 350)',
        'oklch(0.7 0.13 310)',
        'oklch(0.68 0.12 280)',
        'oklch(0.82 0.1 80)',
        'oklch(0.72 0.1 220)',
        'oklch(0.8 0.12 55)',
      ],
    },
    same: { askIconPairInk: 'askIconPair' },
    shimmerLevel: 51,
  },
};

/** The tokens a base leaves to the shipped chain (unprinted unless the theme sets them). */
export function chainedKeys(base: ThemeBaseId, keys: readonly ColorKey[]): ColorKey[] {
  const b = THEME_BASES[base];
  return keys.filter((k) => b.tokens[k] === undefined && b.same[k] === undefined);
}

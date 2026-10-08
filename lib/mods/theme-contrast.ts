import { contrast, parseColor, type Color } from './color';
import { effectiveColor, type ColorKey, type ThemeManifest, type ThemeMode } from './theme-grammar';

/**
 * The pairs the built-in themes put text on, and how much contrast each needs
 * (memory/plans/mods.md, "Themes and Looks"). A failure is a warning: the
 * editor says it and will save anyway once asked to (`contrastOverride`).
 *
 * The minimums sit at WCAG's where the built-ins meet them. Muted text on the
 * well is 2.5, under Paper's own 2.7: the hints there are decoration, and a
 * bar higher than Paper clears would warn on dsul's own look.
 * tests/unit/theme-contrast.test.ts checks every built-in passes.
 */

export interface ContrastPair {
  fg: ColorKey;
  bg: ColorKey;
  min: number;
  label: string;
}

const ON_ACCENT = (['primaryForeground', 'successForeground', 'priorityLowForeground', 'sidebarPrimaryForeground'] as const).map(
  (fg) => ({ fg, bg: 'limeSolid' as const, min: 4.5, label: 'Text on the accent' })
);

const SHARED: ContrastPair[] = [
  { fg: 'ink0', bg: 'paper0', min: 4.5, label: 'Text on the backdrop' },
  { fg: 'ink0', bg: 'paper1', min: 4.5, label: 'Text in the sidebar' },
  { fg: 'ink1', bg: 'paper1', min: 4.5, label: 'Secondary text in the sidebar' },
  { fg: 'ink0', bg: 'paper2', min: 4.5, label: 'Text on the page' },
  { fg: 'ink0', bg: 'paper3', min: 4.5, label: 'Text on cards' },
  { fg: 'ink0', bg: 'paperWell', min: 4.5, label: 'Text on the well' },
  { fg: 'ink1', bg: 'paper2', min: 4.5, label: 'Secondary text on the page' },
  { fg: 'ink1', bg: 'paper3', min: 4.5, label: 'Secondary text on cards' },
  { fg: 'ink1', bg: 'paperWell', min: 4.5, label: 'Secondary text on the well' },
  { fg: 'ink2', bg: 'paper2', min: 3, label: 'Muted text on the page' },
  { fg: 'ink2', bg: 'paperWell', min: 2.5, label: 'Muted text on the well' },
  ...ON_ACCENT,
];

/**
 * Accent as text: light mode writes it in --lime-ink, dark mode in the fill
 * itself (dark's --success-text is var(--lime-solid)).
 */
export const CONTRAST_PAIRS: Record<ThemeMode, ContrastPair[]> = {
  light: [
    ...SHARED,
    { fg: 'limeInk', bg: 'paper2', min: 4.5, label: 'Accent text on the page' },
    // Light only: the dark built-ins draw the wash near their ground (about
    // 1.2 to 1), and put no accent text on it.
    { fg: 'limeInk', bg: 'limeTint', min: 4.5, label: 'Accent text on the accent wash' },
  ],
  dark: [...SHARED, { fg: 'limeSolid', bg: 'paper2', min: 4.5, label: 'Accent text on the page' }],
};

/** The four on-fill foregrounds follow --lime-ink wherever the base leaves them chained. */
const CHAIN: Partial<Record<ColorKey, ColorKey>> = {
  primaryForeground: 'limeInk',
  successForeground: 'limeInk',
  priorityLowForeground: 'limeInk',
  sidebarPrimaryForeground: 'limeInk',
};

/** A token's colour as the page would draw it, chains resolved. */
export function resolvedColor(m: Pick<ThemeManifest, 'base' | 'tokens'>, key: ColorKey): Color | null {
  const v = effectiveColor(m, key);
  if (v !== null) return parseColor(v);
  const next = CHAIN[key];
  return next ? resolvedColor(m, next) : null;
}

export interface ContrastWarning {
  fg: ColorKey;
  bg: ColorKey;
  label: string;
  ratio: number;
  min: number;
}

/** One warning per pair that falls short, deduplicated by label. */
export function contrastWarnings(m: Pick<ThemeManifest, 'mode' | 'base' | 'tokens'>): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  const seen = new Set<string>();
  for (const pair of CONTRAST_PAIRS[m.mode]) {
    const fg = resolvedColor(m, pair.fg);
    const bg = resolvedColor(m, pair.bg);
    if (!fg || !bg) continue;
    const ratio = contrast(fg, bg);
    if (ratio + 1e-9 >= pair.min || seen.has(pair.label)) continue;
    seen.add(pair.label);
    out.push({ fg: pair.fg, bg: pair.bg, label: pair.label, ratio: Math.round(ratio * 10) / 10, min: pair.min });
  }
  return out;
}

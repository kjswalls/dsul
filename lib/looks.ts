/**
 * Catalog of LOOKS: a layout with the colours it was made with.
 *
 * A look is not a fourth setting. It names a combination of three that already
 * exist (the layout, the light theme, the dark theme) and sets them in one tap
 * on Settings → Look. Nothing about it is stored: whether a look is on, or on
 * with a colour changed since ("Edited"), is worked out from the picks every
 * time it is drawn.
 *
 * Its colours are its layout's `pairsWith` (lib/layout-themes.ts), the same
 * pairing the theme swatches mark "for Console", so the two can never
 * disagree. A pairing names only the modes the layout cares about, and a look
 * leaves the other mode's pick alone: Console brings Terminal for the night and
 * keeps your light theme for the day. A layout with its own colours (Notepad's
 * Retro skin) pairs with nothing and still makes a look.
 *
 * Applying one never touches the mode. Following the device stays following.
 */

import { layoutDef, type LayoutDef, type LayoutTheme } from '@/lib/layout-themes';
import { darkLookDef, lightLookDef, type DarkLook, type LightLook } from '@/lib/theme-looks';

export interface LookPreset {
  /** Stable id, for keys and test ids. Never stored. */
  id: string;
  /** The name on the card. */
  label: string;
  /** The exact layout slug, a style included: Retro is `notepad-retro`. */
  layout: LayoutTheme;
}

export const LOOKS: readonly LookPreset[] = [
  { id: 'dsul', label: 'dsul', layout: 'classic' },
  { id: 'console', label: 'Console', layout: 'console' },
  { id: 'notebook', label: 'Notebook', layout: 'notebook' },
  { id: 'retro', label: 'Retro', layout: 'notepad-retro' },
];

/** The colours a look sets: its layout's pairing. */
export function lookColours(look: LookPreset): LayoutDef['pairsWith'] {
  return layoutDef(look.layout).pairsWith;
}

/** Whether a look brings its own colours (a skin), so the themes rest under it. */
export function lookHasOwnColours(look: LookPreset): boolean {
  return layoutDef(look.layout).slots.skin !== 'theme';
}

/**
 * The card's line, from the pairing itself so it cannot drift from what a tap
 * does: "Classic on Paper and Night", "Terminal at night, your light by day".
 */
export function lookBlurb(look: LookPreset): string {
  const def = layoutDef(look.layout);
  const family = layoutDef(def.family).label;
  if (lookHasOwnColours(look)) return `${family} in its own colours`;
  const { light, dark } = def.pairsWith;
  if (light && dark) {
    return `${family} on ${lightLookDef(light).label} and ${darkLookDef(dark).label}`;
  }
  if (dark) return `${darkLookDef(dark).label} at night, your light by day`;
  if (light) return `${lightLookDef(light).label} by day, your dark at night`;
  return `${family} in your colours`;
}

export interface LookPicks {
  layout: LayoutTheme;
  light: LightLook;
  dark: DarkLook;
}

/**
 * 'on'     the layout is the look's, and so is every colour it pairs with.
 * 'edited' the layout is the look's, and a colour it set has been changed.
 * 'off'    another layout, or another style of it.
 */
export type LookState = 'on' | 'edited' | 'off';

export function lookState(look: LookPreset, picks: LookPicks): LookState {
  if (picks.layout !== look.layout) return 'off';
  const { light, dark } = lookColours(look);
  if ((light && picks.light !== light) || (dark && picks.dark !== dark)) return 'edited';
  return 'on';
}

/**
 * What applying a look changes: the layout, and the theme for each mode it
 * pairs with. The caller writes the stores and the one settings patch; kept
 * pure so the arithmetic is testable without either.
 */
export function lookChanges(look: LookPreset): {
  layout: LayoutTheme;
  light?: LightLook;
  dark?: DarkLook;
} {
  const { light, dark } = lookColours(look);
  return { layout: look.layout, ...(light && { light }), ...(dark && { dark }) };
}

export function lookById(id: string): LookPreset | undefined {
  return LOOKS.find((l) => l.id === id);
}

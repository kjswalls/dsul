/**
 * Catalog of THEMES — one per mode, chosen independently.
 *
 * Light / dark / system stays the mode (next-themes, the `.dark` class). A
 * theme sits UNDER a mode: you pick one light theme and one dark theme, and
 * whichever mode is showing uses its own pick. Both picks are kept, so
 * switching mode and back finds the theme you left there.
 *
 * Where a palette (lib/theme-palettes.ts) only re-tints the ground, a theme
 * owns the whole look: ground, ink, the accent, fonts, corner radius, shadows
 * and the RelayField's colours. Each non-default entry is backed by one
 * mode-scoped CSS block in app/globals.css —
 *   light: `:root[data-look-light='slug']:not(.dark)`
 *   dark:  `:root[data-look-dark='slug'].dark`
 * — and tests/unit/theme-looks.test.ts fails if the two drift. Both attributes
 * stay stamped on <html> at all times, so a mode switch needs no JS: the CSS
 * picks the block for whichever mode is showing.
 *
 * The defaults (Paper, Night) are dsul's shipped look and need no block; they
 * are the only themes the ground palettes (Slate, Dune, Iris) tint. A theme's
 * accent inherits the lime's contract: it never dims.
 */

import { isUserThemeSlug, userTheme } from '@/lib/user-themes/store';

export type LightLook = 'paper' | 'studio' | 'sorbet';
export type DarkLook = 'night' | 'terminal' | 'dusk';
export type LookMode = 'light' | 'dark';

/**
 * A pick: a built-in theme, or one of your own (`u-<8 hex>`, lib/user-themes/).
 * The pick is what is saved; what shows is `resolveLightPick(pick)`, which
 * falls back to the default while that theme is off, deleted, not loaded yet
 * or in safe mode, and never throws the saved pick away.
 */
export type LightPick = LightLook | `u-${string}`;
export type DarkPick = DarkLook | `u-${string}`;

export interface LookDef<T extends string = string> {
  value: T;
  label: string;
  description: string;
  /**
   * <meta name="theme-color"> for this theme's mode — a hex approximation of
   * its --paper-0, because browser chrome does not reliably parse oklch.
   * Null on the defaults: they defer to the ground palette's colour.
   */
  themeColor: string | null;
}

export const LIGHT_LOOKS: LookDef<LightLook>[] = [
  {
    value: 'paper',
    label: 'Paper',
    description: 'Warm paper, cool ink and lime. The shipped look.',
    themeColor: null,
  },
  {
    value: 'studio',
    label: 'Studio',
    description: 'Crisp white, black ink, hairlines and a cobalt accent.',
    themeColor: '#f7f7f7',
  },
  {
    value: 'sorbet',
    label: 'Sorbet',
    description: 'Pastel peach, big round corners and a pink accent.',
    themeColor: '#fef0e9',
  },
];

export const DARK_LOOKS: LookDef<DarkLook>[] = [
  {
    value: 'night',
    label: 'Night',
    description: 'Near-black with lime that glows. The shipped look.',
    themeColor: null,
  },
  {
    value: 'terminal',
    label: 'Terminal',
    description: 'True black, monospace type, square corners and amber.',
    themeColor: '#000000',
  },
  {
    value: 'dusk',
    label: 'Dusk',
    description: 'Deep indigo, soft round corners and an apricot accent.',
    themeColor: '#0e0c20',
  },
];

export const DEFAULT_LIGHT_LOOK: LightLook = 'paper';
export const DEFAULT_DARK_LOOK: DarkLook = 'night';

/**
 * Raw localStorage keys the pre-hydration script in app/layout.tsx reads —
 * bare strings, same reason as PALETTE_STORAGE_KEY.
 */
export const LOOK_STORAGE_KEYS: Record<LookMode, string> = {
  light: 'dsul-look-light',
  dark: 'dsul-look-dark',
};

/** The <html> attribute each mode's pick is stamped on. */
export const LOOK_ATTRIBUTES: Record<LookMode, string> = {
  light: 'data-look-light',
  dark: 'data-look-dark',
};

export function isLightLook(value: unknown): value is LightLook {
  return typeof value === 'string' && LIGHT_LOOKS.some((look) => look.value === value);
}

export function isDarkLook(value: unknown): value is DarkLook {
  return typeof value === 'string' && DARK_LOOKS.some((look) => look.value === value);
}

/** A built-in, or anything shaped like a user theme's slug: what a store may hold. */
export function isLightPickShape(value: unknown): value is LightPick {
  return isLightLook(value) || isUserThemeSlug(value);
}

export function isDarkPickShape(value: unknown): value is DarkPick {
  return isDarkLook(value) || isUserThemeSlug(value);
}

/** A built-in, or an enabled user theme of this mode that the registry holds now. */
export function isLightPick(value: unknown): value is LightPick {
  return isLightLook(value) || !!userTheme(value, 'light');
}

export function isDarkPick(value: unknown): value is DarkPick {
  return isDarkLook(value) || !!userTheme(value, 'dark');
}

/** What shows for a pick: itself when it can, else the default. */
export function resolveLightPick(pick: unknown): LightPick {
  return isLightPick(pick) ? pick : DEFAULT_LIGHT_LOOK;
}

export function resolveDarkPick(pick: unknown): DarkPick {
  return isDarkPick(pick) ? pick : DEFAULT_DARK_LOOK;
}

const OWN_DESCRIPTION = 'Your own theme, made in Settings → Make.';

/**
 * A pick's catalog entry, from the merged registry: a built-in, else a user
 * theme with its own name and chrome colour, so a `u-` slug never borrows
 * Paper's. Paper only when the theme is missing.
 */
export function lightLookDef(value: LightPick): LookDef<LightPick> {
  const builtIn = LIGHT_LOOKS.find((look) => look.value === value);
  if (builtIn) return builtIn;
  const own = userTheme(value, 'light');
  if (own) return { value: own.slug as LightPick, label: own.label, description: OWN_DESCRIPTION, themeColor: own.themeColor };
  return LIGHT_LOOKS[0];
}

export function darkLookDef(value: DarkPick): LookDef<DarkPick> {
  const builtIn = DARK_LOOKS.find((look) => look.value === value);
  if (builtIn) return builtIn;
  const own = userTheme(value, 'dark');
  if (own) return { value: own.slug as DarkPick, label: own.label, description: OWN_DESCRIPTION, themeColor: own.themeColor };
  return DARK_LOOKS[0];
}

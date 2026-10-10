import { useMemo } from 'react';
import { useModsStore } from '@/lib/mods-store';
import { LookManifestSchema, ThemeManifestSchema, modLabel, type LookManifest, type UserMod } from '@/lib/mods/schema';
import { layoutDef, type LayoutTheme } from '@/lib/layout-themes';
import {
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  darkLookDef,
  isDarkLook,
  isLightLook,
  lightLookDef,
  resolveDarkPick,
  resolveLightPick,
  type DarkPick,
  type LightPick,
  type LookMode,
} from '@/lib/theme-looks';
import { DRAFT_SLUG, isUserThemeSlug, themeSlugForId } from '@/lib/user-themes/css';
import type { LookPicks } from '@/lib/looks';

/**
 * Your own Looks (memory/plans/mods.md, "Themes and Looks", build order 5b):
 * a shipped layout with a light and a dark theme, beside the built-in
 * LookPresets of lib/looks.ts, with its own apply (applyUserLook in
 * lib/settings/manifest.ts) and its own state.
 *
 * Like a built-in Look, nothing about one is stored on the device: it is a
 * set of three picks, written as picks, and whether it is on is worked out
 * from the saved picks each time it is drawn. A theme it names that is off or
 * held back by safe mode is still written by its slug and shows the default
 * for that side until it is back, and the picker says so; one that is gone
 * lands as the default.
 */

/**
 * A Look's ref: `u-` and the first 8 hex digits of its row id, as a theme's
 * slug is, and never the owner-writable `slug` column. The same shape as a
 * theme slug but a separate namespace: a Look ref only ever appears in a
 * recipe's applyLook step, a theme slug only in a pick or a setTheme step.
 */
export const isUserLookRef = isUserThemeSlug;
export const lookRefForId = themeSlugForId;

export interface UserLook {
  id: string;
  ref: string;
  /** The row's name (modLabel). */
  label: string;
  layout: LayoutTheme;
  light: LightPick;
  dark: DarkPick;
}

/** Enabled Look rows, parsed. None in safe mode; the older row keeps a shared ref; in name order. */
export function userLooksFromRows(rows: readonly UserMod[], safeMode: boolean): UserLook[] {
  if (safeMode) return [];
  const seen = new Set<string>();
  const out: UserLook[] = [];
  const ordered = rows
    .filter((r) => r.kind === 'look' && r.enabled)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const ref = lookRefForId(row.id);
    if (!isUserLookRef(ref) || ref === DRAFT_SLUG || seen.has(ref)) continue;
    const parsed = LookManifestSchema.safeParse(row.manifest);
    if (!parsed.success) continue;
    seen.add(ref);
    const m = parsed.data;
    out.push({ id: row.id, ref, label: modLabel(row), layout: m.layout, light: m.light, dark: m.dark });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
}

/** The enabled Looks, for the picker and the recipe builder. */
export function useUserLooks(): UserLook[] {
  const rows = useModsStore((s) => s.rows);
  const safeMode = useModsStore((s) => s.safeMode);
  return useMemo(() => userLooksFromRows(rows, safeMode), [rows, safeMode]);
}

/**
 * The name for a Look ref the enabled list does not hold: its row's name,
 * marked "(off)" when it is switched off, or "A Look you deleted" when no
 * row has it. A row that is on but unlisted (safe mode) keeps its bare name.
 */
export function unlistedLookLabel(ref: string, rows: readonly UserMod[]): string {
  const row = rows.find((r) => r.kind === 'look' && lookRefForId(r.id) === ref);
  if (!row) return 'A Look you deleted';
  return row.enabled ? modLabel(row) : `${modLabel(row)} (off)`;
}

/** An enabled Look by its ref, now. Undefined in safe mode, or when it is off or gone. */
export function userLookByRef(ref: string): UserLook | undefined {
  const { rows, safeMode } = useModsStore.getState();
  return userLooksFromRows(rows, safeMode).find((l) => l.ref === ref);
}

export interface OwnTheme {
  slug: string;
  /** The row's name (modLabel). */
  label: string;
  enabled: boolean;
}

/**
 * The owner's theme rows of one mode, switched off included, from mods-store's
 * rows rather than the theme registry: the rows are there in safe mode and
 * before the registry has caught up, and a row says off from gone. Where two
 * rows share a slug the one the registry would show wins (enabled, then older).
 */
export function ownThemesOfMode(rows: readonly UserMod[], mode: LookMode): OwnTheme[] {
  const seen = new Set<string>();
  const out: OwnTheme[] = [];
  const ordered = rows
    .filter((r) => r.kind === 'theme')
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  for (const row of ordered) {
    const slug = themeSlugForId(row.id);
    if (!isUserThemeSlug(slug) || slug === DRAFT_SLUG || seen.has(slug)) continue;
    const parsed = ThemeManifestSchema.safeParse(row.manifest);
    if (!parsed.success || parsed.data.mode !== mode) continue;
    seen.add(slug);
    out.push({ slug, label: modLabel(row), enabled: row.enabled });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
}

/** True for a built-in of that mode, or a `u-` slug naming one of the owner's themes of that mode, on or off. */
export function isOwnedPick(value: string, mode: LookMode, rows: readonly UserMod[]): boolean {
  if (!isUserThemeSlug(value)) return mode === 'light' ? isLightLook(value) : isDarkLook(value);
  return ownThemesOfMode(rows, mode).some((t) => t.slug === value);
}

/**
 * What applying the Look writes: its layout, and each side as a pick, the way
 * the theme rows write one. A theme of yours is written by its slug even while
 * it is off, since what shows is resolved at paint (lib/look-store.ts: a theme
 * that is off never costs the saved pick); only a ref that names none of your
 * themes of that mode lands as the default. Asked of mods-store's rows, never
 * the theme registry, so a registry still on its cache (or empty) cannot
 * decide what is saved.
 */
export function userLookChanges(
  look: Pick<UserLook, 'layout' | 'light' | 'dark'>,
  rows: readonly UserMod[] = useModsStore.getState().rows
): LookPicks {
  return {
    layout: look.layout,
    light: isOwnedPick(look.light, 'light', rows) ? look.light : DEFAULT_LIGHT_LOOK,
    dark: isOwnedPick(look.dark, 'dark', rows) ? look.dark : DEFAULT_DARK_LOOK,
  };
}

/** What the Look shows now, each theme resolved: for its preview and its line. */
export function userLookShows(look: Pick<UserLook, 'layout' | 'light' | 'dark'>): LookPicks {
  return { layout: look.layout, light: resolveLightPick(look.light), dark: resolveDarkPick(look.dark) };
}

/** Which sides resolve to something other than what the Look names. */
export function userLookFallbacks(look: Pick<UserLook, 'light' | 'dark'>): { light: boolean; dark: boolean } {
  return { light: resolveLightPick(look.light) !== look.light, dark: resolveDarkPick(look.dark) !== look.dark };
}

/**
 * 'on' when the saved layout and picks (as saved, `u-` slugs included) are
 * what applying the Look would write. A user Look has no "edited": two of
 * them can share a layout, and an edited mark would then show on both.
 */
export function userLookState(
  look: UserLook,
  saved: LookPicks,
  rows: readonly UserMod[] = useModsStore.getState().rows
): 'on' | 'off' {
  const want = userLookChanges(look, rows);
  return saved.layout === want.layout && saved.light === want.light && saved.dark === want.dark ? 'on' : 'off';
}

/** The card's line: "Notepad, Retro in its own colours", "Classic on Paper and Moss". */
export function userLookBlurb(look: UserLook): string {
  const def = layoutDef(look.layout);
  if (def.slots.skin !== 'theme') return `${def.label} in its own colours`;
  const { light, dark } = userLookShows(look);
  return `${def.label} on ${lightLookDef(light).label} and ${darkLookDef(dark).label}`;
}

/** A quiet line when a theme the Look names is not showing, else null. */
export function userLookFallbackNote(look: UserLook): string | null {
  const gone = userLookFallbacks(look);
  const paper = lightLookDef(DEFAULT_LIGHT_LOOK).label;
  const night = darkLookDef(DEFAULT_DARK_LOOK).label;
  if (gone.light && gone.dark) return `Its themes are off or gone, so ${paper} and ${night} show.`;
  if (gone.light) return `Its light theme is off or gone, so ${paper} shows by day.`;
  if (gone.dark) return `Its dark theme is off or gone, so ${night} shows at night.`;
  return null;
}

/**
 * At save: a `u-` side must name one of the owner's themes of that mode. It
 * may be switched off (it then shows the default until it is on again).
 */
export function lookRefProblems(m: LookManifest, rows: readonly UserMod[]): string[] {
  const problems: string[] = [];
  if (!isOwnedPick(m.light, 'light', rows)) problems.push('Pick a light theme.');
  if (!isOwnedPick(m.dark, 'dark', rows)) problems.push('Pick a dark theme.');
  return problems;
}

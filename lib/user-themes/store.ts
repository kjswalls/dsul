import { create } from 'zustand';
import {
  SHIMMER_LEVEL_VAR,
  ThemeManifestSchema,
  isPrintedDecl,
  printTheme,
  shimmerLevelForDecls,
  type Decl,
  type ThemeMode,
} from '@/lib/mods/theme-grammar';
import { modLabel, type UserMod } from '@/lib/mods/schema';
import { DRAFT_SLUG, USER_THEME_CACHE_KEY, isUserThemeSlug, themeSlugForId, type UserThemeCss } from './css';

/**
 * The registry of the signed-in person's user themes (memory/plans/mods.md,
 * "Themes and Looks"): enabled theme rows, parsed and printed. lib/theme-looks.ts
 * reads it to resolve a `u-` pick; <ThemeInjector> writes it to a stylesheet.
 *
 * No Supabase here. The rows come from mods-store by way of the injector; until
 * they arrive (and on a cold load) the registry is the localStorage cache,
 * which holds only declarations the host printed, each checked again on read
 * against PREPAINT_TABLE. A bad entry is dropped whole. Safe mode starts it
 * empty and never writes the cache.
 */

export { USER_THEME_CACHE_KEY };

export interface UserThemeDef extends UserThemeCss {
  slug: string;
  mode: ThemeMode;
  /** The row's name. "Your theme" until rows arrive (the cache holds no labels). */
  label: string;
  /** `#rrggbb`, for <meta name="theme-color">. */
  themeColor: string;
  decls: Decl[];
}

interface UserThemesState {
  themes: Record<string, UserThemeDef>;
  /** The editor's draft: preview twin only, never live. */
  draft: UserThemeCss | null;
  /** Bumped on every change to `themes`, for effects that resolve a pick. */
  rev: number;
  source: 'none' | 'cache' | 'rows';
}

const HEX6 = /^#[0-9a-f]{6}$/;

function safeModeOn(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('safe-mode');
  } catch {
    return false;
  }
}

interface CacheEntry {
  s: string;
  m: ThemeMode;
  c: string;
  d: Decl[];
}

/** One cached entry, or null when any part of it is not what the host writes. */
function entryFromCache(raw: unknown): UserThemeDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<CacheEntry>;
  if (!isUserThemeSlug(e.s) || (e.m !== 'light' && e.m !== 'dark')) return null;
  if (typeof e.c !== 'string' || !HEX6.test(e.c) || !Array.isArray(e.d)) return null;
  const decls: Decl[] = [];
  for (const d of e.d) {
    if (!Array.isArray(d) || d.length !== 2 || !isPrintedDecl(d[0], d[1])) return null;
    decls.push([d[0], d[1]]);
  }
  // Printed by a build with no waiting-shimmer level (main's before the instant
  // planner): the mode's level would stand in, under the floor for a Dusk copy
  // or a theme with its own inks. In memory only; the rows reprint the cache.
  if (!decls.some(([name]) => name === SHIMMER_LEVEL_VAR)) {
    decls.push([SHIMMER_LEVEL_VAR, `${shimmerLevelForDecls(e.m, decls)}%`]);
  }
  return { slug: e.s, mode: e.m, label: 'Your theme', themeColor: e.c, decls };
}

export function readUserThemeCache(): Record<string, UserThemeDef> {
  const out: Record<string, UserThemeDef> = {};
  if (typeof window === 'undefined') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(window.localStorage.getItem(USER_THEME_CACHE_KEY) ?? 'null');
  } catch {
    return out;
  }
  const t = (parsed as { v?: unknown; t?: unknown } | null)?.t;
  if ((parsed as { v?: unknown } | null)?.v !== 1 || !Array.isArray(t)) return out;
  for (const raw of t) {
    const def = entryFromCache(raw);
    if (def && !out[def.slug]) out[def.slug] = def;
  }
  return out;
}

function writeCache(themes: Record<string, UserThemeDef>): void {
  try {
    const t: CacheEntry[] = Object.values(themes).map((d) => ({ s: d.slug, m: d.mode, c: d.themeColor, d: d.decls }));
    if (t.length === 0) window.localStorage.removeItem(USER_THEME_CACHE_KEY);
    else window.localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t }));
  } catch {
    // Private mode: the next cold load paints the default until rows arrive.
  }
}

/** Enabled theme rows, parsed and printed; the older row keeps a shared id prefix. */
export function themesFromRows(rows: readonly UserMod[]): Record<string, UserThemeDef> {
  const out: Record<string, UserThemeDef> = {};
  const ordered = rows
    .filter((r) => r.kind === 'theme' && r.enabled)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const slug = themeSlugForId(row.id);
    if (!isUserThemeSlug(slug) || slug === DRAFT_SLUG || out[slug]) continue;
    const parsed = ThemeManifestSchema.safeParse(row.manifest);
    if (!parsed.success) continue;
    const printed = printTheme(parsed.data);
    out[slug] = { slug, mode: printed.mode, label: modLabel(row), themeColor: printed.themeColor, decls: printed.decls };
  }
  return out;
}

export const useUserThemes = create<UserThemesState>(() => {
  const themes = safeModeOn() ? {} : readUserThemeCache();
  return { themes, draft: null, rev: 0, source: Object.keys(themes).length > 0 ? 'cache' : 'none' };
});

/** From mods-store's rows. Safe mode empties the registry and leaves the cache alone. */
export function setUserThemesFromRows(rows: readonly UserMod[], safeMode: boolean): void {
  const themes = safeMode ? {} : themesFromRows(rows);
  if (!safeMode) writeCache(themes);
  useUserThemes.setState((s) => ({ themes, source: 'rows', rev: s.rev + 1 }));
}

/**
 * The editor's live preview, or null to clear it. Leaves `rev` alone: the draft
 * is a preview twin only, so no live pick, meta or relay depends on it.
 */
export function setUserThemeDraft(draft: UserThemeCss | null): void {
  useUserThemes.setState({ draft });
}

/** An enabled user theme of that mode, or undefined. */
export function userTheme(slug: unknown, mode: ThemeMode): UserThemeDef | undefined {
  if (!isUserThemeSlug(slug)) return undefined;
  const def = useUserThemes.getState().themes[slug];
  return def && def.mode === mode ? def : undefined;
}

/** Account switch and sign-out (lib/local-state.ts RAW_CLEARERS): the cache and the registry. */
export function clearUserThemeCache(): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(USER_THEME_CACHE_KEY);
  } finally {
    useUserThemes.setState((s) => ({ themes: {}, draft: null, source: 'none', rev: s.rev + 1 }));
  }
}

export { isUserThemeSlug };

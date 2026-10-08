import { isPrintedDecl, PREPAINT_TABLE, type Decl, type ThemeMode } from '@/lib/mods/theme-grammar';

/**
 * The stylesheet a user theme becomes (memory/plans/mods.md, "Injection").
 * Pure. Shared by <ThemeInjector> and, as JSON, by the pre-paint script, so
 * the rules a cold load writes are the rules the app writes.
 *
 * Weight: the root rule repeats its attribute, (0,4,0), so it beats a tint left
 * stamped on <html> ((0,3,0)) whatever order the stylesheets land in. The Ask
 * partner rule is the one that wins by order instead, wrapped in :where() so
 * it ties the base rule for its mode and Notepad Retro's partner still beats it.
 */

/** The localStorage cache of printed themes (lib/user-themes/store.ts), read before paint. */
export const USER_THEME_CACHE_KEY = 'dsul-user-themes';

/** A user theme's CSS slug: `u-` and the first 8 hex digits of its row id. */
export const USER_THEME_SLUG_RE = /^u-[0-9a-f]{8}$/;

/** The editor's live preview. Never a row's slug (setFromRows skips it). */
export const DRAFT_SLUG = 'u-00000000';

export function themeSlugForId(id: string): string {
  return `u-${id.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

export function isUserThemeSlug(value: unknown): value is `u-${string}` {
  return typeof value === 'string' && USER_THEME_SLUG_RE.test(value);
}

const ASK = ':is([data-ask-opener],[data-ask-mark])';

/** `%s` is the slug. Shapes per mode, as the built-in blocks in app/globals.css scope theirs. */
export const USER_THEME_SELECTORS: Record<ThemeMode, { root: string; body: string; ask: string; preview: string }> = {
  light: {
    root: ":root[data-look-light='%s'][data-look-light='%s']:not(.dark)",
    body: ":root[data-look-light='%s'][data-look-light='%s']:not(.dark) body",
    ask: `:where(:root[data-look-light='%s']:not(.dark)) ${ASK}`,
    preview: "[data-theme-preview][data-preview-light='%s'][data-preview-light='%s']:not(.dark)",
  },
  dark: {
    root: ":root[data-look-dark='%s'][data-look-dark='%s'].dark",
    body: ":root[data-look-dark='%s'][data-look-dark='%s'].dark body",
    ask: `:where(:root[data-look-dark='%s']).dark ${ASK}`,
    preview: "[data-theme-preview][data-preview-dark='%s'][data-preview-dark='%s'].dark",
  },
};

export interface UserThemeCss {
  slug: string;
  mode: ThemeMode;
  decls: readonly Decl[];
}

const rule = (selector: string, slug: string, decls: Decl[]) =>
  decls.length === 0 ? '' : `${selector.split('%s').join(slug)}{${decls.map(([k, v]) => `${k}:${v}`).join(';')}}\n`;

/**
 * One theme's rules. Null when the slug or any declaration is not one the host
 * prints, so a hostile value costs its theme, never the page.
 */
export function rulesFor(theme: UserThemeCss, opts: { live: boolean; preview: boolean }): string | null {
  if (!isUserThemeSlug(theme.slug) || (theme.mode !== 'light' && theme.mode !== 'dark')) return null;
  const by: Record<'root' | 'body' | 'ask', Decl[]> = { root: [], body: [], ask: [] };
  for (const decl of theme.decls) {
    if (!Array.isArray(decl) || !isPrintedDecl(decl[0], decl[1])) return null;
    by[PREPAINT_TABLE[decl[0]].scope].push([decl[0], decl[1]]);
  }
  const sel = USER_THEME_SELECTORS[theme.mode];
  let css = '';
  if (opts.live) css += rule(sel.root, theme.slug, by.root) + rule(sel.body, theme.slug, by.body) + rule(sel.ask, theme.slug, by.ask);
  if (opts.preview) css += rule(sel.preview, theme.slug, [...by.root, ...by.body]);
  return css;
}

/**
 * The whole sheet: each theme's live rules (and, with `preview`, its twin for
 * Settings → Look's previews), then the editor's draft, preview twin only and
 * last, so it wins over a saved theme's twin.
 */
export function composeUserThemeCss(
  themes: readonly UserThemeCss[],
  opts: { preview: boolean; draft?: UserThemeCss | null }
): string {
  let css = '';
  for (const t of themes) css += rulesFor(t, { live: true, preview: opts.preview }) ?? '';
  if (opts.draft) css += rulesFor(opts.draft, { live: false, preview: true }) ?? '';
  return css;
}

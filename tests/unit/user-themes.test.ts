import { describe, it, expect, beforeEach } from 'vitest';
import {
  USER_THEME_CACHE_KEY,
  clearUserThemeCache,
  readUserThemeCache,
  setUserThemesFromRows,
  themesFromRows,
  useUserThemes,
} from '@/lib/user-themes/store';
import { themeSlugForId } from '@/lib/user-themes/css';
import {
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  darkLookDef,
  isLightPick,
  isLightPickShape,
  lightLookDef,
  resolveDarkPick,
  resolveLightPick,
} from '@/lib/theme-looks';
import type { UserMod } from '@/lib/mods/schema';

/** The user-theme registry (lib/user-themes/store.ts) and how a pick resolves against it. */

const LIGHT = { version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa' }, themeColor: '#eeeeee' };
const DARK = { version: 1, mode: 'dark', base: 'night', tokens: {} };

function row(over: Partial<UserMod>): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: 'u',
    kind: 'theme',
    slug: 'x',
    name: 'Moss',
    enabled: true,
    manifest: LIGHT,
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
});

describe('from rows', () => {
  it('takes enabled theme rows only, and drops a manifest that fails the grammar', () => {
    const on = row({ name: 'Moss' });
    const off = row({ enabled: false });
    const recipe = row({ kind: 'recipe' });
    const bad = row({ manifest: { ...LIGHT, tokens: { paper0: 'url(x)' } } });
    const themes = themesFromRows([on, off, recipe, bad]);
    expect(Object.keys(themes)).toEqual([themeSlugForId(on.id)]);
    expect(themes[themeSlugForId(on.id)]).toMatchObject({ label: 'Moss', mode: 'light', themeColor: '#eeeeee' });
  });

  it('the slug comes from the id, never the owner-written slug column', () => {
    const r = row({ id: 'abcdef01-2345-4678-9abc-def012345678', slug: 'moss' });
    expect(Object.keys(themesFromRows([r]))).toEqual(['u-abcdef01']);
  });

  it('two rows sharing an id prefix: the older wins, the other is dropped', () => {
    const older = row({ id: 'abcdef01-0000-4000-8000-000000000001', name: 'Older', createdAt: '2026-01-01T00:00:00Z' });
    const newer = row({ id: 'abcdef01-0000-4000-8000-000000000002', name: 'Newer', createdAt: '2026-02-01T00:00:00Z' });
    expect(themesFromRows([newer, older])['u-abcdef01'].label).toBe('Older');
  });

  it('writes the cache, which reads back the same, labels aside', () => {
    const r = row({});
    setUserThemesFromRows([r], false);
    const cached = readUserThemeCache();
    const live = useUserThemes.getState().themes;
    expect(Object.keys(cached)).toEqual(Object.keys(live));
    const slug = themeSlugForId(r.id);
    expect(cached[slug].decls).toEqual(live[slug].decls);
    expect(JSON.parse(localStorage.getItem(USER_THEME_CACHE_KEY)!).t[0]).not.toHaveProperty('label');
  });

  it('safe mode: an empty registry, and the cache left as it was', () => {
    setUserThemesFromRows([row({})], false);
    const before = localStorage.getItem(USER_THEME_CACHE_KEY);
    setUserThemesFromRows([row({})], true);
    expect(useUserThemes.getState().themes).toEqual({});
    expect(localStorage.getItem(USER_THEME_CACHE_KEY)).toBe(before);
  });
});

describe('from the cache', () => {
  it('drops an entry with any value the grammar does not print', () => {
    const r = row({});
    setUserThemesFromRows([r], false);
    const raw = JSON.parse(localStorage.getItem(USER_THEME_CACHE_KEY)!);
    raw.t.push({ s: 'u-12345678', m: 'light', c: '#ffffff', d: [['--paper-0', 'url(x)']] });
    raw.t.push({ s: 'not-a-slug', m: 'light', c: '#ffffff', d: [] });
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify(raw));
    expect(Object.keys(readUserThemeCache())).toEqual([themeSlugForId(r.id)]);
  });

  it('the account-switch clear empties the cache and the registry', () => {
    setUserThemesFromRows([row({})], false);
    clearUserThemeCache();
    expect(localStorage.getItem(USER_THEME_CACHE_KEY)).toBeNull();
    expect(useUserThemes.getState().themes).toEqual({});
  });
});

describe('picks resolve against the registry', () => {
  it('a u- pick has its own name and chrome colour, never Paper’s', () => {
    const r = row({ name: 'Moss' });
    setUserThemesFromRows([r], false);
    const slug = themeSlugForId(r.id) as `u-${string}`;
    expect(isLightPick(slug)).toBe(true);
    expect(resolveLightPick(slug)).toBe(slug);
    expect(lightLookDef(slug)).toMatchObject({ value: slug, label: 'Moss', themeColor: '#eeeeee' });
  });

  it('a missing, off or wrong-mode theme falls back to the default, and the shape is still a pick', () => {
    const d = row({ manifest: DARK });
    setUserThemesFromRows([d], false);
    const darkSlug = themeSlugForId(d.id) as `u-${string}`;
    expect(resolveDarkPick(darkSlug)).toBe(darkSlug);
    expect(darkLookDef(darkSlug).themeColor).toMatch(/^#[0-9a-f]{6}$/);
    // A dark theme is not a light pick.
    expect(resolveLightPick(darkSlug)).toBe(DEFAULT_LIGHT_LOOK);
    // Gone.
    expect(resolveLightPick('u-deadbeef')).toBe(DEFAULT_LIGHT_LOOK);
    expect(lightLookDef('u-deadbeef').label).toBe('Paper');
    expect(isLightPickShape('u-deadbeef')).toBe(true);
    expect(isLightPickShape('u-nothex!!')).toBe(false);
    setUserThemesFromRows([], true);
    expect(resolveDarkPick(darkSlug)).toBe(DEFAULT_DARK_LOOK);
  });
});

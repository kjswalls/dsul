import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  }),
}));

import {
  ThemeInjector,
  USER_THEME_BOOT_STYLE_ID,
  USER_THEME_STYLE_ID,
  USER_THEMES_REV_ATTR,
} from '@/components/providers/theme-injector';
import { useModsStore } from '@/lib/mods-store';
import { useLookStore } from '@/lib/look-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { USER_THEME_CACHE_KEY, setUserThemeDraft, useUserThemes } from '@/lib/user-themes/store';
import { DRAFT_SLUG, themeSlugForId } from '@/lib/user-themes/css';
import type { UserMod } from '@/lib/mods/schema';

/** <ThemeInjector> (components/providers/theme-injector.tsx): the one writer of the user-theme sheet. */

const USER = '11111111-1111-4111-8111-111111111111';
const ID = 'abcdef01-2345-4678-9abc-def012345678';
const SLUG = themeSlugForId(ID) as `u-${string}`;
const LIGHT = { version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa', font: 'serif' } };

function themeRow(over: Partial<UserMod> = {}): UserMod {
  return {
    id: ID,
    userId: USER,
    kind: 'theme',
    slug: SLUG,
    name: 'Moss',
    enabled: true,
    manifest: LIGHT,
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    ...over,
  };
}

const HYDRATE = useModsStore.getState().hydrate;
const sheet = () => document.getElementById(USER_THEME_STYLE_ID)?.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.documentElement.removeAttribute(USER_THEMES_REV_ATTR);
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
  useModsStore.getState().reset();
  useModsStore.setState({ safeMode: false, hydrate: HYDRATE });
  useSessionUserStore.setState({ user: { id: USER, email: null, displayName: null, avatarUrl: null } });
  useLookStore.setState({ light: 'paper', dark: 'night' });
});
afterEach(() => cleanup());

function seedRows(rows: UserMod[]) {
  useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, rows });
}

describe('ThemeInjector', () => {
  it('writes each enabled theme with the exact selectors', () => {
    seedRows([themeRow()]);
    render(<ThemeInjector />);
    const css = sheet();
    expect(css).toContain(`:root[data-look-light='${SLUG}'][data-look-light='${SLUG}']:not(.dark){--paper-0:#fafafa;`);
    expect(css).toContain(
      `:root[data-look-light='${SLUG}'][data-look-light='${SLUG}']:not(.dark) body{--font-ui:var(--font-source-serif), 'Source Serif 4', Georgia, serif}`
    );
    expect(css).toContain(
      `:where(:root[data-look-light='${SLUG}']:not(.dark)) :is([data-ask-opener],[data-ask-mark]){--ask-icon-pair:oklch(0.64 0.1 195)}`
    );
    expect(css).toContain(`[data-theme-preview][data-preview-light='${SLUG}'][data-preview-light='${SLUG}']:not(.dark){--paper-0:#fafafa;`);
    // Kept last in <head>.
    expect(document.head.lastElementChild?.id).toBe(USER_THEME_STYLE_ID);
  });

  it('a dark theme is scoped to .dark', () => {
    seedRows([themeRow({ manifest: { version: 1, mode: 'dark', base: 'dusk', tokens: {} } })]);
    render(<ThemeInjector />);
    expect(sheet()).toContain(`:root[data-look-dark='${SLUG}'][data-look-dark='${SLUG}'].dark{`);
    expect(sheet()).toContain(`:where(:root[data-look-dark='${SLUG}']).dark :is([data-ask-opener],[data-ask-mark]){`);
    expect(sheet()).not.toContain('data-look-light');
  });

  it('a draft gets only its preview twin, after the saved themes', () => {
    seedRows([themeRow()]);
    render(<ThemeInjector />);
    const rev = useUserThemes.getState().rev;
    const attr = document.documentElement.getAttribute(USER_THEMES_REV_ATTR);
    act(() => setUserThemeDraft({ slug: DRAFT_SLUG, mode: 'light', decls: [['--paper-0', '#000000']] }));
    // A draft is no live change: nothing keyed to the rev wakes.
    expect(useUserThemes.getState().rev).toBe(rev);
    expect(document.documentElement.getAttribute(USER_THEMES_REV_ATTR)).toBe(attr);
    const css = sheet();
    expect(css).not.toContain(`data-look-light='${DRAFT_SLUG}'`);
    expect(css.trim().split('\n').at(-1)).toBe(
      `[data-theme-preview][data-preview-light='${DRAFT_SLUG}'][data-preview-light='${DRAFT_SLUG}']:not(.dark){--paper-0:#000000}`
    );
  });

  it('removes the pre-paint boot sheet and bumps the rev attribute', () => {
    const boot = document.createElement('style');
    boot.id = USER_THEME_BOOT_STYLE_ID;
    document.head.appendChild(boot);
    render(<ThemeInjector />);
    expect(document.getElementById(USER_THEME_BOOT_STYLE_ID)).toBeNull();
    const first = Number(document.documentElement.getAttribute(USER_THEMES_REV_ATTR));
    act(() => seedRows([themeRow()]));
    expect(Number(document.documentElement.getAttribute(USER_THEMES_REV_ATTR))).toBeGreaterThan(first);
  });

  it('writes the cache from rows, and never in safe mode', () => {
    render(<ThemeInjector />);
    expect(localStorage.getItem(USER_THEME_CACHE_KEY)).toBeNull();
    act(() => seedRows([themeRow()]));
    expect(JSON.parse(localStorage.getItem(USER_THEME_CACHE_KEY)!).t[0].s).toBe(SLUG);
    cleanup();

    localStorage.clear();
    useModsStore.setState({ safeMode: true });
    seedRows([themeRow()]);
    render(<ThemeInjector />);
    expect(localStorage.getItem(USER_THEME_CACHE_KEY)).toBeNull();
    expect(useUserThemes.getState().themes).toEqual({});
    expect(sheet()).toBe('');
  });

  it('loads the theme rows itself when a pick names one of yours', () => {
    const hydrate = vi.fn(async () => {});
    useModsStore.setState({ hydrate });
    render(<ThemeInjector />);
    expect(hydrate).not.toHaveBeenCalled();
    act(() => useLookStore.setState({ light: SLUG }));
    expect(hydrate).toHaveBeenCalledWith(USER);
  });

  it('a theme switched off leaves the sheet', () => {
    seedRows([themeRow()]);
    render(<ThemeInjector />);
    expect(sheet()).toContain(SLUG);
    act(() => seedRows([themeRow({ enabled: false })]));
    expect(sheet()).toBe('');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Applying a Look through lib/settings/manifest.ts: the built-in applyLook and
 * your own applyUserLook share one write (the look store, then one settings
 * patch), and neither touches the mode.
 */

const settings = vi.hoisted(() => ({ saveSettings: vi.fn(), flushSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => settings);

import { applyLook, applyUserLook, type SettingCtx } from '@/lib/settings/manifest';
import { useLookStore } from '@/lib/look-store';
import { useModsStore } from '@/lib/mods-store';
import { setUserThemesFromRows, useUserThemes } from '@/lib/user-themes/store';
import { themeSlugForId } from '@/lib/user-themes/css';
import { lookById } from '@/lib/looks';
import type { UserLook } from '@/lib/user-looks';
import type { UserMod } from '@/lib/mods/schema';

const ctx = (): SettingCtx => ({ theme: 'system', setTheme: vi.fn(), userId: 'u1' });

const MOSS: UserMod = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  userId: 'u1',
  kind: 'theme',
  slug: themeSlugForId('aaaaaaaa-0000-4000-8000-000000000001'),
  name: 'Moss',
  enabled: true,
  manifest: { version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa' } },
  disabledReason: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
};

const look = (p: Partial<UserLook> = {}): UserLook => ({
  id: 'x',
  ref: 'u-12345678',
  label: 'Deep work',
  layout: 'notebook',
  light: 'u-aaaaaaaa',
  dark: 'dusk',
  ...p,
});

beforeEach(() => {
  settings.saveSettings.mockReset();
  localStorage.clear();
  useLookStore.setState({ light: 'paper', dark: 'night', layout: 'classic' });
  useModsStore.setState({ rows: [MOSS] });
  setUserThemesFromRows([MOSS], false);
});
afterEach(() => {
  useModsStore.setState({ rows: [] });
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
  useModsStore.setState({ safeMode: false });
});

describe('applyUserLook', () => {
  it('sets the layout and both themes, saves them as one patch, and leaves the mode alone', () => {
    const c = ctx();
    applyUserLook(look(), c);
    expect(useLookStore.getState()).toMatchObject({ layout: 'notebook', light: 'u-aaaaaaaa', dark: 'dusk' });
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', {
      layout: 'notebook',
      theme_light: 'u-aaaaaaaa',
      theme_dark: 'dusk',
    });
    expect(c.setTheme).not.toHaveBeenCalled();
  });

  it('a theme that is gone lands as the default', () => {
    useLookStore.setState({ light: 'studio' });
    applyUserLook(look({ light: 'u-deadbeef' }), ctx());
    expect(useLookStore.getState().light).toBe('paper');
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', { layout: 'notebook', theme_light: 'paper', theme_dark: 'dusk' });
  });

  it('a theme of yours that is off is saved as itself, never as the default it shows', () => {
    useModsStore.setState({ rows: [{ ...MOSS, enabled: false }] });
    setUserThemesFromRows([{ ...MOSS, enabled: false }], false);
    applyUserLook(look(), ctx());
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', { layout: 'notebook', theme_light: 'u-aaaaaaaa', theme_dark: 'dusk' });
  });

  it('keeps a saved pick of an off theme when the Look names the same one (never the default it shows)', () => {
    useModsStore.setState({ rows: [{ ...MOSS, enabled: false }] });
    setUserThemesFromRows([{ ...MOSS, enabled: false }], false);
    useLookStore.setState({ light: 'u-aaaaaaaa' });
    applyUserLook(look(), ctx());
    expect(useLookStore.getState().light).toBe('u-aaaaaaaa');
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', { layout: 'notebook', theme_light: 'u-aaaaaaaa', theme_dark: 'dusk' });
  });

  it('writes nothing in safe mode', () => {
    useModsStore.setState({ safeMode: true });
    applyUserLook(look({ light: 'studio' }), ctx());
    expect(useLookStore.getState()).toMatchObject({ layout: 'classic', light: 'paper', dark: 'night' });
    expect(settings.saveSettings).not.toHaveBeenCalled();
  });

  it('does not wait on the theme registry: an empty one neither blocks nor changes the write', () => {
    useUserThemes.setState({ themes: {}, source: 'none' });
    applyUserLook(look(), ctx());
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', { layout: 'notebook', theme_light: 'u-aaaaaaaa', theme_dark: 'dusk' });
  });
});

describe('applyLook (built-in), after the shared write', () => {
  it('sets its layout and pairing only', () => {
    useLookStore.setState({ light: 'sorbet' });
    applyLook(lookById('console')!, ctx());
    expect(useLookStore.getState()).toMatchObject({ layout: 'console', light: 'sorbet', dark: 'terminal' });
    expect(settings.saveSettings).toHaveBeenCalledWith('u1', { layout: 'console', theme_dark: 'terminal' });
  });
});

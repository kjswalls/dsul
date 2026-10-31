import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Bloom/Dusk pick (design PR3, D11): a look-store field saved per account
 * in user_settings.atlas_far_paper (087), applied at sign-in, mirrored to
 * localStorage by supabase-provider, and shown on the Look pane as a
 * desktop-only enum.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

const KEY = 'dsul-atlas-far-paper';
const src = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => localStorage.clear());

describe('atlas far zoom on paper: the setting', () => {
  it('defaults to Bloom, and the key and guard agree', async () => {
    const m = await import('@/lib/atlas-far-looks');
    expect(m.DEFAULT_ATLAS_FAR_PAPER).toBe('bloom');
    expect(m.ATLAS_FAR_PAPER_STORAGE_KEY).toBe(KEY);
    expect(m.ATLAS_FAR_PAPER.map((o) => [o.value, o.label])).toEqual([
      ['bloom', 'Bloom'],
      ['dusk', 'Dusk'],
    ]);
    expect(m.isAtlasFarPaper('dusk')).toBe(true);
    expect(m.isAtlasFarPaper('slate')).toBe(false);
    expect(m.isAtlasFarPaper(null)).toBe(false);
  });

  it('look-store starts from this device, and ignores a bad value', async () => {
    localStorage.setItem(KEY, 'dusk');
    const { useLookStore } = await import('@/lib/look-store');
    expect(useLookStore.getState().atlasFarPaper).toBe('dusk');
    vi.resetModules();
    localStorage.setItem(KEY, 'neon');
    const again = await import('@/lib/look-store');
    expect(again.useLookStore.getState().atlasFarPaper).toBe('bloom');
  });

  it('the Look record is a desktop-only enum that writes the store and the account', async () => {
    const { settingById } = await import('@/lib/settings/manifest');
    const { useLookStore } = await import('@/lib/look-store');
    const { saveSettings } = await import('@/lib/settings-service');
    const r = settingById('look.atlasFar')!;
    expect(r).toBeTruthy();
    expect(r.pane).toBe('look');
    expect(r.control).toBe('enum');
    expect(r.desktopOnly).toBe(true);
    expect(r.dbColumn).toBe('atlas_far_paper');
    expect(r.defaultValue).toBe('bloom');
    expect(r.options!.map((o) => o.value)).toEqual(['bloom', 'dusk']);
    expect(r.label).toBe('Atlas zoomed out, light mode');
    // "dusk" is the dark theme's word in search.
    expect(r.keywords).not.toContain('dusk');
    const ctx = { theme: 'light', setTheme: vi.fn(), userId: 'u1' };
    r.write('dusk', ctx);
    expect(useLookStore.getState().atlasFarPaper).toBe('dusk');
    expect(r.read(ctx)).toBe('dusk');
    expect(saveSettings).toHaveBeenCalledWith('u1', { atlas_far_paper: 'dusk' });
    vi.mocked(saveSettings).mockClear();
    // A bad value writes nothing, and no user means no save.
    r.write('neon', ctx);
    expect(useLookStore.getState().atlasFarPaper).toBe('dusk');
    r.write('bloom', { ...ctx, userId: null });
    expect(useLookStore.getState().atlasFarPaper).toBe('bloom');
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('is mirrored to this device by supabase-provider, removed at the default', () => {
    const provider = src('components/providers/supabase-provider.tsx');
    expect(provider).toMatch(/atlasFarPaper === DEFAULT_ATLAS_FAR_PAPER\) window\.localStorage\.removeItem\(ATLAS_FAR_PAPER_STORAGE_KEY\)/);
    expect(provider).toMatch(/window\.localStorage\.setItem\(ATLAS_FAR_PAPER_STORAGE_KEY, atlasFarPaper\)/);
    // And applied from the account at sign-in, only when the column holds a pick.
    expect(provider).toMatch(/if \(isAtlasFarPaper\(settings\.atlas_far_paper\)\) \{\s*useLookStore\.getState\(\)\.setAtlasFarPaper\(settings\.atlas_far_paper\)/);
  });

  it('is a pending-schema column, so a database without 087 still loads every other setting', () => {
    expect(src('lib/settings-service.ts')).toMatch(/PENDING_SCHEMA_COLUMNS = \[[\s\S]*'atlas_far_paper',[\s\S]*\] as const/);
  });
});

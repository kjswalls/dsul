import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app icon catalog (lib/app-icons.ts) and the two promises the rest of
 * the feature leans on: the lime set mirrors the Aurora file names, so
 * FaviconSync's swap is a prefix change; and the column rides in the pending
 * list, so a database that has not run 056 degrades to one missing setting
 * rather than rejecting the whole read.
 */

const selects: string[] = [];
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: (columns: string) => {
        selects.push(columns);
        const behind = columns.includes('app_icon');
        return {
          eq: () => ({
            maybeSingle: async () =>
              behind
                ? {
                    data: null,
                    error: { code: '42703', message: 'column user_settings.app_icon does not exist' },
                  }
                : { data: { theme: 'dark' }, error: null },
          }),
        };
      },
      upsert: async () => ({ error: null }),
    }),
  }),
}));

import { APP_ICONS, DEFAULT_APP_ICON, iconHrefFor, isAppIcon } from '@/lib/app-icons';
import { loadSettings } from '@/lib/settings-service';
import { settingById } from '@/lib/settings/manifest';

const root = process.cwd();
const SIZES = [16, 32, 192, 512];

describe('app icons — catalog', () => {
  it('slugs are unique and slug-shaped, and Aurora leads as the default', () => {
    const values = APP_ICONS.map((i) => i.value);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(APP_ICONS[0].value).toBe('aurora');
    expect(DEFAULT_APP_ICON).toBe('aurora');
  });

  it('isAppIcon takes exactly the catalog', () => {
    expect(isAppIcon('aurora')).toBe(true);
    expect(isAppIcon('lime')).toBe(true);
    for (const bad of ['LIME', 'Lime', '', ' lime', null, undefined, 1]) {
      expect(isAppIcon(bad), String(bad)).toBe(false);
    }
  });

  it('moves an href to its lime twin and leaves Aurora alone', () => {
    expect(iconHrefFor('/icons/icon-32.png', 'lime')).toBe('/icons/lime/icon-32.png');
    expect(iconHrefFor('/icons/icon-32.png', 'aurora')).toBe('/icons/icon-32.png');
    expect(iconHrefFor('https://do.dsul.app/icons/icon-16.png', 'lime')).toBe(
      'https://do.dsul.app/icons/lime/icon-16.png'
    );
  });

  it('every Aurora tab icon has a lime twin of the same name', () => {
    for (const size of SIZES) {
      const name = `icon-${size}.png`;
      expect(existsSync(join(root, 'public', 'icons', name)), name).toBe(true);
      expect(existsSync(join(root, 'public', 'icons', 'lime', name)), `lime/${name}`).toBe(true);
    }
  });
});

describe('app icons — the setting', () => {
  it('look.appIcon persists to app_icon, Aurora first', () => {
    const record = settingById('look.appIcon');
    expect(record?.dbColumn).toBe('app_icon');
    expect(record?.defaultValue).toBe('aurora');
    expect(record?.options?.map((o) => o.value)).toEqual(['aurora', 'lime']);
  });

  it('a database without migration 056 re-reads without app_icon instead of resetting everything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selects.length = 0;
    const settings = await loadSettings('u1');
    warn.mockRestore();

    expect(selects).toHaveLength(2);
    expect(selects[0].split(',')).toContain('app_icon');
    // The fallback read is the STABLE list: app_icon must be pending, not stable.
    expect(selects[1].split(',')).not.toContain('app_icon');
    expect(settings.theme).toBe('dark');
    expect(settings.app_icon).toBeUndefined();
  });
});

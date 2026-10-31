import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The leftovers on Today are ON for a new account (migration 086, Kirby
 * 2026-10-31; memory/plans/ghost-rows.md). The end of day review, the other
 * ritual this file used to pin off, is retired, and its column stays off.
 *
 * "On by default" is not one value; it is every layer that can supply a value
 * before the user has chosen one, and the ones that seed an account have to
 * agree or a new account comes up off:
 *
 *   the column DEFAULT        supabase/migrations/086 (054 is applied; never edited)
 *   the app's first-run seed  lib/settings-service.ts DEFAULT_SETTINGS (also the read-error fallback)
 *   the manifest default      what "modified" and per-row reset compare against
 *
 * Two layers stay OFF on purpose, because they speak for an account whose
 * settings have not landed: the store's own default (lib/morning-store.ts, and
 * its persist migrate) and the provider's reading of a NULL column. A fold that
 * flashed in for someone who turned it off would be the wrong way round.
 *
 * Existing stored values are untouched: 086 moves the default and flips no row.
 */

const db = vi.hoisted(() => ({ upserts: [] as Record<string, unknown>[] }));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        db.upserts.push(row);
        return { error: null };
      },
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { loadSettings } from '@/lib/settings-service';
import { useMorningStore } from '@/lib/morning-store';
import { settingById } from '@/lib/settings/manifest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  db.upserts.length = 0;
});

describe('leftovers on Today default on for a new account', () => {
  it('the first-run seed writes the leftovers on and the retired review off', async () => {
    const settings = await loadSettings('new-user');
    expect(settings.morning_check_enabled).toBe(true);
    expect(settings.eod_review_enabled).toBe(false);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      user_id: 'new-user',
      morning_check_enabled: true,
      eod_review_enabled: false,
    });
  });

  it('the store starts off until settings land, and a persisted blob without the field reads off', () => {
    expect(useMorningStore.getInitialState().morningCheckEnabled).toBe(false);

    const migrate = useMorningStore.persist.getOptions().migrate!;
    const migrated = migrate({}, 0) as { morningCheckEnabled: boolean };
    expect(migrated.morningCheckEnabled).toBe(false);
    // A stored choice survives the migrate, in both directions.
    expect((migrate({ morningCheckEnabled: true }, 0) as { morningCheckEnabled: boolean }).morningCheckEnabled).toBe(true);
  });

  it('the manifest default agrees with the seed, so a fresh account reads as unmodified', () => {
    expect(settingById('rituals.morningCheck')!.defaultValue).toBe(true);
    // The review's records went with it, the iPhone's off switch last (ghost
    // rows phase 3).
    expect(settingById('rituals.eod')).toBeUndefined();
    expect(settingById('rituals.eodTime')).toBeUndefined();
  });

  it('the provider reads a NULL column as off, an unknown never drawing the fold', () => {
    const src = read('components/providers/supabase-provider.tsx');
    expect(src).toContain('morning_check_enabled ?? false');
    expect(src).not.toContain('morning_check_enabled ?? true');
  });

  it('migration 086 moves the column default on and flips no existing row', () => {
    const sql = read('supabase/migrations/086_leftovers_default_on.sql')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    expect(sql).toBe('alter table public.user_settings alter column morning_check_enabled set default true;');
    // No update, no backfill: an account that has it off keeps it off.
    expect(sql).not.toMatch(/\bupdate\b/i);
  });

  it('applied migrations are never edited: 054 and 008 still say what they said', () => {
    const sql054 = read('supabase/migrations/054_morning_check_default_off.sql');
    expect(sql054).toContain(
      'update public.user_settings set morning_check_enabled = true where morning_check_enabled is null;'
    );
    expect(sql054).toContain('alter table public.user_settings alter column morning_check_enabled set default false;');
    expect(sql054).toContain('alter table public.user_settings alter column eod_review_enabled set default false;');
    expect(read('supabase/migrations/008_settings.sql')).toContain('morning_check_enabled  boolean default true');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rituals are opt-in for a NEW account (AI vision step 1, decision (e)).
 *
 * "Off by default" is not one value; it is every layer that can supply a value
 * before the user has chosen one, and they all have to agree or the ritual
 * comes back through whichever was missed:
 *
 *   the column DEFAULT        supabase/migrations/054 (008 is applied; never edited)
 *   the app's first-run seed  lib/settings-service.ts DEFAULT_SETTINGS (also the read-error fallback)
 *   the provider's hydrate    components/providers/supabase-provider.tsx, a NULL column
 *   the store's own default   lib/morning-store.ts, and its persist migrate
 *   the manifest default      what "modified" and per-row reset compare against
 *
 * Existing stored values are untouched: 054 pins any NULL to true BEFORE it
 * moves the default, because every reader used to treat NULL as on.
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
import { useEODStore } from '@/lib/eod-store';
import { settingById } from '@/lib/settings/manifest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  db.upserts.length = 0;
});

describe('rituals default off for a new account', () => {
  it('the first-run seed writes both rituals off', async () => {
    const settings = await loadSettings('new-user');
    expect(settings.morning_check_enabled).toBe(false);
    expect(settings.eod_review_enabled).toBe(false);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      user_id: 'new-user',
      morning_check_enabled: false,
      eod_review_enabled: false,
    });
  });

  it('the stores start off, and a persisted blob without the field reads off', () => {
    expect(useMorningStore.getInitialState().morningCheckEnabled).toBe(false);
    expect(useEODStore.getInitialState().eodReviewEnabled).toBe(false);

    const migrate = useMorningStore.persist.getOptions().migrate!;
    const migrated = migrate({}, 0) as { morningCheckEnabled: boolean };
    expect(migrated.morningCheckEnabled).toBe(false);
    // A stored choice survives the migrate, in both directions.
    expect((migrate({ morningCheckEnabled: true }, 0) as { morningCheckEnabled: boolean }).morningCheckEnabled).toBe(true);
  });

  it('the manifest defaults agree, so a fresh account reads as unmodified', () => {
    expect(settingById('rituals.morningCheck')!.defaultValue).toBe(false);
    expect(settingById('rituals.eod')!.defaultValue).toBe(false);
  });

  it('the provider reads a NULL column as off', () => {
    // Written by U0; read here so every layer is pinned in one place.
    const src = read('components/providers/supabase-provider.tsx');
    expect(src).toContain('morning_check_enabled ?? false');
    expect(src).not.toContain('morning_check_enabled ?? true');
  });

  it('migration 054 pins NULLs on, then moves both column defaults off', () => {
    const sql = read('supabase/migrations/054_morning_check_default_off.sql')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const backfill = sql.indexOf(
      'update public.user_settings set morning_check_enabled = true where morning_check_enabled is null;'
    );
    const morningDefault = sql.indexOf(
      'alter table public.user_settings alter column morning_check_enabled set default false;'
    );
    const eodDefault = sql.indexOf(
      'alter table public.user_settings alter column eod_review_enabled set default false;'
    );
    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(morningDefault).toBeGreaterThan(backfill);
    expect(eodDefault).toBeGreaterThanOrEqual(0);
    // Applied migrations are never edited: 008 still says what it said.
    expect(read('supabase/migrations/008_settings.sql')).toContain('morning_check_enabled  boolean default true');
  });
});

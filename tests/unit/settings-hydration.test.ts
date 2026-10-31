import { describe, it, expect, vi } from 'vitest';

// morning-store reaches settings-service, which builds a Supabase client at
// call time. Nothing here writes; this keeps the import graph inert.
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { settingsBelongToUser } from '@/lib/settings/hydration';
import { useMorningStore } from '@/lib/morning-store';

/**
 * The settings route's gate, pinned.
 *
 * This is the guarantee the route exists to keep: the stores it reads are
 * localStorage-persisted under browser-GLOBAL keys, so on a shared browser
 * they hold the last person to sign in until Supabase answers for the current
 * one. Rendering them as live controls in that window lets a click write
 * someone else's preference into this user's row.
 *
 * The gate was relaxed for speed — it no longer waits on planner-store's
 * seven-table item load, which this route reads nothing from — and these are
 * the cases that say the relaxation did not cost the guarantee. Note there is
 * no `isLoading` parameter to pass: the only way this can answer "yes" is a
 * settings response stamped for the account currently signed in.
 */
describe('settingsBelongToUser', () => {
  const A = 'user-a';
  const B = 'user-b';

  it('is false before anything has been hydrated', () => {
    // Fresh load. The stores hold whatever localStorage had; the stamp is not
    // persisted, so it starts null and nothing is trusted yet.
    expect(settingsBelongToUser(A, null)).toBe(false);
  });

  it('is false when the stamp belongs to the PREVIOUS account', () => {
    // The bug this gate exists for: B signs in on A's browser, and A's values
    // are sitting in the stores with A's stamp still on them.
    expect(settingsBelongToUser(B, A)).toBe(false);
  });

  it('is true only once the stamp names the signed-in account', () => {
    expect(settingsBelongToUser(A, A)).toBe(true);
  });

  it('is false with no signed-in user, even when both sides agree', () => {
    // `null === null` must not read as agreement: there is no account for
    // these values to belong to, so there is nothing safe to write to either.
    expect(settingsBelongToUser(null, null)).toBe(false);
    expect(settingsBelongToUser(undefined, undefined)).toBe(false);
    expect(settingsBelongToUser(null, A)).toBe(false);
  });

  it('is false when the settings response has not landed for anyone yet', () => {
    expect(settingsBelongToUser(A, undefined)).toBe(false);
  });
});

/**
 * The other half of the argument for dropping planner-store's `isLoading`
 * from the gate: the stamp the gate reads is applied in the SAME set() as the
 * values it vouches for, so "the stamp names this account" and "the values on
 * screen are this account's" can never be two different answers.
 *
 * Asserted through a subscriber rather than by reading afterwards, because
 * "afterwards" is the one moment that was never in doubt — the question is
 * whether any observer can ever see the stamp ahead of the values.
 */
describe('applyServerSettings stamps the account and the values together', () => {
  it('never publishes the stamp before the values it vouches for', () => {
    const seen: Array<{ stamp: string | null; time: string }> = [];
    const unsubscribe = useMorningStore.subscribe((s) =>
      seen.push({ stamp: s.settingsHydratedUserId, time: s.morningCheckTime })
    );

    useMorningStore.getState().applyServerSettings('user-a', {
      morningCheckEnabled: true,
      morningCheckTime: '06:45',
      morningAutoAgeEnabled: false,
      morningAutoAgeDays: 30,
    });
    unsubscribe();

    // Exactly one publication, carrying both.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ stamp: 'user-a', time: '06:45' });
    // And no observer ever saw a stamp standing over stale values.
    expect(seen.some((s) => s.stamp === 'user-a' && s.time !== '06:45')).toBe(false);
  });
});

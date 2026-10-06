import { test, expect } from '@playwright/test';
import {
  cleanupTestData,
  createTestHabit,
  setUserSetting,
  testTitle,
  testUserId,
} from './helpers/api';
import { BASE_URL, TEST_TZ, cronSecret } from './helpers/env';

/**
 * The reminder tick, called the way pg_cron calls it (migration 058).
 *
 * After 058 the only scheduled request dsul makes is pg_net's GET of
 * /api/cron/reminders with `Authorization: Bearer <CRON_SECRET>` every five
 * minutes. Nothing else in the suite reaches that route, so nothing else proves
 * the three things un-pausing it rests on: the bearer is enforced, a due cue is
 * claimed and counted, and a second tick in the same window claims nothing (the
 * claim is the dedupe, and a cron is at-least-once).
 *
 * ADVISORY, like the rest of the E2E job: `Unit tests (Vitest)` is the one
 * required check. It also assumes the push channel reports `unreached` at zero
 * devices (PR-A of the plan's Phase 0, which lands before 058): the test user
 * has no push subscription, so its one cue goes nowhere, and the tick must say
 * so rather than count it as delivered.
 *
 * Serial, and restoring what it found, because it writes two GLOBAL columns on
 * the shared test user: habit_reminders_enabled, which global-setup pins off, and
 * timezone, which the scan requires (`.not('timezone', 'is', null)`) and which
 * global-setup never sets. Every other spec leaves both alone, and the page's
 * own timezone sync writes TEST_TZ, the value set here.
 *
 * pg_cron's own dsul-reminders job is live on the local stack after 058 and may
 * fire mid-test. It cannot steal the claim: the local Vault holds no
 * dsul_app_url or dsul_cron_secret, so dsul_tick returns before any request.
 */

/** The user's local day and minute in TEST_TZ, from ONE instant, as the scan's localClock reads them. */
function localNow(): { dateStr: string; hhmm: string; minutes: number } {
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TEST_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TEST_TZ }).format(now);
  const [h, m] = hhmm.split(':').map(Number);
  return { dateStr, hhmm, minutes: h * 60 + m };
}

/** A service-key read, the shape helpers/api.ts's fetch* helpers use. */
async function restRead<T>(path: string): Promise<T[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`[reminders-tick] ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T[];
}

/** The route's body: `{ ok: true, ...ScanSummary }` (lib/reminders/scan.ts). */
interface TickBody {
  ok?: boolean;
  users: number;
  cues: number;
  lastCalls: number;
  unreached?: number;
  notes: string[];
}

test.describe('the reminder tick (GET /api/cron/reminders)', () => {
  test.describe.configure({ mode: 'serial' });

  test('refuses a request without the bearer, then claims a due cue exactly once', async ({
    request,
  }) => {
    const secret = cronSecret();
    test.skip(
      !secret,
      'No CRON_SECRET in .env.test; re-run ./scripts/local-setup.sh e2e. `next dev` lets an ' +
        'unset secret through, so the 401 could not be asserted.'
    );

    const { dateStr, hhmm, minutes } = localNow();
    // The window is [cue, min(cue + 30, 1440)): clamped at midnight, never
    // wrapped (lib/reminders/due.ts). From 23:30 a cue set "now" has less than
    // its full grace left and the day can roll over between the two ticks, so
    // the assertions below would be about tomorrow. Skip rather than flake.
    test.skip(minutes >= 1410, `local time ${hhmm} in ${TEST_TZ} is inside the midnight clamp`);

    const userId = testUserId();
    const [before] = await restRead<{
      habit_reminders_enabled: boolean | null;
      timezone: string | null;
    }>(`user_settings?user_id=eq.${userId}&select=habit_reminders_enabled,timezone`);

    let habitId: string | undefined;
    try {
      await setUserSetting(request, { habit_reminders_enabled: true, timezone: TEST_TZ });
      habitId = await createTestHabit(request, { title: testTitle('tick'), reminderTime: hhmm });

      // The gate first: the route must not scan for a caller without the bearer.
      const anonymous = await request.get(`${BASE_URL}/api/cron/reminders`);
      expect(anonymous.status()).toBe(401);
      const wrong = await request.get(`${BASE_URL}/api/cron/reminders`, {
        headers: { Authorization: 'Bearer not-the-secret' },
      });
      expect(wrong.status()).toBe(401);

      const first = await request.get(`${BASE_URL}/api/cron/reminders`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(first.status(), await first.text()).toBe(200);
      const tick = (await first.json()) as TickBody;
      expect(tick.users).toBeGreaterThanOrEqual(1);
      expect(tick.cues).toBeGreaterThanOrEqual(1);
      // No device is registered for the test user, so the cue reached nobody,
      // and the claim is still consumed (decision 4: discharged, not retried).
      expect(tick.unreached).toBeGreaterThanOrEqual(1);

      // The claim, read back: the local day AND the time it was for.
      const [row] = await restRead<{ reminder_sent_key: string | null }>(
        `items?id=eq.${habitId}&select=reminder_sent_key`
      );
      expect(row?.reminder_sent_key).toBe(`${dateStr}T${hhmm}`);

      // Same window, second tick: the claim already holds, so nothing is sent.
      const second = await request.get(`${BASE_URL}/api/cron/reminders`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(second.status(), await second.text()).toBe(200);
      expect(((await second.json()) as TickBody).cues).toBe(0);
    } finally {
      if (habitId) await cleanupTestData(request, [], [habitId]);
      // Never throws: a failed restore must not mask the assertion this test is
      // reporting. global-setup re-pins the flag on the next run regardless.
      await setUserSetting(request, {
        habit_reminders_enabled: before?.habit_reminders_enabled ?? false,
        timezone: before?.timezone ?? null,
      }).catch((err) => console.warn('[reminders-tick] settings restore failed:', err));
    }
  });
});

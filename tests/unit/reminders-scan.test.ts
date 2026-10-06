import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Item } from '@dsul/types';

/* ── Mocks ────────────────────────────────────────────────────────────────── */

const sendPushToUser = vi.fn(async () => ({ sent: 1, expired: 0 }));
vi.mock('@/lib/push-send', () => ({
  sendPushToUser: (...args: unknown[]) => sendPushToUser(...(args as [])),
  isPushConfigured: () => true,
}));

const fetchItems = vi.fn(async (): Promise<Item[]> => []);
vi.mock('@/lib/db', () => ({
  fetchItems: () => fetchItems(),
  fetchRoutines: async () => [],
  fetchSeasons: async () => [],
}));

import { runReminderScan, localClock } from '@/lib/reminders/scan';
import { makeServiceFake } from './support/service-fake';

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h1', title: 'Vitamins', project: 'G', streak: 12, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const USER = {
  user_id: 'u1',
  timezone: 'America/New_York',
  time_format: '12h',
  // Explicit, because the scan now asserts it rather than inheriting it from
  // the query filter — a user can be in the tick for stakes alone.
  habit_reminders_enabled: true,
  habit_last_call_enabled: false,
  habit_last_call_time: '20:30',
  habit_last_call_date: null,
  stakes_enabled: false,
  stakes_settle_time: '03:00',
  stakes_settled_date: null,
};

/** 2026-08-10T11:35Z is 07:35 in New York — inside a 07:30 cue's window. */
const AT_0735_NY = new Date('2026-08-10T11:35:00Z');

const BOOK_ROW = {
  id: 'h1',
  user_id: 'u1',
  reminder_sent_key: null,
  reminder_snooze_until: null,
  reminder_snooze_date: null,
};

beforeEach(() => {
  sendPushToUser.mockClear();
  fetchItems.mockReset();
  fetchItems.mockResolvedValue([]);
});

/* ── localClock ───────────────────────────────────────────────────────────── */

describe('localClock', () => {
  it('answers in the user\'s own day and minute', () => {
    const clock = localClock(AT_0735_NY, 'America/New_York');
    expect(clock.dateStr).toBe('2026-08-10');
    expect(clock.nowMinutes).toBe(7 * 60 + 35);
  });

  it('puts a user across the date line on their own date', () => {
    // 23:35 in New York on the 10th is already the 11th in London.
    const late = new Date('2026-08-11T03:35:00Z');
    expect(localClock(late, 'America/New_York').dateStr).toBe('2026-08-10');
    expect(localClock(late, 'Europe/London').dateStr).toBe('2026-08-11');
  });

  // hourCycle 'h23' rather than hour12:false, which is NOT the same thing: some
  // ICU builds answer midnight as "24", which parses to 1440 and silently puts
  // the user an entire day outside every window.
  it('reads midnight as 0, never 1440', () => {
    const midnightNY = new Date('2026-08-10T04:00:00Z');
    expect(localClock(midnightNY, 'America/New_York').nowMinutes).toBe(0);
  });
});

/* ── The scan ─────────────────────────────────────────────────────────────── */

describe('runReminderScan', () => {
  it('degrades to silence when migration 032 has not been applied', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { error: { code: '42703', message: 'column does not exist' } },
    });
    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(summary.migrationMissing).toBe(true);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('delivers a cue that is due, worded from the anchor', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30', reminderAnchor: 'you pour your coffee' })]);
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      // The claim is conditional and returns the rows it actually changed.
      'items.update': { data: [{ id: 'h1' }] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });

    expect(summary.cues).toBe(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [, userId, payload] = sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(userId).toBe('u1');
    expect(payload.title).toBe('Vitamins');
    expect(payload.body).toBe('you pour your coffee · 12 days');
    expect(payload.actions).toHaveLength(2);
  });

  // The deliberate divergence from eod-notify. Deliver-first survives a failed
  // write by re-sending, which is nearly free for a push and very much not free
  // once a channel rings a phone.
  it('claims the day BEFORE it delivers', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service, calls, mark } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      'items.update': { data: [{ id: 'h1' }] },
    });

    // The send goes into the same list as the statements, so the order is read
    // off it. A push that never went out leaves no mark, and fails below too.
    sendPushToUser.mockImplementationOnce(async () => {
      mark('push');
      return { sent: 1, expired: 0 };
    });

    await runReminderScan(service, { now: AT_0735_NY });

    const claim = calls.find((c) => c.table === 'items' && c.op === 'update');
    expect(claim?.payload).toMatchObject({ reminder_sent_key: '2026-08-10T07:30' });
    expect(calls.indexOf(claim!)).toBeLessThan(calls.findIndex((c) => c.op === 'push'));
  });

  // A blind stamp is not exclusive: two overlapping ticks — which a slow push
  // endpoint and an at-least-once cron make possible — would both "succeed" and
  // both deliver. Only rows the database actually changed may be sent.
  it('delivers nothing when the claim changed no rows', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      'items.update': { data: [] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.cues).toBe(0);
  });

  it('sends nothing when the claim fails, rather than sending every tick', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      'items.update': { error: { message: 'write conflict' } },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.notes.join()).toMatch(/cue claim failed/);
  });

  // One user's failure must not cost everyone else their reminders.
  it('one user throwing does not abort the tick', async () => {
    fetchItems.mockRejectedValueOnce(new Error('PostgREST exploded'));
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(summary.notes.join()).toMatch(/skipped — PostgREST exploded/);
  });

  it('does not pay for the item fetch when nothing is set and nothing is owed', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [] },
    });
    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(fetchItems).not.toHaveBeenCalled();
    expect(summary.users).toBe(0);
  });

  it('skips a user whose timezone is unusable, and keeps going', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, timezone: 'Mars/Olympus' }] },
      'items.select': { data: [BOOK_ROW] },
    });
    const summary = await runReminderScan(service, { now: AT_0735_NY });
    expect(summary.notes.join()).toMatch(/unusable timezone/);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  describe('the last call', () => {
    /** 2026-08-11T00:35Z is 20:35 in New York — inside a 20:30 last call. */
    const AT_2035_NY = new Date('2026-08-11T00:35:00Z');
    const lastCallUser = { ...USER, habit_last_call_enabled: true };

    it('names what is still open and the streak riding on it', async () => {
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [lastCallUser] },
        'items.select': { data: [] },
        // The last call is CLAIMED, not stamped — the update reports the row it
        // actually changed, and only a winning claim delivers.
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

      const summary = await runReminderScan(service, { now: AT_2035_NY });
      expect(summary.lastCalls).toBe(1);
      const [, , payload] = sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
      expect(payload.body).toBe('Reading · 12 days riding on it');
    });

    // "Everything is done" is not a notification anyone asked for — but it IS
    // an answered question, so the stamp still has to land or the scan re-asks
    // it every tick for the rest of the window.
    it('stamps but says nothing when the day is already clear', async () => {
      fetchItems.mockResolvedValue([habit({ completedDates: ['2026-08-10'] })]);
      const { service, calls } = makeServiceFake({
        'user_settings.select': { data: [lastCallUser] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

      const summary = await runReminderScan(service, { now: AT_2035_NY });
      expect(summary.lastCalls).toBe(0);
      expect(sendPushToUser).not.toHaveBeenCalled();
      expect(calls.find((c) => c.table === 'user_settings' && c.op === 'update')?.payload)
        .toMatchObject({ habit_last_call_date: '2026-08-10' });
    });

    // A blind write always "succeeds", so two overlapping ticks would both
    // deliver — with the call channel on, that is two Twilio calls for one nudge.
    it('does not deliver when another tick won the claim', async () => {
      fetchItems.mockResolvedValue([habit()]);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [lastCallUser] },
        'items.select': { data: [] },
        'user_settings.update': { data: [] },
      });
      const summary = await runReminderScan(service, { now: AT_2035_NY });
      expect(summary.lastCalls).toBe(0);
      expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('does not repeat once it has been sent today', async () => {
      fetchItems.mockResolvedValue([habit()]);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [{ ...lastCallUser, habit_last_call_date: '2026-08-10' }] },
        'items.select': { data: [] },
      });
      const summary = await runReminderScan(service, { now: AT_2035_NY });
      expect(summary.lastCalls).toBe(0);
      expect(sendPushToUser).not.toHaveBeenCalled();
    });
  });
});

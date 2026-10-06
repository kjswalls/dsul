import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Item } from '@dsul/types';

/* ── Mocks ────────────────────────────────────────────────────────────────── */

const sendPushToUser = vi.fn(async () => ({ devices: 1, sent: 1, expired: 0, failed: 0 }));
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

// Passed through untouched, and watched: the nudge the scan hands over is its
// whole contract with the channels, expiresInSeconds included.
vi.mock('@/lib/reminders/deliver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reminders/deliver')>();
  return { ...actual, deliverNudge: vi.fn(actual.deliverNudge) };
});

import { runReminderScan, localClock, secondsUntil } from '@/lib/reminders/scan';
import { deliverNudge } from '@/lib/reminders/deliver';
import type { Nudge } from '@/lib/reminders/nudge';
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
  vi.mocked(deliverNudge).mockClear();
  fetchItems.mockReset();
  fetchItems.mockResolvedValue([]);
});

/** Every nudge the scan handed to the channels, in order. */
const nudges = () => vi.mocked(deliverNudge).mock.calls.map(([nudge]) => nudge as Nudge);

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
      return { devices: 1, sent: 1, expired: 0, failed: 0 };
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

  describe('a nudge that reaches nobody', () => {
    const NO_DEVICE = { devices: 0, sent: 0, expired: 0, failed: 0 };
    const cueDue = () => fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);

    afterEach(() => vi.unstubAllGlobals());

    // habit-reminders.md decision 4: claimed, then delivered, and a delivery
    // that went nowhere does not hand the claim back. A cue with no device is
    // discharged, not held over to be retried into an SMS on the next tick.
    it('still claims the cue, counts it, and says it was unreached', async () => {
      cueDue();
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const { service, calls } = makeServiceFake({
        'user_settings.select': { data: [USER] },
        'items.select': { data: [BOOK_ROW] },
        'items.update': { data: [{ id: 'h1' }] },
      });

      const summary = await runReminderScan(service, { now: AT_0735_NY });

      const claim = calls.find((c) => c.table === 'items' && c.op === 'update');
      expect(claim?.payload).toEqual({ reminder_sent_key: '2026-08-10T07:30' });
      expect(summary.cues).toBe(1);
      expect(summary.unreached).toBe(1);
      expect(summary.notes.join('\n')).toMatch(/u1: cue via push unreached/);
    });

    /** A user with the SMS channel switched on and configured. */
    const smsOn = () =>
      makeServiceFake({
        'user_settings.select': { data: [USER] },
        'items.select': { data: [BOOK_ROW] },
        'items.update': { data: [{ id: 'h1' }] },
        'user_extensions.select': {
          data: [{ slug: 'sms-nudge', enabled: true, config: { to: '+15551234567', from: '+15557654321' } }],
        },
        'user_secrets.select': {
          data: { reminder_secrets: { 'sms-nudge': { accountSid: 'AC1', authToken: 'tok' } } },
        },
      });

    // Reached by text is reached. And with the SMS sent, a push with nowhere
    // to go is how this user set things up, not a line in the notes.
    it('is not unreached when the SMS got through', async () => {
      cueDue();
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
      vi.stubGlobal('fetch', fetchMock);

      const summary = await runReminderScan(smsOn().service, { now: AT_0735_NY });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(summary.cues).toBe(1);
      expect(summary.unreached).toBe(0);
      expect(summary.notes).toEqual([]);
    });

    // A failure is its own note; counting the nudge as unreached as well would
    // file one broken Twilio token under two headings.
    it('is a failure, not unreached, when the SMS failed', async () => {
      cueDue();
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

      const summary = await runReminderScan(smsOn().service, { now: AT_0735_NY });

      expect(summary.unreached).toBe(0);
      const notes = summary.notes.join('\n');
      expect(notes).toMatch(/cue via sms-nudge failed/);
      // Nothing got through, so the empty push is worth its line here.
      expect(notes).toMatch(/cue via push unreached/);
    });

    it('counts an unreached last call the same way', async () => {
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [{ ...USER, habit_last_call_enabled: true }] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

      const summary = await runReminderScan(service, { now: new Date('2026-08-11T00:35:00Z') });

      expect(summary.lastCalls).toBe(1);
      expect(summary.unreached).toBe(1);
      expect(summary.notes.join('\n')).toMatch(/last-call via push unreached/);
    });

    it('a delivered cue is not unreached', async () => {
      cueDue();
      const { service } = makeServiceFake({
        'user_settings.select': { data: [USER] },
        'items.select': { data: [BOOK_ROW] },
        'items.update': { data: [{ id: 'h1' }] },
      });
      const summary = await runReminderScan(service, { now: AT_0735_NY });
      expect(summary.cues).toBe(1);
      expect(summary.unreached).toBe(0);
    });
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

/* ── How long a push may wait ─────────────────────────────────────────────── */

// The scan holds the user's clock, so it is the scan that says how long each
// nudge stays worth delivering; the push channel only turns it into a TTL.
// Every answer stops at the user's own midnight, never past it.
describe('expiresInSeconds', () => {
  /** New York is UTC−4 in August: 23:50 local on the 10th is 03:50Z on the 11th. */
  const AT_2350_NY = new Date('2026-08-11T03:50:00Z');

  const cueService = () =>
    makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      'items.update': { data: [{ id: 'h1' }] },
    }).service;

  const lastCallService = (time: string) =>
    makeServiceFake({
      'user_settings.select': { data: [{ ...USER, habit_last_call_enabled: true, habit_last_call_time: time }] },
      'items.select': { data: [] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
    }).service;

  it('a cue lasts to the end of ITS window, not one grace from the tick', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    await runReminderScan(cueService(), { now: AT_0735_NY });
    // 07:30 + 30 = 08:00, and the tick is at 07:35.
    expect(nudges()[0]).toMatchObject({ kind: 'cue', expiresInSeconds: 25 * 60 });
  });

  it('a 23:45 cue at 23:50 stops at midnight', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '23:45' })]);
    await runReminderScan(cueService(), { now: AT_2350_NY });
    expect(nudges()[0]).toMatchObject({ kind: 'cue', expiresInSeconds: 600 });
  });

  it('a 23:50 last call expires in 600 seconds', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    await runReminderScan(lastCallService('23:50'), { now: AT_2350_NY });

    expect(nudges()[0]).toMatchObject({ kind: 'last-call', expiresInSeconds: 600 });
    // …and that is the TTL the push carries, beside its urgency and topic.
    const [, , payload] = sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(payload).toMatchObject({ ttl: 600, urgency: 'high', topic: 'lc-20260810' });
  });

  // What a last call says is the day's state at the minute it was worked out,
  // so its grace runs from the tick that sent it.
  it('a last call found late in its window still gets one grace from the tick', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    // 20:45 in New York; the last call was due at 20:30.
    await runReminderScan(lastCallService('20:30'), { now: new Date('2026-08-11T00:45:00Z') });
    expect(nudges()[0]).toMatchObject({ kind: 'last-call', expiresInSeconds: 1800 });
  });

  // A matured snooze waits for the first tick after it, any time that day, so
  // the window of the cue it snoozed says nothing about it.
  it('a matured snooze gets one grace from the tick that claimed it', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': {
        data: [{ ...BOOK_ROW, reminder_snooze_until: '2026-08-10T11:34:00+00:00', reminder_snooze_date: '2026-08-10' }],
      },
      'items.update': { data: [{ id: 'h1' }] },
    });

    await runReminderScan(service, { now: AT_0735_NY });

    expect(nudges()[0]).toMatchObject({ kind: 'cue', snoozed: true, expiresInSeconds: 1800 });
  });

  // nowMinutes is truncated. Counted in whole minutes, a tick at 23:50:40
  // would hold the push until 00:00:40, i.e. hand yesterday's last call to a
  // phone after midnight.
  it('counts to the second, so a tick part-way through a minute still stops at midnight', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    await runReminderScan(lastCallService('23:50'), { now: new Date('2026-08-11T03:50:40Z') });
    expect(nudges()[0]).toMatchObject({ kind: 'last-call', expiresInSeconds: 560 });
  });

  it('secondsUntil never answers below zero', () => {
    const clock = localClock(AT_2350_NY, 'America/New_York');
    expect(secondsUntil(clock, 1440)).toBe(600);
    expect(secondsUntil(clock, 1430)).toBe(0);
    expect(secondsUntil(clock, 1400)).toBe(0);
  });
});

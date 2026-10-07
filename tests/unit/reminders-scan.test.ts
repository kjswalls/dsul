import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item } from '@dsul/types';
import type { PushResult } from '@/lib/push-send';

/* ── Mocks ────────────────────────────────────────────────────────────────── */

const sendPushToUser = vi.fn(async (): Promise<PushResult> => ({ devices: 1, sent: 1, expired: 0, failed: 0 }));
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
// whole contract with the channels, expiresAtMs included.
vi.mock('@/lib/reminders/deliver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reminders/deliver')>();
  return { ...actual, deliverNudge: vi.fn(actual.deliverNudge) };
});

import {
  runReminderScan,
  localClock,
  expiryAt,
  ReminderScanError,
  TICK_FLAGS,
  TICK_MINUTES,
  windowOpensAt,
} from '@/lib/reminders/scan';
import { deliverNudge } from '@/lib/reminders/deliver';
import { isWithinWindow, REMINDER_GRACE_MINUTES } from '@/lib/reminders/due';
import type { Nudge } from '@/lib/reminders/nudge';
import { makeServiceFake, type FakeCall } from './support/service-fake';

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
  // The review is off here, so every suite below that is not about it sees
  // the tick it saw before the review was a tier. Its own describe turns it on.
  eod_review_enabled: false,
  eod_review_time: '21:00',
  last_eod_notified_date: null,
  last_eod_review_date: null,
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

/** How long a nudge or a push payload stays worth delivering, in seconds from `tick`. */
const secondsLeft = (of: { expiresAtMs?: unknown }, tick: Date) =>
  ((of.expiresAtMs as number) - tick.getTime()) / 1000;

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

  // The deliberate divergence from the old eod-notify route. Deliver-first
  // survives a failed write by re-sending, which is nearly free for a push and
  // very much not free once a channel rings a phone.
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
      const { service, calls, writes } = makeServiceFake({
        'user_settings.select': { data: [USER] },
        'items.select': { data: [BOOK_ROW] },
        'items.update': { data: [{ id: 'h1' }] },
      });

      const summary = await runReminderScan(service, { now: AT_0735_NY });

      const claim = calls.find((c) => c.table === 'items' && c.op === 'update');
      expect(claim?.payload).toEqual({ reminder_sent_key: '2026-08-10T07:30' });
      // The claim is the only write. One that cleared reminder_sent_key again
      // would re-send the cue on every tick of its window.
      expect(writes()).toEqual([claim]);
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

    // The usual case, not the edge: voice, SMS and the call decline every
    // review (decision 12), and the call declines every cue unless the user
    // lists them. A decline is not a delivery, so with push finding no device
    // the nudge reached nobody: counted, and the empty push gets its line.
    // Without these, counting only `every(unreached)` or calling a skip a
    // delivery passed every other test here, and the one signal that push has
    // quietly stopped reaching an SMS user went with it.
    it('is unreached when push found no device and the SMS declined the review', async () => {
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
      vi.stubGlobal('fetch', fetchMock);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [{ ...USER, habit_reminders_enabled: false, eod_review_enabled: true }] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
        // kinds left blank: the reminders, never the review.
        'user_extensions.select': {
          data: [{ slug: 'sms-nudge', enabled: true, config: { to: '+15551234567', from: '+15557654321' } }],
        },
        'user_secrets.select': {
          data: { reminder_secrets: { 'sms-nudge': { accountSid: 'AC1', authToken: 'tok' } } },
        },
      });

      // 21:05 in New York, inside the 21:00 review's window.
      const summary = await runReminderScan(service, { now: new Date('2026-08-11T01:05:00Z') });

      expect(fetchMock).not.toHaveBeenCalled();
      const reports = await vi.mocked(deliverNudge).mock.results[0].value;
      expect(reports).toEqual([
        expect.objectContaining({ channel: 'push', unreached: true }),
        expect.objectContaining({ channel: 'sms-nudge', ok: true, skipped: true, detail: 'sms declines eod' }),
      ]);
      expect(summary.eod).toBe(1);
      expect(summary.unreached).toBe(1);
      expect(summary.notes.join('\n')).toMatch(/u1: eod via push unreached/);
    });

    it('is unreached when push found no device and the call declined the cue', async () => {
      cueDue();
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
      vi.stubGlobal('fetch', fetchMock);
      const { service } = makeServiceFake({
        'user_settings.select': { data: [USER] },
        'items.select': { data: [BOOK_ROW] },
        'items.update': { data: [{ id: 'h1' }] },
        // kinds left blank: the last call only.
        'user_extensions.select': {
          data: [{ slug: 'phone-call', enabled: true, config: { to: '+15551234567', from: '+15557654321' } }],
        },
        'user_secrets.select': {
          data: { reminder_secrets: { 'phone-call': { accountSid: 'AC1', authToken: 'tok' } } },
        },
      });

      const summary = await runReminderScan(service, { now: AT_0735_NY });

      expect(fetchMock).not.toHaveBeenCalled();
      const reports = await vi.mocked(deliverNudge).mock.results[0].value;
      expect(reports).toEqual([
        expect.objectContaining({ channel: 'push', unreached: true }),
        expect.objectContaining({ channel: 'phone-call', ok: true, skipped: true, detail: 'call declines cue' }),
      ]);
      expect(summary.cues).toBe(1);
      expect(summary.unreached).toBe(1);
      expect(summary.notes.join('\n')).toMatch(/u1: cue via push unreached/);
    });

    it('counts an unreached last call the same way', async () => {
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
      const { service, writes } = makeServiceFake({
        'user_settings.select': { data: [{ ...USER, habit_last_call_enabled: true }] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

      const summary = await runReminderScan(service, { now: new Date('2026-08-11T00:35:00Z') });

      // Claimed, and never handed back.
      expect(writes().map((c) => [c.table, c.payload])).toEqual([
        ['user_settings', { habit_last_call_date: '2026-08-10' }],
      ]);
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

    // 'Last call at' is a free time input. Clamped at midnight, a 23:58 last
    // call's window is [23:58, 24:00) and holds no tick: 23:55 is before it
    // and 00:00 is tomorrow. It opens at the day's last tick instead, as the
    // review's does, and goes a few minutes early rather than never.
    it.each(['23:55', '23:56', '23:58', '23:59'])('a %s last call is sent on the 23:55 tick, until midnight', async (time) => {
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      const { service, writes } = makeServiceFake({
        'user_settings.select': { data: [{ ...lastCallUser, habit_last_call_time: time }] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

      const summary = await runReminderScan(service, { now: new Date('2026-08-11T03:55:00Z') });

      expect(summary.lastCalls).toBe(1);
      expect(writes().map((c) => c.payload)).toEqual([{ habit_last_call_date: '2026-08-10' }]);
      expect(nudges()[0]).toMatchObject({ kind: 'last-call', expiresAtMs: Date.parse('2026-08-11T04:00:00Z') });
    });

    it('a 23:58 last call is nothing at 00:00, the next day\'s', async () => {
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      const { service, writes } = makeServiceFake({
        'user_settings.select': { data: [{ ...lastCallUser, habit_last_call_time: '23:58' }] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });
      const summary = await runReminderScan(service, { now: new Date('2026-08-11T04:00:00Z') });
      expect(summary.lastCalls).toBe(0);
      expect(writes()).toEqual([]);
    });
  });

  // The settlement's time is no window, but `now >= settle time` has the same
  // gap the windows had: 23:56–23:59 is a minute no tick reaches, and at 00:00
  // the date has rolled and the clock is back below it. A free time input
  // (rituals.stakesTime), and 034's CHECK takes any HH:mm, so '23:58' is a value
  // a row can hold, and it used to settle no day at all: no pledge rows, no
  // partner digest, no Beeminder backstop, and no note.
  describe('the stakes settlement', () => {
    const STAKES_USER = {
      ...USER,
      habit_reminders_enabled: false,
      stakes_enabled: true,
      stakes_settled_date: '2026-08-08',
    };

    const stakesService = (user: Record<string, unknown>) =>
      makeServiceFake({
        'user_settings.select': { data: [user] },
        'items.select': { data: [] },
        'user_settings.update': { data: [{ user_id: 'u1' }] },
      });

    it.each(['23:55', '23:56', '23:58', '23:59'])('a %s settlement settles yesterday on the 23:55 tick', async (time) => {
      const { service, writes } = stakesService({ ...STAKES_USER, stakes_settle_time: time });

      const summary = await runReminderScan(service, { now: new Date('2026-08-11T03:55:00Z') });

      expect(summary.daysSettled).toBe(1);
      expect(writes().map((c) => [c.table, c.payload])).toEqual([['user_settings', { stakes_settled_date: '2026-08-09' }]]);
    });

    it('a 23:58 settlement settles nothing new at 00:00', async () => {
      // As the 23:55 tick left it.
      const { service, writes } = stakesService({
        ...STAKES_USER,
        stakes_settle_time: '23:58',
        stakes_settled_date: '2026-08-09',
      });

      const summary = await runReminderScan(service, { now: new Date('2026-08-11T04:00:00Z') });

      expect(summary.daysSettled).toBe(0);
      expect(writes()).toEqual([]);
    });

    // Opened early only where it has to be: a 21:00 settlement waits for 21:00.
    it('a 21:00 settlement does not settle at 20:55', async () => {
      const { service, writes } = stakesService({ ...STAKES_USER, stakes_settle_time: '21:00' });
      const summary = await runReminderScan(service, { now: new Date('2026-08-11T00:55:00Z') });
      expect(summary.daysSettled).toBe(0);
      expect(writes()).toEqual([]);
    });
  });
});

/* ── The end-of-day review ────────────────────────────────────────────────── */

// The review's invitation used to be a cron route of its own, which delivered
// before it stamped, wrapped its window past midnight and never asked whether
// the review was already done. It is the scan's first tier now, under the
// scan's rules: claim, then deliver, through the same fan-out as every nudge.
describe('the EOD review (Tier 0)', () => {
  /** Someone who wants the evening review and no reminders at all. */
  const EOD_USER = { ...USER, habit_reminders_enabled: false, eod_review_enabled: true };

  /** New York is UTC−4 in August: 21:05 local on the 10th is 01:05Z on the 11th. */
  const AT_2105_NY = new Date('2026-08-11T01:05:00Z');

  const ONE_DEVICE = { devices: 1, sent: 1, expired: 0, failed: 0 };
  const NO_DEVICE = { devices: 0, sent: 0, expired: 0, failed: 0 };

  /** A user row, their (empty) bookkeeping, and a claim the database grants. */
  const eodService = (user: Record<string, unknown> = EOD_USER) =>
    makeServiceFake({
      'user_settings.select': { data: [user] },
      'items.select': { data: [] },
      'user_settings.update': { data: [{ user_id: user.user_id }] },
    });

  /** What the one push sent was handed. */
  const pushed = () => sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];

  const eodClaim = (calls: FakeCall[]) =>
    calls.find((c) => c.table === 'user_settings' && c.op === 'update');

  afterEach(() => vi.unstubAllGlobals());

  it('claims the day BEFORE it sends, and only from a row not already holding it', async () => {
    const { service, calls, mark } = eodService();
    sendPushToUser.mockImplementationOnce(async () => {
      mark('push');
      return ONE_DEVICE;
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    const claim = calls.find((c) => c.table === 'user_settings' && c.op === 'update');
    expect(claim?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    expect(claim?.filters).toEqual([
      ['eq', ['user_id', 'u1']],
      ['or', ['last_eod_notified_date.is.null,last_eod_notified_date.neq.2026-08-10']],
      ['select', ['user_id']],
    ]);
    expect(calls.indexOf(claim!)).toBeLessThan(calls.findIndex((c) => c.op === 'push'));
    expect(summary).toMatchObject({ users: 1, eod: 1, cues: 0, lastCalls: 0, unreached: 0, notes: [] });
  });

  it('says what the review always said: one tap into it, and no buttons', async () => {
    await runReminderScan(eodService().service, { now: AT_2105_NY });

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [, userId, payload] = pushed();
    expect(userId).toBe('u1');
    expect(payload).toMatchObject({
      title: 'End of day 🌙',
      body: "How'd today go?",
      // The day it invites a review of, so a tap after midnight is recorded
      // against that day and not the new one (lib/eod.ts's reviewedDay).
      url: '/?eod=2026-08-10',
      tag: 'dsul-eod-2026-08-10',
    });
    expect(payload.actions).toBeUndefined();
    // Good until the user's own midnight (175 minutes from 21:05), and an
    // invitation rather than an alarm, so it does not wake a dozing phone.
    // Handed on as the instant, which push-send turns into a TTL as it sends.
    expect(payload).toMatchObject({ expiresAtMs: Date.parse('2026-08-11T04:00:00Z'), urgency: 'normal', topic: 'eod-20260810' });
    expect(payload).not.toHaveProperty('ttl');
    expect(nudges()[0]).toMatchObject({ kind: 'eod', items: [] });
    expect(secondsLeft(nudges()[0], AT_2105_NY)).toBe(175 * 60);
    expect(nudges()[0].itemId).toBeUndefined();
  });

  it('sends nothing when another tick won the claim', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { data: [EOD_USER] },
      'items.select': { data: [] },
      'user_settings.update': { data: [] },
    });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.eod).toBe(0);
    expect(summary.notes).toEqual([]);
  });

  it('sends nothing when the claim fails, and says so', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { data: [EOD_USER] },
      'items.select': { data: [] },
      'user_settings.update': { error: { message: 'write conflict' } },
    });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.notes.join('\n')).toMatch(/u1: eod claim failed — write conflict/);
  });

  // A claim that errors or is lost costs the review and nothing else: the
  // cues, the last call and the settlement come after it in the same user's
  // turn, and a `continue` there would take them all, every tick of the
  // review's window, with only the note to show for it. The push-failure test
  // below pins the same isolation for a claim that was won.
  it.each([
    ['fails', { error: { message: 'write conflict' } }],
    ['is lost', { data: [] }],
  ])('a review claim that %s leaves the cues running', async (outcome, claim) => {
    // A 07:30 review and a 07:30 cue, for someone with both on.
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service, calls, writes } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, eod_review_enabled: true, eod_review_time: '07:30' }] },
      'items.select': { data: [BOOK_ROW] },
      'user_settings.update': claim,
      'items.update': { data: [{ id: 'h1' }] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });

    // The review was asked for, and not sent…
    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    expect(summary.eod).toBe(0);
    // …and the cue went regardless, claimed and delivered.
    expect(summary.cues).toBe(1);
    expect(nudges().map((n) => n.kind)).toEqual(['cue']);
    expect(writes().map((c) => [c.table, c.payload])).toContainEqual(['items', { reminder_sent_key: '2026-08-10T07:30' }]);
    if (outcome === 'fails') {
      expect(summary.notes).toEqual(['u1: eod claim failed — write conflict']);
    } else {
      expect(summary.notes).toEqual([]);
    }
  });

  it('does not ask again once today is claimed', async () => {
    const { service, calls } = eodService({ ...EOD_USER, last_eod_notified_date: '2026-08-10' });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(eodClaim(calls)).toBeUndefined();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.users).toBe(0);
  });

  // The review's own switch is the one gate left on it. The route this tier
  // replaced asked for `eod_review_enabled = true` in its SQL; the scan's query
  // lets a user in for reminders, stakes OR the review, and every row holds a
  // review hour whether or not the review is on (21:00 is 010's default). So
  // someone here for their habit cues, inside that hour's window, is the case
  // that must stay quiet. Null is a row the column's default never reached,
  // and reads as off.
  it.each([false, null])('never invites a review whose switch is %s, even inside its window', async (enabled) => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service, calls } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, eod_review_enabled: enabled, eod_review_time: '21:00' }] },
      'items.select': { data: [BOOK_ROW] },
      // Granted, so nothing but the switch stands between this user and a claim.
      'user_settings.update': { data: [{ user_id: 'u1' }] },
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    // In the tick for the cues, and served them (none is due at 21:05)…
    expect(summary.users).toBe(1);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    // …and never asked about the review: no claim, no nudge, no push.
    expect(eodClaim(calls)).toBeUndefined();
    expect(summary.eod).toBe(0);
    expect(nudges().filter((nudge) => nudge.kind === 'eod')).toEqual([]);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  // The window is the scan's own: thirty minutes from the review's hour, the
  // same grace every cue gets, where the old route had five and lost the night
  // to one failed tick.
  it.each([
    ['21:29', '2026-08-11T01:29:00Z', true],
    ['21:30', '2026-08-11T01:30:00Z', false],
    ['20:59', '2026-08-11T00:59:00Z', false],
  ])('a 21:00 review at %s: sent is %s', async (_, iso, sent) => {
    const { service, calls } = eodService();
    const summary = await runReminderScan(service, { now: new Date(iso) });
    expect(sendPushToUser).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(eodClaim(calls) !== undefined).toBe(sent);
    expect(summary.eod).toBe(sent ? 1 : 0);
  });

  // The old route wrapped its window past midnight, and a wrap plus a stamp
  // that names the day is a double-send: wrapped, a 23:50 review's thirty
  // minutes are still open at 00:05, the date has rolled, the stamp no longer
  // matches, and yesterday's review goes out again. Clamped, it gets ten
  // minutes and the next day owes nothing until 23:50.
  it('a 23:50 review: sent at 23:55, and nothing at 00:05 the next day', async () => {
    const late = { ...EOD_USER, eod_review_time: '23:50' };

    const first = eodService(late);
    const summary = await runReminderScan(first.service, { now: new Date('2026-08-11T03:55:00Z') });
    expect(summary.eod).toBe(1);
    expect(eodClaim(first.calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    // …and it stops at midnight: five minutes is all the review has left.
    expect(nudges()[0]).toMatchObject({ kind: 'eod', expiresAtMs: Date.parse('2026-08-11T04:00:00Z') });

    sendPushToUser.mockClear();
    // As the 23:55 claim left it, and as a database read just after it gives it.
    const next = eodService({ ...late, last_eod_notified_date: '2026-08-10' });
    const after = await runReminderScan(next.service, { now: new Date('2026-08-11T04:05:00Z') });
    expect(eodClaim(next.calls)).toBeUndefined();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(after.eod).toBe(0);
  });

  // Clamped at midnight, a window that opens after the day's last tick has no
  // tick in it: 23:55 is before a 23:57 review and 00:00 is tomorrow, when the
  // date has rolled. The setting is a native time input, so any minute can be
  // saved. The window opens at 23:55 instead: a few minutes early, not never.
  it.each(['23:55', '23:56', '23:57', '23:58', '23:59'])('a %s review is sent on the 23:55 tick', async (time) => {
    const { service, calls } = eodService({ ...EOD_USER, eod_review_time: time });
    const summary = await runReminderScan(service, { now: new Date('2026-08-11T03:55:00Z') });
    expect(summary.eod).toBe(1);
    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    expect(nudges()[0]).toMatchObject({ kind: 'eod', expiresAtMs: Date.parse('2026-08-11T04:00:00Z') });
  });

  it('a 23:57 review: nothing at 00:00, claimed at 23:55 or not', async () => {
    for (const stamped of ['2026-08-10', null]) {
      const { service, calls } = eodService({ ...EOD_USER, eod_review_time: '23:57', last_eod_notified_date: stamped });
      const summary = await runReminderScan(service, { now: new Date('2026-08-11T04:00:00Z') });
      // The 11th now, whose review is not owed until tonight.
      expect(eodClaim(calls)).toBeUndefined();
      expect(summary.eod).toBe(0);
    }
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  // The rule the tests above are instances of, for every minute a review
  // can be set to: some tick of the day, stepped the way pg_cron runs them,
  // lands inside its window.
  it('every minute of the day has a tick inside the window it opens', () => {
    const ticks = Array.from({ length: 1440 / TICK_MINUTES }, (_, i) => i * TICK_MINUTES);
    const missed = Array.from({ length: 1440 }, (_, minute) => minute).filter(
      (minute) => !ticks.some((tick) => isWithinWindow(windowOpensAt(minute), tick, REMINDER_GRACE_MINUTES)),
    );
    expect(missed).toEqual([]);
    // Opened early only where it has to be: after the day's last tick.
    expect(windowOpensAt(1435)).toBe(1435);
    expect(windowOpensAt(1439)).toBe(1435);
    expect(windowOpensAt(21 * 60)).toBe(21 * 60);
  });

  // windowOpensAt is right only while the tick runs every TICK_MINUTES, and
  // that number lives in SQL: 044 scheduled the job, 058 re-creates it.
  it('TICK_MINUTES is the schedule pg_cron holds for the tick', () => {
    for (const file of ['044_dsul_rename.sql', '058_resume_cron_tick.sql']) {
      const sql = readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
      const schedule = /cron\.schedule\(\s*'dsul-reminders',\s*'([^']+)'/.exec(sql)?.[1];
      expect(schedule, file).toBe(`*/${TICK_MINUTES} * * * *`);
    }
  });

  // The tick's gate in SQL asks the scan's own question first, and only while
  // the two name the same switches. A flag the scan reads and the gate does not
  // (#220's morning check, say, added to TICK_FLAGS alone) is a tier dsul_tick
  // never wakes the route for, for anyone with only that switch on, and with
  // nothing to say so: the job succeeds and sends no request. Read from the
  // LATEST migration that defines the function, so a new one that redefines
  // the gate is what this checks from then on.
  it('TICK_FLAGS are the switches dsul_tick gates on', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const defines = /create\s+(?:or\s+replace\s+)?function\s+public\.dsul_tick\s*\(/i;
    const latest = readdirSync(dir)
      .filter((file) => /^\d{3}_.*\.sql$/.test(file))
      .sort()
      .filter((file) => defines.test(readFileSync(join(dir, file), 'utf8')))
      .at(-1);
    // 058 when this was written; whichever redefines the gate after it.
    expect(latest).toBeDefined();

    const sql = readFileSync(join(dir, latest!), 'utf8');
    const start = sql.search(defines);
    // The body only, its comments dropped, so a flag named in prose is not read
    // as one the gate asks about.
    const body = sql.slice(start, sql.indexOf('$$;', start)).replace(/--[^\n]*/g, '');
    const gated = [...body.matchAll(/coalesce\(\s*(\w+)\s*,\s*false\s*\)/gi)].map((m) => m[1]);

    expect(new Set(gated)).toEqual(new Set(TICK_FLAGS));
    expect(gated).toHaveLength(TICK_FLAGS.length);
  });

  // eod_review_time has no CHECK, and the store saves what it is given. due.ts's
  // strict HH:mm parser would read '9:00' as no time at all; lib/eod.ts's, which
  // the dock already uses, reads it as nine.
  it("reads an unpadded '9:00' as 09:00, and sends at 09:10", async () => {
    const { service, calls } = eodService({ ...EOD_USER, eod_review_time: '9:00' });
    const summary = await runReminderScan(service, { now: new Date('2026-08-10T13:10:00Z') });
    expect(summary.eod).toBe(1);
    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
  });

  // The question the dock asks, asked here too. A review already done is not
  // owed, and inviting someone to what they finished an hour ago is noise.
  it('does not invite a review already done today, and claims nothing', async () => {
    const { service, calls } = eodService({ ...EOD_USER, last_eod_review_date: '2026-08-10' });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(eodClaim(calls)).toBeUndefined();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.eod).toBe(0);
  });

  // The veto reads a date, so it is only right while the date is the day the
  // review was FOR. Last night's 21:00 push, tapped and finished at 00:15 this
  // morning, used to be stamped with this morning's date, and that cancelled
  // tonight's invitation before it was sent: a night owl got every other
  // night's push. Its link names its day now, and Done records that day
  // (eod.test.ts and eod-reviewed-day.test.tsx pin the client half), so the
  // row says the 9th, and the 10th is still owed.
  it('a review of last night, finished after midnight, leaves tonight invited', async () => {
    const { service, calls } = eodService({
      ...EOD_USER,
      last_eod_notified_date: '2026-08-09',
      last_eod_review_date: '2026-08-09',
    });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    expect(pushed()[2]).toMatchObject({ url: '/?eod=2026-08-10' });
    expect(summary.eod).toBe(1);
  });

  it('a malformed hour is never due', async () => {
    const { service, calls } = eodService({ ...EOD_USER, eod_review_time: '9pm' });
    await runReminderScan(service, { now: AT_2105_NY });
    expect(eodClaim(calls)).toBeUndefined();
  });

  // …and costs the user nothing else. Asked of someone with only the review on,
  // a malformed hour that threw would look the same as one that was ignored:
  // there is nothing else to run. With a cue due as well, a throw would put
  // the user in the notes as skipped and cost them the cue, every tick.
  it('a malformed hour leaves the cues alone', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    const { service, calls, writes } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, eod_review_enabled: true, eod_review_time: '9pm' }] },
      'items.select': { data: [BOOK_ROW] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
      'items.update': { data: [{ id: 'h1' }] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });

    expect(eodClaim(calls)).toBeUndefined();
    expect(summary).toMatchObject({ eod: 0, cues: 1, notes: [] });
    expect(writes().map((c) => [c.table, c.payload])).toEqual([['items', { reminder_sent_key: '2026-08-10T07:30' }]]);
  });

  // localClock names the hour cycle, so midnight is minute 0, inside a 00:00
  // review's window, rather than 1440 and a whole day outside it.
  it('a 00:00 review is sent at 00:05, as that day\'s', async () => {
    const { service } = eodService({ ...EOD_USER, eod_review_time: '00:00' });
    const summary = await runReminderScan(service, { now: new Date('2026-08-10T04:05:00Z') });
    expect(summary.eod).toBe(1);
    expect(pushed()[2]).toMatchObject({ tag: 'dsul-eod-2026-08-10' });
  });

  // Reminder rows left over from before the switch went off included: they bring
  // the item tiers nothing to do.
  it('a user who only wants the review never pays for the item fetch', async () => {
    const { service } = makeServiceFake({
      'user_settings.select': { data: [EOD_USER] },
      'items.select': { data: [BOOK_ROW] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
    });
    const summary = await runReminderScan(service, { now: AT_2105_NY });
    expect(fetchItems).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ users: 1, eod: 1 });
  });

  it("one user's throw leaves the next one invited", async () => {
    const { service } = makeServiceFake((call) => {
      if (call.table === 'user_settings' && call.op === 'select') {
        return { data: [EOD_USER, { ...EOD_USER, user_id: 'u2' }] };
      }
      if (call.table === 'user_settings' && call.op === 'update') {
        if (call.filters.some(([method, args]) => method === 'eq' && args[1] === 'u1')) {
          throw new Error('PostgREST exploded');
        }
        return { data: [{ user_id: 'u2' }] };
      }
      return undefined;
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    expect(summary.notes.join('\n')).toMatch(/u1: skipped — PostgREST exploded/);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(pushed()[1]).toBe('u2');
    expect(summary.eod).toBe(1);
  });

  // Why the review goes through deliverNudge and never straight to the push
  // channel: the fan-out is what absorbs a channel that fails. Called directly
  // at the top of the per-user try, one PostgREST hiccup on the device read
  // would have cost this user the review AND every cue after it this tick.
  it.each([
    ['answers with a failed read', () => sendPushToUser.mockResolvedValueOnce({ ...NO_DEVICE, detail: 'read failed: fetch failed' })],
    ['rejects outright', () => sendPushToUser.mockRejectedValueOnce(new Error('fetch failed'))],
  ])('a push that %s: the claim stands, a note says so, nothing throws, and the cues still run', async (_, failPush) => {
    // A 07:30 review and a 07:30 cue, for someone with both on.
    fetchItems.mockResolvedValue([habit({ reminderTime: '07:30' })]);
    failPush();
    const { service, calls, writes } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, eod_review_enabled: true, eod_review_time: '07:30' }] },
      'items.select': { data: [BOOK_ROW] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
      'items.update': { data: [{ id: 'h1' }] },
    });

    const summary = await runReminderScan(service, { now: AT_0735_NY });

    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    // The two claims, and nothing after them: a failed push hands neither
    // back. Released, the review would be re-claimed and re-sent every tick
    // of its window, and with SMS or a call on, re-texted or re-rung.
    expect(writes().map((c) => [c.table, c.payload])).toEqual([
      ['user_settings', { last_eod_notified_date: '2026-08-10' }],
      ['items', { reminder_sent_key: '2026-08-10T07:30' }],
    ]);
    expect(summary.notes.join('\n')).toMatch(/u1: eod via push failed — push (read failed|threw): fetch failed/);
    expect(summary).toMatchObject({ eod: 1, cues: 1, unreached: 0 });
    expect(nudges().map((n) => n.kind)).toEqual(['eod', 'cue']);
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
  });

  // The channel state is read before ANY claim, the review's included. A
  // claim that lands and is then followed by a read that throws is a review
  // stamped as invited and never sent: lost for the night, with nothing in
  // the log but the read.
  it('reads the channel state before it claims: a failed read claims nothing', async () => {
    const { service, calls, writes } = makeServiceFake({
      'user_settings.select': { data: [EOD_USER] },
      'items.select': { data: [] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
      'user_extensions.select': { error: { message: 'timeout' } },
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    expect(eodClaim(calls)).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(summary.eod).toBe(0);
    expect(summary.notes).toEqual(['u1: skipped — user_extensions unreadable: timeout']);
  });

  // decision 4, as for a cue: an invitation with no device to go to is
  // discharged, not held over for the next tick.
  it('a review with no device is still claimed, counted, and called unreached', async () => {
    sendPushToUser.mockResolvedValueOnce(NO_DEVICE);
    const { service, calls, writes } = eodService();

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    expect(eodClaim(calls)?.payload).toEqual({ last_eod_notified_date: '2026-08-10' });
    // …and the claim is the only write: nothing hands it back.
    expect(writes()).toEqual([eodClaim(calls)]);
    expect(summary).toMatchObject({ eod: 1, unreached: 1 });
    expect(summary.notes.join('\n')).toMatch(/u1: eod via push unreached/);
  });

  // Push only (decision 12): voice and SMS read a blank `kinds` as the
  // reminders, never as everything, so turning the review on texts nobody.
  it('is not texted to an SMS user who listed no kinds', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeServiceFake({
      'user_settings.select': { data: [EOD_USER] },
      'items.select': { data: [] },
      'user_settings.update': { data: [{ user_id: 'u1' }] },
      'user_extensions.select': {
        data: [{ slug: 'sms-nudge', enabled: true, config: { to: '+15551234567', from: '+15557654321' } }],
      },
      'user_secrets.select': {
        data: { reminder_secrets: { 'sms-nudge': { accountSid: 'AC1', authToken: 'tok' } } },
      },
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    expect(summary.eod).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverNudge).mock.results).toHaveLength(1);
    const reports = await vi.mocked(deliverNudge).mock.results[0].value;
    expect(reports).toContainEqual(expect.objectContaining({ channel: 'sms-nudge', skipped: true, detail: 'sms declines eod' }));
  });

  /* ── Who is in the tick ─────────────────────────────────────────────── */

  // Any of the three switches brings a user in; filtering on reminders alone
  // would never invite the review of someone who wants only that.
  it('the enumeration asks for the review\'s switch beside the other two', async () => {
    const { service, calls } = eodService();
    await runReminderScan(service, { now: AT_2105_NY });

    const read = calls.find((c) => c.table === 'user_settings' && c.op === 'select');
    expect(read?.payload).toEqual(
      'user_id, timezone, time_format, habit_reminders_enabled, habit_last_call_enabled, ' +
        'habit_last_call_time, habit_last_call_date, ' +
        'eod_review_enabled, eod_review_time, last_eod_notified_date, last_eod_review_date, ' +
        'stakes_enabled, stakes_settle_time, stakes_settled_date',
    );
    expect(read?.filters).toEqual([
      ['or', ['habit_reminders_enabled.eq.true,stakes_enabled.eq.true,eod_review_enabled.eq.true']],
      ['not', ['timezone', 'is', null]],
    ]);
  });

  // A database without the stakes columns (034) retries without them. The
  // review's columns are older than 032, so they stay, and so does its flag.
  it('still invites the review on the retry without the stakes columns', async () => {
    const { service, calls } = makeServiceFake((call) => {
      if (call.table === 'user_settings' && call.op === 'select') {
        return String(call.payload).includes('stakes_enabled')
          ? { error: { code: '42703', message: 'column user_settings.stakes_enabled does not exist' } }
          : { data: [EOD_USER] };
      }
      if (call.table === 'user_settings' && call.op === 'update') return { data: [{ user_id: 'u1' }] };
      return undefined;
    });

    const summary = await runReminderScan(service, { now: AT_2105_NY });

    const reads = calls.filter((c) => c.table === 'user_settings' && c.op === 'select');
    expect(reads).toHaveLength(2);
    expect(String(reads[1].payload)).not.toMatch(/stakes/);
    expect(reads[1].filters).toEqual([
      ['or', ['habit_reminders_enabled.eq.true,eod_review_enabled.eq.true']],
      ['not', ['timezone', 'is', null]],
    ]);
    expect(summary.eod).toBe(1);
    expect(summary.notes).toEqual(['migration 034 not applied — settling is off, reminders continue']);
  });
});

/* ── When the scan cannot start ───────────────────────────────────────────── */

// The two reads every claim depends on. A failure there claims nothing and
// sends nothing, so the route may answer 500 (decision 7), and it carries what
// the scan had already found so the 500 says more than its message.
describe('ReminderScanError', () => {
  it('is what a failed user read rejects with, carrying the notes so far', async () => {
    const { service } = makeServiceFake((call) => {
      if (call.table !== 'user_settings') return undefined;
      return String(call.payload).includes('stakes_enabled')
        ? { error: { code: '42703', message: 'column user_settings.stakes_enabled does not exist' } }
        : { error: { message: 'Gateway Timeout' } };
    });

    const outcome = runReminderScan(service, { now: AT_0735_NY });

    await expect(outcome).rejects.toBeInstanceOf(ReminderScanError);
    await expect(outcome).rejects.toMatchObject({
      message: 'Gateway Timeout',
      notes: ['migration 034 not applied — settling is off, reminders continue'],
    });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('is what a failed bookkeeping read rejects with', async () => {
    const { service, calls } = makeServiceFake({
      'user_settings.select': { data: [{ ...USER, eod_review_enabled: true }] },
      'items.select': { error: { message: 'Gateway Timeout' } },
    });
    await expect(runReminderScan(service, { now: AT_0735_NY })).rejects.toMatchObject({
      name: 'ReminderScanError',
      message: 'Gateway Timeout',
      notes: [],
    });
    // Before any claim: not even the review's.
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });
});

/* ── How long a push may wait ─────────────────────────────────────────────── */

// The scan holds the user's clock, so it is the scan that says when each
// nudge stops being worth delivering; push-send turns that instant into a TTL
// as each request leaves. Every answer stops at the user's own midnight.
describe('expiresAtMs', () => {
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
    expect(nudges()[0]).toMatchObject({ kind: 'cue', expiresAtMs: Date.parse('2026-08-10T12:00:00Z') });
    expect(secondsLeft(nudges()[0], AT_0735_NY)).toBe(25 * 60);
  });

  it('a 23:45 cue at 23:50 stops at midnight', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '23:45' })]);
    await runReminderScan(cueService(), { now: AT_2350_NY });
    expect(nudges()[0]).toMatchObject({ kind: 'cue' });
    expect(secondsLeft(nudges()[0], AT_2350_NY)).toBe(600);
  });

  // The scan ticks every five minutes, so it tells dueReminders its last tick
  // and a 23:58 cue's window opens there: sent at 23:55, claimed under its own
  // time, and good until midnight.
  it('a 23:58 cue is sent on the 23:55 tick, and stops at midnight', async () => {
    fetchItems.mockResolvedValue([habit({ reminderTime: '23:58' })]);
    const { service, writes } = makeServiceFake({
      'user_settings.select': { data: [USER] },
      'items.select': { data: [BOOK_ROW] },
      'items.update': { data: [{ id: 'h1' }] },
    });
    const at = new Date('2026-08-11T03:55:00Z');

    const summary = await runReminderScan(service, { now: at });

    expect(summary.cues).toBe(1);
    expect(writes().map((c) => c.payload)).toEqual([{ reminder_sent_key: '2026-08-10T23:58' }]);
    expect(nudges()[0]).toMatchObject({ kind: 'cue', expiresAtMs: Date.parse('2026-08-11T04:00:00Z') });
    expect(secondsLeft(nudges()[0], at)).toBe(300);
  });

  it('a 23:50 last call expires at midnight, 600 seconds on', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    await runReminderScan(lastCallService('23:50'), { now: AT_2350_NY });

    expect(nudges()[0]).toMatchObject({ kind: 'last-call' });
    expect(secondsLeft(nudges()[0], AT_2350_NY)).toBe(600);
    // …and that is the instant the push carries, beside its urgency and topic.
    const [, , payload] = sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(payload).toMatchObject({ expiresAtMs: Date.parse('2026-08-11T04:00:00Z'), urgency: 'high', topic: 'lc-20260810' });
  });

  // What a last call says is the day's state at the minute it was worked out,
  // so its grace runs from the tick that sent it.
  it('a last call found late in its window still gets one grace from the tick', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    // 20:45 in New York; the last call was due at 20:30.
    const at = new Date('2026-08-11T00:45:00Z');
    await runReminderScan(lastCallService('20:30'), { now: at });
    expect(nudges()[0]).toMatchObject({ kind: 'last-call' });
    expect(secondsLeft(nudges()[0], at)).toBe(1800);
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

    expect(nudges()[0]).toMatchObject({ kind: 'cue', snoozed: true });
    expect(secondsLeft(nudges()[0], AT_0735_NY)).toBe(1800);
  });

  // nowMinutes is truncated. Counted in whole minutes from the tick, a tick
  // at 23:50:40 would hold the push until 00:00:40, i.e. hand yesterday's last
  // call to a phone after midnight.
  it('counts from the minute, so a tick part-way through one still stops at midnight', async () => {
    fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
    const at = new Date('2026-08-11T03:50:40.250Z');
    await runReminderScan(lastCallService('23:50'), { now: at });
    expect(nudges()[0]).toMatchObject({ kind: 'last-call', expiresAtMs: Date.parse('2026-08-11T04:00:00Z') });
    expect(secondsLeft(nudges()[0], at)).toBe(559.75);
  });

  // An instant, so how long the tick takes to reach this user changes nothing:
  // the scan's answer is fixed by its own clock, and the TTL is worked out from
  // it by push-send as the request leaves (push-send.test.ts pins that half).
  it('is an instant fixed by the tick, however late in the tick the send is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The tick began at 23:50, and this user is reached seventy seconds
      // later, in the NEXT minute. A lag inside the tick's own minute proves
      // nothing: expiryAt rounds down to the minute, so a wall-clock read ten
      // seconds in rounds back to 23:50:00 and gives the same midnight. Read
      // at 23:51:10, the wall clock would answer 00:01:00.
      vi.setSystemTime(AT_2350_NY.getTime() + 70_000);
      fetchItems.mockResolvedValue([habit({ title: 'Reading', streak: 12 })]);
      await runReminderScan(lastCallService('23:50'), { now: AT_2350_NY });
      expect(nudges()[0].expiresAtMs).toBe(Date.parse('2026-08-11T04:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('expiryAt is never before the tick', () => {
    const clock = localClock(AT_2350_NY, 'America/New_York');
    expect(expiryAt(clock, 1440)).toBe(AT_2350_NY.getTime() + 600_000);
    expect(expiryAt(clock, 1430)).toBe(AT_2350_NY.getTime());
    expect(expiryAt(clock, 1400)).toBe(AT_2350_NY.getTime());
  });
});

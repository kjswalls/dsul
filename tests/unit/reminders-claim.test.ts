// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Item } from '@dsul/types';
import { called, eqOf, fakeService, op, type FakeQuery, type FakeResult } from './helpers/fake-service';

/**
 * POST /api/reminders/claim (memory/plans/reminders-platforms.md §5.2,
 * PR-1b): an open page claims a cue with the scan's own compare-and-swap,
 * through the SESSION client, and only after the server has re-asked
 * dueReminders whether the cue is due by the database and its own clock.
 * Won, lost and later for each of the three kinds; the snooze CAS filter; a
 * release that never clears a newer key; a foreign itemId that changes nothing.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ITEM = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const TZ = 'America/New_York';
const DAY = '2026-10-10';
/** 07:31 in New York (EDT, UTC-4). */
const AT_0731 = '2026-10-10T11:31:00.000Z';

const h = vi.hoisted(() => ({
  session: null as unknown,
  fetchItemById: vi.fn(),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
}));

vi.mock('@/lib/supabase-server', () => ({ createClient: async () => h.session }));
vi.mock('@/lib/db', () => ({
  fetchItemById: h.fetchItemById,
  fetchRoutines: h.fetchRoutines,
  fetchSeasons: h.fetchSeasons,
}));

import { POST } from '@/app/api/reminders/claim/route';

const habit = (over: Partial<Item> = {}): Item =>
  ({
    type: 'habit',
    id: ITEM,
    title: 'Vitamins',
    project: 'G',
    streak: 3,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    reminderTime: '07:30',
    ...over,
  }) as Item;

let settings: Record<string, unknown> | null;
let book: Record<string, unknown>[];
let casResult: FakeResult;
let fake: ReturnType<typeof fakeService>;
let user: { id: string } | null;

function respond(q: FakeQuery): FakeResult {
  if (q.table === 'user_settings') return { data: settings, error: null };
  if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: q.table } };
  if (op(q) === 'update') return casResult;
  return { data: book.filter((r) => (called(q, 'in')[0]?.[1] as string[]).includes(r.id as string)), error: null };
}

const claim = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/reminders/claim', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest
  );

const cue = (over: Record<string, unknown> = {}) => ({ kind: 'cue', itemId: ITEM, dateStr: DAY, at: '07:30', ...over });
const updates = () => fake.queries.filter((q) => op(q) === 'update');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT_0731));
  vi.clearAllMocks();
  settings = { timezone: TZ, habit_reminders_enabled: true };
  book = [{ id: ITEM, reminder_sent_key: null, reminder_snooze_until: null, reminder_snooze_date: null }];
  casResult = { data: [{ id: ITEM }], error: null };
  user = { id: USER };
  h.fetchItemById.mockImplementation(async (_u: string, id: string) => (id === ITEM ? habit() : null));
  fake = fakeService(respond);
  h.session = { ...fake.service, auth: { getUser: async () => ({ data: { user } }) } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the door', () => {
  it('401 without a session', async () => {
    user = null;
    expect((await claim({ candidates: [cue()] })).status).toBe(401);
  });

  it('400 on a body that is not the strict shape', async () => {
    expect((await claim({ candidates: [] })).status).toBe(400);
    expect((await claim({ candidates: [cue({ extra: 1 })] })).status).toBe(400);
    expect((await claim({ candidates: [cue({ kind: 'last-call' })] })).status).toBe(400);
    expect((await claim({ candidates: [cue({ at: '7:30' })] })).status).toBe(400);
    expect((await claim({ candidates: [{ kind: 'snooze', itemId: ITEM, dateStr: DAY, held: 'soon' }] })).status).toBe(400);
    expect(fake.queries).toEqual([]);
  });
});

describe('a cue', () => {
  it('won: the scan’s compare-and-swap, as the user, on the day+time key', async () => {
    const res = await claim({ candidates: [cue()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ won: [cue()], lost: [], later: [] });
    const [cas] = updates();
    expect(cas.calls[0]).toEqual(['update', [{ reminder_sent_key: '2026-10-10T07:30' }]]);
    expect(eqOf(cas, 'id')).toBe(ITEM);
    expect(eqOf(cas, 'user_id')).toBe(USER);
    expect(called(cas, 'or')[0]).toEqual(['reminder_sent_key.is.null,reminder_sent_key.neq.2026-10-10T07:30']);
    // Asked of the item as the database holds it, as this user.
    expect(h.fetchItemById).toHaveBeenCalledWith(USER, ITEM, h.session);
  });

  it('lost: the row was already stamped (the scan, or another page, got there first)', async () => {
    casResult = { data: [], error: null };
    expect(await (await claim({ candidates: [cue()] })).json()).toEqual({ won: [], lost: [cue()], later: [] });
  });

  it('later: the database refused the write; nothing was claimed', async () => {
    casResult = { data: null, error: { message: 'nope' } };
    expect(await (await claim({ candidates: [cue()] })).json()).toEqual({ won: [], lost: [], later: [cue()] });
  });

  it('lost, and no write: the server already reads it as sent', async () => {
    book[0].reminder_sent_key = '2026-10-10T07:30';
    expect(await (await claim({ candidates: [cue()] })).json()).toMatchObject({ lost: [cue()] });
    expect(updates()).toEqual([]);
  });

  it('lost, and no write: a habit ticked elsewhere (the page’s items were stale)', async () => {
    h.fetchItemById.mockResolvedValue(habit({ completedDates: [DAY] } as Partial<Item>));
    expect(await (await claim({ candidates: [cue()] })).json()).toMatchObject({ lost: [cue()] });
    expect(updates()).toEqual([]);
  });

  it('later, and no write: a page clock ahead of the server’s', async () => {
    vi.setSystemTime(new Date('2026-10-10T11:29:50.000Z'));
    expect(await (await claim({ candidates: [cue()] })).json()).toEqual({ won: [], lost: [], later: [cue()] });
    expect(updates()).toEqual([]);
  });

  it('lost: tomorrow’s cue asked tonight, or a day that is over', async () => {
    const tomorrow = cue({ dateStr: '2026-10-11' });
    const yesterday = cue({ dateStr: '2026-10-09' });
    expect(await (await claim({ candidates: [tomorrow, yesterday] })).json()).toMatchObject({ lost: [tomorrow, yesterday] });
    expect(updates()).toEqual([]);
  });

  it('lost: a time the item no longer holds', async () => {
    const old = cue({ at: '07:15' });
    expect(await (await claim({ candidates: [old] })).json()).toMatchObject({ lost: [old] });
    expect(updates()).toEqual([]);
  });

  it('lost, no item read: reminders off, or no stored zone (the scan sends nothing either)', async () => {
    settings = { timezone: TZ, habit_reminders_enabled: false };
    expect(await (await claim({ candidates: [cue()] })).json()).toMatchObject({ lost: [cue()] });
    settings = { timezone: null, habit_reminders_enabled: true };
    expect(await (await claim({ candidates: [cue()] })).json()).toMatchObject({ lost: [cue()] });
    expect(h.fetchItemById).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it('a foreign itemId changes no rows: RLS hides it from the read, and nothing is written', async () => {
    const foreign = cue({ itemId: FOREIGN });
    expect(await (await claim({ candidates: [foreign] })).json()).toEqual({ won: [], lost: [foreign], later: [] });
    expect(h.fetchItemById).not.toHaveBeenCalledWith(USER, FOREIGN, expect.anything());
    expect(updates()).toEqual([]);
    const read = fake.queries.find((q) => q.table === 'items')!;
    expect(eqOf(read, 'user_id')).toBe(USER);
  });

  it('500 when a read fails before any claim', async () => {
    h.fetchItemById.mockRejectedValue(new Error('down'));
    expect((await claim({ candidates: [cue()] })).status).toBe(500);
    expect(updates()).toEqual([]);
  });
});

describe('a snooze', () => {
  const HELD_PG = '2026-10-10T11:20:00+00:00';
  const HELD = '2026-10-10T11:20:00.000Z';
  const snooze = (held = HELD) => ({ kind: 'snooze', itemId: ITEM, dateStr: DAY, held });

  beforeEach(() => {
    book[0] = { ...book[0], reminder_sent_key: '2026-10-10T07:30', reminder_snooze_until: HELD_PG, reminder_snooze_date: DAY };
  });

  it('won: cleared only while the row still holds that exact snooze', async () => {
    expect(await (await claim({ candidates: [snooze()] })).json()).toEqual({ won: [snooze()], lost: [], later: [] });
    const [cas] = updates();
    expect(cas.calls[0]).toEqual(['update', [{ reminder_snooze_until: null, reminder_snooze_date: null }]]);
    expect(eqOf(cas, 'reminder_snooze_until')).toBe(HELD_PG);
    expect(eqOf(cas, 'user_id')).toBe(USER);
  });

  it('lost: a newer snooze (another device’s tap) is never this page’s to clear', async () => {
    const stale = snooze('2026-10-10T11:05:00.000Z');
    expect(await (await claim({ candidates: [stale] })).json()).toMatchObject({ lost: [stale] });
    expect(updates()).toEqual([]);
  });

  it('later: not matured on the server’s clock yet', async () => {
    vi.setSystemTime(new Date('2026-10-10T11:19:00.000Z'));
    expect(await (await claim({ candidates: [snooze()] })).json()).toMatchObject({ later: [snooze()] });
    expect(updates()).toEqual([]);
  });

  it('lost: a snooze that belongs to another day', async () => {
    book[0].reminder_snooze_date = '2026-10-09';
    expect(await (await claim({ candidates: [snooze()] })).json()).toMatchObject({ lost: [snooze()] });
  });
});

describe('a release', () => {
  const release = { kind: 'release', itemId: ITEM, dateStr: DAY, at: '07:30' };

  it('nulls the key only while it is still the one the page wrote', async () => {
    expect(await (await claim({ candidates: [release] })).json()).toEqual({ won: [release], lost: [], later: [] });
    const [cas] = updates();
    expect(cas.calls[0]).toEqual(['update', [{ reminder_sent_key: null }]]);
    expect(eqOf(cas, 'reminder_sent_key')).toBe('2026-10-10T07:30');
    expect(eqOf(cas, 'user_id')).toBe(USER);
    // Not re-asked of due.ts: it only gives back what the page took.
    expect(fake.queries.some((q) => q.table === 'user_settings')).toBe(false);
  });

  it('a newer key is never cleared: the CAS matches nothing and the answer is lost', async () => {
    casResult = { data: [], error: null };
    expect(await (await claim({ candidates: [release] })).json()).toEqual({ won: [], lost: [release], later: [] });
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { called, eqOf, fakeService, op, type FakeQuery, type FakeResult } from './helpers/fake-service';

/**
 * POST /api/reminders/act, the notification's Done, and the recipes it starts
 * (memory/plans/mods.md, build order 6): a Done that ticked an item not
 * already done runs the user's "I tick an item" recipes on the server once the
 * response is out, through the runner's one door. A Done on a day already
 * done, and a snooze, start nothing; a recipe that fails costs the tick
 * nothing.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ITEM = '44444444-4444-4444-8444-444444444444';
const DAY = '2026-10-07';

const h = vi.hoisted(() => ({
  session: null as unknown,
  after: vi.fn(),
  runItemEventRecipes: vi.fn(),
  reportLiveCompletion: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/supabase-server', () => ({ createClient: async () => h.session }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock('@/lib/stakes/live', () => ({ reportLiveCompletion: h.reportLiveCompletion }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: h.after,
}));
// The real door (lib/recipes/server/index.ts), with the runner behind it stubbed.
vi.mock('@/lib/recipes/server/item-events', () => ({ runItemEventRecipes: h.runItemEventRecipes }));

import { POST } from '@/app/api/reminders/act/route';

let row: Record<string, unknown> | null;
let doneBefore: boolean;
let fake: ReturnType<typeof fakeService>;

function respond(q: FakeQuery): FakeResult {
  if (q.table === 'item_events') return { data: null, error: null };
  if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: q.table } };
  if (op(q) === 'update') return { data: null, error: null };
  if (called(q, 'contains').length > 0) return { data: doneBefore ? { id: ITEM } : null, error: null };
  return { data: row, error: null };
}

const act = (body: unknown) =>
  POST(new Request('https://do.dsul.app/api/reminders/act', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest);

async function runAfter() {
  for (const [callback] of h.after.mock.calls) await (callback as () => Promise<void>)();
}

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: ITEM, type: 'habit', repeat_frequency: 'daily', status: 'pending', start_date: null };
  doneBefore = false;
  fake = fakeService(respond);
  // The cookie session's client: the same recording builder, plus the user.
  h.session = { ...fake.service, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } };
  h.runItemEventRecipes.mockResolvedValue({ runs: 1, notes: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Done starts the tick recipes, once the response is out', () => {
  it('a recurring item not yet done: the recipes run in after(), for the user, the item and the day', async () => {
    const res = await act({ action: 'done', itemId: ITEM, dateStr: DAY });
    expect(await res.json()).toEqual({ ok: true });
    expect(h.runItemEventRecipes).not.toHaveBeenCalled();
    expect(h.after).toHaveBeenCalledTimes(1);
    await runAfter();
    expect(h.runItemEventRecipes).toHaveBeenCalledWith({ service: true }, USER, {
      kind: 'item.completed',
      itemId: ITEM,
      type: 'habit',
      date: DAY,
    });
    // Whether it was done was asked of that one day, as the user, before the tick.
    const asked = fake.queries.find((q) => called(q, 'contains').length > 0)!;
    expect(eqOf(asked, 'user_id')).toBe(USER);
    expect(called(asked, 'contains')[0]).toEqual(['completed_dates', [DAY]]);
    expect(fake.queries.indexOf(asked)).toBeLessThan(fake.queries.findIndex((q) => op(q) === 'update'));
  });

  it('a day already done starts nothing', async () => {
    doneBefore = true;
    expect(await (await act({ action: 'done', itemId: ITEM, dateStr: DAY })).json()).toEqual({ ok: true });
    expect(h.after).not.toHaveBeenCalled();
  });

  it('a one-off decides on its status, and its day is its own', async () => {
    row = { id: ITEM, type: 'task', repeat_frequency: null, status: 'pending', start_date: '2026-10-05' };
    await act({ action: 'done', itemId: ITEM, dateStr: DAY });
    await runAfter();
    expect(h.runItemEventRecipes).toHaveBeenCalledWith(expect.anything(), USER, expect.objectContaining({ date: '2026-10-05' }));
    expect(fake.queries.filter((q) => called(q, 'contains').length > 0)).toEqual([]);

    vi.clearAllMocks();
    row = { ...row, status: 'completed' };
    await act({ action: 'done', itemId: ITEM, dateStr: DAY });
    expect(h.after).not.toHaveBeenCalled();
  });

  it('a snooze starts nothing', async () => {
    const res = await act({ action: 'snooze', itemId: ITEM, dateStr: DAY });
    expect((await res.json()).ok).toBe(true);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('a recipe that fails costs the tick nothing', async () => {
    h.runItemEventRecipes.mockRejectedValue(new Error('recipes down'));
    const res = await act({ action: 'done', itemId: ITEM, dateStr: DAY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(runAfter()).resolves.toBeUndefined();
  });

  it('a tick that failed starts nothing', async () => {
    fake.rpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } } as never);
    const res = await act({ action: 'done', itemId: ITEM, dateStr: DAY });
    expect(res.status).toBe(500);
    expect(h.after).not.toHaveBeenCalled();
  });
});

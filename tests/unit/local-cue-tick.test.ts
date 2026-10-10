import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '@dsul/types';
import {
  createLocalCueTick,
  deviceClaims,
  PRESENCE_MS,
  type LocalTickDeps,
  type PlannerView,
  type Presenter,
  type ThisDevice,
} from '@/lib/reminders/local-tick';
import type { ClaimAnswer, ClaimCandidate } from '@/lib/reminders/claim-wire';

/**
 * The page tick (lib/reminders/local-tick.ts, reminders PR-1b) with every
 * browser effect faked: when it asks, what it shows, what it acks, what it
 * gives back, and what it never asks again.
 */

const ITEM = '44444444-4444-4444-8444-444444444444';
const TZ = 'America/New_York';
const DAY = '2026-10-10';
/** 07:31 in New York (EDT). */
const T0731 = Date.parse('2026-10-10T11:31:00.000Z');

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

let now: number;
let visible: boolean;
let lastInput: number;
let permission: string;
let view: PlannerView;
let device: ThisDevice | null;
let presenter: (Presenter & { showNotification: ReturnType<typeof vi.fn> }) | null;
let answer: (asked: ClaimCandidate[]) => ClaimAnswer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are read field by field
type Body = any;
let posts: { path: string; body: Body }[];
let deps: LocalTickDeps;

const won = (asked: ClaimCandidate[]): ClaimAnswer => ({ won: asked, lost: [], later: [] });
const claims = () => posts.filter((p) => p.path === '/api/reminders/claim');
const acks = () => posts.filter((p) => p.path === '/api/reminders/ack');

beforeEach(() => {
  now = T0731;
  visible = true;
  lastInput = T0731 - 60_000;
  permission = 'granted';
  view = { userId: 'u1', items: [habit()], timezone: TZ, timeFormat: '12h', remindersEnabled: true };
  device = { deviceId: 'web-device-0001', claimsLocally: true };
  presenter = { showNotification: vi.fn(async () => undefined) };
  answer = won;
  posts = [];
  deps = {
    now: () => now,
    visible: () => visible,
    lastInputMs: () => lastInput,
    permission: () => permission,
    planner: () => view,
    device: vi.fn(async () => device),
    presenter: vi.fn(async () => presenter),
    post: vi.fn(async (path: string, body: Body) => {
      posts.push({ path, body });
      const json = path === '/api/reminders/claim' && body.candidates[0].kind !== 'release' ? answer(body.candidates) : { ok: true };
      return { ok: true, json: async () => json };
    }),
  };
});

describe('nobody here, nothing asked', () => {
  it('a hidden page asks nothing', async () => {
    visible = false;
    await createLocalCueTick(deps).tick();
    expect(posts).toEqual([]);
  });

  it('no input in five minutes asks nothing', async () => {
    lastInput = now - PRESENCE_MS - 1;
    await createLocalCueTick(deps).tick();
    expect(posts).toEqual([]);
  });

  it('no notification permission asks nothing', async () => {
    permission = 'default';
    await createLocalCueTick(deps).tick();
    expect(posts).toEqual([]);
  });

  it('reminders off, or no stored zone, asks nothing', async () => {
    view = { ...view, remindersEnabled: false };
    await createLocalCueTick(deps).tick();
    view = { ...view, remindersEnabled: true, timezone: null };
    await createLocalCueTick(deps).tick();
    expect(posts).toEqual([]);
  });

  it('nothing due reads nothing: no device read, no worker, no request', async () => {
    now = Date.parse('2026-10-10T13:00:00.000Z');
    await createLocalCueTick(deps).tick();
    expect(deps.device).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('a page that is not this account’s device, or switched off, never claims', async () => {
    device = null;
    await createLocalCueTick(deps).tick();
    device = { deviceId: 'web-device-0001', claimsLocally: false };
    await createLocalCueTick(deps).tick();
    expect(claims()).toEqual([]);
  });

  it('a page with no worker to show through never claims (a claim is never best-effort)', async () => {
    presenter = null;
    await createLocalCueTick(deps).tick();
    expect(claims()).toEqual([]);
  });
});

describe('a won claim', () => {
  it('is shown once, under the push’s tag, then acked with this device’s id', async () => {
    await createLocalCueTick(deps).tick();
    expect(claims()).toHaveLength(1);
    expect(claims()[0].body).toEqual({ candidates: [{ kind: 'cue', itemId: ITEM, dateStr: DAY, at: '07:30' }] });
    expect(presenter!.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = presenter!.showNotification.mock.calls[0];
    expect(title).toBe('Vitamins');
    expect(options).toMatchObject({
      body: '7:30 am · 3 days',
      tag: `dsul-item-${ITEM}`,
      renotify: true,
      actions: [
        { action: 'done', title: 'Done' },
        { action: 'snooze', title: 'Snooze 15m' },
      ],
      data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: DAY, kind: 'cue' },
    });
    expect(acks()).toEqual([
      { path: '/api/reminders/ack', body: { key: `cue:${ITEM}:${DAY}T07:30`, deviceId: 'web-device-0001' } },
    ]);
  });

  it('is not shown again the next minute', async () => {
    const tick = createLocalCueTick(deps);
    await tick.tick();
    now += 60_000;
    await tick.tick();
    expect(claims()).toHaveLength(1);
    expect(presenter!.showNotification).toHaveBeenCalledTimes(1);
  });

  it('a presenter that fails after the claim gives the cue back (release), and is not acked', async () => {
    presenter!.showNotification.mockRejectedValue(new Error('no'));
    await createLocalCueTick(deps).tick();
    expect(claims().map((c) => c.body.candidates[0])).toEqual([
      { kind: 'cue', itemId: ITEM, dateStr: DAY, at: '07:30' },
      { kind: 'release', itemId: ITEM, dateStr: DAY, at: '07:30' },
    ]);
    expect(acks()).toEqual([]);
  });
});

describe('lost and later', () => {
  it('a lost claim is never asked again', async () => {
    answer = (asked) => ({ won: [], lost: asked, later: [] });
    const tick = createLocalCueTick(deps);
    await tick.tick();
    now += 60_000;
    await tick.tick();
    expect(claims()).toHaveLength(1);
    expect(presenter!.showNotification).not.toHaveBeenCalled();
  });

  it('a later one is asked again next minute', async () => {
    answer = (asked) => ({ won: [], lost: [], later: asked });
    const tick = createLocalCueTick(deps);
    await tick.tick();
    now += 60_000;
    await tick.tick();
    expect(claims()).toHaveLength(2);
  });

  it('a habit ticked here is not asked at all', async () => {
    view = { ...view, items: [habit({ completedDates: [DAY] } as Partial<Item>)] };
    await createLocalCueTick(deps).tick();
    expect(posts).toEqual([]);
  });
});

describe('snoozes', () => {
  const HELD = '2026-10-10T11:46:00.000Z';

  it('a snooze tapped here is re-claimed at the instant it was held, and rung', async () => {
    const tick = createLocalCueTick(deps);
    await tick.tick(); // the cue itself
    tick.noteSnooze({ itemId: ITEM, dateStr: DAY, held: HELD });
    now = Date.parse('2026-10-10T11:40:00.000Z');
    await tick.tick();
    expect(claims()).toHaveLength(1); // not matured: nothing asked
    now = Date.parse(HELD) + 5_000;
    lastInput = now - 1_000;
    await tick.tick();
    expect(claims()[1].body).toEqual({ candidates: [{ kind: 'snooze', itemId: ITEM, dateStr: DAY, held: HELD }] });
    expect(presenter!.showNotification).toHaveBeenCalledTimes(2);
    expect(acks()[1].body.key).toBe(`snooze:${ITEM}:${HELD}`);
    now += 60_000;
    lastInput = now;
    await tick.tick();
    expect(claims()).toHaveLength(2);
  });

  it('a snooze held past its day’s local midnight is dropped, never rung', async () => {
    const tick = createLocalCueTick(deps);
    view = { ...view, items: [habit({ reminderTime: '23:50' } as Partial<Item>)] };
    // Tapped at 23:55 New York; the server stored the ungated 00:10.
    tick.noteSnooze({ itemId: ITEM, dateStr: DAY, held: '2026-10-11T04:10:00.000Z' });
    now = Date.parse('2026-10-11T04:11:00.000Z'); // 00:11 on the 11th
    lastInput = now;
    await tick.tick();
    expect(claims()).toEqual([]);
  });
});

describe('deviceClaims', () => {
  it('on unless switched off, the cue kind is off, or the device is muted', () => {
    expect(deviceClaims({})).toBe(true);
    expect(deviceClaims(null)).toBe(true);
    expect(deviceClaims({ claimsLocally: true })).toBe(true);
    expect(deviceClaims({ claimsLocally: false })).toBe(false);
    expect(deviceClaims({ kinds: { cue: false } })).toBe(false);
    expect(deviceClaims({ kinds: { eod: false } })).toBe(true);
    expect(deviceClaims({ muted: true })).toBe(false);
  });
});

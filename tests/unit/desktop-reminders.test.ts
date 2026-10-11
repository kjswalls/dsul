import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '@dsul/types';
import { desktopNotifier, type DesktopNotificationEvent, type DsulDesktop } from '@/lib/desktop';
import { desktopRegistration } from '@/lib/devices/web-client';
import { DeviceRegistrationSchema } from '@dsul/types';
import {
  actOnDesktopNotification,
  atTheDesk,
  DESKTOP_IDLE_SECONDS,
  desktopPresenter,
  specFor,
  type ActDeps,
} from '@/lib/reminders/desktop-presenter';
import { createLocalCueTick, PRESENCE_MS, type LocalTickDeps } from '@/lib/reminders/local-tick';
import type { ClaimCandidate } from '@/lib/reminders/claim-wire';
import { notificationFor } from '@/lib/sw/handlers';
import notify from '../../electron/lib/notify.cjs';

/**
 * The desktop app's side of reminders PR-1c: the page tick drawing through
 * main instead of a service worker, "here" meaning any use of the computer,
 * and a click or a button handled the way the service worker handles one.
 */

const ITEM = '44444444-4444-4444-8444-444444444444';
const DAY = '2026-10-10';
const T0731 = Date.parse('2026-10-10T11:31:00.000Z');

const pushed = notificationFor({
  title: 'Vitamins',
  body: '7:30 AM · 3 days',
  url: `/item/${ITEM}`,
  tag: `dsul-item-${ITEM}`,
  actions: [
    { action: 'done', title: 'Done' },
    { action: 'snooze', title: 'Snooze 15m' },
  ],
  data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: DAY, kind: 'cue', key: `cue:${ITEM}:${DAY}T07:30` },
});

describe('specFor / desktopPresenter', () => {
  it('turns the push’s own notification into a spec main accepts, buttons and all', () => {
    const spec = specFor(pushed.title, pushed.options);
    expect(spec).toEqual({
      tag: `dsul-item-${ITEM}`,
      title: 'Vitamins',
      body: '7:30 AM · 3 days',
      url: `/item/${ITEM}`,
      actions: [
        { action: 'done', title: 'Done' },
        { action: 'snooze', title: 'Snooze 15m' },
      ],
      data: { itemId: ITEM, dateStr: DAY, kind: 'cue', key: `cue:${ITEM}:${DAY}T07:30` },
    });
    expect(notify.shapeNotification(spec, 'darwin')?.actionIds).toEqual(['done', 'snooze']);
  });

  it('throws when main refused, so the tick gives the claim back', async () => {
    const presenter = desktopPresenter({ notify: async () => false });
    await expect(presenter.showNotification(pushed.title, pushed.options)).rejects.toThrow();
    const shown = vi.fn(async () => true);
    await desktopPresenter({ notify: shown }).showNotification(pushed.title, pushed.options);
    expect(shown).toHaveBeenCalledTimes(1);
  });
});

describe('atTheDesk', () => {
  it('is any input on the computer in the last five minutes, and nobody when main will not say', async () => {
    expect(DESKTOP_IDLE_SECONDS * 1000).toBe(PRESENCE_MS);
    expect(await atTheDesk({ idleSeconds: async () => 10 })).toBe(true);
    expect(await atTheDesk({ idleSeconds: async () => DESKTOP_IDLE_SECONDS })).toBe(false);
    expect(await atTheDesk({ idleSeconds: async () => null })).toBe(false);
  });
});

describe('the tick, run by the desktop app', () => {
  const habit = {
    type: 'habit', id: ITEM, title: 'Vitamins', project: 'G', streak: 3, status: 'pending',
    completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily', reminderTime: '07:30',
  } as unknown as Item;

  const deps = (presence: () => Promise<boolean>, notifyFn = vi.fn(async () => true)) => {
    const posts: { path: string; body: { candidates?: ClaimCandidate[] } }[] = [];
    const d: LocalTickDeps = {
      now: () => T0731,
      // A window behind another app, with no input of its own for an hour.
      visible: () => false,
      lastInputMs: () => T0731 - 3_600_000,
      permission: () => 'granted',
      planner: () => ({ userId: 'u1', items: [habit], timezone: 'America/New_York', timeFormat: '12h', remindersEnabled: true }),
      device: async () => ({ deviceId: 'web-desktop-0001', claimsLocally: true }),
      presenter: async () => desktopPresenter({ notify: notifyFn }),
      post: async (path, body) => {
        posts.push({ path, body: body as { candidates?: ClaimCandidate[] } });
        const json = path === '/api/reminders/claim' ? { won: (body as { candidates: ClaimCandidate[] }).candidates, lost: [], later: [] } : { ok: true };
        return { ok: true, json: async () => json };
      },
      presence,
    };
    return { d, posts, notifyFn };
  };

  it('claims and draws through main while someone uses the computer, though the window is hidden', async () => {
    const { d, posts, notifyFn } = deps(async () => true);
    await createLocalCueTick(d).tick();
    expect(posts.map((p) => p.path)).toEqual(['/api/reminders/claim', '/api/reminders/ack']);
    expect(notifyFn).toHaveBeenCalledWith(expect.objectContaining({ tag: `dsul-item-${ITEM}`, title: 'Vitamins' }));
  });

  it('asks nothing while the computer is idle', async () => {
    const { d, posts } = deps(async () => false);
    await createLocalCueTick(d).tick();
    expect(posts).toEqual([]);
  });

  it('gives the cue back when main refuses to draw it', async () => {
    const { d, posts } = deps(async () => true, vi.fn(async () => false));
    await createLocalCueTick(d).tick();
    expect(posts.map((p) => p.path)).toEqual(['/api/reminders/claim', '/api/reminders/claim']);
    expect(posts[1].body.candidates?.[0]).toMatchObject({ kind: 'release', itemId: ITEM, at: '07:30' });
  });

  it('never claims when the probe said nobody would see it (permission is not granted)', async () => {
    const { d, posts } = deps(async () => true);
    await createLocalCueTick({ ...d, permission: () => 'denied' }).tick();
    expect(posts).toEqual([]);
  });
});

describe('actOnDesktopNotification', () => {
  let deps: ActDeps & { posts: unknown[]; navigated: string[]; snoozes: unknown[]; failures: unknown[] };
  let answer: { ok: boolean; body: unknown } | Error;

  beforeEach(() => {
    answer = { ok: true, body: { ok: true } };
    const posts: unknown[] = [];
    const navigated: string[] = [];
    const snoozes: unknown[] = [];
    const failures: unknown[] = [];
    deps = {
      posts,
      navigated,
      snoozes,
      failures,
      post: async (path, body) => {
        posts.push([path, body]);
        if (answer instanceof Error) throw answer;
        const { ok, body: json } = answer;
        return { ok, json: async () => json };
      },
      navigate: (url) => navigated.push(url),
      noteSnooze: (s) => snoozes.push(s),
      failed: (title, url) => failures.push([title, url]),
    };
  });

  const data = { url: `/item/${ITEM}`, itemId: ITEM, dateStr: DAY, kind: 'cue' as const };
  const event = (over: Partial<DesktopNotificationEvent>): DesktopNotificationEvent => ({ type: 'click', tag: `dsul-item-${ITEM}`, data, ...over });

  it('a plain click opens the link and calls nothing', async () => {
    await actOnDesktopNotification(event({}), deps);
    expect(deps.navigated).toEqual([`/item/${ITEM}`]);
    expect(deps.posts).toEqual([]);
  });

  it('Done calls the act route with the item and day, as the service worker does', async () => {
    await actOnDesktopNotification(event({ type: 'action', action: 'done' }), deps);
    expect(deps.posts).toEqual([['/api/reminders/act', { action: 'done', itemId: ITEM, dateStr: DAY }]]);
    expect(deps.navigated).toEqual([]);
  });

  it('a stored Snooze goes to the tick to ring at its time; one held past midnight does not', async () => {
    answer = { ok: true, body: { ok: true, snoozedUntil: '2026-10-10T11:46:00.000Z' } };
    await actOnDesktopNotification(event({ type: 'action', action: 'snooze' }), deps);
    expect(deps.snoozes).toEqual([{ itemId: ITEM, dateStr: DAY, held: '2026-10-10T11:46:00.000Z' }]);
    answer = { ok: true, body: { ok: true, snoozedUntil: null } };
    await actOnDesktopNotification(event({ type: 'action', action: 'snooze' }), deps);
    expect(deps.snoozes).toHaveLength(1);
  });

  it('a button that could not act says so, offline or refused', async () => {
    answer = { ok: false, body: {} };
    await actOnDesktopNotification(event({ type: 'action', action: 'done' }), deps, 'Vitamins');
    answer = new Error('offline');
    await actOnDesktopNotification(event({ type: 'action', action: 'done' }), deps, 'Vitamins');
    expect(deps.failures).toEqual([
      ['Vitamins', `/item/${ITEM}`],
      ['Vitamins', `/item/${ITEM}`],
    ]);
  });

  it('a button with no item or day is a plain click', async () => {
    await actOnDesktopNotification(event({ type: 'action', action: 'done', data: { url: '/' } }), deps);
    expect(deps.posts).toEqual([]);
    expect(deps.navigated).toEqual(['/']);
  });
});

describe('desktopNotifier', () => {
  const base = { version: 1, shellVersion: '0.2.0', electronVersion: '44', platform: 'darwin' } as unknown as DsulDesktop;

  it('is null for a shell built before reminders, and for a browser', () => {
    expect(desktopNotifier(null)).toBeNull();
    expect(desktopNotifier(base)).toBeNull();
    expect(desktopNotifier({ ...base, notify: async () => true } as DsulDesktop)).toBeNull();
  });

  it('is the five members, bound to the bridge, when the shell has them all', async () => {
    const bridge = {
      ...base,
      notify: vi.fn(async () => true),
      idleSeconds: vi.fn(async () => 3),
      notifyProbe: vi.fn(async () => 'ok' as const),
      onNotification: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    } as unknown as DsulDesktop;
    const n = desktopNotifier(bridge)!;
    expect(await n.idleSeconds()).toBe(3);
    expect(await n.notifyProbe()).toBe('ok');
  });
});

describe('desktopRegistration', () => {
  it('is a tokenless electron row the registry accepts, on each desktop OS', () => {
    for (const [platform, os] of [['darwin', 'macos'], ['win32', 'windows'], ['linux', 'linux']]) {
      const body = desktopRegistration(platform, 'web-desktop-0001');
      expect(body).toMatchObject({ deviceId: 'web-desktop-0001', platform: 'electron', transport: 'none', os, form: 'desktop' });
      expect(body).not.toHaveProperty('token');
      expect(DeviceRegistrationSchema.safeParse(body).success).toBe(true);
    }
  });
});

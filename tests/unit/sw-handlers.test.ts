import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_DONE as SW_DONE,
  ACTION_SNOOZE as SW_SNOOZE,
  handleNotificationClick,
  handlePush,
  handleSubscriptionChange,
  notificationFor,
  payloadFromPush,
  SNOOZED_MESSAGE,
  SNOOZE_MINUTES as SW_SNOOZE_MINUTES,
  type ClientLike,
  type SwContext,
} from '@/lib/sw/handlers';
import { ACTION_DONE, ACTION_SNOOZE, SNOOZE_MINUTES } from '@/lib/reminders/channels/push';
import { ACTION_SKIP } from '@/lib/reminders/act';

/**
 * The service worker's handlers (lib/sw/handlers.ts), driven through a fake
 * context: what app/sw.ts does with `self`, without a worker.
 */

const ITEM = '44444444-4444-4444-8444-444444444444';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abcdef-0001';

let shown: { title: string; options: Record<string, unknown> }[];
let fetches: { url: string; init: RequestInit }[];
let fetchAnswer: { ok: boolean; body: unknown };
let clients: (ClientLike & { messages: unknown[] })[];
let ctx: SwContext;

beforeEach(() => {
  shown = [];
  fetches = [];
  fetchAnswer = { ok: true, body: { ok: true } };
  clients = [{ url: 'https://do.dsul.app/', messages: [], postMessage(m) { this.messages.push(m); } }];
  ctx = {
    origin: 'https://do.dsul.app',
    showNotification: vi.fn(async (title, options) => void shown.push({ title, options: options as Record<string, unknown> })),
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return { ok: fetchAnswer.ok, json: async () => fetchAnswer.body };
    }),
    matchClients: vi.fn(async () => clients),
    openWindow: vi.fn(async () => undefined),
    pushEndpoint: vi.fn(async () => ENDPOINT),
  };
});

const cuePayload = {
  title: 'Vitamins',
  body: '7:30 am · 3 days',
  url: `/item/${ITEM}`,
  tag: `dsul-item-${ITEM}`,
  actions: [
    { action: 'done', title: 'Done' },
    { action: 'snooze', title: 'Snooze 15m' },
  ],
  data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: '2026-10-10', kind: 'cue', key: `cue:${ITEM}:2026-10-10T07:30` },
};

describe('the ids are the sender’s', () => {
  it('Done, Snooze and the snooze length match lib/reminders/channels/push.ts; Skip matches act.ts', () => {
    expect([SW_DONE, SW_SNOOZE, SW_SNOOZE_MINUTES]).toEqual([ACTION_DONE, ACTION_SNOOZE, SNOOZE_MINUTES]);
    expect(ACTION_SKIP).toBe('skip');
  });
});

describe('both envelopes become the same notification', () => {
  it('dsul’s own and the declarative one (web_push: 8030) → the same options', () => {
    const declarative = {
      web_push: 8030,
      notification: {
        title: cuePayload.title,
        body: cuePayload.body,
        navigate: cuePayload.url,
        tag: cuePayload.tag,
        actions: cuePayload.actions,
        data: cuePayload.data,
      },
    };
    expect(notificationFor(payloadFromPush(declarative))).toEqual(notificationFor(payloadFromPush(cuePayload)));
    const { title, options } = notificationFor(payloadFromPush(cuePayload));
    expect(title).toBe('Vitamins');
    expect(options).toMatchObject({ tag: `dsul-item-${ITEM}`, renotify: true, actions: cuePayload.actions });
  });

  it('text that is not JSON is a bare notification; no tag means no renotify (it would throw)', () => {
    const { title, options } = notificationFor(payloadFromPush('hello'));
    expect(title).toBe('dsul');
    expect(options.body).toBe('hello');
    expect(options.renotify).toBe(false);
    expect(options.data).toEqual({ url: '/' });
  });
});

describe('push', () => {
  it('shows, THEN acks the key with the worker’s endpoint and the cookie', async () => {
    await handlePush(ctx, cuePayload);
    expect(shown).toHaveLength(1);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe('/api/reminders/ack');
    expect(fetches[0].init.credentials).toBe('include');
    expect(JSON.parse(fetches[0].init.body as string)).toEqual({ key: cuePayload.data.key, endpoint: ENDPOINT });
    expect((ctx.showNotification as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (ctx.fetch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
  });

  it('a push with no key is shown and never acked', async () => {
    await handlePush(ctx, { ...cuePayload, data: { url: '/' } });
    expect(shown).toHaveLength(1);
    expect(fetches).toEqual([]);
  });

  it('an ack that fails costs nothing', async () => {
    ctx.fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(handlePush(ctx, cuePayload)).resolves.toBeUndefined();
    expect(shown).toHaveLength(1);
  });
});

describe('notificationclick', () => {
  const click = (action: string, data: unknown = cuePayload.data) =>
    handleNotificationClick(ctx, { action, title: 'Vitamins', data });

  it('Done calls the act route with the cookie, for the item and the day it was about', async () => {
    await click('done');
    expect(fetches[0].url).toBe('/api/reminders/act');
    expect(fetches[0].init.credentials).toBe('include');
    expect(JSON.parse(fetches[0].init.body as string)).toEqual({ action: 'done', itemId: ITEM, dateStr: '2026-10-10' });
    expect(shown).toEqual([]);
  });

  it('a Done the route refused says so', async () => {
    fetchAnswer = { ok: false, body: {} };
    await click('done');
    expect(shown.map((s) => s.title)).toEqual(["Couldn't save that"]);
  });

  it('a stored Snooze is told to every open page, with the instant the server stored', async () => {
    fetchAnswer = { ok: true, body: { ok: true, snoozedUntil: '2026-10-10T11:46:00.000Z' } };
    await click('snooze');
    expect(clients[0].messages).toEqual([
      { type: SNOOZED_MESSAGE, itemId: ITEM, dateStr: '2026-10-10', until: '2026-10-10T11:46:00.000Z' },
    ]);
  });

  it('a snooze held past its day (snoozedUntil: null) tells no page anything', async () => {
    fetchAnswer = { ok: true, body: { ok: true, snoozedUntil: null } };
    await click('snooze');
    expect(clients[0].messages).toEqual([]);
  });

  it('a plain click opens the app on the notification’s url', async () => {
    await click('');
    expect(fetches).toEqual([]);
    expect(ctx.openWindow).toHaveBeenCalledWith(`https://do.dsul.app/item/${ITEM}`);
  });
});

describe('pushsubscriptionchange', () => {
  it('rotates with the cookie, old endpoint to new', async () => {
    await handleSubscriptionChange(ctx, 'https://old.example/endpoint-0001', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(fetches[0].url).toBe('/api/devices/rotate');
    expect(fetches[0].init.credentials).toBe('include');
    expect(JSON.parse(fetches[0].init.body as string)).toEqual({
      oldToken: 'https://old.example/endpoint-0001',
      token: ENDPOINT,
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('a subscription without keys is left to the next boot', async () => {
    await handleSubscriptionChange(ctx, null, { endpoint: ENDPOINT });
    expect(fetches).toEqual([]);
  });
});

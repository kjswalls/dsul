import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * #254: a browser lets go of its push subscription when the person at it
 * changes. Three layers, each pinned here:
 *
 *   - the route deletes by ENDPOINT alone, with no session, and the row is gone
 *     (the devices row since migration 065, push_subscriptions before it);
 *   - the client helper releases the row BEFORE it unsubscribes, unsubscribes
 *     even when the release fails, and never throws;
 *   - lib/local-state.ts calls it on every known user change (sign-out, a stamp
 *     naming someone else, a sibling tab's re-stamp) and on nothing else.
 */

// ── In-memory devices and push_subscriptions tables behind a service-client stand-in ──

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let deleteError: { message: string; code?: string } | null = null;
/** 065 not applied yet: every `devices` statement answers PostgREST's "no such table". */
let registryMissing = false;
const filters: Array<[string, string, unknown]> = [];

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (name: string) => ({
      delete: () => {
        const mine: Array<[string, unknown]> = [];
        const chain = {
          eq: (column: string, value: unknown) => {
            mine.push([column, value]);
            filters.push([name, column, value]);
            return chain;
          },
          then: (resolve: (v: unknown) => unknown) => {
            if (name === 'devices' && registryMissing) {
              return resolve({ error: { code: 'PGRST205', message: 'no devices table' } });
            }
            if (deleteError) return resolve({ error: deleteError });
            tables[name] = (tables[name] ?? []).filter((r) => !mine.every(([c, v]) => r[c] === v));
            return resolve({ error: null });
          },
        };
        return chain;
      },
    }),
  }),
}));

// The cookie form needs a session; the token form must never ask for one.
const getUser = vi.fn(async () => ({ data: { user: null as { id: string } | null } }));
vi.mock('@/lib/supabase-server', () => ({ createClient: async () => ({ auth: { getUser } }) }));

import { POST as pushRelease } from '@/app/api/push/release/route';
import { POST as devicesRelease } from '@/app/api/devices/release/route';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

const postTo = (handler: typeof pushRelease, url: string) => (body: unknown) =>
  handler(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );

const seed = () => {
  tables = {
    devices: [
      // One endpoint has one owner since 065, whoever registered it last.
      { user_id: 'user-b', device_id: 'web-b-0001', transport: 'webpush', token: ENDPOINT },
      { user_id: 'user-a', device_id: 'web-a-0001', transport: 'webpush', token: 'https://web.push.apple.com/other-device' },
      { user_id: 'user-a', device_id: 'desk-a-001', transport: 'none', token: null },
    ],
    push_subscriptions: [
      // The shared-browser case: two accounts once subscribed from this browser.
      { user_id: 'user-a', endpoint: ENDPOINT },
      { user_id: 'user-b', endpoint: ENDPOINT },
      { user_id: 'user-a', endpoint: 'https://web.push.apple.com/other-device' },
    ],
  };
  deleteError = null;
  registryMissing = false;
  filters.length = 0;
  getUser.mockClear();
  getUser.mockResolvedValue({ data: { user: null } });
};

describe.each([
  ['POST /api/devices/release', (endpoint: unknown) => postTo(devicesRelease, 'https://do.dsul.app/api/devices/release')({ transport: 'webpush', token: endpoint })],
  ['POST /api/push/release (the alias)', (endpoint: unknown) => postTo(pushRelease, 'https://do.dsul.app/api/push/release')({ endpoint })],
])('%s, the token form', (_name, post) => {
  beforeEach(seed);

  it('deletes the row holding the endpoint, whoever owns it, with no session', async () => {
    const res = await post(ENDPOINT);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(tables.devices.map((r) => r.device_id)).toEqual(['web-a-0001', 'desk-a-001']);
    // Keyed on the endpoint and nothing else: no user_id filter to need a session for.
    expect(filters).toEqual([
      ['devices', 'transport', 'webpush'],
      ['devices', 'token', ENDPOINT],
    ]);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('before 065, deletes every push_subscriptions row holding it instead', async () => {
    registryMissing = true;
    const res = await post(ENDPOINT);
    expect(res.status).toBe(200);
    expect(tables.push_subscriptions).toEqual([{ user_id: 'user-a', endpoint: 'https://web.push.apple.com/other-device' }]);
    expect(filters.filter(([t]) => t === 'push_subscriptions')).toEqual([['push_subscriptions', 'endpoint', ENDPOINT]]);
  });

  it('answers ok for an endpoint nobody holds, so it says nothing about who did', async () => {
    const res = await post('https://fcm.googleapis.com/fcm/send/nobody');
    expect(res.status).toBe(200);
    expect(tables.devices).toHaveLength(3);
  });

  it.each([
    ['no endpoint', undefined],
    ['a non-string', 42],
    ['plain http', 'http://fcm.googleapis.com/x'],
    ['not a URL', 'abc-not-a-url-at-all'],
    ['an over-long endpoint', `https://x.example/${'a'.repeat(2048)}`],
  ])('refuses %s with a 400 and deletes nothing', async (_label, endpoint) => {
    const res = await post(endpoint);
    expect(res.status).toBe(400);
    expect(filters).toEqual([]);
    expect(tables.devices).toHaveLength(3);
  });

  it('a failed delete is a 500 that does not echo the database error', async () => {
    deleteError = { message: 'relation "devices" secret detail' };
    const res = await post(ENDPOINT);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});

describe('POST /api/devices/release', () => {
  beforeEach(seed);
  const post = postTo(devicesRelease, 'https://do.dsul.app/api/devices/release');

  it('refuses a body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400);
  });

  // An APNs or FCM token cannot send by itself: an open delete-by-token for one
  // would be a free denial of service.
  it.each(['apns', 'fcm', 'none'])('refuses a %s token without a session', async (transport) => {
    const res = await post({ transport, token: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(filters).toEqual([]);
  });

  it('refuses a body with anything else in it', async () => {
    const res = await post({ transport: 'webpush', token: ENDPOINT, userId: 'user-a' });
    expect(res.status).toBe(400);
  });

  it('the device-id form needs a session', async () => {
    const res = await post({ deviceId: 'desk-a-001' });
    expect(res.status).toBe(401);
    expect(filters).toEqual([]);
  });

  it("the device-id form deletes the session user's own row, and is filtered by exactly that user", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-a' } } });
    const res = await post({ deviceId: 'desk-a-001' });
    expect(res.status).toBe(200);
    expect(filters).toEqual([
      ['devices', 'user_id', 'user-a'],
      ['devices', 'device_id', 'desk-a-001'],
    ]);
    expect(tables.devices.map((r) => r.device_id)).toEqual(['web-b-0001', 'web-a-0001']);
  });

  it("cannot reach another account's device by its id", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-a' } } });
    await post({ deviceId: 'web-b-0001' });
    expect(tables.devices.map((r) => r.device_id)).toEqual(['web-b-0001', 'web-a-0001', 'desk-a-001']);
  });
});

// ── The client helper ────────────────────────────────────────────────────────

describe('releaseThisBrowserPush', () => {
  const calls: string[] = [];
  const unsubscribe = vi.fn(async () => {
    calls.push('unsubscribe');
    return true;
  });
  let subscription: { endpoint: string; unsubscribe: typeof unsubscribe } | null;
  let fetchImpl: () => Promise<Response>;

  beforeEach(() => {
    calls.length = 0;
    unsubscribe.mockClear();
    subscription = { endpoint: ENDPOINT, unsubscribe };
    fetchImpl = async () => {
      calls.push('release');
      return new Response('{"ok":true}');
    };
    vi.stubGlobal('fetch', vi.fn(() => fetchImpl()));
    Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (window as { PushManager?: unknown }).PushManager;
  });

  const load = async () => (await import('@/lib/push-release')).releaseThisBrowserPush;

  it('releases the row first, then unsubscribes', async () => {
    const release = await load();
    await release();

    expect(calls).toEqual(['release', 'unsubscribe']);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/devices/release');
    expect(JSON.parse(String(init.body))).toEqual({ transport: 'webpush', token: ENDPOINT });
    expect(init.keepalive).toBe(true);
  });

  it('unsubscribes even when the release request fails', async () => {
    fetchImpl = async () => {
      calls.push('release');
      throw new TypeError('offline');
    };
    const release = await load();
    await expect(release()).resolves.toBeUndefined();
    expect(calls).toEqual(['release', 'unsubscribe']);
  });

  it('does nothing when this browser holds no subscription', async () => {
    subscription = null;
    const release = await load();
    await release();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing, and never waits on ready, when no worker is registered', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: async () => undefined,
        get ready(): Promise<never> {
          throw new Error('ready must not be read');
        },
      },
    });
    const release = await load();
    await release();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws, even when unsubscribe does', async () => {
    unsubscribe.mockRejectedValueOnce(new Error('push service down'));
    const release = await load();
    await expect(release()).resolves.toBeUndefined();
  });
});

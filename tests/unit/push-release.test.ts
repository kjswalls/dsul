import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * #254: a browser lets go of its push subscription when the person at it
 * changes. Three layers, each pinned here:
 *
 *   - the route deletes by ENDPOINT alone, with no session, and the row is gone;
 *   - the client helper releases the row BEFORE it unsubscribes, unsubscribes
 *     even when the release fails, and never throws;
 *   - lib/local-state.ts calls it on every known user change (sign-out, a stamp
 *     naming someone else, a sibling tab's re-stamp) and on nothing else.
 */

// ── An in-memory push_subscriptions table behind a service-client stand-in ──

type Row = { user_id: string; endpoint: string };
let table: Row[] = [];
let deleteError: { message: string } | null = null;
const filters: Array<[string, unknown]> = [];

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (name: string) => {
      expect(name).toBe('push_subscriptions');
      return {
        delete: () => ({
          eq: async (column: string, value: unknown) => {
            filters.push([column, value]);
            if (deleteError) return { error: deleteError };
            table = table.filter((r) => (r as Record<string, unknown>)[column] !== value);
            return { error: null };
          },
        }),
      };
    },
  }),
}));

import { POST } from '@/app/api/push/release/route';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

const post = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/push/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );

describe('POST /api/push/release', () => {
  beforeEach(() => {
    table = [
      { user_id: 'user-a', endpoint: ENDPOINT },
      // The shared-browser case: two accounts once subscribed from this browser.
      { user_id: 'user-b', endpoint: ENDPOINT },
      { user_id: 'user-a', endpoint: 'https://web.push.apple.com/other-device' },
    ];
    deleteError = null;
    filters.length = 0;
  });

  it('deletes every row holding the endpoint, whoever owns it, with no session', async () => {
    const res = await post({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(table).toEqual([{ user_id: 'user-a', endpoint: 'https://web.push.apple.com/other-device' }]);
    // Keyed on the endpoint and nothing else: no user_id filter to need a session for.
    expect(filters).toEqual([['endpoint', ENDPOINT]]);
  });

  it('answers ok for an endpoint nobody holds, so it says nothing about who did', async () => {
    const res = await post({ endpoint: 'https://fcm.googleapis.com/fcm/send/nobody' });
    expect(res.status).toBe(200);
    expect(table).toHaveLength(3);
  });

  it.each([
    ['no endpoint', {}],
    ['a non-string', { endpoint: 42 }],
    ['plain http', { endpoint: 'http://fcm.googleapis.com/x' }],
    ['not a URL', { endpoint: 'abc' }],
    ['an over-long endpoint', { endpoint: `https://x.example/${'a'.repeat(2048)}` }],
  ])('refuses %s with a 400 and deletes nothing', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(filters).toEqual([]);
    expect(table).toHaveLength(3);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
  });

  it('a failed delete is a 500 that does not echo the database error', async () => {
    deleteError = { message: 'relation "push_subscriptions" secret detail' };
    const res = await post({ endpoint: ENDPOINT });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
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
    expect(url).toBe('/api/push/release');
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: ENDPOINT });
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

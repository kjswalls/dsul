import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpConversationsApi as api } from '@/lib/conversations-api';
import { summary } from './helpers/conversations-fakes';

/**
 * The HTTP client for PR-1's routes: a failure is a value with the status and
 * the route's code, never a throw, and what the user typed rides only in
 * bodies, never in a URL.
 */

type Call = { url: string; init: RequestInit };

function stubFetch(answer: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return answer(url, init);
    })
  );
  return calls;
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

afterEach(() => vi.unstubAllGlobals());

const ID = '0b6f8d2a-3c4e-4f5a-8b9c-0d1e2f3a4b5c';

describe('every call', () => {
  it('is same-origin and no-store', async () => {
    const calls = stubFetch(() => json(200, { conversations: [], nextCursor: null }));
    await api.list();
    expect(calls[0].init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', method: 'GET' });
  });

  it('answers a network failure as status 0, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await api.thread(ID)).toEqual({ ok: false, status: 0, error: 'network' });
  });

  it("reads the route's code, else one for the status", async () => {
    stubFetch(() => json(503, { error: 'unavailable' }));
    expect(await api.list()).toEqual({ ok: false, status: 503, error: 'unavailable' });
    stubFetch(() => ({ ok: false, status: 429, json: async () => Promise.reject(new SyntaxError('x')) }));
    expect(await api.list()).toEqual({ ok: false, status: 429, error: 'busy' });
    stubFetch(() => json(502, { error: 'Some platform page' }));
    expect(await api.list()).toEqual({ ok: false, status: 502, error: 'server' });
  });

  it("reads a bare 503 as the platform's 5xx, never as the missing migration", async () => {
    // A throttled or paused deployment answers 503 with an HTML page; only the
    // routes' own `unavailable` may latch saving off for the session.
    stubFetch(() => ({ ok: false, status: 503, json: async () => Promise.reject(new SyntaxError('<html>')) }));
    expect(await api.appendTurn(ID, { ownerId: 'u', messages: [{ id: 'm', role: 'user', content: 'hi' }] })).toEqual({
      ok: false,
      status: 503,
      error: 'server',
    });
  });

  it('carries the conversation id of a 409', async () => {
    stubFetch(() => json(409, { error: 'conflict', conversationId: ID }));
    const res = await api.appendTurn('draft', { ownerId: 'u', messages: [{ id: 'm', role: 'user', content: 'hi' }] });
    expect(res).toEqual({ ok: false, status: 409, error: 'conflict', conversationId: ID });
  });

  it('treats a 200 it cannot read as a fault, not data', async () => {
    stubFetch(() => json(200, { nope: true }));
    expect(await api.thread(ID)).toEqual({ ok: false, status: 0, error: 'server' });
  });
});

describe('the routes', () => {
  it('pages History by cursor and limit', async () => {
    const calls = stubFetch(() => json(200, { conversations: [], nextCursor: null }));
    await api.list({ cursor: 'abc', limit: 30 });
    expect(calls[0].url).toBe('/api/ai/conversations?limit=30&cursor=abc');
  });

  it("asks for an item's one conversation, and reads none as null", async () => {
    const row = summary({ id: ID, itemId: 'i1' });
    let calls = stubFetch(() => json(200, { conversations: [row] }));
    expect(await api.forItem('i1')).toEqual({ ok: true, value: row });
    expect(calls[0].url).toBe('/api/ai/conversations?itemId=i1');
    calls = stubFetch(() => json(200, { conversations: [] }));
    expect(await api.forItem('i1')).toEqual({ ok: true, value: null });
  });

  it('searches with the query in the body, never the URL', async () => {
    const calls = stubFetch(() => json(200, { results: [] }));
    await api.search('dentist appointment');
    expect(calls[0].url).toBe('/api/ai/conversations/search');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ q: 'dentist appointment' });
  });

  it('pages a thread back from a position', async () => {
    const calls = stubFetch(() => json(200, { conversation: summary({ id: ID }), messages: [], hasEarlier: false }));
    await api.thread(ID);
    await api.thread(ID, { before: 101 });
    expect(calls.map((c) => c.url)).toEqual([`/api/ai/conversations/${ID}`, `/api/ai/conversations/${ID}?before=101`]);
  });

  it('saves a turn, patches, and deletes', async () => {
    const row = summary({ id: ID });
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/turns')) return json(200, { conversation: row, inserted: 1 });
      if (init.method === 'PATCH') return json(200, { conversation: row });
      return json(200, { ok: true });
    });
    expect(await api.appendTurn(ID, { ownerId: 'u', messages: [{ id: 'm', role: 'user', content: 'hi' }] })).toEqual({
      ok: true,
      value: { conversation: row, inserted: 1 },
    });
    expect(await api.patch(ID, { starred: true })).toEqual({ ok: true, value: row });
    expect(await api.remove(ID)).toEqual({ ok: true, value: true });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', `/api/ai/conversations/${ID}/turns`],
      ['PATCH', `/api/ai/conversations/${ID}`],
      ['DELETE', `/api/ai/conversations/${ID}`],
    ]);
  });

  it('sends a keepalive save as fetch keepalive, and never throws', () => {
    const calls = stubFetch(() => json(200, {}));
    api.appendTurnKeepalive(ID, '{"ownerId":"u"}');
    expect(calls[0].url).toBe(`/api/ai/conversations/${ID}/turns`);
    expect(calls[0].init).toMatchObject({ method: 'POST', keepalive: true, body: '{"ownerId":"u"}' });

    vi.stubGlobal('fetch', vi.fn(() => {
      throw new TypeError('body over the keepalive limit');
    }));
    expect(() => api.appendTurnKeepalive(ID, 'x')).not.toThrow();
  });

  it('sends a keepalive delete as fetch keepalive, with no body, and never throws', () => {
    const calls = stubFetch(() => json(200, { ok: true }));
    api.removeKeepalive(ID);
    expect(calls[0].url).toBe(`/api/ai/conversations/${ID}`);
    expect(calls[0].init).toMatchObject({ method: 'DELETE', keepalive: true, credentials: 'same-origin' });
    expect(calls[0].init.body).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(() => {
      throw new TypeError('refused');
    }));
    expect(() => api.removeKeepalive(ID)).not.toThrow();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import {
  DEDUPE_WINDOW_NOTHING_MS,
  DEDUPE_WINDOW_USABLE_MS,
  getAICapabilities,
  useAICapabilities,
  useAIConnectionStore,
} from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { NO_AI } from '@/lib/ai-registry';
import type { AIConnectionResponse, ConnectRequest, ModelConnectionView } from '@/lib/ai-types';
import { CONNECTED_MODEL, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';

/**
 * The AI gate's one source: what the server last said can answer.
 *
 * Every surface reads it through lib/ai-registry.ts, so what these tests pin
 * is what the WHOLE app shows: hidden while unknown (fail closed), never a
 * previous account's answer for a single frame, never a stale write applied
 * over a new account, and re-asked often enough that setup finished elsewhere
 * shows up on the next tab return.
 */

const A = 'user-a';
const B = 'user-b';
const T0 = new Date('2026-10-01T09:00:00.000Z').getTime();

const MODEL_OK: ModelConnectionView = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: null,
  authMethod: 'key',
  status: 'ok',
  problem: null,
  checkedAt: '2026-10-01T08:00:00.000Z',
};

const CONNECTED: AIConnectionResponse = {
  available: true,
  model: MODEL_OK,
  openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
};

const NOTHING: AIConnectionResponse = {
  available: true,
  model: null,
  openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
};

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const respond = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

type Deferred = {
  url: string;
  method: string;
  resolve: (r: FakeResponse) => void;
  reject: (e: unknown) => void;
};
type Call = { url: string; init: RequestInit | undefined };

/** Every fetch is held until the test answers it, in order. */
let calls: Call[] = [];
let pending: Deferred[] = [];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return new Promise<FakeResponse>((resolve, reject) =>
    pending.push({ url, method: init?.method ?? 'GET', resolve, reject })
  );
});

const store = () => useAIConnectionStore.getState();
const gets = () => calls.filter((c) => (c.init?.method ?? 'GET') === 'GET' && c.url === '/api/ai/connection');

/** Answer the oldest held fetch and let the store apply it. */
async function answer(body: unknown, status = 200) {
  const d = pending.shift();
  if (!d) throw new Error('no fetch is waiting');
  await act(async () => {
    d.resolve(respond(body, status));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Answer the oldest held fetch for this method + url, wherever it sits in the queue. */
async function answerFor(method: string, url: string, body: unknown, status = 200) {
  const i = pending.findIndex((d) => d.method === method && d.url === url);
  if (i < 0) throw new Error(`no ${method} ${url} is waiting`);
  const [d] = pending.splice(i, 1);
  await act(async () => {
    d.resolve(respond(body, status));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const STATUS = '/api/ai/connection';
const MODELS = '/api/ai/connection/models';
const answerGet = (body: unknown) => answerFor('GET', STATUS, body);
const modelGets = () => calls.filter((c) => c.url === MODELS);

/** Let a queued write reach fetch. */
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function fail() {
  const d = pending.shift();
  if (!d) throw new Error('no fetch is waiting');
  await act(async () => {
    d.reject(new TypeError('Failed to fetch'));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** hydrate(userId) and answer it. */
async function hydrated(userId: string, body: AIConnectionResponse) {
  const p = store().hydrate(userId);
  await answer(body);
  await p;
}

beforeEach(() => {
  calls = [];
  pending = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  store().reset();
  useAISettingsStore.getState().clearUserScopedState();
});

afterEach(() => {
  store().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fail closed', () => {
  it('is NO_AI until the server has answered', () => {
    expect(store().phase).toBe('unknown');
    expect(getAICapabilities()).toBe(NO_AI);

    void store().hydrate(A);
    // In flight: still nothing.
    expect(getAICapabilities()).toBe(NO_AI);
  });

  it('a failed status read is NO_AI and unlatches, so the next SIGNED_IN tries again', async () => {
    const p = store().hydrate(A);
    await fail();
    await p;

    expect(store().phase).toBe('error');
    expect(store().hydratedUserId).toBeNull();
    expect(getAICapabilities()).toBe(NO_AI);

    void store().hydrate(A);
    expect(gets()).toHaveLength(2);
    await answer(CONNECTED);
    expect(getAICapabilities().canChat).toBe(true);
  });

  it('a non-2xx or a malformed body is a failure too', async () => {
    let p = store().hydrate(A);
    await answer({ error: 'server' }, 503);
    await p;
    expect(store().phase).toBe('error');

    p = store().hydrate(A);
    await answer({ nonsense: true });
    await p;
    expect(store().phase).toBe('error');
  });

  it('reads an unknown status as failing, never as ok', async () => {
    await hydrated(A, { ...CONNECTED, model: { ...MODEL_OK, status: 'weird' as 'ok' } });
    expect(store().model?.status).toBe('failing');
    expect(getAICapabilities().modelUsable).toBe(false);
  });

  it('asks the right endpoint, uncached, with the session cookie', async () => {
    await hydrated(A, CONNECTED);
    expect(calls[0].url).toBe('/api/ai/connection');
    expect(calls[0].init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });

  it('does nothing at import', async () => {
    vi.resetModules();
    fetchMock.mockClear();
    await import('@/lib/ai-connection-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dedupe', () => {
  it('a second hydrate for the same user while one is in flight makes no second request', async () => {
    const p1 = store().hydrate(A);
    const p2 = store().hydrate(A);
    expect(gets()).toHaveLength(1);
    await answer(CONNECTED);
    await Promise.all([p1, p2]);
    expect(store().phase).toBe('ready');
  });

  it('with something that can answer, a SIGNED_IN at +4 min is skipped and one past 5 min fetches', async () => {
    await hydrated(A, CONNECTED);

    vi.setSystemTime(T0 + 4 * 60_000);
    await store().hydrate(A);
    expect(gets()).toHaveLength(1);

    vi.setSystemTime(T0 + DEDUPE_WINDOW_USABLE_MS + 1);
    void store().hydrate(A);
    expect(gets()).toHaveLength(2);
    await answer(CONNECTED);
  });

  it('with nothing usable, a SIGNED_IN at +10 s is skipped and one at +31 s fetches', async () => {
    await hydrated(A, NOTHING);

    vi.setSystemTime(T0 + 10_000);
    await store().hydrate(A);
    expect(gets()).toHaveLength(1);

    vi.setSystemTime(T0 + 31_000);
    void store().hydrate(A);
    expect(gets()).toHaveLength(2);
    // The OpenClaw plugin registered its chat url server-side meanwhile.
    await answer({
      ...NOTHING,
      openclaw: { gateway: false, pluginChat: true, agent: true, agentId: 'kirby-1' },
    });
    expect(getAICapabilities().canChat).toBe(true);
    expect(DEDUPE_WINDOW_NOTHING_MS).toBe(30_000);
  });

  it('a failing model counts as nothing usable (the short window)', async () => {
    await hydrated(A, { ...CONNECTED, model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } });
    vi.setSystemTime(T0 + 31_000);
    void store().hydrate(A);
    expect(gets()).toHaveLength(2);
    await answer(CONNECTED);
  });
});

describe('account switch', () => {
  it('clears the previous account synchronously, before the new answer arrives', async () => {
    await hydrated(A, CONNECTED);
    expect(getAICapabilities().canChat).toBe(true);

    void store().hydrate(B);

    // Same tick: nothing of A's answer is visible under B.
    expect(store().phase).toBe('unknown');
    expect(store().model).toBeNull();
    expect(store().hydratedUserId).toBeNull();
    expect(getAICapabilities()).toBe(NO_AI);

    await answer(NOTHING);
    expect(store().hydratedUserId).toBe(B);
    expect(getAICapabilities().canChat).toBe(false);
  });

  it("drops A's late answer once B is being asked for", async () => {
    void store().hydrate(A);
    void store().hydrate(B);
    expect(gets()).toHaveLength(2);

    // A's (connected) answer arrives first and must not land under B.
    await answer(CONNECTED);
    expect(store().phase).toBe('unknown');
    expect(store().model).toBeNull();

    await answer(NOTHING);
    expect(store().hydratedUserId).toBe(B);
    expect(store().model).toBeNull();
  });
});

describe('reset', () => {
  it('drops a response that arrives after it', async () => {
    void store().hydrate(A);
    store().reset();

    await answer(CONNECTED);

    expect(store().phase).toBe('unknown');
    expect(store().model).toBeNull();
    expect(getAICapabilities()).toBe(NO_AI);
  });

  it('makes refresh a no-op until the next hydrate', async () => {
    await hydrated(A, CONNECTED);
    store().reset();

    await store().refresh();

    expect(gets()).toHaveLength(1);
    expect(store().phase).toBe('unknown');
  });
});

describe('refresh', () => {
  it('fetches inside the 5-minute window and keeps the stale answer on screen meanwhile', async () => {
    await hydrated(A, CONNECTED);
    vi.setSystemTime(T0 + 60_000);

    const p = store().refresh();
    expect(gets()).toHaveLength(2);
    // Nothing flickers while it runs.
    expect(store().phase).toBe('ready');
    expect(getAICapabilities().canChat).toBe(true);

    await answer({ ...CONNECTED, model: { ...MODEL_OK, model: 'gpt-4.1-mini' } });
    await p;
    expect(store().model?.model).toBe('gpt-4.1-mini');
    expect(store().fetchedAt).toBe(T0 + 60_000);
  });

  it('keeps the stale-good answer when a same-user refresh fails', async () => {
    await hydrated(A, CONNECTED);

    const p = store().refresh();
    await fail();
    await p;

    expect(store().phase).toBe('ready');
    expect(store().hydratedUserId).toBe(A);
    expect(getAICapabilities().canChat).toBe(true);
  });

  it('still knows whom to ask after a failed hydrate', async () => {
    const p = store().hydrate(A);
    await fail();
    await p;
    expect(store().phase).toBe('error');

    const r = store().refresh();
    expect(gets()).toHaveLength(2);
    await answer(CONNECTED);
    await r;
    expect(store().phase).toBe('ready');
    expect(store().hydratedUserId).toBe(A);
  });

  it('is deduped against a fetch already in flight for the same user', async () => {
    void store().hydrate(A);
    void store().refresh();
    expect(gets()).toHaveLength(1);
    await answer(CONNECTED);
  });

  it('is a no-op before anyone has signed in', async () => {
    await store().refresh();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  const REQ: ConnectRequest = { provider: 'openai', apiKey: 'sk-test-SENTINEL-9876' };

  it('are serialized: the second is not sent until the first has answered', async () => {
    await hydrated(A, CONNECTED);

    const first = store().setModel('gpt-4.1-mini');
    const second = store().recheck();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
    expect(store().busy).toBe('model');

    await answer({ connection: { ...MODEL_OK, model: 'gpt-4.1-mini' } });
    await expect(first).resolves.toEqual({ ok: true });
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(2);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ recheck: true });

    await answer({ connection: { ...MODEL_OK, model: 'gpt-4.1-mini', checkedAt: '2026-10-01T09:00:00.000Z' } });
    await expect(second).resolves.toEqual({ ok: true });
    expect(store().busy).toBeNull();
    expect(store().model?.model).toBe('gpt-4.1-mini');
  });

  it('a write answered after a change of user is dropped', async () => {
    await hydrated(A, CONNECTED);

    const write = store().setModel('gpt-4.1-mini');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    void store().hydrate(B);

    // The PATCH for A answers now; the GET for B is still held behind it.
    const patch = pending.shift()!;
    await act(async () => {
      patch.resolve(respond({ connection: { ...MODEL_OK, model: 'gpt-4.1-mini' } }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await expect(write).resolves.toEqual({ ok: false, code: 'unauthorized' });
    expect(store().model).toBeNull();
    expect(store().busy).toBeNull();
    await answer(NOTHING);
    expect(store().model).toBeNull();
  });

  it('a write queued for a user who has since changed is never sent', async () => {
    await hydrated(A, CONNECTED);

    const first = store().recheck();
    const second = store().setModel('gpt-4.1-mini');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    store().reset();

    const held = pending.shift()!;
    await act(async () => {
      held.resolve(respond({ connection: MODEL_OK }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await expect(first).resolves.toEqual({ ok: false, code: 'unauthorized' });
    await expect(second).resolves.toEqual({ ok: false, code: 'unauthorized' });
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
  });

  it('connect sends the key, never keeps it, applies the answer and drops the legacy notice', async () => {
    await hydrated(A, NOTHING);
    useAISettingsStore.setState({ legacyNotice: true });

    const p = store().connect(REQ);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toBe('/api/ai/connection');
    expect(put.init).toMatchObject({ credentials: 'same-origin' });
    expect(new Headers(put.init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(put.init?.body))).toEqual(REQ);
    expect(store().busy).toBe('connect');

    await answer({
      connection: MODEL_OK,
      models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }, { id: 'has space', label: 'x' }],
      listed: true,
    });
    await expect(p).resolves.toEqual({ ok: true });

    expect(store().model).toEqual(MODEL_OK);
    expect(store().models).toEqual([{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }]);
    expect(store().modelsListed).toBe(true);
    expect(store().busy).toBeNull();
    expect(useAISettingsStore.getState().legacyNotice).toBe(false);
    expect(getAICapabilities().canChat).toBe(true);
    expect(JSON.stringify(store())).not.toContain('SENTINEL');
  });

  it('a connect made while the gate read had failed keeps its model list through the follow-up refresh', async () => {
    const h = store().hydrate(A);
    await fail();
    await h;
    expect(store().phase).toBe('error');

    const p = store().connect(REQ);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await answer({ connection: MODEL_OK, models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], listed: true });
    await expect(p).resolves.toEqual({ ok: true });

    // The connect knows the model half; it asks for the rest (OpenClaw, phase)…
    expect(gets()).toHaveLength(2);
    // …without wiping what it just learned while that read is in flight.
    expect(store().models).toEqual([{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }]);
    expect(store().model).toEqual(MODEL_OK);

    await answer(CONNECTED);
    expect(store().phase).toBe('ready');
    expect(store().models).toEqual([{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }]);
    expect(getAICapabilities().canChat).toBe(true);
  });

  it('connect answers the route code on failure and leaves the connection alone', async () => {
    await hydrated(A, CONNECTED);

    const p = store().connect({ ...REQ, provider: 'anthropic' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await answer({ error: 'key_rejected' }, 400);

    await expect(p).resolves.toEqual({ ok: false, code: 'key_rejected' });
    expect(store().model).toEqual(MODEL_OK);
  });

  it('connect, setModel and recheck pass on the field the route named, and only a named one', async () => {
    await hydrated(A, CONNECTED);

    const connect = store().connect({ ...REQ, provider: 'custom', baseUrl: 'https://llm.example.com/v1' });
    await tick();
    await answerFor('PUT', STATUS, { error: 'invalid', field: 'baseUrl' }, 400);
    await expect(connect).resolves.toEqual({ ok: false, code: 'invalid', field: 'baseUrl' });

    const pick = store().setModel('claude-opus-5-5');
    await tick();
    await answerFor('PATCH', STATUS, { error: 'invalid', field: 'model' }, 400);
    await expect(pick).resolves.toEqual({ ok: false, code: 'invalid', field: 'model' });

    const check = store().recheck();
    await tick();
    await answerFor('PATCH', STATUS, { error: 'invalid', field: 'model' }, 400);
    await expect(check).resolves.toEqual({ ok: false, code: 'invalid', field: 'model' });

    // Unnamed, or named with something that is not a field name: no `field` key at all.
    for (const body of [{ error: 'invalid' }, { error: 'invalid', field: 42 }, { error: 'invalid', field: '' }]) {
      const again = store().recheck();
      await tick();
      await answerFor('PATCH', STATUS, body, 400);
      const result = await again;
      expect(result).toStrictEqual({ ok: false, code: 'invalid' });
    }
    // None of these moved the connection.
    expect(store().model).toEqual(MODEL_OK);
  });

  it('disconnect clears the connection and the model list', async () => {
    await hydrated(A, CONNECTED);
    useAIConnectionStore.setState({ models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], modelsStatus: 'ready' });

    const p = store().disconnect();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.at(-1)?.init?.method).toBe('DELETE');
    await answer({ ok: true });

    await expect(p).resolves.toEqual({ ok: true });
    expect(store().model).toBeNull();
    expect(store().models).toBeNull();
    expect(store().modelsStatus).toBe('idle');
    expect(getAICapabilities().canChat).toBe(false);
  });

  it('loadModels fetches once and keeps the valid ids', async () => {
    await hydrated(A, CONNECTED);

    const p1 = store().loadModels();
    const p2 = store().loadModels();
    expect(calls.filter((c) => c.url === '/api/ai/connection/models')).toHaveLength(1);
    expect(store().modelsStatus).toBe('loading');
    await answer({ models: [{ id: 'gpt-4o', label: 'GPT-4o' }], listed: true });
    await expect(p1).resolves.toEqual({ ok: true });
    await expect(p2).resolves.toEqual({ ok: true });
    expect(store().models).toEqual([{ id: 'gpt-4o', label: 'GPT-4o' }]);

    // Cached until forced.
    await store().loadModels();
    expect(calls.filter((c) => c.url === '/api/ai/connection/models')).toHaveLength(1);
    void store().loadModels({ force: true });
    expect(calls.filter((c) => c.url === '/api/ai/connection/models')).toHaveLength(2);
    await answer({ models: [], listed: false });
  });
});

describe('the legacy notice goes once a model has been seen, by any road', () => {
  // "AI now uses your own model" explains a move. A model connected through
  // the OpenRouter sign-in (its callback saves server-side; the panel only
  // refreshes) or on another device completes that move as surely as a pasted
  // key does. Keyed to `model !== null` alone, a later disconnect would bring
  // the explanation back to a user who already followed it.
  const OPENROUTER_OAUTH: AIConnectionResponse = {
    ...CONNECTED,
    model: { ...MODEL_OK, provider: 'openrouter', model: 'openrouter/auto', authMethod: 'oauth' },
  };
  const wouldShow = () => {
    const caps = getAICapabilities();
    return caps.known && store().model === null && !caps.canChat && useAISettingsStore.getState().legacyNotice;
  };

  it('an OpenRouter sign-in (seen only through a refresh) drops it, and a disconnect does not bring it back', async () => {
    useAISettingsStore.setState({ legacyNotice: true });
    await hydrated(A, NOTHING);
    expect(wouldShow()).toBe(true);

    // The panel's ?connect=ok path: refresh() and nothing else.
    const r = store().refresh();
    await answer(OPENROUTER_OAUTH);
    await r;
    expect(store().model?.authMethod).toBe('oauth');
    expect(useAISettingsStore.getState().legacyNotice).toBe(false);
    expect(JSON.parse(localStorage.getItem('dsul-ai-settings') ?? '{}').state?.legacyNotice).toBe(false);

    const d = store().disconnect();
    await tick();
    await answer({ ok: true });
    await expect(d).resolves.toEqual({ ok: true });
    expect(store().model).toBeNull();
    expect(wouldShow()).toBe(false);
  });

  it('a model connected on another device, first seen at hydrate, drops it too (a failing one counts)', async () => {
    useAISettingsStore.setState({ legacyNotice: true });
    await hydrated(A, { ...CONNECTED, model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } });
    expect(useAISettingsStore.getState().legacyNotice).toBe(false);
  });

  it('a read naming no model leaves it up', async () => {
    useAISettingsStore.setState({ legacyNotice: true });
    await hydrated(A, NOTHING);
    const r = store().refresh();
    await answer({ ...NOTHING, openclaw: { gateway: true, pluginChat: true, agent: false, agentId: null } });
    await r;
    // OpenClaw answering hides the notice, but is not the move it explains.
    expect(useAISettingsStore.getState().legacyNotice).toBe(true);
  });

  it("a previous account's late answer naming a model does not drop the new account's flag", async () => {
    const h = store().hydrate(A);
    void store().hydrate(B);
    useAISettingsStore.setState({ legacyNotice: true });

    // A's GET answers after B is being asked for: dropped whole.
    await answer(CONNECTED);
    await h;
    expect(useAISettingsStore.getState().legacyNotice).toBe(true);

    await answer(NOTHING);
    expect(useAISettingsStore.getState().legacyNotice).toBe(true);
  });
});

describe('reads are ordered against writes', () => {
  // A status GET the server answered BEFORE a write must never land on top of
  // it. `generation` only moves with the account, so without this a slow read
  // undoes a connect, a model pick or a disconnect on screen.
  const REQ: ConnectRequest = { provider: 'openai', apiKey: 'sk-test-SENTINEL-9876' };

  it('a connect made while the first read is out is not undone by that read', async () => {
    void store().hydrate(A);
    const p = store().connect(REQ);
    await tick();
    await answerFor('PUT', STATUS, { connection: MODEL_OK, models: [], listed: true });
    await expect(p).resolves.toEqual({ ok: true });

    // The follow-up read is a NEW one; the one in flight began before the PUT.
    expect(gets()).toHaveLength(2);

    // The pre-connect read answers "nothing connected": dropped.
    await answerGet(NOTHING);
    expect(store().model).toEqual(MODEL_OK);
    expect(gets()).toHaveLength(2);

    await answerGet(CONNECTED);
    expect(store().phase).toBe('ready');
    expect(store().model).toEqual(MODEL_OK);
    expect(getAICapabilities().canChat).toBe(true);
  });

  it('a model pick is not snapped back by a refresh that was already out', async () => {
    await hydrated(A, CONNECTED);
    void store().refresh(); // e.g. the panel-mount refresh
    const p = store().setModel('gpt-4.1');
    await tick();
    await answerFor('PATCH', STATUS, { connection: { ...MODEL_OK, model: 'gpt-4.1' } });
    await expect(p).resolves.toEqual({ ok: true });

    await answerGet(CONNECTED); // the old row
    expect(store().model?.model).toBe('gpt-4.1');

    // …and the read is asked again, so the screen still converges on the server.
    expect(gets()).toHaveLength(3);
    await answerGet({ ...CONNECTED, model: { ...MODEL_OK, model: 'gpt-4.1' } });
    expect(store().model?.model).toBe('gpt-4.1');
    expect(store().phase).toBe('ready');
  });

  it('a disconnect is not shown as still connected by a refresh that was already out', async () => {
    await hydrated(A, CONNECTED);
    void store().refresh();
    const p = store().disconnect();
    await tick();
    await answerFor('DELETE', STATUS, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });

    await answerGet(CONNECTED);
    expect(store().model).toBeNull();
    expect(getAICapabilities().canChat).toBe(false);

    expect(gets()).toHaveLength(3);
    await answerGet(NOTHING);
    expect(store().model).toBeNull();
  });

  it("'auth' starts a fresh read; the older one cannot put 'ok' back", async () => {
    await hydrated(A, CONNECTED);
    void store().refresh();
    store().noteCallFailure('auth');
    expect(gets()).toHaveLength(3);

    await answerGet(CONNECTED); // read before the server marked the key failing
    expect(store().model?.status).toBe('failing');
    expect(getAICapabilities().canChat).toBe(false);
    expect(gets()).toHaveLength(3);

    await answerGet({ ...CONNECTED, model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } });
    expect(store().model?.status).toBe('failing');
  });

  it('a failed read that began before a write does not fail the gate closed under it', async () => {
    const h = store().hydrate(A);
    const p = store().connect(REQ);
    await tick();
    await answerFor('PUT', STATUS, { connection: MODEL_OK, models: [], listed: true });
    await p;

    await fail(); // the pre-connect read
    expect(store().phase).not.toBe('error');
    await answerGet(CONNECTED);
    await h;
    expect(store().phase).toBe('ready');
    expect(store().model).toEqual(MODEL_OK);
  });

  it('a model-list read begun before a connect does not overwrite the list the connect brought', async () => {
    await hydrated(A, CONNECTED);
    const list = store().loadModels();
    const p = store().connect({ provider: 'anthropic', apiKey: 'sk-ant-SENTINEL' });
    await tick();
    const claude = { ...MODEL_OK, provider: 'anthropic' as const, model: 'claude-opus-5-5' };
    await answerFor('PUT', STATUS, {
      connection: claude,
      models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
      listed: true,
    });
    await expect(p).resolves.toEqual({ ok: true });

    await answerFor('GET', MODELS, { models: [{ id: 'gpt-4o', label: 'GPT-4o' }], listed: true });
    await expect(list).resolves.toEqual({ ok: true });
    expect(store().models).toEqual([{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]);
    expect(store().modelsStatus).toBe('ready');
    expect(modelGets()).toHaveLength(1);
  });
});

describe('the model list follows the connection', () => {
  const CLAUDE: ModelConnectionView = { ...MODEL_OK, provider: 'anthropic', model: 'claude-opus-5-5' };

  async function listed(models: { id: string; label: string }[]) {
    const p = store().loadModels();
    await answerFor('GET', MODELS, { models, listed: true });
    await p;
  }

  it('a status answer for the same provider keeps the list; another provider clears it and the next load fetches', async () => {
    await hydrated(A, CONNECTED);
    await listed([{ id: 'gpt-4o', label: 'GPT-4o' }]);

    void store().refresh();
    await answerGet({ ...CONNECTED, model: { ...MODEL_OK, checkedAt: '2026-10-01T09:30:00.000Z' } });
    expect(store().models).toEqual([{ id: 'gpt-4o', label: 'GPT-4o' }]);

    // Replaced on another device.
    void store().refresh();
    await answerGet({ ...CONNECTED, model: CLAUDE });
    expect(store().model?.provider).toBe('anthropic');
    expect(store().models).toBeNull();
    expect(store().modelsStatus).toBe('idle');

    const p = store().loadModels();
    expect(modelGets()).toHaveLength(2);
    await answerFor('GET', MODELS, { models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }], listed: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(store().models).toEqual([{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]);
  });

  it('a new custom host clears the list too, and so does a connection gone', async () => {
    const custom: ModelConnectionView = { ...MODEL_OK, provider: 'custom', baseUrl: 'https://a.example/v1' };
    await hydrated(A, { ...CONNECTED, model: custom });
    await listed([{ id: 'llama-3', label: 'llama-3' }]);

    void store().refresh();
    await answerGet({ ...CONNECTED, model: { ...custom, baseUrl: 'https://b.example/v1' } });
    expect(store().models).toBeNull();

    await listed([{ id: 'qwen', label: 'qwen' }]);
    void store().refresh();
    await answerGet(NOTHING);
    expect(store().models).toBeNull();
    expect(store().modelsStatus).toBe('idle');
  });

  it("a list read in flight when another provider shows up is dropped, and its caller gets the new one's list", async () => {
    await hydrated(A, CONNECTED);
    const p = store().loadModels();

    void store().refresh();
    await answerGet({ ...CONNECTED, model: CLAUDE });

    await answerFor('GET', MODELS, { models: [{ id: 'gpt-4o', label: 'GPT-4o' }], listed: true });
    expect(store().models).toBeNull();
    expect(modelGets()).toHaveLength(2);

    await answerFor('GET', MODELS, { models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }], listed: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(store().models).toEqual([{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]);
  });
});

describe('seedAI drives the real store', () => {
  // The shared fixture seeds by setState, but every write and refresh() asks
  // the store's ACCOUNT, which lives outside the state. A seed that left it
  // unset made every write answer 'unauthorized' without a request.
  const REQ: ConnectRequest = { provider: 'openai', apiKey: 'sk-test-SENTINEL-9876' };

  it('after seedAI(NOTHING_CONNECTED), connect sends exactly one PUT and applies its answer', async () => {
    const cleanup = seedAI(NOTHING_CONNECTED);
    const p = store().connect(REQ);
    await tick();

    const puts = calls.filter((c) => c.init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0].init?.body))).toEqual(REQ);

    await answerFor('PUT', STATUS, { connection: MODEL_OK, models: [], listed: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(store().model).toEqual(MODEL_OK);
    expect(getAICapabilities().canChat).toBe(true);
    // Already 'ready': no follow-up read.
    expect(gets()).toHaveLength(0);
    cleanup();
  });

  it('refresh(), setModel and loadModels reach fetch after a ready seed', async () => {
    const cleanup = seedAI(CONNECTED_MODEL);

    void store().refresh();
    expect(gets()).toHaveLength(1);
    await answerGet(CONNECTED);

    void store().loadModels();
    expect(modelGets()).toHaveLength(1);
    await answerFor('GET', MODELS, { models: [], listed: true });

    void store().setModel('gpt-4.1');
    await tick();
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
    await answerFor('PATCH', STATUS, { connection: { ...MODEL_OK, model: 'gpt-4.1' } });
    cleanup();
  });

  it("an 'error' seed still knows whom to ask; an 'unknown' seed and the cleanup arm nobody", async () => {
    let cleanup = seedAI({ phase: 'error' });
    void store().refresh();
    expect(gets()).toHaveLength(1);
    await fail();
    expect(store().phase).toBe('error');
    cleanup();

    cleanup = seedAI();
    await store().refresh();
    await expect(store().connect(REQ)).resolves.toEqual({ ok: false, code: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();

    seedAI(CONNECTED_MODEL)();
    await store().refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a re-seed drops what was in flight from before it', async () => {
    seedAI(CONNECTED_MODEL);
    void store().refresh();
    const cleanup = seedAI(NOTHING_CONNECTED);

    await answerGet(CONNECTED);
    expect(store().model).toBeNull();
    expect(getAICapabilities().canChat).toBe(false);
    cleanup();
  });
});

describe('noteCallFailure', () => {
  it("'auth' flips the model to failing at once, then refreshes", async () => {
    await hydrated(A, CONNECTED);
    expect(getAICapabilities().canChat).toBe(true);

    store().noteCallFailure('auth');

    expect(store().model?.status).toBe('failing');
    expect(getAICapabilities().canChat).toBe(false);
    expect(getAICapabilities().modelFailing).toBe(true);
    expect(gets()).toHaveLength(2);
    await answer({ ...CONNECTED, model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } });
    expect(store().model?.problem).toBe('key_rejected');
  });

  it("'not_connected' refreshes; anything else does nothing", async () => {
    await hydrated(A, CONNECTED);

    store().noteCallFailure('rate_limit');
    store().noteCallFailure('upstream');
    expect(gets()).toHaveLength(1);
    expect(store().model?.status).toBe('ok');

    store().noteCallFailure('not_connected');
    expect(gets()).toHaveLength(2);
    await answer(NOTHING);
    expect(store().model).toBeNull();
  });
});

describe('useAICapabilities', () => {
  it('agrees with getAICapabilities, and follows the device choice', async () => {
    const { result } = renderHook(() => useAICapabilities());
    expect(result.current).toBe(NO_AI);

    await hydrated(A, {
      ...CONNECTED,
      openclaw: { gateway: false, pluginChat: true, agent: true, agentId: 'kirby-1' },
    });
    expect(result.current).toEqual(getAICapabilities());
    expect(result.current.target).toBe('model');

    act(() => useAISettingsStore.setState({ chatTarget: 'openclaw' }));
    expect(result.current.target).toBe('openclaw');
    expect(result.current.answererName).toBe('OpenClaw');
    expect(result.current).toEqual(getAICapabilities());
  });

  it('does not re-render on a change the gate does not read', async () => {
    await hydrated(A, CONNECTED);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAICapabilities();
    });
    const first = result.current;
    const before = renders;

    act(() => useAIConnectionStore.setState({ busy: 'recheck', modelsStatus: 'loading', fetchedAt: 1 }));
    // A refresh that brought back the same answer, as new objects.
    act(() =>
      useAIConnectionStore.setState({
        model: { ...MODEL_OK, checkedAt: '2026-10-01T10:00:00.000Z' },
        openclaw: { ...CONNECTED.openclaw },
      })
    );

    expect(renders).toBe(before);
    expect(result.current).toBe(first);
  });
});

describe('source', () => {
  it('never persists: the gate is never read off disk', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/ai-connection-store.ts'), 'utf8');
    expect(src).not.toContain('persist(');
    expect(src).not.toMatch(/zustand\/middleware['"]/);
  });
});

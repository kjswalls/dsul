import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PUT/DELETE /api/ai/agents/wake: saving a connected app's wake
 * (lib/agent-wake.ts). Pinned here: only a routine URL and a plausible token,
 * only for an app connected with leave to change the planner, a test fire
 * before anything is saved (a refused one saves nothing), and removal.
 */

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  apps: [] as Array<{ name: string; scope: string }>,
  fireOk: true,
  fired: [] as string[],
  saved: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
  })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/mcp-oauth/store', () => ({ listGrants: vi.fn(async () => h.apps) }));
vi.mock('@/lib/agent-wake-store', () => ({
  putWake: vi.fn(async (_db: unknown, _uid: string, assignee: string, wake: unknown) => {
    h.saved.push([assignee, wake]);
    return 'ok';
  }),
}));
vi.mock('@/lib/agent-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-wake')>()),
  fireRoutine: vi.fn(async (_w: unknown, text: string) => {
    h.fired.push(text);
    return h.fireOk;
  }),
}));

import { DELETE, PUT } from '@/app/api/ai/agents/wake/route';

const URL_OK = 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire';
const call = (method: 'PUT' | 'DELETE', body: unknown) =>
  (method === 'PUT' ? PUT : DELETE)(
    new Request('https://do.dsul.app/api/ai/agents/wake', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.apps = [{ name: 'Claude', scope: 'planner' }];
  h.fireOk = true;
  h.fired = [];
  h.saved = [];
});

describe('PUT /api/ai/agents/wake', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await call('PUT', { assignee: 'Claude', url: URL_OK, token: 'tok-123456' })).status).toBe(401);
  });

  it('tests the routine, then saves it', async () => {
    const res = await call('PUT', { assignee: 'Claude', url: URL_OK, token: 'tok-123456' });
    expect(res.status).toBe(200);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatch(/Nothing was handed to you/);
    expect(h.saved).toEqual([['Claude', { url: URL_OK, token: 'tok-123456' }]]);
  });

  it('saves nothing when the routine refuses the test', async () => {
    h.fireOk = false;
    const res = await call('PUT', { assignee: 'Claude', url: URL_OK, token: 'tok-123456' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'key_rejected' });
    expect(h.saved).toEqual([]);
  });

  it('refuses another URL, a bad token, or an app that is not connected to change the planner, firing nothing', async () => {
    for (const body of [
      { assignee: 'Claude', url: 'https://evil.com/fire', token: 'tok-123456' },
      { assignee: 'Claude', url: URL_OK, token: 'x' },
      { assignee: 'Cursor', url: URL_OK, token: 'tok-123456' },
    ]) {
      expect((await call('PUT', body)).status, JSON.stringify(body)).toBe(400);
    }
    h.apps = [{ name: 'Claude', scope: 'read' }];
    expect((await call('PUT', { assignee: 'Claude', url: URL_OK, token: 'tok-123456' })).status).toBe(400);
    expect(h.fired).toEqual([]);
    expect(h.saved).toEqual([]);
  });
});

describe('DELETE /api/ai/agents/wake', () => {
  it('removes the wake', async () => {
    expect((await call('DELETE', { assignee: 'Claude' })).status).toBe(200);
    expect(h.saved).toEqual([['Claude', null]]);
  });
});

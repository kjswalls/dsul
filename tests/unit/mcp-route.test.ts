import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The MCP route's own plumbing: JSON-RPC in, the RIGHT agent handler called
 * with the right method, path params and forwarded auth.
 *
 * agent-api is mocked so this stays a test of the glue — the handlers'
 * behaviour is already covered by their own suites, and what is unproven here
 * is the bit written last: synthesising a request and dispatching in-process.
 */

const calls: Array<{ handler: string; url: string; method: string; auth: string | null; id?: string; body?: unknown }> = [];

/** Records the call and answers 200, standing in for a real agent handler. */
function fake(handler: string) {
  return async (req: Request, ctx?: { params: Promise<{ id: string }> }) => {
    const id = ctx ? (await ctx.params).id : undefined;
    let body: unknown;
    try {
      body = req.method === 'GET' ? undefined : await req.json();
    } catch {
      body = undefined;
    }
    calls.push({
      handler,
      url: req.url,
      method: req.method,
      auth: req.headers.get('authorization'),
      id,
      body,
    });
    return Response.json({ ok: handler });
  };
}

vi.mock('@/lib/agent-api', () => ({
  makeAgentCreateHandler: (t: string) => fake(`create:${t}`),
  makeAgentItemHandlers: (t: string) => ({ PATCH: fake(`patch:${t}`), DELETE: fake(`delete:${t}`) }),
  makeContainerCreateHandler: (k: string) => fake(`create:${k}`),
  makeContainerItemHandlers: (k: string) => ({ PATCH: fake(`patch:${k}`), DELETE: fake(`delete:${k}`) }),
  makeGoalCreateHandler: () => fake('create:goal'),
  makeGoalItemHandlers: () => ({ PATCH: fake('patch:goal'), DELETE: fake('delete:goal') }),
}));
vi.mock('@/app/api/agent/items/[id]/progress/route', () => ({
  POST: async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json();
    calls.push({
      handler: 'progress',
      url: req.url,
      method: req.method,
      auth: req.headers.get('authorization'),
      id,
      body,
    });
    return Response.json({ itemId: id, ...body });
  },
}));
vi.mock('@/app/api/agent/items/[id]/ask/route', () => ({
  POST: async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json();
    calls.push({
      handler: 'ask',
      url: req.url,
      method: req.method,
      auth: req.headers.get('authorization'),
      id,
      body,
    });
    return Response.json({ itemId: id, ...body });
  },
}));
vi.mock('@/app/api/agent/items/[id]/events/route', () => ({
  GET: async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    calls.push({ handler: 'events', url: req.url, method: req.method, auth: req.headers.get('authorization'), id });
    return Response.json({ itemId: id, events: [{ action: 'agent_reply', payload: { text: 'the one on King St' } }] });
  },
}));
vi.mock('@/app/api/agent/context/route', () => ({
  GET: async (req: Request) => {
    calls.push({ handler: 'context', url: req.url, method: req.method, auth: req.headers.get('authorization') });
    return Response.json({
      fetchedAt: '2026-08-25T09:00:00.000Z',
      userTimezone: 'Europe/London',
      items: [
        { id: 'a', title: 'Book dentist', type: 'task', status: 'pending', isScheduled: false, order: 0, completedDates: [], assignee: 'openclaw', aiStatus: 'queued' },
        { id: 'b', title: 'Mine to do', type: 'task', status: 'pending', isScheduled: false, order: 0, completedDates: [] },
      ],
    });
  },
}));
// The route resolves the bearer key before doing any work; the handlers still
// authenticate independently, which their own suites cover.
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: vi.fn(() => ({})),
  resolveUserIdFromApiKey: vi.fn(async (key: string) => (key === 'dsul_testkey' ? 'user-1' : null)),
}));

import { POST } from '@/app/api/mcp/route';
import { NextRequest } from 'next/server';

const AUTH = 'Bearer dsul_testkey';

function rpc(body: unknown, auth: string | null = AUTH): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (auth) headers.set('authorization', auth);
  return new NextRequest('https://dsul.test/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

beforeEach(() => {
  calls.length = 0;
});

describe('auth', () => {
  it('refuses a request with no bearer token before any handshake', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a bearer token that is not a real key, before any work', async () => {
    // A prefix check costs nothing to satisfy, so an unresolvable key must not
    // reach the batch loop and spend a round-trip per element.
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer not-a-key'));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('forwards the caller\'s bearer token to the agent handler', async () => {
    await POST(call('dsul_get_context'));
    expect(calls[0].auth).toBe(AUTH);
  });
});

describe('dispatch to agent handlers', () => {
  it('routes get_context to the context GET, with no body', async () => {
    const res = await POST(call('dsul_get_context'));
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ handler: 'context', method: 'GET' });
    expect(calls[0].body).toBeUndefined();
  });

  it('routes a create to the create handler with the JSON body intact', async () => {
    await POST(call('dsul_create_task', { title: 'Book dentist', priority: 'high' }));
    expect(calls[0]).toMatchObject({
      handler: 'create:task',
      method: 'POST',
      body: { title: 'Book dentist', priority: 'high' },
    });
  });

  it('routes an update to PATCH and passes the id as a route param', async () => {
    await POST(call('dsul_update_task', { id: 'task-42', priority: 'low' }));
    expect(calls[0]).toMatchObject({
      handler: 'patch:task',
      method: 'PATCH',
      id: 'task-42',
      body: { priority: 'low' },
    });
  });

  it('routes a delete to DELETE with the id', async () => {
    await POST(call('dsul_delete_habit', { id: 'h-9' }));
    expect(calls[0]).toMatchObject({ handler: 'delete:habit', method: 'DELETE', id: 'h-9' });
  });

  it('routes each collection kind to its own handler', async () => {
    await POST(call('dsul_create_collection', { kind: 'goal', name: 'Run a 10k' }));
    await POST(call('dsul_update_collection', { kind: 'season', id: 'p1', state: 'active' }));
    await POST(call('dsul_delete_collection', { kind: 'routine', id: 'r1' }));
    expect(calls.map((c) => c.handler)).toEqual(['create:goal', 'patch:season', 'delete:routine']);
  });

  it('builds an absolute URL on the request origin', async () => {
    await POST(call('dsul_update_task', { id: 'abc' }));
    expect(calls[0].url).toBe('https://dsul.test/api/agent/tasks/abc');
  });
});

describe('tool-level failures stay inside a 200', () => {
  it('returns isError for a refused argument rather than a protocol error', async () => {
    const res = await POST(call('dsul_create_task', {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.error).toBeUndefined();
    expect(calls).toHaveLength(0); // never reached the handler
  });

  it('does not mark a successful agent write as an error', async () => {
    const res = await POST(call('dsul_create_task', { title: 'x' }));
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain('create:task');
  });
});

describe('JSON-RPC transport rules', () => {
  it('answers a notification with 202 and no body', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('handles a batch and answers only the non-notifications', async () => {
    const res = await POST(
      rpc([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ])
    );
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });

  it('returns 202 for a batch of only notifications', async () => {
    const res = await POST(rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
    expect(res.status).toBe(202);
  });

  it('rejects an empty batch as an Invalid Request', async () => {
    const res = await POST(rpc([]));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('refuses an oversized batch rather than executing it', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      jsonrpc: '2.0', id: i, method: 'tools/call',
      params: { name: 'dsul_get_context' },
    }));
    const res = await POST(rpc(many));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('never answers or executes an id-less tools/call', async () => {
    // Without an id there is nothing to report failure to, so a fire-and-forget
    // write is worse than the protocol violation.
    const res = await POST(
      rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'dsul_create_task', arguments: { title: 'x' } } })
    );
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
  });

  it('answers GET with 405, since it cannot open an SSE stream', async () => {
    const { GET } = await import('@/app/api/mcp/route');
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns a parse error for a malformed body', async () => {
    const req = new NextRequest('https://dsul.test/api/mcp', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', authorization: AUTH }),
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it('lists tools through the real registry', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(5);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('dsul_get_context');
  });
});

describe('the delegation loop, end to end through the route', () => {
  it('narrows the whole planner down to just the assigned work', async () => {
    const res = await POST(call('dsul_my_work'));
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);

    expect(payload.assigned).toHaveLength(1);
    expect(payload.assigned[0]).toMatchObject({ id: 'a', title: 'Book dentist', aiStatus: 'queued' });
    // The unassigned item never reaches the model — that is the whole point.
    expect(body.result.content[0].text).not.toContain('Mine to do');
  });

  it('still reads through the ordinary context endpoint', async () => {
    await POST(call('dsul_my_work'));
    expect(calls[0]).toMatchObject({ handler: 'context', method: 'GET' });
  });

  it('reads an item\'s activity, which is where a blocked answer arrives', async () => {
    const res = await POST(call('dsul_item_activity', { id: 'a' }));
    expect(calls[0]).toMatchObject({ handler: 'events', method: 'GET', id: 'a' });
    expect((await res.json()).result.content[0].text).toContain('King St');
  });

  it('refuses a traversal in an activity id too', async () => {
    const res = await POST(call('dsul_item_activity', { id: '../../context' }));
    expect((await res.json()).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reports progress to the route that can refuse it', async () => {
    // The generic task PATCH verified only account ownership — no assignee
    // check and no precondition — so a late report from a run the user had
    // already superseded landed on top of the work that replaced it.
    await POST(call('dsul_report_progress', { id: 'a', status: 'working' }));
    expect(calls[0]).toMatchObject({
      handler: 'progress',
      method: 'POST',
      id: 'a',
      body: { aiStatus: 'working' },
    });
  });

  it('carries the precondition through to the handler', async () => {
    await POST(
      call('dsul_report_progress', {
        id: 'a',
        status: 'done',
        lastSeenAt: '2026-08-26T10:00:00.000Z',
      })
    );
    expect(calls[0].body).toMatchObject({ lastSeenAt: '2026-08-26T10:00:00.000Z' });
  });

  it('refuses a traversal in a progress id', async () => {
    const res = await POST(
      call('dsul_report_progress', { id: '../../context', status: 'done' })
    );
    expect((await res.json()).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('routes a question with options to its own handler', async () => {
    await POST(
      call('dsul_ask_user', {
        id: 'a',
        question: 'Which Dana?',
        options: ['Dana Reyes', 'Dana Whitfield'],
      })
    );
    expect(calls[0]).toMatchObject({
      handler: 'ask',
      method: 'POST',
      id: 'a',
      body: { question: 'Which Dana?', options: ['Dana Reyes', 'Dana Whitfield'] },
    });
  });

  it('refuses a traversal in an ask id', async () => {
    // Dispatch reads the RAW path while proxyRequest normalises it, so a
    // traversal would make the two disagree about what is being addressed.
    const res = await POST(call('dsul_ask_user', { id: '../../context', question: 'hi' }));
    expect((await res.json()).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('forwards the caller auth to the ask handler, like every other route', async () => {
    await POST(call('dsul_ask_user', { id: 'a', question: 'Which one?' }));
    expect(calls[0].auth).toBe('Bearer dsul_testkey');
  });
});

describe('path safety', () => {
  it('refuses a traversal in an id rather than dispatching it anywhere', async () => {
    const res = await POST(call('dsul_update_task', { id: '../../context' }));
    expect((await res.json()).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses a percent-encoded traversal too', async () => {
    const res = await POST(call('dsul_delete_task', { id: '%2e%2e%2fcontext' }));
    expect((await res.json()).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('still accepts an ordinary uuid-shaped id', async () => {
    await POST(call('dsul_update_task', { id: '3f1a2b6c-0000-4000-8000-abcdefabcdef' }));
    expect(calls[0]).toMatchObject({ handler: 'patch:task' });
  });
});

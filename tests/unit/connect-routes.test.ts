import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Chainable Supabase mock
// Returns a fluent chain where the terminal operation resolves to `result`.
// ---------------------------------------------------------------------------

function makeChain(result: unknown) {
  // Return a proxy where any method call returns itself (for chaining),
  // and the object is awaitable (then/catch/finally).
  const chain: Record<string, unknown> = {};

  const handler: ProxyHandler<typeof chain> = {
    get(_target, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'catch') {
        return (reject: (e: unknown) => void) =>
          Promise.resolve(result).catch(reject);
      }
      if (prop === 'finally') {
        return (cb: () => void) =>
          Promise.resolve(result).finally(cb);
      }
      // Chainable terminal methods that return the resolved result
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve(result);
      }
      // Any other method (eq, gt, lt, gte, select, insert, etc.) returns `this`
      return () => new Proxy(chain, handler);
    },
  };

  return new Proxy(chain, handler);
}

// We track what `from` was called with and return different chains per table/op.
// Simple approach: configure per-call results via a queue.

type CallResult = { data: unknown; error: unknown; count?: number | null };

let callQueue: CallResult[] = [];

function enqueue(...results: CallResult[]) {
  callQueue.push(...results);
}

function nextResult(): CallResult {
  return callQueue.shift() ?? { data: null, error: null };
}

const mockServiceClient = {
  // The authorize route validates a Bearer token via the SERVICE client's
  // auth.getUser(token); reads the shared mockAuthUser at call time.
  auth: {
    getUser: vi.fn((_token?: string) =>
      Promise.resolve({
        data: { user: mockAuthUser },
        error: mockAuthUser ? null : { message: 'Not authenticated' },
      })
    ),
  },
  from: vi.fn((_table: string) => ({
    delete: vi.fn(() => makeChain(nextResult())),
    select: vi.fn((_cols?: string, _opts?: unknown) => makeChain(nextResult())),
    insert: vi.fn((_data: unknown) => makeChain(nextResult())),
    update: vi.fn((_data: unknown) => makeChain(nextResult())),
    upsert: vi.fn((_data: unknown, _opts?: unknown) => makeChain(nextResult())),
  })),
};

// readAgentKey / storeAgentKey stay real: the routes hand them the service
// client, so their reads and writes draw from the same queue.
vi.mock('@/lib/supabase-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase-service')>()),
  createServiceClient: vi.fn(() => mockServiceClient),
  resolveUserIdFromApiKey: vi.fn(),
}));

const mockUser = { id: 'user-123', email: 'test@example.com' };
let mockAuthUser: typeof mockUser | null = mockUser;

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({
          data: { user: mockAuthUser },
          error: mockAuthUser ? null : { message: 'Not authenticated' },
        })
      ),
    },
  })),
}));

function makeRequest(url: string, options?: RequestInit): NextRequest {
  return new NextRequest(url, options);
}

// ---------------------------------------------------------------------------
// Tests: POST /api/agent/connect/init
// ---------------------------------------------------------------------------

describe('POST /api/agent/connect/init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callQueue = [];
  });

  it('returns sessionId, userCode, connectUrl, expiresAt on success', async () => {
    // delete (cleanup) → count select (rate limit) → insert + select
    enqueue(
      { data: null, error: null },                          // delete expired
      { data: null, error: null, count: 0 },                // count pending
      { data: { id: 'session-uuid-1' }, error: null },      // insert
    );
    const { POST } = await import('@/app/api/agent/connect/init/route');
    const req = makeRequest('http://localhost/api/agent/connect/init', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('sessionId', 'session-uuid-1');
    expect(body).toHaveProperty('userCode');
    expect(body.userCode).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(body).toHaveProperty('connectUrl');
    expect(body.connectUrl).toContain(body.userCode);
    expect(body).toHaveProperty('expiresAt');
  });

  it('returns 429 when too many pending sessions exist', async () => {
    enqueue(
      { data: null, error: null },                          // delete expired
      { data: null, error: null, count: 10 },               // count at limit
    );
    const { POST } = await import('@/app/api/agent/connect/init/route');
    const req = makeRequest('http://localhost/api/agent/connect/init', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it('returns 500 on database insert error', async () => {
    enqueue(
      { data: null, error: null },                          // delete expired
      { data: null, error: null, count: 0 },                // count pending
      { data: null, error: { message: 'DB error' } },       // insert fails
    );
    const { POST } = await import('@/app/api/agent/connect/init/route');
    const req = makeRequest('http://localhost/api/agent/connect/init', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it('generates userCode with only unambiguous characters', async () => {
    enqueue(
      { data: null, error: null },
      { data: null, error: null, count: 0 },
      { data: { id: 'session-uuid-2' }, error: null },
    );
    const { POST } = await import('@/app/api/agent/connect/init/route');
    const req = makeRequest('http://localhost/api/agent/connect/init', { method: 'POST' });
    const res = await POST(req);
    const { userCode } = await res.json();
    const [alpha, digits] = userCode.split('-');
    // No ambiguous alpha chars (O, I, L)
    expect(alpha).not.toMatch(/[OIL]/);
    // No ambiguous digit chars (0, 1)
    expect(digits).not.toMatch(/[01]/);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/agent/connect/authorize
// ---------------------------------------------------------------------------

describe('POST /api/agent/connect/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callQueue = [];
    mockAuthUser = mockUser;
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUser = null;
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({ userCode: 'ABCD-2345' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when userCode is missing', async () => {
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when session not found or expired', async () => {
    // session lookup returns null
    enqueue({ data: null, error: null });
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({ userCode: 'ABCD-2345' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns ok:true and generates new key when user has no existing key', async () => {
    enqueue(
      // session lookup
      { data: { id: 'session-uuid-1', status: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() }, error: null },
      // existing api key lookup → none
      { data: null, error: null },
      // upsert new key
      { data: null, error: null },
      // update session status
      { data: null, error: null },
    );
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({ userCode: 'ABCD-2345' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // The key is read from and minted into user_secrets (service role only),
    // never user_settings, which the user's own browser can SELECT (#123).
    const tables = mockServiceClient.from.mock.calls.map((c) => c[0]);
    expect(tables).toEqual(['connect_sessions', 'user_secrets', 'user_secrets', 'connect_sessions']);
    expect(tables).not.toContain('user_settings');
  });

  it('reuses existing API key when user already has one', async () => {
    enqueue(
      // session lookup
      { data: { id: 'session-uuid-1', status: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() }, error: null },
      // existing api key lookup → found
      { data: { openclaw_api_key: 'dsul_existingkey' }, error: null },
      // update session (no upsert needed since key exists)
      { data: null, error: null },
    );
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({ userCode: 'ABCD-2345' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('normalizes userCode to uppercase before lookup', async () => {
    enqueue(
      { data: { id: 'session-uuid-1', status: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    );
    const { POST } = await import('@/app/api/agent/connect/authorize/route');
    const req = makeRequest('http://localhost/api/agent/connect/authorize', {
      method: 'POST',
      body: JSON.stringify({ userCode: 'abcd-2345' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/agent/connect/poll
// ---------------------------------------------------------------------------

describe('GET /api/agent/connect/poll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callQueue = [];
  });

  it('returns 400 when session param is missing', async () => {
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when session not found', async () => {
    enqueue({ data: null, error: null });
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=nonexistent');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns { status: "expired" } for expired sessions', async () => {
    enqueue({
      data: {
        id: 'session-1',
        status: 'pending',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        api_key: null,
        last_polled_at: null,
      },
      error: null,
    });
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    const body = await res.json();
    expect(body.status).toBe('expired');
  });

  it('returns 429 when polled too recently', async () => {
    enqueue({
      data: {
        id: 'session-1',
        status: 'pending',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        api_key: null,
        last_polled_at: new Date(Date.now() - 500).toISOString(), // 500ms ago
      },
      error: null,
    });
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    expect(res.status).toBe(429);
  });

  it('returns { status: "pending" } for pending sessions', async () => {
    enqueue(
      {
        data: {
          id: 'session-1',
          status: 'pending',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          api_key: null,
          last_polled_at: null,
        },
        error: null,
      },
      { data: null, error: null }, // update last_polled_at
    );
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    const body = await res.json();
    expect(body.status).toBe('pending');
  });

  it('returns { status: "authorized", apiKey, dsulUrl } and marks consumed', async () => {
    enqueue(
      {
        data: {
          id: 'session-1',
          status: 'authorized',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          api_key: 'dsul_abc123',
          last_polled_at: null,
        },
        error: null,
      },
      { data: null, error: null }, // update last_polled_at
      { data: null, error: null }, // update status → consumed
    );
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    const body = await res.json();
    expect(body.status).toBe('authorized');
    expect(body.apiKey).toBe('dsul_abc123');
    expect(body.dsulUrl).toBe('https://do.dsul.app');
    // The consumed row keeps no copy of the key.
    const updates = mockServiceClient.from.mock.results
      .map((r) => (r.value as { update: ReturnType<typeof vi.fn> }).update.mock.calls)
      .flat();
    expect(updates).toContainEqual([expect.objectContaining({ status: 'consumed', api_key: null })]);
  });

  it('returns { status: "consumed" } without apiKey for already-consumed sessions', async () => {
    enqueue(
      {
        data: {
          id: 'session-1',
          status: 'consumed',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          api_key: 'dsul_abc123',
          last_polled_at: null,
        },
        error: null,
      },
      { data: null, error: null }, // update last_polled_at
    );
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    const body = await res.json();
    expect(body.status).toBe('consumed');
    expect(body.apiKey).toBeUndefined();
  });

  it('allows polling when last_polled_at is old enough (>2s)', async () => {
    enqueue(
      {
        data: {
          id: 'session-1',
          status: 'pending',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          api_key: null,
          last_polled_at: new Date(Date.now() - 3000).toISOString(), // 3s ago
        },
        error: null,
      },
      { data: null, error: null }, // update last_polled_at
    );
    const { GET } = await import('@/app/api/agent/connect/poll/route');
    const req = makeRequest('http://localhost/api/agent/connect/poll?session=session-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});

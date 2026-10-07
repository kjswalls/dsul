import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the session Supabase client used by /api/openclaw/status.
//
// Shape exercised by the route:
//   supabase.auth.getUser()
//   supabase.from(...).select(...).eq(...).maybeSingle()
// ---------------------------------------------------------------------------

type SettingsRow = {
  openclaw_api_key: string | null;
  openclaw_chat_url: string | null;
  openclaw_agent_id: string | null;
};

let mockUser: { id: string } | null = { id: 'user-1' };
let mockRow: SettingsRow | null = null;
let mockRowError: { message: string } | null = null;

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockUser },
        error: mockUser ? null : { message: 'no session' },
      })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: mockRow, error: mockRowError })),
        })),
      })),
    })),
  })),
}));

// The key itself is read through the service-role helper (user_secrets since
// migration 059); this row's openclaw_api_key stands in for what it finds.
const readAgentKey = vi.fn(async () => mockRow?.openclaw_api_key ?? null);
vi.mock('@/lib/supabase-service', () => ({ readAgentKey }));

const { GET } = await import('@/app/api/openclaw/status/route');

beforeEach(() => {
  mockUser = { id: 'user-1' };
  mockRow = null;
  mockRowError = null;
});

describe('GET /api/openclaw/status', () => {
  it('401s when there is no session', async () => {
    mockUser = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('reports not-connected when no API key is stored', async () => {
    mockRow = { openclaw_api_key: null, openclaw_chat_url: null, openclaw_agent_id: null };
    const body = await (await GET()).json();
    expect(body).toEqual({ state: 'not-connected', agentId: null });
  });

  it('reports not-connected when the user_settings row does not exist yet', async () => {
    mockRow = null;
    const body = await (await GET()).json();
    expect(body.state).toBe('not-connected');
  });

  // The regression this route exists for: a device-authorized plugin running
  // without publicUrl never registers a chat URL, and used to read as a failure.
  it('reports pull-only when authorized but no chat URL was registered', async () => {
    mockRow = { openclaw_api_key: 'dsul_abc', openclaw_chat_url: null, openclaw_agent_id: null };
    const body = await (await GET()).json();
    expect(body).toEqual({ state: 'pull-only', agentId: null });
  });

  it('still reports pull-only when a stale agentId outlived the chat URL', async () => {
    mockRow = { openclaw_api_key: 'dsul_abc', openclaw_chat_url: '', openclaw_agent_id: 'main' };
    const body = await (await GET()).json();
    expect(body).toEqual({ state: 'pull-only', agentId: null });
  });

  it('reports connected when both the API key and a chat URL are present', async () => {
    mockRow = {
      openclaw_api_key: 'dsul_abc',
      openclaw_chat_url: 'https://gw.example/plugins/dsul/chat',
      openclaw_agent_id: 'planner',
    };
    const body = await (await GET()).json();
    expect(body).toEqual({ state: 'connected', agentId: 'planner' });
  });

  it('never returns the API key itself', async () => {
    mockRow = {
      openclaw_api_key: 'dsul_secret',
      openclaw_chat_url: 'https://gw.example/plugins/dsul/chat',
      openclaw_agent_id: 'main',
    };
    const raw = await (await GET()).text();
    expect(raw).not.toContain('dsul_secret');
  });

  it('500s when the settings read fails', async () => {
    mockRowError = { message: 'boom' };
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

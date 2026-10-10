import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The agent key stays out of the browser (#123, #142).
 *
 *   - The browser's plugin-chat credential is an HMAC of the key, derived the
 *     same way on both sides, and the plugin accepts nothing else.
 *   - /api/agent/chat-url hands out that token, never the key.
 *   - The key is stored and looked up in user_secrets (service role only),
 *     falling back to the old user_settings column ONLY while user_secrets has
 *     no such column (a build ahead of migration 059), never on a miss.
 *   - No code outside the service helpers selects the old column.
 */

const KEY = `dsul_${'ab'.repeat(32)}`;

describe('the plugin chat token', () => {
  it('is derived identically by dsul and by the plugin', async () => {
    const dsul = await import('@/lib/plugin-chat-token');
    const plugin = await import('@/openclaw-plugin/src/chat-token');
    expect(dsul.PLUGIN_CHAT_TOKEN_LABEL).toBe(plugin.PLUGIN_CHAT_TOKEN_LABEL);
    expect(dsul.pluginChatToken(KEY)).toBe(plugin.pluginChatToken(KEY));
    // A fixed vector, so a change to EITHER side (label, prefix, hash) fails here
    // rather than in a user's Ask.
    expect(dsul.pluginChatToken('dsul_test')).toBe(
      'dsulchat_' + (await import('node:crypto')).createHmac('sha256', 'dsul_test').update('dsul-plugin-chat-v1').digest('hex')
    );
  });

  it('is not the key and does not contain it', async () => {
    const { pluginChatToken } = await import('@/lib/plugin-chat-token');
    const token = pluginChatToken(KEY);
    expect(token).toMatch(/^dsulchat_[0-9a-f]{64}$/);
    expect(token).not.toContain(KEY.slice(5));
    expect(pluginChatToken(`${KEY}x`)).not.toBe(token);
  });
});

describe('the plugin chat route', () => {
  function call(authorization: string | undefined) {
    const req = Readable.from([Buffer.from(JSON.stringify({ message: 'hi', sessionKey: 'dsul-chat-1' }))]) as unknown as IncomingMessage;
    req.method = 'POST';
    req.headers = authorization ? { authorization } : {};
    let status = 0;
    let body = '';
    const res = {
      headersSent: false,
      writeHead(this: { headersSent: boolean }, code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(chunk?: string) {
        body += chunk ?? '';
      },
    } as unknown as ServerResponse;
    const runtime = {
      subagent: {
        run: vi.fn(async () => ({ runId: 'r1' })),
        waitForRun: vi.fn(async () => ({ status: 'ok' })),
        getSessionMessages: vi.fn(async () => ({ messages: [{ role: 'assistant', content: 'hello back' }] })),
      },
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    return { req, res, runtime, logger, result: () => ({ status, body }) };
  }

  async function run(authorization: string | undefined) {
    const { handleChatRequest } = await import('@/openclaw-plugin/src/chat');
    const c = call(authorization);
    await handleChatRequest(c.req, c.res, { dsulUrl: 'https://do.dsul.app', apiKey: KEY }, c.runtime as never, c.logger);
    return { ...c.result(), runtime: c.runtime };
  }

  it('answers the derived token', async () => {
    const { pluginChatToken } = await import('@/openclaw-plugin/src/chat-token');
    const r = await run(`Bearer ${pluginChatToken(KEY)}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ content: 'hello back' });
  });

  it('refuses the raw API key, a wrong token, and no bearer', async () => {
    for (const auth of [`Bearer ${KEY}`, 'Bearer dsulchat_nope', undefined]) {
      const r = await run(auth);
      expect(r.status).toBe(401);
      expect(r.runtime.subagent.run).not.toHaveBeenCalled();
    }
  });
});

// ── Storage: user_secrets first, user_settings only while 059 is missing ─────

type Answer = { data: unknown; error: { code?: string; message?: string } | null };
const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let answer: (table: string, op: string) => Answer = () => ({ data: null, error: null });

function chain(table: string, op: string, args: unknown[]) {
  calls.push({ table, op, args });
  const self: Record<string, unknown> = {
    eq: (...a: unknown[]) => {
      calls.push({ table, op: 'eq', args: a });
      return self;
    },
    maybeSingle: async () => answer(table, op),
    then: (resolve: (v: Answer) => void) => resolve(answer(table, op)),
  };
  return self;
}
/** The real helpers; the module itself is mocked below for the chat-url route. */
const real = () => vi.importActual<typeof import('@/lib/supabase-service')>('@/lib/supabase-service');

const client = {
  from: (table: string) => ({
    select: (...a: unknown[]) => chain(table, 'select', a),
    upsert: (...a: unknown[]) => chain(table, 'upsert', a),
    update: (...a: unknown[]) => chain(table, 'update', a),
  }),
};

describe('agent key storage', () => {
  beforeEach(() => {
    calls.length = 0;
    answer = () => ({ data: null, error: null });
  });

  it('reads, writes and resolves the key in user_secrets', async () => {
    const svc = await real();
    answer = (table) => (table === 'user_secrets' ? { data: { openclaw_api_key: KEY, user_id: 'u1' }, error: null } : { data: null, error: null });
    expect(await svc.readAgentKey('u1', client as never)).toBe(KEY);
    expect(await svc.resolveUserIdFromApiKey(KEY, client as never)).toBe('u1');
    expect(await svc.storeAgentKey('u1', KEY, client as never)).toEqual({ error: null });
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(['user_secrets']));
  });

  it('a miss in user_secrets does not fall back to user_settings', async () => {
    const svc = await real();
    answer = (table) =>
      table === 'user_secrets' ? { data: null, error: null } : { data: { openclaw_api_key: KEY, user_id: 'u1' }, error: null };
    expect(await svc.readAgentKey('u1', client as never)).toBeNull();
    expect(await svc.resolveUserIdFromApiKey(KEY, client as never)).toBeNull();
    expect(calls.map((c) => c.table)).not.toContain('user_settings');
  });

  it('falls back to user_settings only while user_secrets has no key column (before 059)', async () => {
    const svc = await real();
    answer = (table) =>
      table === 'user_secrets'
        ? { data: null, error: { code: '42703', message: 'column user_secrets.openclaw_api_key does not exist' } }
        : { data: { openclaw_api_key: KEY, user_id: 'u1' }, error: null };
    expect(await svc.readAgentKey('u1', client as never)).toBe(KEY);
    expect(await svc.resolveUserIdFromApiKey(KEY, client as never)).toBe('u1');
    expect(await svc.storeAgentKey('u1', KEY, client as never)).toEqual({ error: null });
    expect(calls.filter((c) => c.op === 'upsert').map((c) => c.table)).toEqual(['user_secrets', 'user_settings']);
  });

  it('Unpair clears the key in user_secrets, and only there', async () => {
    const svc = await real();
    expect(await svc.clearAgentKey('u1', client as never)).toEqual({ error: null });
    expect(calls.filter((c) => c.op === 'update')).toEqual([
      { table: 'user_secrets', op: 'update', args: [{ openclaw_api_key: null }] },
    ]);
    expect(calls.filter((c) => c.op === 'eq').map((c) => c.args)).toEqual([['user_id', 'u1']]);
  });

  it('Unpair clears user_settings only while user_secrets has no key column, and says only a code', async () => {
    const svc = await real();
    answer = (table) =>
      table === 'user_secrets'
        ? { data: null, error: { code: 'PGRST204', message: 'no openclaw_api_key column' } }
        : { data: null, error: null };
    expect(await svc.clearAgentKey('u1', client as never)).toEqual({ error: null });
    expect(calls.filter((c) => c.op === 'update').map((c) => c.table)).toEqual(['user_secrets', 'user_settings']);

    calls.length = 0;
    answer = () => ({ data: null, error: { code: '23514', message: `row (${KEY})` } });
    expect(await svc.clearAgentKey('u1', client as never)).toEqual({ error: '23514' });
    expect(calls.map((c) => c.table)).not.toContain('user_settings');
  });

  it('any other error is not a fallback', async () => {
    const svc = await real();
    answer = () => ({ data: null, error: { code: 'PGRST301', message: 'boom' } });
    await expect(svc.readAgentKey('u1', client as never)).rejects.toThrow('boom');
    expect(await svc.resolveUserIdFromApiKey(KEY, client as never)).toBeNull();
    expect(await svc.storeAgentKey('u1', KEY, client as never)).toEqual({ error: 'boom' });
    expect(calls.map((c) => c.table)).not.toContain('user_settings');
  });
});

// ── /api/agent/chat-url ───────────────────────────────────────────────────────

const readAgentKey = vi.fn(async (): Promise<string | null> => null);
vi.mock('@/lib/supabase-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase-service')>()),
  readAgentKey,
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } }, error: null })) },
    from: vi.fn(() => ({
      select: vi.fn((columns: string) => {
        // The session client never asks for the key.
        expect(columns).not.toContain('openclaw_api_key');
        return {
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: { openclaw_chat_url: 'https://claw.example/plugins/dsul/chat', openclaw_agent_id: 'main' },
              error: null,
            })),
          })),
        };
      }),
    })),
  })),
}));

describe('GET /api/agent/chat-url', () => {
  it('returns the chat token and never the key', async () => {
    readAgentKey.mockResolvedValueOnce(KEY);
    const { GET } = await import('@/app/api/agent/chat-url/route');
    const { pluginChatToken } = await import('@/lib/plugin-chat-token');
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      chatUrl: 'https://claw.example/plugins/dsul/chat',
      agentId: 'main',
      chatToken: pluginChatToken(KEY),
    });
    expect(text).not.toContain(KEY);
  });
});

// ── Source scan ───────────────────────────────────────────────────────────────

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('nothing else reads the key column', () => {
  it('only the service helpers and the status read select openclaw_api_key', () => {
    const allowed = new Set(['lib/supabase-service.ts', 'lib/ai-server/connections.ts']);
    const offenders = ['app', 'lib', 'components', 'hooks']
      .flatMap((d) => files(join(process.cwd(), d)))
      .map((path) => ({ rel: path.slice(process.cwd().length + 1), text: readFileSync(path, 'utf8') }))
      .filter(({ rel }) => !allowed.has(rel))
      .filter(({ text }) => /\.(select|eq|upsert|update|insert)\([^)]*openclaw_api_key/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('no route hands the browser the key', () => {
    const routes = files(join(process.cwd(), 'app'));
    const offenders = routes.filter((p) => /dsulApiKey|apiKey: data\?\.openclaw_api_key/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

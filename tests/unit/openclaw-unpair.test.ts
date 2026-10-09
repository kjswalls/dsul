// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unpair: DELETE /api/ai/openclaw over the REAL `unpairOpenClaw`
 * (lib/ai-server/connections.ts) and the REAL `clearAgentKey`
 * (lib/supabase-service.ts), on an in-memory service client.
 *
 * What is pinned:
 *   1. The order: webhooks, the chat URL and agent id, device sessions still
 *      holding the key, the key, then webhooks once more. The key goes last,
 *      so any failure before it leaves the pairing (and its Unpair button).
 *   2. The gateway URL and token are never written.
 *   3. Before 059 the key is cleared where it still lives, user_settings.
 *   4. A failure answers 503 `server` and logs one code, never a message or
 *      the key; asking again finishes the job.
 */

const SENTINEL_KEY = `dsul_${'5e'.repeat(32)}`;

const h = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
  })),
}));

type Err = { code?: string; message?: string; details?: string } | null;

interface Db {
  settings: Record<string, unknown> | null;
  secrets: Record<string, unknown> | null;
  /** `${table}.${op}` → the error that statement answers. */
  errors: Record<string, Err>;
  log: Array<{ table: string; op: string; values?: unknown; filters: Array<[string, unknown]> }>;
}

const db = vi.hoisted(() => ({ current: null as unknown as Db }));

function client() {
  return {
    from(table: string) {
      const run = (op: string, values?: unknown) => {
        const entry = { table, op, values, filters: [] as Array<[string, unknown]> };
        db.current.log.push(entry);
        const error = db.current.errors[`${table}.${op}`] ?? null;
        const result = () => {
          if (error) return { data: null, error };
          if (op === 'update') {
            const row = table === 'user_settings' ? db.current.settings : table === 'user_secrets' ? db.current.secrets : null;
            if (row) Object.assign(row, values as object);
            return { data: null, error: null };
          }
          const row = table === 'user_settings' ? db.current.settings : table === 'user_secrets' ? db.current.secrets : null;
          return { data: row ? { ...row } : null, error: null };
        };
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            entry.filters.push([col, val]);
            return chain;
          },
          maybeSingle: async () => result(),
          then: (resolve: (v: unknown) => void) => resolve(result()),
        };
        return chain;
      };
      return {
        select: () => run('select'),
        update: (values: unknown) => run('update', values),
      };
    },
  };
}

vi.mock('@/lib/supabase-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase-service')>()),
  createServiceClient: vi.fn(() => client()),
}));

const registry = vi.hoisted(() => ({ ok: [] as boolean[] }));
vi.mock('@/lib/openclaw-registry', () => ({
  deregisterAllPlugins: vi.fn(async (userId: string) => {
    db.current.log.push({ table: 'plugin_registrations', op: 'delete', filters: [['user_id', userId]] });
    const ok = registry.ok.length > 0 ? registry.ok.shift()! : true;
    return ok ? { ok: true, durable: true } : { ok: false, reason: 'deregister failed' };
  }),
}));

import { DELETE } from '@/app/api/ai/openclaw/route';
import { createServiceClient } from '@/lib/supabase-service';
import { deregisterAllPlugins } from '@/lib/openclaw-registry';

const ORIGIN = 'https://do.dsul.app';
const call = (headers: Record<string, string> = {}) =>
  DELETE(new Request(`${ORIGIN}/api/ai/openclaw`, { method: 'DELETE', headers }));

let logs: unknown[][];

beforeEach(() => {
  h.user = { id: 'user-1' };
  registry.ok = [];
  db.current = {
    settings: {
      openclaw_chat_url: 'https://claw.example/plugins/dsul/chat',
      openclaw_agent_id: 'atlas',
      openclaw_gateway_url: null,
      openclaw_api_key: null,
    },
    secrets: { openclaw_api_key: SENTINEL_KEY, openclaw_gateway_token: null },
    errors: {},
    log: [],
  };
  logs = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a));
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a));
  vi.mocked(createServiceClient).mockClear();
  vi.mocked(deregisterAllPlugins).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const writes = () => db.current.log.filter((e) => e.op !== 'select');
const steps = () => writes().map((e) => `${e.table}.${e.op}`);

describe('DELETE /api/ai/openclaw', () => {
  it('unpairs in order, and the key goes last', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(steps()).toEqual([
      'plugin_registrations.delete',
      'user_settings.update',
      'connect_sessions.update',
      'user_secrets.update',
      'plugin_registrations.delete',
    ]);
    for (const w of writes()) expect(w.filters[0]).toEqual(['user_id', 'user-1']);
    expect(await res.json()).toEqual({
      openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
    });
  });

  it('clears the chat URL and agent id, and never touches the gateway', async () => {
    db.current.settings!.openclaw_gateway_url = 'https://gw.example';
    db.current.secrets!.openclaw_gateway_token = 'gw-token';
    const res = await call();
    const settings = writes().find((w) => w.table === 'user_settings')!;
    expect(settings.values).toEqual({ openclaw_chat_url: null, openclaw_agent_id: null });
    const secrets = writes().find((w) => w.table === 'user_secrets')!;
    expect(secrets.values).toEqual({ openclaw_api_key: null });
    expect((await res.json()).openclaw).toEqual({ gateway: true, pluginChat: false, agent: false, agentId: null });
  });

  it('expires only authorized device sessions, and drops their copy of the key', async () => {
    await call();
    const sessions = writes().find((w) => w.table === 'connect_sessions')!;
    expect(sessions.values).toEqual({ status: 'expired', api_key: null });
    expect(sessions.filters).toEqual([
      ['user_id', 'user-1'],
      ['status', 'authorized'],
    ]);
  });

  it('before 059, clears the key where it still lives', async () => {
    db.current.errors['user_secrets.update'] = { code: '42703', message: 'column does not exist' };
    db.current.settings!.openclaw_api_key = SENTINEL_KEY;
    const res = await call();
    expect(res.status).toBe(200);
    expect(steps()).toEqual([
      'plugin_registrations.delete',
      'user_settings.update',
      'connect_sessions.update',
      'user_secrets.update',
      'user_settings.update',
      'plugin_registrations.delete',
    ]);
    expect(writes()[4].values).toEqual({ openclaw_api_key: null });
  });

  it('nothing paired answers the same 200, every time', async () => {
    db.current.settings = null;
    db.current.secrets = null;
    for (let i = 0; i < 2; i += 1) {
      const res = await call();
      expect(res.status).toBe(200);
      expect((await res.json()).openclaw).toEqual({ gateway: false, pluginChat: false, agent: false, agentId: null });
    }
  });

  it.each([
    ['the webhooks', () => void registry.ok.push(false), 'registry'],
    ['the chat URL', () => void (db.current.errors['user_settings.update'] = { code: 'PGRST301' }), 'PGRST301'],
    ['the device sessions', () => void (db.current.errors['connect_sessions.update'] = { code: '57014' }), '57014'],
  ])('a failure at %s answers 503 and leaves the key, so Unpair stays', async (_step, arrange, code) => {
    arrange();
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'server' });
    expect(steps()).not.toContain('user_secrets.update');
    expect(db.current.secrets!.openclaw_api_key).toBe(SENTINEL_KEY);
    expect(logs).toContainEqual(['[ai] db', 'unpair', 'failed', code]);
  });

  it('a key that will not clear answers 503, and logs its code and nothing it said', async () => {
    db.current.errors['user_secrets.update'] = {
      code: '23514',
      message: `violates check SENTINEL ${SENTINEL_KEY}`,
      details: `Failing row contains (user-1, ${SENTINEL_KEY}).`,
    };
    const res = await call();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'server' });
    expect(logs).toEqual([['[ai] db', 'unpair', 'failed', '23514']]);
    expect(JSON.stringify(logs)).not.toContain('SENTINEL');
    expect(JSON.stringify(logs)).not.toContain(SENTINEL_KEY);
  });

  it('a webhook registered before the key went is swept after it', async () => {
    registry.ok.push(true, false);
    const res = await call();
    expect(res.status).toBe(503);
    expect(steps().at(-1)).toBe('plugin_registrations.delete');
    expect(db.current.secrets!.openclaw_api_key).toBeNull();
    expect(logs).toContainEqual(['[ai] db', 'unpair', 'failed', 'registry']);
  });

  it('a status read that fails afterwards still answers 200, with nothing to apply', async () => {
    db.current.errors['user_settings.select'] = { code: 'PGRST301' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openclaw: null });
    expect(db.current.secrets!.openclaw_api_key).toBeNull();
  });

  it('never answers with the key', async () => {
    const text = await (await call()).text();
    expect(text).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL_KEY);
  });

  it('no session: 401, and nothing is touched', async () => {
    h.user = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(deregisterAllPlugins).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }])(
    'a cross-site request (%o): 403, and nothing is touched',
    async (headers) => {
      const res = await call(headers);
      expect(res.status).toBe(403);
      expect(createServiceClient).not.toHaveBeenCalled();
      expect(deregisterAllPlugins).not.toHaveBeenCalled();
    }
  );
});

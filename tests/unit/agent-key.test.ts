import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent key stays out of the browser (#123, #142).
 *
 *   - The key is stored and looked up in user_secrets (service role only),
 *     falling back to the old user_settings column ONLY while user_secrets has
 *     no such column (a build ahead of migration 059), never on a miss.
 *   - No code outside the service helpers selects the old column.
 */

const KEY = `dsul_${'ab'.repeat(32)}`;

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

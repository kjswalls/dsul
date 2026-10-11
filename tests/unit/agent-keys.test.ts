// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_KEYS,
  cleanKeyName,
  createAgentKey,
  isAgentKeyShape,
  listAgentKeys,
  resolveAgentKey,
  revokeAgentKey,
} from '@/lib/agent-keys';
import { resolveUserIdFromApiKey } from '@/lib/supabase-service';

/**
 * Named agent keys (lib/agent-keys.ts, migration 072): made, shown once,
 * stored as a hash, listed without it, revoked, and routed by their prefix in
 * resolveUserIdFromApiKey at the same scopes an OAuth app's token has. Against
 * an in-memory stand-in for the table.
 */

type Row = Record<string, unknown>;

function fakeDb() {
  const rows: Row[] = [];
  let ids = 0;
  function from(table: string) {
    if (table !== 'agent_keys') throw new Error(`unexpected table ${table}`);
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row[] = [];
    let counting = false;
    const hit = () => rows.filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op === 'insert') return inserted;
      const h = hit();
      if (op === 'update') for (const r of h) Object.assign(r, patch);
      return h;
    };
    const builder = {
      select(_c?: string, o?: { count?: string; head?: boolean }) {
        if (o?.head) counting = true;
        return builder;
      },
      eq(k: string, v: unknown) {
        filters.push((r) => r[k] === v);
        return builder;
      },
      is(k: string, v: unknown) {
        filters.push((r) => (r[k] ?? null) === v);
        return builder;
      },
      order() {
        return builder;
      },
      update(p: Row) {
        op = 'update';
        patch = p;
        return builder;
      },
      insert(r: Row) {
        op = 'insert';
        const id = `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
        inserted = [{ id, created_at: '2026-10-11T00:00:00.000Z', last_used_at: null, revoked_at: null, ...r }];
        rows.push(...inserted);
        return builder;
      },
      async maybeSingle() {
        return { data: run()[0] ?? null, error: null };
      },
      async single() {
        const out = run();
        return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'none' } };
      },
      then(resolve: (v: unknown) => unknown) {
        const out = run();
        return Promise.resolve(counting ? { count: out.length, error: null } : { data: out, error: null }).then(resolve);
      },
    };
    return builder;
  }
  return { db: { from } as never, rows };
}

describe('the rules', () => {
  it('cleans a name to 1–60 characters, or refuses it', () => {
    expect(cleanKeyName('  Home   server ')).toBe('Home server');
    expect(cleanKeyName('   ')).toBeNull();
    expect(cleanKeyName('x'.repeat(61))).toBeNull();
    expect(cleanKeyName(7)).toBeNull();
  });

  it('knows a key by its shape, and never takes the legacy hex key for one', () => {
    expect(isAgentKeyShape(`dsul_ak_${'A'.repeat(43)}`)).toBe(true);
    expect(isAgentKeyShape(`dsul_ak_${'A'.repeat(42)}`)).toBe(false);
    expect(isAgentKeyShape(`dsul_${'ab'.repeat(32)}`)).toBe(false);
  });
});

describe('the store', () => {
  it('shows the key once and keeps only its sha256', async () => {
    const { db, rows } = fakeDb();
    const made = await createAgentKey(db, 'u1', 'Home server', 'planner:read');
    if (!made.ok) throw new Error('not made');
    expect(isAgentKeyShape(made.key)).toBe(true);
    expect(rows[0].key_hash).toBe(createHash('sha256').update(made.key).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(made.key);
    const listed = await listAgentKeys(db, 'u1');
    expect(listed).toEqual([made.agentKey]);
    expect(JSON.stringify(listed)).not.toContain(made.key);
  });

  it('resolves a live key to its owner and scope, and nothing once revoked', async () => {
    const { db } = fakeDb();
    const made = await createAgentKey(db, 'u1', 'Script', 'planner');
    if (!made.ok) throw new Error('not made');
    expect(await resolveAgentKey(db, made.key)).toMatchObject({ userId: 'u1', scope: 'planner' });
    expect(await revokeAgentKey(db, 'u2', made.agentKey.id)).toBe(false);
    expect(await revokeAgentKey(db, 'u1', made.agentKey.id)).toBe(true);
    expect(await revokeAgentKey(db, 'u1', made.agentKey.id)).toBe(false);
    expect(await resolveAgentKey(db, made.key)).toBeNull();
    expect(await listAgentKeys(db, 'u1')).toEqual([]);
  });

  it('refuses a key past the cap', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < MAX_AGENT_KEYS; i++) await createAgentKey(db, 'u1', `k${i}`, 'planner:read');
    expect(await createAgentKey(db, 'u1', 'one more', 'planner:read')).toEqual({ ok: false, error: 'limit' });
    expect((await createAgentKey(db, 'u2', 'theirs', 'planner:read')).ok).toBe(true);
  });

  it('marks a key used, at most every ten minutes', async () => {
    const { db, rows } = fakeDb();
    const made = await createAgentKey(db, 'u1', 'Script', 'planner');
    if (!made.ok) throw new Error('not made');
    const t0 = new Date('2026-10-11T10:00:00Z');
    await resolveAgentKey(db, made.key, t0);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[0].last_used_at).toBe(t0.toISOString());
    await resolveAgentKey(db, made.key, new Date('2026-10-11T10:05:00Z'));
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[0].last_used_at).toBe(t0.toISOString());
  });
});

describe('resolveUserIdFromApiKey', () => {
  it('opens read routes to either scope, write routes to the full one, and never a gateway route', async () => {
    const { db } = fakeDb();
    const read = await createAgentKey(db, 'u1', 'Reader', 'planner:read');
    const write = await createAgentKey(db, 'u1', 'Writer', 'planner');
    if (!read.ok || !write.ok) throw new Error('not made');
    expect(await resolveUserIdFromApiKey(read.key, db, 'read')).toBe('u1');
    expect(await resolveUserIdFromApiKey(read.key, db, 'write')).toBeNull();
    expect(await resolveUserIdFromApiKey(write.key, db, 'write')).toBe('u1');
    expect(await resolveUserIdFromApiKey(write.key, db, 'key')).toBeNull();
    expect(await resolveUserIdFromApiKey(write.key, db)).toBeNull();
  });
});

describe('migration 072', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/072_agent_keys.sql'), 'utf8');
  it('is service-role only, cascades from the account, and allows only the two scopes', () => {
    expect(sql).toMatch(/references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on public\.agent_keys from anon, authenticated/);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toMatch(/check \(scope in \('planner', 'planner:read'\)\)/);
    expect(sql).toMatch(/create unique index if not exists agent_keys_hash_idx/);
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimits, takeSharedToken } from '@/lib/ai-server/rate-limit';

/**
 * The connect and check buckets also count in the database (migration 064),
 * because a per-instance count gives a key-guesser one limit per cold start.
 * The memory bucket answers first; the shared count fails open.
 */

const { rpc, createServiceClient } = vi.hoisted(() => {
  const rpc = vi.fn();
  return { rpc, createServiceClient: vi.fn(() => ({ rpc })) };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => createServiceClient() }));


beforeEach(() => {
  __resetRateLimits();
  rpc.mockReset();
  createServiceClient.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {}).mockClear();
});

describe('takeSharedToken', () => {
  it('asks the shared count for one token at the bucket’s limit', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(takeSharedToken('u1', 'connect')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('take_ai_token', { p_user: 'u1', p_bucket: 'connect', p_limit: 20, p_cost: 1 });
    await takeSharedToken('u1', 'check');
    expect(rpc).toHaveBeenLastCalledWith('take_ai_token', { p_user: 'u1', p_bucket: 'check', p_limit: 60, p_cost: 1 });
  });

  it('refuses when the shared count is spent, though this instance has room', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(takeSharedToken('u1', 'connect')).resolves.toBe(false);
  });

  it('refuses from memory first, without a query', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    for (let i = 0; i < 20; i++) await takeSharedToken('u1', 'connect');
    rpc.mockClear();
    await expect(takeSharedToken('u1', 'connect')).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['064 not applied yet', { data: null, error: { code: 'PGRST202', message: 'x' } }],
    ['a database error', { data: null, error: { code: '57014', message: 'x' } }],
  ])('fails open on %s, and logs the code once, never the message', async (_name, answer) => {
    rpc.mockResolvedValue(answer);
    await expect(takeSharedToken('u1', 'connect')).resolves.toBe(true);
    await expect(takeSharedToken('u1', 'connect')).resolves.toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('"x"');
  });

  it('fails open when the client cannot be built (no service key)', async () => {
    createServiceClient.mockImplementationOnce(() => {
      throw new Error('Missing env');
    });
    await expect(takeSharedToken('u1', 'check')).resolves.toBe(true);
  });
});

describe('064_ai_rate_limits.sql', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/064_ai_rate_limits.sql'), 'utf8');

  it('is service-role only', () => {
    expect(sql).toMatch(/enable row level security/);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toMatch(/revoke all on table public\.ai_rate_limits from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.take_ai_token\([^)]*\) to service_role;/);
    expect(sql).not.toMatch(/grant [^;]* to (?:anon|authenticated)/);
  });

  it('checks and takes in one statement, so racing instances cannot both pass', () => {
    expect(sql).toMatch(/on conflict \(user_id, bucket\) do update[\s\S]*?where[\s\S]*?<= p_limit/);
  });
});

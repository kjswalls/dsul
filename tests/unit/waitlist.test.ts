import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWaitlistLimits,
  callerOf,
  clipWhy,
  isTicket,
  normalizeEmail,
  sourceOf,
  takeWaitlistToken,
  WAITLIST_LIMITS,
  WHY_MAX,
} from '@/lib/waitlist';

// The service client, as a recorder: each test sets what the next query answers.
type Answer = { data: unknown; error: { code?: string } | null };
const db = vi.hoisted(() => ({
  answer: { data: [], error: null } as { data: unknown; error: { code?: string } | null },
  calls: [] as Array<{ op: string; args: unknown[] }>,
  throws: false,
}));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    if (db.throws) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    const chain: Record<string, unknown> = {};
    for (const op of ['from', 'upsert', 'update', 'select', 'eq', 'gte']) {
      chain[op] = (...args: unknown[]) => {
        db.calls.push({ op, args });
        return chain;
      };
    }
    chain.then = (resolve: (a: Answer) => unknown) => resolve(db.answer);
    return chain;
  },
}));

import { PATCH, POST } from '@/app/api/waitlist/route';

const TICKET = '0b7d6c1e-5f3a-4c2b-9e8d-7a6b5c4d3e2f';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function req(method: 'POST' | 'PATCH', body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://dsul.app/api/waitlist', {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function call(op: string) {
  return db.calls.find((c) => c.op === op);
}

beforeEach(() => {
  __resetWaitlistLimits();
  db.answer = { data: [], error: null };
  db.calls = [];
  db.throws = false;
});
afterEach(() => vi.restoreAllMocks());

describe('lib/waitlist', () => {
  it('trims and lowercases an address, and refuses what cannot be one', () => {
    expect(normalizeEmail('  Jo@Example.COM ')).toBe('jo@example.com');
    for (const bad of ['', 'jo', 'jo@', '@x.com', 'jo@example', 'jo @example.com', 'a@b.c'.padStart(260, 'a'), 42, null]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('folds the why to one line, capped by code point', () => {
    expect(clipWhy('  too\n\nmany   red  numbers ')).toBe('too many red numbers');
    expect(clipWhy('   ')).toBeNull();
    expect(clipWhy(7)).toBeNull();
    const long = clipWhy('😀'.repeat(WHY_MAX + 20))!;
    expect(Array.from(long)).toHaveLength(WHY_MAX);
    expect(long.endsWith('😀')).toBe(true);
  });

  it('knows a ticket by its shape, and a source falls back to the hero', () => {
    expect(isTicket(TICKET)).toBe(true);
    expect(isTicket('not-a-ticket')).toBe(false);
    expect(sourceOf('closer')).toBe('closer');
    expect(sourceOf('elsewhere')).toBe('hero');
  });

  it('reads the caller from x-real-ip, then the first x-forwarded-for hop', () => {
    expect(callerOf(new Headers({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1');
    expect(callerOf(new Headers({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }))).toBe('2.2.2.2');
    expect(callerOf(new Headers())).toBe('unknown');
  });

  it('lets each caller through a set number of times an hour', () => {
    const now = 1_000_000;
    for (let i = 0; i < WAITLIST_LIMITS.join; i++) expect(takeWaitlistToken('a', 'join', now)).toBe(true);
    expect(takeWaitlistToken('a', 'join', now)).toBe(false);
    expect(takeWaitlistToken('b', 'join', now)).toBe(true);
    expect(takeWaitlistToken('a', 'join', now + 60 * 60 * 1000)).toBe(true);
  });
});

describe('POST /api/waitlist', () => {
  it('adds the address, lowercased, and hands back its row ticket', async () => {
    db.answer = { data: [{ ticket: TICKET }], error: null };
    const res = await POST(req('POST', { email: ' Jo@Example.com', source: 'closer' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ticket: TICKET });
    expect(call('from')?.args).toEqual(['waitlist_signups']);
    expect(call('upsert')?.args).toEqual([
      { email: 'jo@example.com', source: 'closer' },
      { onConflict: 'email', ignoreDuplicates: true },
    ]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers a repeat exactly like a new signup, with a ticket that names no row', async () => {
    db.answer = { data: [], error: null };
    const res = await POST(req('POST', { email: 'jo@example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['ok', 'ticket']);
    expect(body.ticket).toMatch(UUID);
    expect(body.ticket).not.toBe(TICKET);
  });

  it('takes the honeypot for a bot: an ordinary 200, and nothing written', async () => {
    const res = await POST(req('POST', { email: 'jo@example.com', company: 'Acme' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ticket).toMatch(UUID);
    expect(db.calls).toHaveLength(0);
  });

  it('refuses an address that cannot be one', async () => {
    const res = await POST(req('POST', { email: 'not an email' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_email' });
    expect(db.calls).toHaveLength(0);
  });

  it('takes JSON only, and only a small body', async () => {
    expect((await POST(req('POST', 'email=jo%40example.com', { 'content-type': 'application/x-www-form-urlencoded' }))).status).toBe(415);
    expect((await POST(req('POST', '{"email":'))).status).toBe(400);
    expect((await POST(req('POST', '["jo@example.com"]'))).status).toBe(400);
    expect((await POST(req('POST', { email: 'jo@example.com', pad: 'x'.repeat(5_000) }))).status).toBe(413);
  });

  it('slows one caller down after the hourly allowance', async () => {
    for (let i = 0; i < WAITLIST_LIMITS.join; i++) {
      expect((await POST(req('POST', { email: `jo${i}@example.com` }))).status).toBe(200);
    }
    const res = await POST(req('POST', { email: 'one-more@example.com' }));
    expect(res.status).toBe(429);
    expect((await POST(req('POST', { email: 'sam@example.com' }, { 'x-real-ip': '198.51.100.4' }))).status).toBe(200);
  });

  it.each(['42P01', 'PGRST205'])('answers 503 while the table is not there yet (%s)', async (code) => {
    db.answer = { data: null, error: { code } };
    const res = await POST(req('POST', { email: 'jo@example.com' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('answers 503 when the server has no service key', async () => {
    db.throws = true;
    expect((await POST(req('POST', { email: 'jo@example.com' }))).status).toBe(503);
  });

  it('logs a failure by its code, never the address', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.answer = { data: null, error: { code: '23514' } };
    const res = await POST(req('POST', { email: 'jo@example.com' }));
    expect(res.status).toBe(500);
    expect(log).toHaveBeenCalledWith('[waitlist]', 'join', '23514');
    expect(JSON.stringify(log.mock.calls)).not.toContain('jo@example.com');
  });
});

describe('PATCH /api/waitlist', () => {
  it('saves the answer by ticket, for a day after the signup', async () => {
    const before = Date.now();
    const res = await PATCH(req('PATCH', { ticket: TICKET, planner: 'paper', why: ' it had\nno undo ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [patch] = call('update')!.args as [Record<string, unknown>];
    expect(patch).toMatchObject({ planner: 'paper', why: 'it had no undo' });
    expect(typeof patch.answered_at).toBe('string');
    expect(call('eq')?.args).toEqual(['ticket', TICKET]);
    const [col, since] = call('gte')!.args as [string, string];
    expect(col).toBe('created_at');
    expect(before - Date.parse(since)).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1_000);
  });

  it('touches only what was sent', async () => {
    await PATCH(req('PATCH', { ticket: TICKET, planner: 'brain' }));
    const [patch] = call('update')!.args as [Record<string, unknown>];
    expect(Object.keys(patch).sort()).toEqual(['answered_at', 'planner']);
  });

  it('refuses a bad ticket, a planner that is not a chip, or nothing to save', async () => {
    expect((await PATCH(req('PATCH', { ticket: 'jo@example.com', planner: 'paper' }))).status).toBe(400);
    expect((await PATCH(req('PATCH', { ticket: TICKET, planner: 'filofax' }))).status).toBe(400);
    expect((await PATCH(req('PATCH', { ticket: TICKET }))).status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it('never takes an email in place of a ticket', async () => {
    await PATCH(req('PATCH', { ticket: TICKET, email: 'jo@example.com', planner: 'all' }));
    const [patch] = call('update')!.args as [Record<string, unknown>];
    expect(patch).not.toHaveProperty('email');
    expect(db.calls.some((c) => c.op === 'eq' && c.args[0] === 'email')).toBe(false);
  });
});

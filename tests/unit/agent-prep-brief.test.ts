import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET /api/agent/prep-brief — an agent getting items ready reads what the
 * person's own model is told: the same rules, their writing style, and which
 * handed-over items they keep moving. Only ever the key holder's account.
 */

let resolvedUser: string | null;
let callerName: string;
const tables: Record<string, { data: unknown; error: unknown }> = {};
const filters: Record<string, [string, unknown][]> = {};

function query(table: string) {
  filters[table] = [];
  const q: Record<string, unknown> = {};
  const chain = (name: string) => (col: string, val?: unknown) => {
    filters[table].push([`${name}:${col}`, val]);
    return q;
  };
  for (const m of ['select', 'eq', 'not', 'is', 'gte', 'limit']) q[m] = chain(m);
  q.maybeSingle = async () => tables[table];
  q.then = (resolve: (v: unknown) => void) => resolve(tables[table]);
  return q;
}

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({ from: (t: string) => query(t) }),
}));

vi.mock('@/lib/agent-caller', () => ({
  resolveAgentCaller: async () =>
    resolvedUser ? { userId: resolvedUser, scope: 'planner:read', who: async () => callerName } : null,
}));

import { GET } from '@/app/api/agent/prep-brief/route';
import { PREP_KIND_RULES, PREP_QUESTION_RULE_LIST } from '@/lib/prep-rules';

const brief = (auth = 'Bearer dsul_key') =>
  GET(new Request('http://localhost/api/agent/prep-brief', { headers: auth ? { authorization: auth } : {} }) as never);

beforeEach(() => {
  resolvedUser = 'u1';
  callerName = 'openclaw';
  tables.user_extensions = { data: { config: { writingStyle: 'Short. Starts with "Hi".' } }, error: null };
  tables.items = {
    data: [
      { id: 'a', title: 'Call the GP', status: 'pending', assignee: 'openclaw' },
      { id: 'b', title: 'Email Jo', status: 'pending', assignee: 'openclaw' },
      { id: 'c', title: 'Done already', status: 'completed', assignee: 'openclaw' },
      { id: 'd', title: "Claude's errand", status: 'pending', assignee: 'Claude' },
    ],
    error: null,
  };
  tables.item_events = {
    data: [
      { item_id: 'a', created_at: '2026-10-01T09:00:00Z' },
      { item_id: 'a', created_at: '2026-10-01T18:00:00Z' },
      { item_id: 'a', created_at: '2026-10-05T09:00:00Z' },
      { item_id: 'a', created_at: '2026-10-09T09:00:00Z' },
      { item_id: 'b', created_at: '2026-10-09T09:00:00Z' },
      { item_id: 'c', created_at: '2026-10-01T09:00:00Z' },
      { item_id: 'c', created_at: '2026-10-02T09:00:00Z' },
      { item_id: 'c', created_at: '2026-10-03T09:00:00Z' },
      { item_id: 'd', created_at: '2026-10-01T09:00:00Z' },
      { item_id: 'd', created_at: '2026-10-02T09:00:00Z' },
      { item_id: 'd', created_at: '2026-10-03T09:00:00Z' },
    ],
    error: null,
  };
});

describe('GET /api/agent/prep-brief', () => {
  it("answers the model's rules, the style and the stuck items, for this account only", async () => {
    const res = await brief();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toEqual(expect.arrayContaining([...PREP_KIND_RULES]));
    expect(body.rules.join(' ')).toMatch(/dsul_save_prep/);
    expect(body.rules.join(' ')).toMatch(/dsul_ask_user/);
    expect(body.rules).not.toContain(PREP_QUESTION_RULE_LIST[0]);
    expect(body.style).toBe('Short. Starts with "Hi".');
    expect(body.stuck).toEqual([{ id: 'a', title: 'Call the GP' }]);
    for (const t of ['user_extensions', 'items', 'item_events']) {
      expect(filters[t]).toContainEqual(['eq:user_id', 'u1']);
    }
  });

  it("names only the caller's own queue, never another agent's items", async () => {
    expect((await (await brief()).json()).stuck).toEqual([{ id: 'a', title: 'Call the GP' }]);
    callerName = 'Claude';
    expect((await (await brief()).json()).stuck).toEqual([{ id: 'd', title: "Claude's errand" }]);
    callerName = '\u0000';
    expect((await (await brief()).json()).stuck).toEqual([]);
  });

  it('refuses without a key that resolves', async () => {
    expect((await brief('')).status).toBe(401);
    resolvedUser = null;
    expect((await brief()).status).toBe(401);
  });

  it('keeps the rest of the brief when one read fails', async () => {
    tables.item_events = { data: null, error: { code: '42P01' } };
    tables.user_extensions = { data: null, error: null };
    const body = await (await brief()).json();
    expect(body.stuck).toEqual([]);
    expect(body.style).toBe('');
    expect(body.rules.length).toBeGreaterThan(5);
  });
});

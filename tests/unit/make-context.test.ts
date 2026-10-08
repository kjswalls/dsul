// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMakeContext } from '@/lib/ai-server/make-context';
import { MAKE_KINDS } from '@/lib/ai-limits';

/**
 * The names "Write with AI" reads (lib/ai-server/make-context.ts). A mod
 * (build order 10) is never sent project names, and they are not even read:
 * projects are agent-writable, and nothing an agent writes reaches a prompt
 * that writes code. Every other kind still reads them.
 */

function fakeDb(rows: Record<string, unknown[]>) {
  const from: string[] = [];
  const db = {
    from(table: string) {
      from.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'in']) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(ok, bad);
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, from };
}

const ROWS = {
  projects: [{ name: 'Work' }],
  item_types: [{ name: 'chore', label: 'Chore' }],
  user_mods: [{ id: '1234abcd-0000-4000-8000-000000000001', kind: 'theme', name: 'Moss', mode: 'light' }],
};

describe('buildMakeContext', () => {
  it('for a mod, issues no projects query, and still reads types, themes and Looks', async () => {
    const { db, from } = fakeDb(ROWS);
    const ctx = await buildMakeContext(db, 'u1', 'mod');
    expect(from.sort()).toEqual(['item_types', 'user_mods']);
    expect(ctx.projects).toEqual([]);
    expect(ctx.types).toEqual([{ name: 'chore', label: 'Chore' }]);
    expect(ctx.themes).toEqual([{ ref: 'u-1234abcd', name: 'Moss', mode: 'light' }]);
  });

  it.each(MAKE_KINDS.filter((k) => k !== 'mod'))('for a %s, reads the projects too', async (kind) => {
    const { db, from } = fakeDb(ROWS);
    const ctx = await buildMakeContext(db, 'u1', kind);
    expect(from.sort()).toEqual(['item_types', 'projects', 'user_mods']);
    expect(ctx.projects).toEqual(['Work']);
  });
});

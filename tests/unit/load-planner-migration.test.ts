import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Migration 050's load_planner(), read as text.
 *
 * This cannot run the SQL, so it cannot catch a wrong column or a typo. What it
 * catches are the edits whose damage is silent:
 *
 * - A `begin atomic` body records a dependency on items_windowed, and
 *   rebuild_items_windowed() (031) drops that view WITHOUT cascade — every later
 *   migration that adds an items column would fail.
 * - `security definer` would turn the `user_id = auth.uid()` filters from a
 *   mirror of the fetchers into the only access control.
 * - A relation renamed under the function raises 42P01 at call time, which the
 *   client reads as "050 not applied" and silently latches onto the ten-request
 *   fallback. Pinning the exact relation list makes the rename that forgets to
 *   re-create this function fail here instead.
 * - The filters and orders mirror the per-table fetchers in lib/db.ts; a
 *   dropped `deleted_at is null` would bring trashed rows back to the grid.
 */
const FILE = readFileSync(
  resolve(__dirname, '../../supabase/migrations/050_load_planner.sql'),
  'utf8'
);

/** The function body only — the header and the comment discuss the very words
 *  the assertions refuse. */
const BODY = (() => {
  const start = FILE.indexOf('as $$');
  const end = FILE.indexOf('$$;', start);
  if (start < 0 || end < 0) throw new Error('050: no $$ string body found');
  return FILE.slice(start + 'as $$'.length, end)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .toLowerCase();
})();

/** Everything before the body: the signature and its attributes. */
const HEAD = FILE.slice(FILE.indexOf('create or replace function'), FILE.indexOf('as $$')).toLowerCase();

const ENTITY_TABLES = ['items_windowed', 'projects', 'routines', 'seasons', 'goals'];
const RELATIONS = [
  ...ENTITY_TABLES,
  'item_types',
  'routine_items',
  'season_items',
  'season_routines',
  'goal_items',
].sort();

describe('migration 050 load_planner()', () => {
  it('is a stable SECURITY INVOKER sql function with an empty search_path', () => {
    expect(HEAD).toContain('public.load_planner()');
    expect(HEAD).toContain('returns jsonb');
    expect(HEAD).toContain('language sql');
    expect(HEAD).toMatch(/\bstable\b/);
    expect(HEAD).toContain('security invoker');
    expect(FILE.toLowerCase()).not.toContain('security definer');
    expect(HEAD).toContain("set search_path = ''");
  });

  it('keeps a $$ string body, never BEGIN ATOMIC', () => {
    expect(BODY).not.toContain('begin atomic');
    expect(HEAD).not.toContain('begin atomic');
  });

  it('reads exactly the ten relations, through items_windowed and never the base items table', () => {
    const read = [...BODY.matchAll(/\bfrom public\.([a-z_]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(read)].sort()).toEqual(RELATIONS);
    expect(read).toHaveLength(RELATIONS.length);
    expect(BODY).not.toMatch(/from public\.items\s/);
  });

  it("filters every relation on (select auth.uid()), evaluated once", () => {
    // One per relation plus the bundle's `uid`.
    const uid = BODY.match(/\(select auth\.uid\(\)\)/g) ?? [];
    expect(uid).toHaveLength(RELATIONS.length + 1);
    expect(BODY.replace(/\(select auth\.uid\(\)\)/g, '')).not.toContain('auth.uid()');
  });

  it('drops soft-deleted rows from the five entity tables', () => {
    for (const table of ENTITY_TABLES) {
      const at = BODY.indexOf(`from public.${table} `);
      const where = BODY.slice(at, BODY.indexOf('limit 1000', at));
      expect(where, table).toContain('deleted_at is null');
    }
    expect(BODY.match(/deleted_at is null/g)).toHaveLength(ENTITY_TABLES.length);
  });

  it("orders sort_order and item order nulls last, as the fetchers' nullsFirst:false", () => {
    // items "order", routines, routine_items, seasons, goals, goal_items — each
    // in its inner ORDER BY and its jsonb_agg ORDER BY.
    expect(BODY.match(/"order" asc nulls last/g)).toHaveLength(2);
    expect(BODY.match(/sort_order asc nulls last/g)).toHaveLength(10);
    expect(BODY).not.toMatch(/sort_order asc(?! nulls last)/);
  });

  it('caps each of the ten collections at 1000, as PostgREST db-max-rows does', () => {
    expect(BODY.match(/limit 1000/g)).toHaveLength(RELATIONS.length);
  });

  it('stamps the shape version and the answering uid', () => {
    expect(BODY).toContain("'v', 1");
    expect(BODY).toContain("'uid', (select auth.uid())");
  });

  it('is callable by signed-in users only', () => {
    const lower = FILE.toLowerCase();
    expect(lower).toContain('revoke all on function public.load_planner() from public, anon;');
    expect(lower).toContain('grant execute on function public.load_planner() to authenticated;');
  });
});

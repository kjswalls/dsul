// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration 087 (where each container sits on Atlas), read as text. Each rule
 * here is one the design rests on: the account cascade, the three CHECKs (xy
 * both or neither), owner RLS, column grants that keep user_id out of a
 * client's hands, the cap and forget functions' SECURITY INVOKER and empty
 * search_path, the four forget triggers, and the far-zoom column added once.
 */

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/087_atlas_positions.sql'), 'utf8');

/** The SQL without its comments, lower-cased (migration-text.test.ts's `code()`). */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .toLowerCase();
}

const src = code(SQL);
const flat = src.replace(/\s+/g, ' ');

/** The text of one function, from its head to the end of its body. */
function fn(name: string): string {
  const at = src.indexOf(`create or replace function public.${name}`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  const rest = src.slice(at);
  const open = rest.indexOf('$$');
  const close = rest.indexOf('$$', open + 2);
  return rest.slice(0, close + 2).replace(/\s+/g, ' ');
}

/** The body of the CHECK added under one constraint name. */
function check(name: string): string {
  const at = flat.indexOf(`add constraint ${name}`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  return flat.slice(at, flat.indexOf('end if;', at));
}

describe('087_atlas_positions.sql', () => {
  it('creates the table, cascading from the account inline, keyed by (user, kind, container)', () => {
    expect(flat).toContain('create table if not exists public.atlas_positions');
    expect(flat).toMatch(/user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
    expect(flat).toContain('primary key (user_id, container_kind, container_id)');
    // No column that the account-deletion parser would read as an owner.
    expect(flat).not.toMatch(/\bowner\w*\s+uuid/);
  });

  it('holds the kind to the four containers and the band to the three columns', () => {
    expect(check('atlas_positions_kind_check')).toContain(
      "container_kind in ('project', 'routine', 'season', 'goal')"
    );
    expect(check('atlas_positions_band_check')).toContain("pinned_band is null or pinned_band in ('now', 'soon', 'resting')");
  });

  it('keeps x and y both or neither, finite and in range', () => {
    const xy = check('atlas_positions_xy_check');
    expect(xy).toContain('(x is null and y is null)');
    // The IS NOT NULLs are load-bearing: a CHECK passes on NULL.
    expect(xy).toContain('x is not null and y is not null');
    expect(xy).toContain('x between -1000000 and 1000000 and y between -1000000 and 1000000');
  });

  it('adds each constraint only when it is missing (re-runnable)', () => {
    for (const name of ['atlas_positions_kind_check', 'atlas_positions_band_check', 'atlas_positions_xy_check']) {
      expect(flat).toContain(`if not exists (select 1 from pg_constraint where conname = '${name}')`);
    }
  });

  it('turns on RLS with one own-rows policy', () => {
    expect(flat).toContain('alter table public.atlas_positions enable row level security');
    expect(flat).toContain('create policy atlas_positions_own on public.atlas_positions for all to authenticated');
    expect(flat).toContain('using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))');
  });

  it('revokes before it grants, and never grants a write of user_id', () => {
    const revoke = flat.indexOf('revoke all on table public.atlas_positions from public, anon, authenticated');
    expect(revoke).toBeGreaterThanOrEqual(0);
    const grants = [...flat.matchAll(/grant ([^;]*?) on (?:table )?public\.atlas_positions to authenticated/g)];
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.index!).toBeGreaterThan(revoke);
    const what = grants.map((g) => g[1]);
    expect(what).toContain('select, delete');
    expect(what).toContain('insert (container_kind, container_id, x, y, pinned_band)');
    expect(what).toContain('update (container_kind, container_id, x, y, pinned_band)');
    expect(what.some((g) => g.includes('user_id'))).toBe(false);
    expect(what.some((g) => /\ball\b/.test(g))).toBe(false);
  });

  it('caps an account at 2,000 rows, counting only a new key', () => {
    const cap = fn('atlas_positions_cap');
    expect(cap).toContain('security invoker');
    expect(cap).toContain("set search_path = ''");
    expect(cap).toContain('>= 2000');
    expect(cap).toContain("raise exception 'atlas_positions_limit'");
    expect(flat).toContain(
      'create trigger atlas_positions_cap before insert on public.atlas_positions for each row execute function public.atlas_positions_cap()'
    );
    expect(flat).toContain('revoke all on function public.atlas_positions_cap() from public, anon, authenticated');
  });

  it('forgets a container when its row is deleted, on all four tables, as the definer', () => {
    const forget = fn('atlas_positions_forget');
    // Delete account: GoTrue's cascade from auth.users fires these triggers as
    // supabase_auth_admin, which has no grant on atlas_positions. As the
    // invoker the delete fails and rolls the account deletion back.
    expect(forget).toContain('security definer');
    expect(forget).not.toContain('security invoker');
    expect(forget).toContain("set search_path = ''");
    expect(forget).toContain('container_kind = tg_argv[0]');
    expect(forget).toContain('container_id = old.id');
    expect(forget).toContain('user_id = old.user_id');
    for (const [table, kind] of [
      ['projects', 'project'],
      ['routines', 'routine'],
      ['seasons', 'season'],
      ['goals', 'goal'],
    ]) {
      expect(flat).toContain(`drop trigger if exists atlas_positions_forget on public.${table}`);
      expect(flat).toContain(
        `create trigger atlas_positions_forget after delete on public.${table} for each row execute function public.atlas_positions_forget('${kind}')`
      );
    }
    expect(flat).toContain('revoke all on function public.atlas_positions_forget() from public, anon, authenticated');
    // The trigger's filter is the primary key; a second index by container is never used.
    expect(flat).not.toMatch(/create index[^;]*atlas_positions/);
  });

  it('adds the far-zoom paper column once, nullable, with no CHECK', () => {
    expect(flat).toContain('alter table public.user_settings add column if not exists atlas_far_paper text;');
    expect(flat).not.toMatch(/atlas_far_paper text not null/);
  });

  it('touches no cron, no Realtime publication and no agent surface', () => {
    expect(flat).not.toContain('cron.');
    expect(flat).not.toContain('supabase_realtime');
  });
});

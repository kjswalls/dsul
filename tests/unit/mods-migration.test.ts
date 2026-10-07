import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MOD_KINDS,
  MOD_NAME_MAX,
  MOD_SLUG_RE,
  MOD_SOURCE_MAX_BYTES,
  MOD_STORE_MAX_BYTES,
} from '@/lib/mods/schema';

/**
 * Migration 061 (user_mods, mod_runs, mod_store_set), read as text, as
 * chat-migration.test.ts reads 057. It cannot run the SQL (CI's E2E job
 * replays it onto an empty database); it catches the silent edits: a guard
 * dropped, a privilege widened, an immutable column made updatable, a cap or
 * the slug rule drifting from lib/mods/schema.ts, the run FK losing its user.
 * migration-text.test.ts applies the repo-wide rules on top.
 */
const FILE = readFileSync(resolve(__dirname, '../../supabase/migrations/061_user_mods.sql'), 'utf8');

/** Without `--` comments, lower-cased: the header discusses words refused below. */
const SQL = FILE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();

/** Whitespace runs as one space. */
const FLAT = SQL.replace(/\s+/g, ' ');

function head(name: string): string {
  const start = FLAT.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`061: no function ${name}`);
  return FLAT.slice(start, FLAT.indexOf('as $$', start));
}

describe('migration 061 user_mods', () => {
  it('opens with its header', () => {
    expect(FILE.startsWith('-- 061_user_mods:')).toBe(true);
    const header = FILE.slice(0, FILE.indexOf('create table'));
    for (const section of ['WHAT IS STORED', 'NOT STORED', 'ACCESS', 'OWNER-ASSERTED', 'NOT EXPOSED', 'DSUL_TICK DEFERRED', 'DEPLOY ORDER', 'Idempotent']) {
      expect(header, section).toContain(section);
    }
  });

  it('guards every object, so a re-run and an empty-database replay both apply', () => {
    for (const m of FLAT.matchAll(/create (unique )?(table|index) (?!if not exists)/g)) {
      throw new Error(`unguarded: ${FLAT.slice(m.index, m.index + 80)}`);
    }
    expect(FLAT).not.toMatch(/create function /);
    expect(FLAT.match(/create or replace function /g)).toHaveLength(1);
    expect(FLAT).toContain('drop trigger if exists user_mods_updated_at on public.user_mods;');
    expect(FLAT).toContain('execute function public.update_updated_at()');
    for (const m of FLAT.matchAll(/add constraint (\w+)/g)) {
      expect(FLAT, m[1]).toContain(`where conname = '${m[1]}'`);
    }
  });

  it('turns RLS on for both tables, owner-only both ways', () => {
    for (const table of ['user_mods', 'mod_runs']) {
      expect(FLAT).toContain(`alter table public.${table} enable row level security;`);
      expect(FLAT).toContain(
        `create policy ${table}_own on public.${table} for all to authenticated ` +
          'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));'
      );
    }
  });

  it('mod_store_set is SECURITY INVOKER with an empty path, owner-checked, capped', () => {
    const h = head('mod_store_set');
    expect(h).toContain('p_mod_id uuid, p_key text, p_value jsonb');
    expect(h).toContain('security invoker');
    expect(h).toContain("set search_path = ''");
    expect(FLAT).not.toContain('security definer');
    expect(FLAT).toContain('where m.id = p_mod_id and m.user_id = v_uid for update;');
    expect(FLAT).toContain(`if octet_length(v_store::text) > ${MOD_STORE_MAX_BYTES} then`);
    expect(FLAT).toContain('revoke all on function public.mod_store_set(uuid, text, jsonb) from public, anon;');
  });

  it('pins the slug rule, kinds and caps to lib/mods/schema.ts', () => {
    expect(FLAT).toContain(`slug ~ '${MOD_SLUG_RE.source}'`);
    expect(FLAT).toContain(`check (kind in (${MOD_KINDS.map((k) => `'${k}'`).join(', ')}))`);
    expect(FLAT).toContain(`check (char_length(name) between 1 and ${MOD_NAME_MAX})`);
    expect(FLAT).toContain(`check (octet_length(source) <= ${MOD_SOURCE_MAX_BYTES})`);
    expect(FLAT).toContain(`check (octet_length(store::text) <= ${MOD_STORE_MAX_BYTES})`);
  });

  it('holds a run to a mod of the same user (composite FK)', () => {
    expect(FLAT).toContain(
      'add constraint mod_runs_mod_fkey foreign key (mod_id, user_id) references public.user_mods (id, user_id) on delete cascade;'
    );
    expect(FLAT).toContain('add constraint user_mods_id_user_id_key unique (id, user_id);');
    // No single-column FK on mod_id sneaking back in.
    expect(FLAT).not.toMatch(/mod_id uuid not null references/);
  });

  it('grants nothing to anon or public, no TRUNCATE, and never updates an identity column', () => {
    for (const m of FLAT.matchAll(/grant [^;]*? to ([^;]*);/g)) {
      expect(m[1], m[0]).not.toMatch(/\b(anon|public)\b/);
    }
    expect(FLAT).not.toMatch(/grant [^;]*truncate/);
    const update = FLAT.match(/grant update \(([^)]*)\) on public\.user_mods to authenticated;/);
    expect(update).not.toBeNull();
    const cols = update![1].split(',').map((c) => c.trim());
    expect(cols).toContain('store');
    for (const fixed of ['id', 'user_id', 'kind', 'slug', 'created_at', 'updated_at']) {
      expect(cols, fixed).not.toContain(fixed);
    }
    expect(FLAT).not.toMatch(/grant update[^;]*on public\.mod_runs/);
    // A deleted claim would let the same (mod_id, claim_key) run twice.
    expect(FLAT).toContain('grant select on table public.mod_runs to authenticated;');
    expect(FLAT).not.toMatch(/grant [^;]*delete[^;]*on table public\.mod_runs/);
  });

  it('pins mod_store_set\'s argument names, which PostgREST callers send', () => {
    expect(FLAT).toContain('function public.mod_store_set(p_mod_id uuid, p_key text, p_value jsonb)');
  });

  it('leaves dsul_tick and cron alone (build order 6), and reloads PostgREST', () => {
    expect(SQL).not.toContain('dsul_tick');
    expect(SQL).not.toMatch(/\bcron\./);
    expect(FLAT).toContain("notify pgrst, 'reload schema';");
  });
});

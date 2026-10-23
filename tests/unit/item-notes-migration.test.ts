// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration 082 (notes on an item's timeline), read as text. Each rule here is
 * one the design rests on: the cascades (item and account), one pinned note
 * per item held by the database, owner RLS that checks the item, the column
 * grants that keep user_id, created_at, edited_at and updated_at out of a
 * client's hands, and the pin RPC as the only way to pin.
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const SQL = readFileSync(join(DIR, '082_item_notes.sql'), 'utf8');

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

describe('082_item_notes.sql', () => {
  it('creates the table, cascading from the account and from the item', () => {
    expect(flat).toContain('create table if not exists public.item_notes');
    expect(flat).toMatch(/user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
    expect(flat).toMatch(/item_id uuid not null references public\.items \(id\) on delete cascade/);
  });

  it('holds the body to 1 to 10,000 characters with something in it, and never btrim', () => {
    const check = flat.slice(flat.indexOf('item_notes_body_check'));
    expect(check).toMatch(/char_length\(body\) between 1 and 10000 and body ~ '\\s'/);
    expect(flat).not.toContain('btrim');
  });

  it('holds one pinned note per item with a partial unique index', () => {
    expect(flat).toMatch(
      /create unique index if not exists item_notes_one_pinned on public\.item_notes \(item_id\) where pinned_at is not null/
    );
  });

  it('turns on RLS, with a policy that checks the item is yours', () => {
    expect(flat).toContain('alter table public.item_notes enable row level security');
    expect(flat).toContain('exists (select 1 from public.items');
    expect(flat).toMatch(/using \(user_id = \(select auth\.uid\(\)\)\)/);
  });

  it('grants insert of (id, item_id, body) and update of (body, pinned_at) only', () => {
    expect(flat).toContain('grant insert (id, item_id, body) on public.item_notes to authenticated');
    expect(flat).toContain('grant update (body, pinned_at) on public.item_notes to authenticated');
    const grants = [...flat.matchAll(/grant ([^;]*?) on (?:table )?public\.item_notes to authenticated/g)].map(
      (m) => m[1]
    );
    expect(grants.filter((g) => /\binsert\b/.test(g))).toEqual(['insert (id, item_id, body)']);
    expect(grants.filter((g) => /\bupdate\b/.test(g))).toEqual(['update (body, pinned_at)']);
    expect(grants.some((g) => /\ball\b/.test(g))).toBe(false);
  });

  it('pins only through item_note_pin: SECURITY INVOKER, an empty path, a local dsul.pin, granted to authenticated', () => {
    const pin = fn('item_note_pin');
    expect(pin).toContain('security invoker');
    expect(pin).toContain("set search_path = ''");
    expect(pin).toMatch(/set_config\('dsul\.pin', 'on', true\)/);
    expect(flat).toContain('revoke all on function public.item_note_pin(uuid) from public, anon');
    expect(flat).toContain('grant execute on function public.item_note_pin(uuid) to authenticated');
  });

  it('refuses a pin the RPC did not flag, in the touch trigger', () => {
    const touch = fn('item_notes_touch');
    expect(touch).toContain('new.pinned_at is not null and old.pinned_at is null');
    expect(touch).toContain("current_setting('dsul.pin', true)");
  });

  it('checks the item is the caller’s before the caps trigger counts anything', () => {
    const caps = fn('item_notes_caps');
    const owner = caps.indexOf('i.user_id = new.user_id');
    const counted = caps.indexOf('count(*)');
    expect(owner).toBeGreaterThan(0);
    expect(counted).toBeGreaterThan(owner);
    expect(caps).toContain('security definer');
  });

  it('is re-runnable: every constraint behind a guard, every trigger dropped first', () => {
    const adds = [...src.matchAll(/add constraint/g)].map((m) => m.index!);
    for (const at of adds) {
      const before = src.slice(0, at);
      expect(before.lastIndexOf('do $$')).toBeGreaterThan(before.lastIndexOf('end$$'));
    }
    for (const t of ['item_notes_touch', 'item_notes_caps']) {
      const drop = flat.indexOf(`drop trigger if exists ${t} on public.item_notes`);
      const create = flat.indexOf(`create trigger ${t}`);
      expect(drop, t).toBeGreaterThanOrEqual(0);
      expect(create, t).toBeGreaterThan(drop);
    }
  });

  it('is in no purge: neither the 180-day trace purge nor the trash purge names item_notes', () => {
    const purges = readdirSync(DIR)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .map((name) => code(readFileSync(join(DIR, name), 'utf8')))
      .filter((sql) => /delete\s+from\s+(public\.)?item_events/.test(sql) || /purge/.test(sql));
    expect(purges.length).toBeGreaterThan(0);
    for (const sql of purges) expect(sql).not.toContain('item_notes');
  });
});

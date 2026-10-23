import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration 081: who added a file. Idempotent, and a browser can never claim
 * to be an agent: a trigger keeps added_by NULL (or as it was) for every role
 * but service_role, which a later table-wide grant cannot undo, and no
 * migration grants authenticated a table-wide insert or update on item_files.
 */

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/081_item_files_added_by.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');

describe('migration 081', () => {
  it('adds the column and its length check idempotently', () => {
    expect(code).toMatch(/alter table public\.item_files add column if not exists added_by text;/);
    expect(code).toMatch(
      /do \$\$[\s\S]*if not exists \(select 1 from pg_constraint where conname = 'item_files_added_by_len'\)[\s\S]*end\$\$;/
    );
    expect(code).toMatch(/check \(added_by is null or char_length\(added_by\) between 1 and 200\)/);
  });

  it('forces added_by for every role but service_role, on insert and on update', () => {
    expect(code).toMatch(/create or replace function public\.item_files_added_by\(\)/);
    expect(code).not.toMatch(/security definer/);
    expect(code).toMatch(/if current_user = 'service_role' then\s+return new;/);
    expect(code).toMatch(/new\.added_by := null;/);
    expect(code).toMatch(/new\.added_by := old\.added_by;/);
    expect(code).toMatch(/drop trigger if exists item_files_added_by on public\.item_files;/);
    expect(code).toMatch(/before insert or update on public\.item_files/);
  });

  it('grants nothing on added_by to authenticated', () => {
    expect(code).not.toMatch(/grant[^;]*added_by[^;]*to authenticated/i);
    expect(code).not.toMatch(/grant[^;]*to authenticated/i);
  });

  it('no migration gives authenticated a table-wide insert or update on item_files', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const all = readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, ''))
      .join('\n');
    for (const m of all.matchAll(/grant\s+([^;]*?)\s+on\s+(?:table\s+)?public\.item_files\s+to\s+([^;]*);/gi)) {
      if (!/authenticated/i.test(m[2])) continue;
      expect(m[1], m[0]).not.toMatch(/\b(all|insert|update)\b(?!\s*\()/i);
    }
  });
});

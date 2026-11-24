// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration 090 (the invite-only sign-up gate), read as text. The rules it rests
 * on: only invited rows let a sign-up through, only GoTrue's own role may call
 * the hook (a browser could otherwise probe the list one address at a time), the
 * list stays service-role only, and nothing in it switches the gate on: that is
 * a dashboard setting, so the migration alone changes no sign-up.
 */

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/090_beta_gate.sql'), 'utf8');

/** The SQL without its comments, lower-cased (migration-text.test.ts's `code()`). */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .toLowerCase();
}

const flat = code(SQL).replace(/\s+/g, ' ');

describe('090 beta gate', () => {
  it('lets a sign-up through only for an invited row on the list', () => {
    expect(flat).toContain('from public.waitlist_signups w where w.email = addr and w.invited_at is not null');
    expect(flat).toContain("lower(btrim(coalesce(event -> 'user' ->> 'email', '')))");
  });

  it('is a definer with an empty path, callable only by supabase_auth_admin', () => {
    expect(flat).toMatch(/function public\.hook_beta_gate\(event jsonb\) returns jsonb .*security definer set search_path = ''/);
    expect(flat).toContain('revoke all on function public.hook_beta_gate(jsonb) from public, anon, authenticated;');
    expect(flat).toContain('grant execute on function public.hook_beta_gate(jsonb) to supabase_auth_admin;');
    expect(flat).not.toMatch(/grant [^;]* on function public\.hook_beta_gate\(jsonb\) to [^;]*(anon|authenticated)/);
  });

  it('never opens the list to a browser', () => {
    expect(flat).not.toMatch(/grant [^;]* on (table )?public\.waitlist_signups/);
    expect(flat).not.toContain('create policy');
  });

  it('does not switch itself on', () => {
    expect(flat).not.toContain('auth.config');
    expect(flat).not.toContain('hook_before_user_created');
  });

  it('keeps the form route\'s sources and adds the hand-written invite', () => {
    expect(flat).toContain("check (source in ('hero', 'closer', 'invite'))");
  });
});

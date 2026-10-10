import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_LIMITS } from '@/lib/conversation-types';

/**
 * Migration 068 (a reply's action lines), read as text. The replay against a
 * real Postgres is in the PR description; this catches the silent drifts:
 * a cap that no longer matches what the app cleans to, a privilege wider than
 * the one column chat_append now writes, and the function turned into a
 * SECURITY DEFINER or losing its empty search_path.
 */
const FILE = readFileSync(resolve(__dirname, '../../supabase/migrations/068_chat_actions.sql'), 'utf8');
const SQL = FILE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
const FLAT = SQL.replace(/\s+/g, ' ');

describe('068_chat_actions', () => {
  it('grants authenticated INSERT on meta and nothing else', () => {
    const grants = FLAT.match(/grant [^;]+;/g) ?? [];
    expect(grants).toEqual(['grant insert (meta) on public.chat_messages to authenticated;']);
    expect(FLAT).not.toMatch(/\brevoke\b/);
  });

  it('replaces chat_append with the same signature, invoker, empty search_path', () => {
    expect(FLAT).toContain('create or replace function public.chat_append( p_conversation uuid, p_create jsonb, p_messages jsonb ) returns jsonb');
    expect(FLAT).toContain('security invoker');
    expect(FLAT).not.toContain('security definer');
    expect(FLAT).toContain("set search_path = ''");
  });

  it('caps the lines exactly as the app cleans them', () => {
    expect(FLAT).toContain(`where a.n <= ${CHAT_LIMITS.actions}`);
    expect(FLAT).toContain(`'g')), ${CHAT_LIMITS.actionChars})`);
    expect(FLAT).toContain("v_role = 'assistant' and jsonb_typeof(v_msg->'actions') = 'array'");
  });

  it('writes meta only as {actions}, and {} otherwise', () => {
    expect(FLAT).toContain("then jsonb_build_object('actions', v_actions) else '{}'::jsonb end");
  });
});

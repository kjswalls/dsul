import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_LIMITS, cleanImageCount } from '@/lib/conversation-types';
import { MAX_CHAT_IMAGES } from '@/lib/chat-images';

/**
 * Migration 070 (a question's picture count), read as text, as 068's test
 * does: the cap matches what the app cleans to, the grants are 068's and
 * untouched, the function stays SECURITY INVOKER with an empty search_path,
 * and a reply's meta is still 068's {actions}.
 */
const FILE = readFileSync(resolve(__dirname, '../../supabase/migrations/070_chat_images.sql'), 'utf8');
const SQL = FILE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
const FLAT = SQL.replace(/\s+/g, ' ');

describe('070_chat_images', () => {
  it('keeps one cap: the box, the app and the database agree', () => {
    expect(CHAT_LIMITS.images).toBe(MAX_CHAT_IMAGES);
    expect(FLAT).toContain(`v_images := least((v_msg->>'imageCount')::numeric, ${CHAT_LIMITS.images})::integer;`.toLowerCase());
    expect(FLAT).toContain(`v_role = 'user' and jsonb_typeof(v_msg->'imagecount') = 'number'`);
  });

  it('grants and revokes nothing (068’s meta grant is what it writes through)', () => {
    expect(FLAT).not.toMatch(/\bgrant\b/);
    expect(FLAT).not.toMatch(/\brevoke\b/);
  });

  it('replaces chat_append with the same signature, invoker, empty search_path', () => {
    expect(FLAT).toContain('create or replace function public.chat_append( p_conversation uuid, p_create jsonb, p_messages jsonb ) returns jsonb');
    expect(FLAT).toContain('security invoker');
    expect(FLAT).not.toContain('security definer');
    expect(FLAT).toContain("set search_path = ''");
  });

  it('writes meta as {actions} on a reply, {images} on a question, and {} otherwise', () => {
    expect(FLAT).toContain(
      "then jsonb_build_object('actions', v_actions) when v_images > 0 then jsonb_build_object('images', v_images) else '{}'::jsonb end"
    );
    // 068's rule for the lines is carried over unchanged.
    expect(FLAT).toContain(`where a.n <= ${CHAT_LIMITS.actions}`);
  });

  it('cleans in the app as the SQL does', () => {
    expect([1, 2, 3, 4, 0, -1, 1.5, '2', null].map(cleanImageCount)).toEqual([1, 2, 3, 3, 0, 0, 0, 0, 0]);
  });
});

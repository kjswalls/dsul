/**
 * Named agent keys (migration 072, ai-vision-decisions.md decision 1): as many
 * as you like, each read-only or read-and-change, shown once and stored as a
 * sha256 hash, revocable from Settings → AI → Agent keys.
 *
 * They sit BESIDE the OpenClaw key, never instead of it: that one is still the
 * only credential that registers a gateway or a webhook, and the plugin throws
 * on drift. These open what an OAuth app's token opens, at the same two scopes
 * (lib/mcp-oauth/scopes.ts), through resolveUserIdFromApiKey.
 *
 * Every function takes the service client: the table is service-role only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { hashSecret, mint } from './mcp-oauth/core';
import { AGENT_KEY_PREFIX, isScope, type Scope } from './mcp-oauth/scopes';

type Db = SupabaseClient;

/** What Settings shows of a key. Never the key, never its hash. */
export interface AgentKey {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Enough for anyone; a cap so a loop in a script cannot fill the table. */
export const MAX_AGENT_KEYS = 20;
export const AGENT_KEY_NAME_MAX = 60;

/** A name as stored: trimmed, inner runs of space collapsed, 1 to 60 characters, or null. */
export function cleanKeyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= AGENT_KEY_NAME_MAX ? name : null;
}

/** The shape a key has, checked before any hashing or database read. */
export function isAgentKeyShape(token: string): boolean {
  return /^dsul_ak_[A-Za-z0-9_-]{43}$/.test(token);
}

/** Live keys, newest first. Null when the table is missing (072 not applied) or the read failed. */
export async function listAgentKeys(db: Db, userId: string): Promise<AgentKey[] | null> {
  const { data, error } = await db
    .from('agent_keys')
    .select('id, name, scope, created_at, last_used_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) return null;
  return (data ?? []).flatMap((row) =>
    isScope(row.scope)
      ? [
          {
            id: row.id as string,
            name: row.name as string,
            scope: row.scope,
            createdAt: row.created_at as string,
            lastUsedAt: (row.last_used_at as string | null) ?? null,
          },
        ]
      : []
  );
}

export type CreateResult =
  | { ok: true; key: string; agentKey: AgentKey }
  | { ok: false; error: 'limit' | 'unavailable' };

/**
 * Make a key. The plaintext is returned here and nowhere else, ever: what is
 * stored is its hash.
 */
export async function createAgentKey(db: Db, userId: string, name: string, scope: Scope): Promise<CreateResult> {
  const live = await db
    .from('agent_keys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (live.error) return { ok: false, error: 'unavailable' };
  if ((live.count ?? 0) >= MAX_AGENT_KEYS) return { ok: false, error: 'limit' };

  const key = mint(AGENT_KEY_PREFIX);
  const { data, error } = await db
    .from('agent_keys')
    .insert({ user_id: userId, name, scope, key_hash: await hashSecret(key) })
    .select('id, name, scope, created_at')
    .single();
  if (error || !data || !isScope(data.scope)) return { ok: false, error: 'unavailable' };
  return {
    ok: true,
    key,
    agentKey: {
      id: data.id as string,
      name: data.name as string,
      scope: data.scope,
      createdAt: data.created_at as string,
      lastUsedAt: null,
    },
  };
}

/** Settings' Revoke. Only the owner's own key: the user id is in the filter. True when a live key stopped. */
export async function revokeAgentKey(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  const { data, error } = await db
    .from('agent_keys')
    .update({ revoked_at: now.toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
  return !error && (data?.length ?? 0) > 0;
}

/** Who a key belongs to and what it may do, or null for a malformed, unknown or revoked one. */
export async function resolveAgentKey(
  db: Db,
  token: string,
  now = new Date()
): Promise<{ userId: string; scope: Scope; keyId: string } | null> {
  if (!isAgentKeyShape(token)) return null;
  const { data, error } = await db
    .from('agent_keys')
    .select('id, user_id, scope, revoked_at, last_used_at')
    .eq('key_hash', await hashSecret(token))
    .maybeSingle();
  if (error || !data || data.revoked_at || !isScope(data.scope)) return null;

  // "Last used" for Settings, written at most every ten minutes, never awaited.
  const last = data.last_used_at ? new Date(data.last_used_at as string).getTime() : 0;
  if (now.getTime() - last > 10 * 60 * 1000) {
    void db
      .from('agent_keys')
      .update({ last_used_at: now.toISOString() })
      .eq('id', data.id)
      .then(
        () => {},
        () => {}
      );
  }
  return { userId: data.user_id as string, scope: data.scope, keyId: data.id as string };
}

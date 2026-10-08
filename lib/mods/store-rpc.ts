'use client';

import { createClient } from '@/lib/supabase';

/**
 * One `$.store` key to user_mods.store, through 061's mod_store_set (memory/
 * plans/mods.md, "Data model"): one key at a time, so two devices never
 * overwrite each other's keys. PostgREST matches arguments by name, so these
 * are the function's own. A null value deletes the key.
 *
 * Called only by the runtime manager's flush, never inside a hook.
 */
export type StoreSetResult = 'ok' | 'gone' | 'too_big' | 'error';

export async function modStoreSet(modId: string, key: string, value: unknown): Promise<StoreSetResult> {
  try {
    const { data, error } = await createClient().rpc('mod_store_set', {
      p_mod_id: modId,
      p_key: key,
      p_value: value === undefined ? null : value,
    });
    if (error) {
      console.warn('[mods] store write failed:', error);
      return 'error';
    }
    const status = (data as { status?: unknown } | null)?.status;
    return status === 'ok' || status === 'gone' || status === 'too_big' ? status : 'error';
  } catch (error) {
    console.warn('[mods] store write failed:', error);
    return 'error';
  }
}

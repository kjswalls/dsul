'use client';

import { createClient } from '@/lib/supabase';
import { MOD_RUN_SUMMARY_MAX_BYTES } from '@/lib/recipes/limits';
import { FAULT_CODES, type FaultCode } from './protocol';

/**
 * A mod's faults, as mod_runs rows (memory/plans/mods.md, build order 8):
 * `claim_key = 'fault:<uuid>'` and `summary.kind = 'fault'`. 061 already
 * grants the owner INSERT, so this needs no migration, and the run log
 * (lib/recipes/runs.ts fetchRecentRuns) leaves these rows out.
 *
 * Problems (components/settings/mod-problems.tsx) reads them back. The
 * message is the mod's own text, so it is shown only under a host label.
 */

export interface FaultSummary {
  kind: 'fault';
  /** The hook's label, `load`, or `store` for a flush. */
  hook: string;
  code: FaultCode;
  message: string;
  /** The user's own day. */
  day: string;
  /** Logged but not counted toward switching the mod off. */
  counted?: false;
}

export interface FaultRow {
  summary: FaultSummary;
  at: string;
}

const missingTable = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205';

const encoder = new TextEncoder();

/** Clipped until it fits 061's 4096-byte summary CHECK. */
function clipped(summary: FaultSummary): FaultSummary {
  let s = { ...summary, hook: summary.hook.slice(0, 120) };
  while (encoder.encode(JSON.stringify(s)).length > MOD_RUN_SUMMARY_MAX_BYTES - 64 && s.message.length > 0) {
    s = { ...s, message: s.message.slice(0, Math.floor(s.message.length / 2)) };
  }
  return s;
}

/** Fire and forget; a lost fault row never changes what the runtime does. */
export async function logFault(userId: string, modId: string, summary: FaultSummary): Promise<void> {
  try {
    const { error } = await createClient()
      .from('mod_runs')
      .insert({ user_id: userId, mod_id: modId, claim_key: `fault:${crypto.randomUUID()}`, summary: clipped(summary) });
    if (error && !missingTable(error)) console.warn('[mods] fault log failed:', error);
  } catch (error) {
    console.warn('[mods] fault log failed:', error);
  }
}

function isFaultSummary(v: unknown): v is FaultSummary {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<FaultSummary>;
  return (
    s.kind === 'fault' &&
    typeof s.hook === 'string' &&
    typeof s.message === 'string' &&
    (FAULT_CODES as readonly unknown[]).includes(s.code)
  );
}

/** The latest faults for one mod, newest first. Rows the owner wrote in some other shape are left out. */
export async function fetchRecentFaults(modId: string, limit = 10): Promise<FaultRow[]> {
  const { data, error } = await createClient()
    .from('mod_runs')
    .select('summary,at')
    .eq('mod_id', modId)
    .like('claim_key', 'fault:%')
    .order('at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as { summary: unknown; at: string }[])
    .filter((r) => isFaultSummary(r.summary))
    .map((r) => ({ summary: r.summary as FaultSummary, at: r.at }));
}

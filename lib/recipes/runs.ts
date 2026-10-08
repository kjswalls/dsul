'use client';

import { createClient } from '@/lib/supabase';
import type { UndoOp } from './undo';

/**
 * A recipe's run log and claims, in mod_runs (migration 061), through the
 * SESSION client and RLS. 061 grants the owner SELECT and INSERT only: no
 * UPDATE (a claim's summary can never be filled in later) and no DELETE (a
 * deleted claim could run twice). So a clock run writes two rows, the claim
 * `<key>` before it acts and its result `<key>:done` after. A run started by an
 * event or ⌘K needs no claim and writes one result row, `run:<uuid>`.
 *
 * The run log shows only result rows (`summary.kind === 'run'`).
 */

/** Short codes only, never a title: the log is about what ran, not what it touched. */
export interface RunSummary {
  kind: 'run';
  trigger: string;
  /** Writes that happened. */
  did: number;
  /** Writes planned. */
  of: number;
  /** Writes whose verb was no longer eligible. */
  skipped: number;
  /** Writes refused (stake lock, missing item, unknown project, a type that cannot be added). */
  refused: number;
  /** Writes past the cap, or (a server run) past the tick's deadline. */
  stopped: number;
  /** One code per write step: done, skip:ineligible, refuse:<why>, stop:cap, stop:deadline. */
  steps: string[];
  /** The user's own day the run counted against (the server's daily rate limit reads it). */
  day?: string;
  /** Run by the server runner (lib/recipes/server/), not in a browser. */
  server?: true;
  /** Screen steps the server could not run (dsul was closed). */
  ui?: number;
  /** The inverse writes for Revert, newest first (./undo.ts). Server runs only. */
  undo?: UndoOp[];
  /** False when the inverse writes did not fit the summary, so the run cannot be reverted. */
  revertable?: boolean;
}

/** The row a Revert writes (`revert:<run key>:done`): what it put back. */
export interface RevertSummary {
  kind: 'revert';
  of: string;
  did: number;
  skipped: number;
  /** Set when the claim was spent and nothing was put back (the planner went away under it). */
  failed?: string;
}

export interface RunRow {
  claimKey: string;
  summary: RunSummary;
  at: string;
  /** A Revert of this run put things back (its `revert:<claimKey>:done` row says so). */
  reverted?: boolean;
  /** A Revert was claimed and its result row says it put nothing back. */
  revertFailed?: boolean;
  /** A Revert was claimed (`revert:<claimKey>`), whatever came of it: no second one. */
  revertClaimed?: boolean;
}

const missingTable = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205';

/**
 * Claims `key` for this recipe. `won` only when THIS call inserted the row.
 * ON CONFLICT DO NOTHING needs only the INSERT grant, and a lost race returns
 * no row (`lost`). A missing table (061 not applied) is `lost` too: it will not
 * appear by the next minute. Any other failure is `error`, so the caller can
 * try again later; either way a claim that cannot be proved runs nothing.
 */
export type ClaimResult = 'won' | 'lost' | 'error';

export async function claimRun(userId: string, modId: string, key: string): Promise<ClaimResult> {
  try {
    const { data, error } = await createClient()
      .from('mod_runs')
      .upsert(
        { user_id: userId, mod_id: modId, claim_key: key, summary: { kind: 'claim' } },
        { onConflict: 'mod_id,claim_key', ignoreDuplicates: true }
      )
      .select('id');
    if (error) {
      if (missingTable(error)) return 'lost';
      console.warn('[recipes] claim failed:', error);
      return 'error';
    }
    return Array.isArray(data) && data.length === 1 ? 'won' : 'lost';
  } catch (error) {
    console.warn('[recipes] claim failed:', error);
    return 'error';
  }
}

/** One result row. Fire and forget; a lost log line never undoes a run. */
export async function logRun(
  userId: string,
  modId: string,
  key: string,
  summary: RunSummary | RevertSummary
): Promise<void> {
  try {
    const { error } = await createClient()
      .from('mod_runs')
      .insert({ user_id: userId, mod_id: modId, claim_key: key, summary });
    if (error && !missingTable(error)) console.warn('[recipes] run log failed:', error);
  } catch (error) {
    console.warn('[recipes] run log failed:', error);
  }
}

function isRunSummary(v: unknown): v is RunSummary {
  return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'run';
}

/** A Revert's claim: `revert:<run key>`, its result `revert:<run key>:done`. */
export const revertClaimKey = (runKey: string) => `revert:${runKey}`;

/**
 * The latest result rows for one recipe, newest first, each marked with what
 * came of a Revert of it: claimed, and then put back or failed, by the
 * Revert's own result row, never the bare claim. 061 grants no UPDATE, so a
 * revert is a row of its own, never a change to the run's.
 */
export async function fetchRecentRuns(modId: string, limit = 10): Promise<RunRow[]> {
  const client = createClient();
  const [runs, reverts] = await Promise.all([
    client
      .from('mod_runs')
      .select('claim_key,summary,at')
      .eq('mod_id', modId)
      .order('at', { ascending: false })
      // Claims ride along with clock and server runs, so read twice the rows to show `limit`.
      .limit(limit * 2),
    client
      .from('mod_runs')
      .select('claim_key,summary')
      .eq('mod_id', modId)
      .like('claim_key', 'revert:%')
      .order('at', { ascending: false })
      .limit(100),
  ]);
  if (runs.error) throw runs.error;
  // A failed read of the reverts shows no Revert as done; the claim still
  // stops a second one.
  const revertRows = new Map(
    ((reverts.error ? [] : reverts.data) ?? []).map((r) => {
      const row = r as { claim_key: string; summary: unknown };
      return [row.claim_key, row.summary] as const;
    })
  );
  const revertOf = (runKey: string): Partial<RunRow> => {
    const key = revertClaimKey(runKey);
    if (!revertRows.has(key)) return {};
    const done = revertRows.get(`${key}:done`) as Partial<RevertSummary> | undefined;
    if (!done || done.kind !== 'revert') return { revertClaimed: true };
    return done.failed ? { revertClaimed: true, revertFailed: true } : { revertClaimed: true, reverted: true };
  };
  const rows = (runs.data ?? []) as { claim_key: string; summary: unknown; at: string }[];
  return rows
    .filter((r) => isRunSummary(r.summary))
    .slice(0, limit)
    .map((r) => ({
      claimKey: r.claim_key,
      summary: r.summary as RunSummary,
      at: r.at,
      ...revertOf(r.claim_key),
    }));
}

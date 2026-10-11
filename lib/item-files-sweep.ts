/**
 * The server's only part in files on an item (migration 073): removing bytes
 * whose row is gone. Postgres may not delete Storage objects itself, so every
 * deleted `item_files` row (the panel's Delete, an item purged from the trash,
 * an account deleted) queues its path in `storage_sweep` from a trigger, and
 * this empties the queue through the Storage API. It also sweeps rows that
 * never became ready (an upload abandoned mid-way) once they are a day old.
 *
 * A tier of the reminders cron (app/api/cron/reminders/route.ts), in its own
 * try: it never decides that route's status. Service role, never a session.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const SWEEP_BATCH = 100;
const STALE_MS = 24 * 60 * 60 * 1000;

export interface SweepSummary {
  removed: number;
  stale: number;
  notes: string[];
}

const isMissingTable = (error: { code?: string } | null): boolean =>
  error?.code === '42P01' || error?.code === 'PGRST205';

export async function sweepItemFiles(db: SupabaseClient, now = new Date()): Promise<SweepSummary> {
  const notes: string[] = [];

  // Rows abandoned mid-upload: deleting them queues their paths below.
  let stale = 0;
  const old = await db
    .from('item_files')
    .delete()
    .eq('ready', false)
    .lt('created_at', new Date(now.getTime() - STALE_MS).toISOString())
    .select('id');
  if (old.error) {
    if (isMissingTable(old.error)) return { removed: 0, stale: 0, notes };
    notes.push('stale rows unreadable');
  } else {
    stale = old.data?.length ?? 0;
  }

  const queue = await db
    .from('storage_sweep')
    .select('bucket, path')
    .order('queued_at', { ascending: true })
    .limit(SWEEP_BATCH);
  if (queue.error) {
    if (!isMissingTable(queue.error)) notes.push('queue unreadable');
    return { removed: 0, stale, notes };
  }
  const rows = (queue.data ?? []) as { bucket: string; path: string }[];
  if (rows.length === 0) return { removed: 0, stale, notes };

  let removed = 0;
  const byBucket = new Map<string, string[]>();
  for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path]);
  for (const [bucket, paths] of byBucket) {
    // Removing a path that is already gone is not an error, so a retry after
    // a lost answer is harmless.
    const { error } = await db.storage.from(bucket).remove(paths);
    if (error) {
      notes.push(`remove failed in ${bucket}`);
      continue;
    }
    const done = await db.from('storage_sweep').delete().eq('bucket', bucket).in('path', paths);
    if (done.error) notes.push(`queue not cleared in ${bucket}`);
    else removed += paths.length;
  }
  return { removed, stale, notes };
}

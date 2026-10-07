'use client';

import { batchHistory, mergeServerItems, usePlannerStore } from '@/lib/planner-store';
import { fetchItemById } from '@/lib/db';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { withSuppressed } from '@/lib/mod-events';
import { isDoneOn, isHabit, isSkippedOn } from '@/lib/item-verbs';
import { isRecurring, toDateStr } from '@/lib/recurrence';
import { claimRun, logRun, revertClaimKey, type RunRow } from './runs';
import { UndoOpsSchema, type UndoOp } from './undo';
import type { Item } from '@/lib/planner-types';

/**
 * Revert a server run (memory/plans/mods.md, "On the server": there is no undo
 * there, so the run log offers Revert). The run's inverse writes
 * (summary.undo, ./undo.ts) are applied through the planner store, the same
 * path a ⌘Z or a click takes, as ONE quiet history entry, so the Revert itself
 * is one ⌘Z away from being taken back, and inside withSuppressed, so it
 * starts no recipe.
 *
 * The planner holds no news of a server run (nothing refetches it for the
 * session), so a tab open across an 08:00 run lacks what it added and did.
 * The run's items are read back first and folded into the store
 * (mergeServerItems), and only then is it asked what still applies. Nothing
 * left to put back claims nothing.
 *
 * Claimed last (`revert:<run key>`, 061 grants no UPDATE, so a revert is a
 * row of its own), as the one await before the synchronous batch: two tabs
 * or two clicks revert once. Each op asks the store again as it writes, so
 * something already put back by hand is left alone. The result row
 * (`revert:<run key>:done`) says what it put back, or, when the planner went
 * away under the claim, that it put back nothing and why, so the log is
 * never a "Reverted" that did nothing.
 */

export type RevertResult =
  /** Put back. */
  | 'done'
  /** Another tab or device claimed this Revert first. */
  | 'taken'
  /** The planner is not this user's, loaded, yet: open it and try again. */
  | 'unavailable'
  /** Every write the run made is already undone, or gone. Nothing claimed. */
  | 'nothing'
  /** The run's ops did not parse, a read or the claim failed, or the planner went away under the claim. */
  | 'failed';

const planner = () => usePlannerStore.getState();

function ready(userId: string): boolean {
  const p = planner();
  return p.userId === userId && selectPlannerSettled(p) && p.loadFailedUserId !== userId;
}

/** An instant that is `day` in `tz`, for the store's Date-taking actions. */
function instantOn(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const noon = Date.UTC(y, m - 1, d, 12);
  for (const hours of [0, -6, 6, -11, 11, -14, 14]) {
    const at = new Date(noon + hours * 3_600_000);
    if (toDateStr(at, tz) === day) return at;
  }
  return new Date(noon);
}

/** Whether the store still says what the run left, so `op` has something to put back. */
function applies(op: UndoOp): boolean {
  const item = planner().items.find((i) => i.id === op[1]);
  if (!item) return false;
  switch (op[0]) {
    case 'uncomplete':
      return op[2] === null ? !isRecurring(item) && isDoneOn(item, '') : isDoneOn(item, op[2]);
    case 'unskip':
      return isSkippedOn(item, op[2]);
    case 'move':
      return !isHabit(item) && item.startDate === op[3];
    case 'delete':
      return !isHabit(item);
  }
}

/** One op, if it still applies. True when it wrote. */
function applyOp(op: UndoOp, tz: string): boolean {
  if (!applies(op)) return false;
  const p = planner();
  const item = p.items.find((i) => i.id === op[1])!;
  switch (op[0]) {
    case 'uncomplete': {
      const day = op[2];
      if (day === null) p.toggleTaskStatus(item.id, 'pending');
      else if (isHabit(item)) p.toggleHabitStatus(item.id, 'pending', undefined, instantOn(day, tz));
      else p.toggleTaskStatus(item.id, 'pending', instantOn(day, tz));
      return true;
    }
    case 'unskip':
      p.setItemSkipped(item.id, false, instantOn(op[2], tz));
      return true;
    case 'move':
      if (op[2] === null) p.unscheduleTask(item.id);
      else p.moveTaskToDate(item.id, op[2]);
      return true;
    case 'delete':
      p.deleteTask(item.id);
      return true;
  }
}

/** Puts back what one server run did (see RevertResult). */
export async function revertServerRun(modId: string, label: string, run: RunRow): Promise<RevertResult> {
  const s = run.summary;
  if (!s.server) return 'failed';
  if (run.reverted || run.revertClaimed) return 'taken';
  // Owner-asserted: parsed before anything acts on it.
  const parsed = UndoOpsSchema.safeParse(s.undo);
  if (!parsed.success || parsed.data.length === 0) return 'failed';
  const ops = parsed.data;
  const userId = planner().userId;
  if (!userId || !ready(userId)) return 'unavailable';

  // The rows as they are now, the user's own through RLS.
  const ids = [...new Set(ops.map((op) => op[1]))];
  let fresh: (Item | null)[];
  try {
    fresh = await Promise.all(ids.map((id) => fetchItemById(userId, id)));
  } catch (err) {
    console.warn('[recipes] revert read failed:', err);
    return 'failed';
  }
  if (!ready(userId)) return 'unavailable';
  // Gone from the database (deleted since): nothing of it to put back.
  const gone = new Set(ids.filter((_, i) => fresh[i] === null));
  mergeServerItems(fresh.filter((i): i is Item => i !== null));
  const live = (op: UndoOp) => !gone.has(op[1]);
  if (!ops.some((op) => live(op) && applies(op))) return 'nothing';

  const key = revertClaimKey(run.claimKey);
  const claim = await claimRun(userId, modId, key);
  if (claim !== 'won') return claim === 'lost' ? 'taken' : 'failed';
  if (!ready(userId)) {
    // The claim is spent; say so rather than leave a silent "Reverted".
    void logRun(userId, modId, `${key}:done`, {
      kind: 'revert',
      of: run.claimKey,
      did: 0,
      skipped: ops.length,
      failed: 'planner-not-ready',
    });
    return 'failed';
  }

  const tz = planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let did = 0;
  let skipped = 0;
  withSuppressed(() =>
    batchHistory(
      `Revert: ${label}`,
      ops.length,
      () => {
        for (const op of ops) {
          try {
            if (live(op) && applyOp(op, tz)) did++;
            else skipped++;
          } catch (err) {
            console.error('[recipes] revert step failed:', err);
            skipped++;
          }
        }
      },
      { quiet: true }
    )
  );
  void logRun(userId, modId, `${key}:done`, { kind: 'revert', of: run.claimKey, did, skipped });
  return 'done';
}

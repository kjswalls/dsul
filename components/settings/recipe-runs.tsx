'use client';

import { useEffect, useId, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { fetchRecentRuns, type RunRow, type RunSummary } from '@/lib/recipes/runs';
import { revertServerRun } from '@/lib/recipes/revert';

/**
 * A recipe's recent runs, from mod_runs, newest first. Read when opened, never
 * before: a closed list costs nothing.
 */

/** "Did 3 of 3", then what did not happen. */
export function describeRun(s: RunSummary): string {
  const parts = [s.of === 0 ? 'Ran' : `Did ${s.did} of ${s.of}`];
  if (s.skipped > 0) parts.push(`skipped ${s.skipped}`);
  if (s.refused > 0) parts.push(`refused ${s.refused}`);
  if (s.stopped > 0) parts.push(`stopped ${s.stopped} at the limit`);
  if (s.server) parts.push('on the server');
  if (s.ui && s.ui > 0) parts.push(`${s.ui} screen ${s.ui === 1 ? 'step' : 'steps'} skipped (dsul was closed)`);
  return parts.join(', ');
}

/** Whether a run can be put back from here: a server run with its inverse writes, no Revert claimed yet. */
export function canRevert(r: RunRow): boolean {
  return (
    !!r.summary.server &&
    Array.isArray(r.summary.undo) &&
    r.summary.undo.length > 0 &&
    !r.reverted &&
    !r.revertClaimed
  );
}

/** What a Revert that did not put anything back says, by why. */
export const REVERT_COPY = {
  unavailable: 'Open your planner first, then revert from here.',
  nothing: 'Nothing left to put back.',
  failed: 'Couldn’t revert this run.',
  pending: 'Revert started on another tab or device.',
} as const;

/** A run's Revert state, after the run's own line. */
function revertNote(r: RunRow): string | null {
  if (r.reverted) return 'Reverted';
  if (r.revertFailed) return 'Revert failed';
  if (r.revertClaimed) return REVERT_COPY.pending;
  if (r.summary.server && r.summary.revertable === false) return 'too large to revert';
  return null;
}

function ago(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : formatDistanceToNowStrict(d, { addSuffix: true });
}

export function RecipeRuns({ modId, label }: { modId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});

  const revert = async (r: RunRow) => {
    setBusy(r.claimKey);
    const out = await revertServerRun(modId, label, r).catch(() => 'failed' as const);
    if (out === 'done') {
      setRows((rs) =>
        rs?.map((x) => (x.claimKey === r.claimKey ? { ...x, reverted: true, revertClaimed: true } : x)) ?? rs
      );
    } else if (out === 'taken') {
      // Someone else's Revert: what came of it is its result row's to say,
      // never the claim's.
      const fresh = await fetchRecentRuns(modId).catch(() => null);
      const row = fresh?.find((x) => x.claimKey === r.claimKey);
      setRows((rs) =>
        rs?.map((x) => (x.claimKey === r.claimKey ? (row ?? { ...x, revertClaimed: true }) : x)) ?? rs
      );
    } else {
      setSaid((m) => ({ ...m, [r.claimKey]: REVERT_COPY[out] }));
    }
    setBusy(null);
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchRecentRuns(modId)
      .then((r) => {
        if (live) setRows(r);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open, modId]);

  return (
    <div data-testid="recipe-runs" className="pb-2">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Recent runs for ${label}`}
        onClick={() => {
          setFailed(false);
          setOpen((o) => !o);
        }}
      >
        Recent runs
      </button>
      {open && (
        <ul id={listId} className="text-muted-foreground mt-1 space-y-0.5 text-xs" data-testid="recipe-runs-list">
          {failed ? (
            <li>Could not load runs.</li>
          ) : rows === null ? null : rows.length === 0 ? (
            <li>No runs yet.</li>
          ) : (
            rows.map((r) => (
              <li key={r.claimKey} data-testid="recipe-run">
                {describeRun(r.summary)} · {ago(r.at)}
                {revertNote(r) && <span> · {revertNote(r)}</span>}
                {canRevert(r) && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      data-testid="recipe-run-revert"
                      className="hover:text-foreground underline underline-offset-2"
                      disabled={busy !== null}
                      onClick={() => void revert(r)}
                    >
                      Revert
                    </button>
                  </>
                )}
                {said[r.claimKey] && <span> · {said[r.claimKey]}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

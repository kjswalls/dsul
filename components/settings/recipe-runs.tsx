'use client';

import { useEffect, useId, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { fetchRecentRuns, type RunRow, type RunSummary } from '@/lib/recipes/runs';

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
  return parts.join(', ');
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
              <li key={r.claimKey}>
                {describeRun(r.summary)} · {ago(r.at)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useEffect, useId, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { fetchRecentFaults, type FaultRow } from '@/lib/mods/faults-log';
import { faultCodeWords } from '@/lib/mods/faults';

/**
 * A mod's recent problems (memory/plans/mods.md, "Faults"; build order 8):
 * the last 10 fault rows from mod_runs, newest first, read when opened and
 * never before, as RecipeRuns reads runs.
 *
 * Plain text only. The time, the hook and the code in words are the app's;
 * the message is the mod's own, so it sits under a host label ("Your mod
 * reported:") in muted text and can never pass for the app speaking.
 */

function ago(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : formatDistanceToNowStrict(d, { addSuffix: true });
}

/** The label a mod's own words sit under, wherever Make draws them. */
export const MOD_REPORTED = 'Your mod reported:';

export function ModProblems({ modId, label }: { modId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [rows, setRows] = useState<FaultRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchRecentFaults(modId)
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
    <div data-testid="mod-problems" className="pb-1">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Problems for ${label}`}
        onClick={() => {
          setFailed(false);
          setOpen((o) => !o);
        }}
      >
        Problems
      </button>
      {open && (
        <ul id={listId} className="mt-1 space-y-1.5 text-xs" data-testid="mod-problems-list">
          {failed ? (
            <li className="text-muted-foreground">Could not load problems.</li>
          ) : rows === null ? null : rows.length === 0 ? (
            <li className="text-muted-foreground">No problems.</li>
          ) : (
            rows.map((r, i) => (
              <li key={`${r.at}-${i}`} data-testid="mod-problem">
                <span className="text-foreground block">
                  {ago(r.at)} · {r.summary.hook} · {faultCodeWords(r.summary.code)}
                  {r.summary.counted === false && <span className="text-muted-foreground"> (not counted)</span>}
                </span>
                {r.summary.message && (
                  <span className="text-muted-foreground block">
                    {MOD_REPORTED} <span className="break-words">{r.summary.message}</span>
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

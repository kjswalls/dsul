'use client';

import { useEffect, useRef } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';

// Actions that raise the transient strip row (components/notices/undo-strip.tsx).
const SIGNIFICANT_ACTIONS = [
  'Delete task:',
  'Delete habit:',
  'Delete project:',
  'Complete task:',
  'Uncomplete task:',
  // A recurring task's tick names the day it was ticked for — "Complete task
  // on 2026-09-25: Swim" — so the one-shot prefixes above never matched it,
  // and the most common completion of all raised no row.
  'Complete task on ',
  'Uncomplete task on ',
  'Complete habit:',
  'Skip habit:',
  'Reset habit:',
  'Unschedule task:',
  'Move task to',
  'Schedule task:',
  // The multi-select group drag. It wrote startDate and isScheduled on every
  // selected item and raised nothing — not even an undo affordance.
  'Schedule items:',
  'Move habit to',
  'Move all tasks',
  'Reset streak:',
  'Delete items',
  'Complete items',
  'Uncomplete items',
  // Bulk membership. Collecting into a container that is currently off hides
  // the items on the spot, so this is a move verb in every way that matters and
  // carries the same receipt — it needs the toast to show it.
  'Add to ',
  'Remove from ',
  // A goal role that stopped being true of its item — a milestone made
  // recurring, a check-in made one-shot. The membership yields rather than the
  // edit (goals never constrain their members), which means the user's item
  // edit succeeded and something ELSE quietly changed. That is precisely the
  // shape of change that needs a receipt: without it the milestone silently
  // stops counting and the goal reads behind weeks later, with nothing on
  // screen ever having said so.
  'Role changed:',
  // The paste-a-list path. A single add shows its row right where you typed
  // it and stays quiet; a bulk add lands N rows in one gesture — possibly on
  // a surface you aren't looking at — so it earns the receipt and the one-⌘Z
  // offer.
  'Bulk add:',
  // planner-store.applyProposal emits exactly this prefix. Accepting an AI
  // proposal is the single most important place to show the undo affordance:
  // one tap changes several items at once, and the offer to take it back is
  // what makes accepting feel safe rather than irreversible.
  'Accept plan:',
];

/**
 * Does this action get said out loud?
 *
 * Two ways in, and the second is not a widening of the first. A prefix in the
 * list above says "this VERB is consequential enough to offer an undo for". A
 * receipt on an `Add ` verb says something narrower and stronger: the store
 * attached one only because the item it just created is not visible where the
 * user just put it (plan decision 11), which is the exact condition this toast
 * exists for — and creating is far too ordinary a verb to list. An item created
 * straight into a program that is currently off is gone from the grid the moment
 * the dialog closes, and the list alone would let that happen in silence while
 * the bulk "Add to …" path announced the identical write.
 *
 * Scoped to the `Add ` prefix rather than "any receipt at all", because the
 * other receipted verbs are not ready to speak and each needs its own fix
 * first:
 *
 *  - `Edit task:` attaches its receipt on `'startDate' in updates` — key
 *    PRESENCE, not change — and the mobile modal commits the whole DRAFT_KEYS
 *    payload on every Save, so changing only a priority on a task in a paused
 *    program would toast. It needs `updates.startDate !== task.startDate`
 *    there before a receipt on it means anything.
 *  - EOD's "Move all to tomorrow" carries N suppressed rows through that same
 *    action; React batches them into ONE toast, which names one arbitrary row
 *    and whose Undo reverses only that row.
 *  - The undo/restore paths in the morning triage and EOD write the saved
 *    scheduling fields back through it too, so a REVERSAL would announce
 *    "hidden where it landed" about the thing it just put back.
 *
 * None of that is this rule's to settle, so it stays on the path whose receipt
 * was audited: the create path.
 *
 * Exported for the unit test, which is the only place the rule can be checked:
 * the hook itself needs a store and a subscription to say anything.
 *
 * The name outlived the surface. The row is a strip above the dock now, not a
 * toast (components/notices/undo-strip.tsx) — but this is the same audited
 * predicate over the same action labels, and renaming a rule in the commit that
 * moves it makes every future failure ambiguous about which change caused it.
 * The `morning-bar` testid was kept across its own move for the same reason.
 */
export function isToastWorthy(action: { label: string; receipt?: string }): boolean {
  if (action.receipt && action.label.startsWith('Add ')) return true;
  return SIGNIFICANT_ACTIONS.some((prefix) => action.label.startsWith(prefix));
}

export function useUndoToast() {
  const actionLog = usePlannerStore((state) => state.actionLog);
  const lastActionIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Get the latest action
    if (actionLog.length === 0) return;

    const latestAction = actionLog[0]; // Most recent is first

    // Only trigger if this is a new action we haven't seen
    if (latestAction.id === lastActionIdRef.current) {
      return;
    }

    // Update our reference to the latest action
    lastActionIdRef.current = latestAction.id;

    if (isToastWorthy(latestAction)) {
      // A receipt has something to read, so it gets longer than the reflexive
      // "oops, undo" window the bare label needs.
      const durationMs = latestAction.receipt ? 8000 : 5000;

      // The previous row is replaced rather than stacked — one transient row at
      // a time, which is what keeps the strip a strip. Its timer goes with it,
      // or it would take the replacement down early.
      if (timerRef.current) clearTimeout(timerRef.current);

      useUndoStripStore.getState().show({
        id: latestAction.id,
        label: latestAction.label,
        // Decision 11's receipt, when the store attached one: the move was
        // allowed, but what it moved is not visible where it landed. Absent on
        // every other action, so this reads as an exception rather than chrome.
        receipt: latestAction.receipt,
        durationMs,
      });

      // Conditional on the id: a timer that outlives its own row — the user
      // pressed Undo, or a newer action replaced it — must not clear whatever
      // is standing there now.
      timerRef.current = setTimeout(() => {
        useUndoStripStore.getState().dismiss(latestAction.id);
        timerRef.current = null;
      }, durationMs);
    }
  }, [actionLog]);

  // AppShell holds this for the app's whole life, so this only runs on teardown
  // — but a stranded timer writing into a store after unmount is exactly the
  // kind of thing that shows up as a test that passes alone and fails in a suite.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );
}

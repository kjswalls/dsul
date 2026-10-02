'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchItemEvents, getItemEventsAvailable } from '@/lib/db';
import { pickOpenQuestionOptions } from '@/lib/agent-question';

/** Shared empty list, so a render with no options allocates nothing. */
const NO_OPTIONS: string[] = [];

/** How long `ready` waits on the trail before a surface stops waiting for it. */
export const READY_AFTER_MS = 1500;

/**
 * The tappable answers to an agent's question on `item`, if it offered any for
 * the question on screen (lib/agent-question.ts `pickOpenQuestionOptions`).
 * Used by the item's AgentReply and by Ask home's Needs-you card.
 *
 * Fetched per item rather than lifted from the Activity section: this only
 * runs while the item is `blocked`, so the query is rare, and the sections are
 * independent by design (Activity is collapsible and may never be opened).
 *
 * CLEAR BEFORE FETCHING. A surface showing this is REUSED across items (the
 * item dialog re-seeds on id change without unmounting), so leaving the old
 * options up during the round-trip meant opening blocked item B while A was on
 * screen showed A's buttons with B's id already bound: a tap filed A's answer
 * against B and re-queued B unanswered. So the options are TAGGED with the item
 * and question they belong to, and derived during render rather than reset by
 * an effect, which would reset a render late and paint the previous item's
 * buttons for one frame.
 *
 * `clear()` withdraws them once answered, so nobody replies twice; the status
 * flip usually unmounts the surface anyway, but that is the caller's
 * behaviour, and nothing here leans on it.
 *
 * `ready`: the answer for THIS question is in (options or none, a failed fetch
 * counting as none), or there is no trail to ask, or it has taken longer than
 * READY_AFTER_MS. A surface that puts a free-text field where no options came
 * waits for it, or every card would paint the field and then swap it for the
 * chips once the trail answered, taking a caret already in the field with it.
 */
export function useAgentQuestion(item: { id: string; aiResult?: string }): {
  options: string[];
  ready: boolean;
  clear: () => void;
} {
  const optionsKey = `${item.id}\u0000${(item.aiResult ?? '').trim()}`;
  const [fetched, setFetched] = useState<{ key: string; options: string[] }>(() => ({
    key: '',
    options: NO_OPTIONS,
  }));
  const [lateKey, setLateKey] = useState('');
  const options = fetched.key === optionsKey ? fetched.options : NO_OPTIONS;
  const available = getItemEventsAvailable();
  const ready = !available || fetched.key === optionsKey || lateKey === optionsKey;

  useEffect(() => {
    let cancelled = false;
    if (!getItemEventsAvailable()) return;

    // A trail that never answers must not leave the question unanswerable.
    const late = setTimeout(() => setLateKey(optionsKey), READY_AFTER_MS);
    fetchItemEvents(item.id)
      .then((events) => {
        if (cancelled) return;
        setFetched({ key: optionsKey, options: pickOpenQuestionOptions(events, item.aiResult) });
      })
      .catch(() => {
        if (!cancelled) setFetched({ key: optionsKey, options: NO_OPTIONS });
      });

    return () => {
      cancelled = true;
      clearTimeout(late);
    };
  }, [item.id, item.aiResult, optionsKey]);

  const clear = useCallback(() => setFetched({ key: '', options: NO_OPTIONS }), []);
  return { options, ready, clear };
}

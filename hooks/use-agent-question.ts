'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchItemEvents, getItemEventsAvailable } from '@/lib/db';
import { pickOpenQuestionOptions } from '@/lib/agent-question';

/** Shared empty list, so a render with no options allocates nothing. */
const NO_OPTIONS: string[] = [];

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
 */
export function useAgentQuestion(item: { id: string; aiResult?: string }): {
  options: string[];
  clear: () => void;
} {
  const optionsKey = `${item.id}\u0000${(item.aiResult ?? '').trim()}`;
  const [fetched, setFetched] = useState<{ key: string; options: string[] }>(() => ({
    key: '',
    options: NO_OPTIONS,
  }));
  const options = fetched.key === optionsKey ? fetched.options : NO_OPTIONS;

  useEffect(() => {
    let cancelled = false;
    if (!getItemEventsAvailable()) return;

    fetchItemEvents(item.id)
      .then((events) => {
        if (cancelled) return;
        setFetched({ key: optionsKey, options: pickOpenQuestionOptions(events, item.aiResult) });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [item.id, item.aiResult, optionsKey]);

  const clear = useCallback(() => setFetched({ key: '', options: NO_OPTIONS }), []);
  return { options, clear };
}

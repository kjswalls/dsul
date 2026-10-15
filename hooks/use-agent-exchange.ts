'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchItemEvents, getItemEventsAvailable, type ItemEvent } from '@/lib/db';
import { buildAgentExchange, type AgentExchange } from '@/lib/agent-exchange';
import { useAgentAnswers } from '@/lib/agent-question';
import type { SentAnswer } from '@/lib/agent-exchange';

const NO_EVENTS: ItemEvent[] = [];
const NO_SENT: SentAnswer[] = [];

/**
 * The item's exchange with its agent (lib/agent-exchange.ts), read from the
 * item's trail. Fetched while an agent holds the item, and again whenever its
 * agent state moves (the planner re-reads that on its own,
 * hooks/use-agent-freshness.ts `useDelegatedFreshness`), so a question, an
 * answer and a result each show up here without a reload.
 *
 * Tagged by item, like useAgentQuestion: a panel reused across items never
 * shows one item's exchange under another's title.
 */
export function useAgentExchange(item: {
  id: string;
  assignee?: string;
  aiStatus?: string;
  aiResult?: string;
  aiStatusAt?: string;
}): AgentExchange | null {
  const [fetched, setFetched] = useState<{ id: string; events: ItemEvent[] }>({ id: '', events: NO_EVENTS });
  const sent = useAgentAnswers((s) => s.byItem[item.id] ?? NO_SENT);
  const held = !!item.assignee;

  useEffect(() => {
    if (!held || !getItemEventsAvailable()) return;
    let cancelled = false;
    // A moment after the move, so an answer's own trail write (fire and forget) has landed.
    const timer = setTimeout(() => {
      fetchItemEvents(item.id)
        .then((events) => {
          if (!cancelled) setFetched({ id: item.id, events });
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [held, item.id, item.aiStatus, item.aiStatusAt, item.aiResult]);

  const events = fetched.id === item.id ? fetched.events : NO_EVENTS;
  const { assignee, aiStatus, aiResult, aiStatusAt } = item;
  return useMemo(
    () => buildAgentExchange(events, { assignee, aiStatus, aiResult, aiStatusAt }, sent),
    [events, assignee, aiStatus, aiResult, aiStatusAt, sent]
  );
}

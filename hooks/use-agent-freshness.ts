'use client';

import { useEffect } from 'react';
import { fetchAgentStates } from '@/lib/db';
import { mergeAgentStates, usePlannerStore } from '@/lib/planner-store';
import { useConversationsStore } from '@/lib/conversations-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';

/** At most one agent-state read per this long, however often Ask shows or the window gains focus. */
export const AGENT_FRESHNESS_MS = 60_000;

/** Module state: one throttle for every mount, so two surfaces never double the read. */
let lastRead = -Infinity;

/** Tests: forget the last read, so the next refresh goes out. */
export function resetAgentFreshness(): void {
  lastRead = -Infinity;
}

/**
 * Freshness without realtime, for Ask home: the agent columns of delegated
 * items (lib/db.ts `fetchAgentStates`, folded in by planner-store
 * `mergeAgentStates`, newer stamp wins), and the conversation list's first
 * page when it is older than a minute (`refreshIfStale`, which keeps its own
 * clock).
 *
 * The agent read goes out at most once per AGENT_FRESHNESS_MS. A result that
 * lands after the account changed is dropped: it is the last account's rows.
 * Any failure is "nothing new"; what the store holds stays up.
 *
 * Resolves when the read is done (tests); callers fire and forget.
 */
export function refreshAgentFreshness(now: number = Date.now()): Promise<void> {
  useConversationsStore.getState().refreshIfStale(AGENT_FRESHNESS_MS);
  const userId = usePlannerStore.getState().userId;
  if (!userId || now - lastRead < AGENT_FRESHNESS_MS) return Promise.resolve();
  lastRead = now;
  return fetchAgentStates()
    .then((rows) => {
      if (usePlannerStore.getState().userId !== userId) return;
      // A finish may come with a card the agent saved from outside the
      // browser (MCP's dsul_save_prep): read the packs again when one lands.
      if (mergeAgentStates(rows) > 0 && rows.some((r) => r.aiStatus === 'done')) {
        void usePrepPacksStore.getState().refresh(userId);
      }
    })
    .catch(() => {});
}

/**
 * Keep Ask home's agent rows and conversation rows current while it shows: on
 * mount (the rail opening, or Back to it), on window focus, and on the tab
 * becoming visible, throttled as above. `active` is whether Ask is on screen:
 * Ask stays mounted, hidden, under an item, and a hidden Ask asks for nothing.
 */
export function useAgentFreshness(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    void refreshAgentFreshness();
    const onFocus = () => void refreshAgentFreshness();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshAgentFreshness();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active]);
}

/** An agent still owes this item something: its next status, or your answer's pickup. */
const IN_FLIGHT = new Set(['queued', 'working', 'blocked']);

/**
 * The planner's own freshness, beside Ask home's: while any item is with an
 * agent and not finished, read the agent columns on mount, on focus, on the tab
 * becoming visible, and once a minute while the tab shows.
 *
 * Without it the agent's writes reached the planner only through Ask home, so
 * an item handed to Claude kept saying "queued" on its row and in its panel
 * (no question, no answer box) until Ask was opened, while the panel's
 * timeline, which reads item_events itself, already showed the question.
 * The same throttle as Ask home's, so the two never double a read; quiet, and
 * reading nothing, while nothing is delegated.
 */
export function useDelegatedFreshness(): void {
  const inFlight = usePlannerStore((s) =>
    s.items.some((item) => {
      const held = item as { assignee?: string; aiStatus?: string };
      return !!held.assignee && IN_FLIGHT.has(held.aiStatus ?? '');
    })
  );
  useEffect(() => {
    if (!inFlight) return;
    void refreshAgentFreshness();
    const tick = () => {
      if (document.visibilityState === 'visible') void refreshAgentFreshness();
    };
    const timer = setInterval(tick, AGENT_FRESHNESS_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [inFlight]);
}

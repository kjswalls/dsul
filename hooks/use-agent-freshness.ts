'use client';

import { useEffect } from 'react';
import { fetchAgentStates } from '@/lib/db';
import { mergeAgentStates, usePlannerStore } from '@/lib/planner-store';
import { useConversationsStore } from '@/lib/conversations-store';

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
      mergeAgentStates(rows);
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

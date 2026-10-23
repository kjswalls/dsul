'use client';

import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { packIsStale, packIsSteps } from '@/lib/prep-packs';
import { getAICapabilities, useAICapabilities } from '@/lib/ai-connection-store';
import { canBreakDown } from '@/lib/item-asks';
import { showItemSteps } from '@/lib/open-chat';

/**
 * First steps (Kirby's pick S1, 2026-10-13; memory/plans/power-mode.md, round
 * 5), now with one home (2026-10-23): the item panel's Subtasks, where the
 * AI's steps are drafted rows to keep, edit, hand off or drop
 * (components/planner/drafted-steps.tsx). Opening first steps opens the item
 * there, and asks for a draft only when none is up yet (a steps pack, or a
 * breakdown already asked for), so a pack prepared in the background is
 * never paid for twice. There is no modal any more.
 *
 * Opened from the up-next card, the F key while doing stuff, and the item's
 * "AI ▸" menu; offered only where Break it down is (`canBreakDown`).
 */

/**
 * Open first steps for an item, where the AI can break it down; false (and
 * nothing opens) where it can't, so a key that asks can let the press go.
 */
export function openFirstSteps(id: string): boolean {
  const item = usePlannerStore.getState().items.find((i) => i.id === id);
  if (!item || !canBreakDown(item, getAICapabilities().canPropose)) return false;
  showItemSteps(item, { ask: !hasDrafts(id, item.title) });
  return true;
}

/** Open an item's drafted steps where they live, asking for nothing. */
export function openDraftedSteps(id: string): void {
  const item = usePlannerStore.getState().items.find((i) => i.id === id);
  if (item) showItemSteps(item, { ask: false });
}

function hasDrafts(id: string, title: string): boolean {
  const stored = usePrepPacksStore.getState().packs[id];
  if (stored && !packIsStale(stored, title) && packIsSteps(stored.pack)) return true;
  const p = useProposalStore.getState();
  return p.lastRequest?.surface === `item:${id}` && (p.status === 'loading' || p.status === 'ready');
}

/** May first steps be offered on this item? The same rule as Break it down. */
export function useCanFirstSteps(id: string | undefined): boolean {
  const { canPropose } = useAICapabilities();
  const item = usePlannerStore((s) => (id ? s.items.find((i) => i.id === id) : undefined));
  return !!item && canBreakDown(item, canPropose);
}

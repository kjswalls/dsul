import { getAICapabilities } from '@/lib/ai-connection-store';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { leaveZen } from '@/lib/open-chat';
import { railModeNow, useRailStore } from '@/lib/rail-store';
import { closeItemPanel } from '@/lib/ui-store';

/**
 * Show what waits on the user, turned to `itemId` where there is a card for
 * it (a grid block's short card, components/ai/needs-you/block-ask.tsx).
 *
 * The inbox opens from whichever anchor is drawn: the Ask key's count, or,
 * with no Ask, the header pill. With neither on screen (Ask is open and the
 * key has gone, Zen, or a header row with no room for the key), Ask itself
 * shows them: its home, whose Needs you holds every question.
 */
export function openNeedsYou(itemId: string | null = null): void {
  const store = useNeedsYouStore.getState();
  if (store.hosts > 0 || !getAICapabilities().canChat) {
    store.openInbox(itemId);
    return;
  }
  if (railModeNow() === 'item') closeItemPanel();
  leaveZen();
  useRailStore.getState().summon({ home: true });
}

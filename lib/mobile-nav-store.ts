'use client';

import { create } from 'zustand';

/**
 * Which surface the phone shell is showing. Default is Today (glanceable on
 * open); Braindump sits first in the order below so the "get it out of your
 * head" surface is one swipe left.
 */
export type MobileTab = 'braindump' | 'today' | 'chat';

/**
 * The order the switcher sheet lists these in (the dock's mode card opens it);
 * also the left-to-right axis swipe navigation walks.
 */
export const MOBILE_TAB_ORDER: MobileTab[] = ['braindump', 'today', 'chat'];

/**
 * The surfaces the phone can actually reach right now: MOBILE_TAB_ORDER without
 * `chat` while nothing can answer (lib/ai-registry.ts). The sheet lists these
 * and a swipe walks them, so a hidden chat tab is never one gesture away.
 */
export function mobileTabOrder(canChat: boolean): MobileTab[] {
  return canChat ? MOBILE_TAB_ORDER : MOBILE_TAB_ORDER.filter((t) => t !== 'chat');
}

/**
 * The surface the shell SHOWS for a stored `activeTab`. A `chat` that can no
 * longer answer renders as Today in the same frame; the shell's effect then
 * moves the stored tab there too (once the gate has answered), so the dock's
 * card, the sheet and the content never disagree about where you are.
 */
export function shownMobileTab(activeTab: MobileTab, canChat: boolean): MobileTab {
  return activeTab === 'chat' && !canChat ? 'today' : activeTab;
}

interface MobileNavStore {
  activeTab: MobileTab;
  setActiveTab: (tab: MobileTab) => void;
}

export const useMobileNavStore = create<MobileNavStore>((set) => ({
  activeTab: 'today',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));

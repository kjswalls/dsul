'use client';

import { create } from 'zustand';
import type { AICapabilities } from './ai-registry';

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

/** The three answers of the AI gate (lib/ai-registry.ts) that decide the phone's third surface. */
export type ChatOffer = Pick<AICapabilities, 'canChat' | 'askInvite' | 'askFix'>;

/**
 * Whether the phone has a third surface at all: Ask while something answers,
 * or in its place the setup page ("Set up AI", `askInvite`) or the fix home
 * ("Fix AI", `askFix`). Never while the gate is unknown or failed, which
 * offers nothing (NO_AI), so a slow status read never flashes a tab, and
 * never once the account has said No AI.
 */
export function chatOffered(c: ChatOffer): boolean {
  return c.canChat || c.askInvite || c.askFix;
}

/**
 * The `chat` tab holds the setup page or the fix home rather than Ask:
 * offered, and nothing answers. The rule the shell mounts that page by, and
 * the one the phone's palette runs ask before moving off `chat` to reach the
 * omnibar (the setup page keeps the dock's omnibar; Ask's composer takes its
 * place).
 */
export function setupPageShown(c: ChatOffer): boolean {
  return !c.canChat && (c.askInvite || c.askFix);
}

/**
 * The surfaces the phone can actually reach right now: MOBILE_TAB_ORDER
 * without `chat` while it is not offered (`chatOffered`, which callers pass).
 * The sheet lists these and a swipe walks them, so a hidden chat tab is never
 * one gesture away.
 */
export function mobileTabOrder(offered: boolean): MobileTab[] {
  return offered ? MOBILE_TAB_ORDER : MOBILE_TAB_ORDER.filter((t) => t !== 'chat');
}

/**
 * The surface the shell SHOWS for a stored `activeTab`. A `chat` that is no
 * longer offered (`chatOffered`) renders as Today in the same frame; the
 * shell's effect then moves the stored tab there too (once the gate has
 * answered), so the dock's card, the sheet and the content never disagree
 * about where you are.
 */
export function shownMobileTab(activeTab: MobileTab, offered: boolean): MobileTab {
  return activeTab === 'chat' && !offered ? 'today' : activeTab;
}

interface MobileNavStore {
  activeTab: MobileTab;
  setActiveTab: (tab: MobileTab) => void;
}

export const useMobileNavStore = create<MobileNavStore>((set) => ({
  activeTab: 'today',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));

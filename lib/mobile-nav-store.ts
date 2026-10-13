'use client';

import { create } from 'zustand';
import type { AICapabilities } from './ai-registry';

/**
 * Which surface the phone shell is showing, as the iPhone app lays them out
 * (memory/handoffs/mobile-web.md, round 3, which Kirby picked on 2026-10-13):
 * Today, and Ask while the AI gate offers it. Default is Today (glanceable on
 * open).
 *
 * Braindump is not a tab any more. It is a sheet that opens over Today from
 * the capture bar's count (`braindumpOpen` below), the way it opens over the
 * schedule on the iPhone. Organize is a key in the tab pill too, but it opens
 * the Organize console rather than a surface of its own, so it is not here.
 */
export type MobileTab = 'today' | 'chat';

/** The order the dock's tab pill shows the surfaces in. */
export const MOBILE_TAB_ORDER: MobileTab[] = ['today', 'chat'];

/**
 * What the onboarding tour and the palette ask the phone to show. `braindump`
 * is Today with the braindump sheet open over it; the other two are tabs.
 */
export type MobileSurface = 'braindump' | MobileTab;

/** The three answers of the AI gate (lib/ai-registry.ts) that decide the phone's Ask tab. */
export type ChatOffer = Pick<AICapabilities, 'canChat' | 'askInvite' | 'askFix'>;

/**
 * Whether the phone has an Ask tab at all: Ask while something answers, or in
 * its place the setup page ("Set up AI", `askInvite`) or the fix home
 * ("Fix AI", `askFix`). Never while the gate is unknown or failed, which
 * offers nothing (NO_AI), so a slow status read never flashes a tab, and
 * never once the account has said No AI or this device turned chat off.
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
 * The tab pill draws these, so a hidden Ask tab is never one tap away.
 */
export function mobileTabOrder(offered: boolean): MobileTab[] {
  return offered ? MOBILE_TAB_ORDER : MOBILE_TAB_ORDER.filter((t) => t !== 'chat');
}

/**
 * The surface the shell SHOWS for a stored `activeTab`. A `chat` that is no
 * longer offered (`chatOffered`) renders as Today in the same frame; the
 * shell's effect then moves the stored tab there too (once the gate has
 * answered), so the tab pill and the content never disagree about where you
 * are.
 */
export function shownMobileTab(activeTab: MobileTab, offered: boolean): MobileTab {
  return activeTab === 'chat' && !offered ? 'today' : activeTab;
}

interface MobileNavStore {
  activeTab: MobileTab;
  /**
   * Whether the braindump sheet is open over Today. Closed by every tab
   * change: the sheet belongs to Today, and Ask brings its own composer.
   */
  braindumpOpen: boolean;
  /**
   * The dock's folded state (round 3's "minimized" dock): scrolling Today's
   * view down folds the two rows into one, and scrolling back up, or a tap on
   * the folded tab circle, unfolds it. Never folded on Ask, whose composer is
   * the bar.
   */
  dockMinimized: boolean;
  setActiveTab: (tab: MobileTab) => void;
  setBraindumpOpen: (open: boolean) => void;
  setDockMinimized: (minimized: boolean) => void;
}

export const useMobileNavStore = create<MobileNavStore>((set) => ({
  activeTab: 'today',
  braindumpOpen: false,
  dockMinimized: false,
  setActiveTab: (tab) => set({ activeTab: tab, braindumpOpen: false, dockMinimized: false }),
  setBraindumpOpen: (open) =>
    set(open ? { activeTab: 'today', braindumpOpen: true } : { braindumpOpen: false }),
  setDockMinimized: (minimized) => set({ dockMinimized: minimized }),
}));

/**
 * Show a surface by name: the one door for callers that still think in the
 * old three surfaces (the onboarding tour, `goto.braindump`). `braindump`
 * opens the sheet over Today; the tabs close it.
 */
export function showMobileSurface(surface: MobileSurface): void {
  const nav = useMobileNavStore.getState();
  if (surface === 'braindump') nav.setBraindumpOpen(true);
  else nav.setActiveTab(surface);
}

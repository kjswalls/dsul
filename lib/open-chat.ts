import { getAICapabilities } from './ai-connection-store';
import { useMobileNavStore } from './mobile-nav-store';
import { useProposalStore, type ProposalSurface } from './proposal-store';
import { useSidebarStore } from './sidebar-store';

/**
 * Opens the chat surface iff something can answer (`getAICapabilities().canChat`).
 *
 * Desktop: the left sidebar, with chat expanded. Mobile: the chat tab. Returns
 * whether it opened, so a caller (a command, the catch-up card, the settings
 * no-results button) can do something else when chat is not there to open —
 * an open into a surface that is hidden is a button that does nothing.
 */
export function revealChat(isMobile: boolean): boolean {
  if (!getAICapabilities().canChat) return false;
  if (isMobile) {
    useMobileNavStore.getState().setActiveTab('chat');
  } else {
    const sidebar = useSidebarStore.getState();
    sidebar.setLeftSidebarOpen(true);
    sidebar.setChatExpanded(true);
  }
  return true;
}

/**
 * Exactly ProposalCard's own render rule (components/ai/proposal-card.tsx):
 * not idle, and the request came from this surface (or names none). Pure.
 *
 * The catch-up hosts mount their box only when this is true, so a host with
 * nothing to show takes no space; a test pins it to ProposalCard's behaviour.
 */
export function proposalCardShowsOn(
  s: { status: string; lastRequest: { surface: ProposalSurface } | null },
  surface: ProposalSurface
): boolean {
  if (s.status === 'idle') return false;
  const requestSurface = s.lastRequest?.surface;
  return requestSurface === undefined || requestSurface === surface;
}

/** Whether the chat-surface proposal card has something to show (for the catch-up hosts). */
export function useChatHostCard(): boolean {
  return useProposalStore((s) => proposalCardShowsOn(s, 'chat'));
}

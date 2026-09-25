import { describe, it, expect, beforeEach } from 'vitest';

import { useSidebarStore } from '@/lib/sidebar-store';

/**
 * Docking or collapsing the column ends a hover-peek in the same write.
 *
 * The peek flag is otherwise cleared only by the sidebar wrapper's mouseleave,
 * and the two ways to dock from a peek (the pin on the peeked edge, and ⌘[)
 * both act from a pointer that is still inside that wrapper. Left set, the
 * flag outlives the dock, and the next collapse drops the column straight
 * back into a peek instead of closing it.
 */
describe('sidebar peek flag', () => {
  beforeEach(() => {
    useSidebarStore.setState({
      leftSidebarOpen: false,
      leftSidebarHovered: true,
      leftSidebarHoverEnabled: true,
    });
  });

  it('is cleared when the peek is pinned open', () => {
    useSidebarStore.getState().setLeftSidebarOpen(true);
    const s = useSidebarStore.getState();
    expect(s.leftSidebarOpen).toBe(true);
    expect(s.leftSidebarHovered).toBe(false);
  });

  it('is cleared when the shortcut docks mid-peek, so the next collapse closes', () => {
    const { toggleLeftSidebar } = useSidebarStore.getState();
    toggleLeftSidebar();
    expect(useSidebarStore.getState().leftSidebarHovered).toBe(false);
    toggleLeftSidebar();
    const s = useSidebarStore.getState();
    expect(s.leftSidebarOpen).toBe(false);
    expect(s.leftSidebarHovered).toBe(false);
  });
});

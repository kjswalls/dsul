// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Where the braindump's mod card mounts (memory/plans/mods.md, build order 9):
 * under the braindump in the left column while it is docked open (never
 * during a hover peek, which would run resolves for a glance), and in the
 * Console layout's pane while it is open. Closed, nothing mounts, so nothing
 * resolves.
 */

vi.mock('@/components/sidebar/braindump', () => ({ Braindump: () => <div data-testid="braindump" /> }));
vi.mock('@/components/sidebar/sidebar-dock', () => ({ SidebarDock: () => <div data-testid="sidebar-dock" /> }));
vi.mock('@/components/mods/mod-card', () => ({ ModCard: () => <div data-testid="mod-card" /> }));

import { Sidebar } from '@/components/sidebar/sidebar';
import { BraindumpPane } from '@/components/shell/braindump-pane';
import { useSidebarStore } from '@/lib/sidebar-store';

beforeEach(() => {
  useSidebarStore.setState({ leftSidebarOpen: true, leftSidebarHovered: false, leftSidebarHoverEnabled: true });
});
afterEach(cleanup);

describe('the mod card under the braindump', () => {
  it('mounts between the braindump and the dock while the column is open', () => {
    render(<Sidebar />);
    const card = screen.getByTestId('mod-card');
    const order = [screen.getByTestId('braindump'), card, screen.getByTestId('sidebar-dock')];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not mounted while the column is closed or only peeking', () => {
    useSidebarStore.setState({ leftSidebarOpen: false, leftSidebarHovered: false });
    render(<Sidebar />);
    expect(screen.queryByTestId('mod-card')).toBeNull();
    cleanup();
    useSidebarStore.setState({ leftSidebarOpen: false, leftSidebarHovered: true, leftSidebarHoverEnabled: true });
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-column')).toHaveAttribute('data-column-state', 'peek');
    expect(screen.queryByTestId('mod-card')).toBeNull();
  });

  it('mounts after the braindump in the Console pane only while it is open', () => {
    render(<BraindumpPane />);
    expect(screen.getByTestId('mod-card')).toBeInTheDocument();
    cleanup();
    useSidebarStore.setState({ leftSidebarOpen: false });
    render(<BraindumpPane />);
    expect(screen.queryByTestId('mod-card')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The docked item panel scrolls (components/planner/surface.tsx), so its content passes under
// the desktop app's window-drag band; the column is a hole so that content stays clickable.
vi.mock('@/components/sidebar/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/views/view-router', () => ({ ViewRouter: () => null }));
vi.mock('@/components/views/season-notice', () => ({ SeasonNotice: () => null }));
vi.mock('@/components/notices/notice-slot', () => ({ DayHeaderNotice: () => null }));
vi.mock('@/components/canvas/week-scale', () => ({ WeekScale: () => null }));
vi.mock('@/components/canvas/header-capsule', () => ({ HeaderCapsule: () => null }));
vi.mock('@/components/planner/item-dialog', () => ({ ItemDialog: () => <div data-testid="panel-stub" /> }));

import { DesktopShell } from '@/components/shell/desktop-shell';

describe('<DesktopShell/> item panel column', () => {
  it('is a hole in the window-drag band', () => {
    render(<DesktopShell />);
    expect(screen.getByTestId('panel-stub').parentElement).toHaveClass('titlebar-hole');
  });
});

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The header capsule's Layout menu on Atlas (design PR2): four layouts, and
 * SelectMenu's disabled option. By goal shows "Turn on Goals" while Goals is
 * off and can't be picked; with Goals on it picks.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { HeaderCapsule } from '@/components/canvas/header-capsule';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EXT_GOALS } from '@/lib/extension-registry';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { disableExtensions, enableExtensions } from './support/extensions';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  useViewStore.setState({ scope: 'day', atlasLayout: 'map' });
  disableExtensions(EXT_GOALS);
});

function openLayout() {
  usePlannerStore.setState({ goalsAvailable: true, selectedDate: new Date('2026-03-10T12:00:00Z') });
  useViewStore.setState({ scope: 'atlas', atlasLayout: 'map' });
  render(<HeaderCapsule />);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Layout' }), { button: 0, ctrlKey: false });
}

describe('the Atlas Layout menu', () => {
  it('lists four layouts; By goal is disabled with its note while Goals is off', async () => {
    disableExtensions(EXT_GOALS);
    openLayout();
    const goal = await screen.findByTestId('select-option-goal');
    expect(screen.getByTestId('select-option-momentum')).toBeTruthy();
    expect(screen.getByTestId('select-option-timeline')).toBeTruthy();
    expect(goal.getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByTestId('select-option-note-goal').textContent).toBe(ATLAS_COPY.goalsOffNote);
    fireEvent.click(goal);
    expect(useViewStore.getState().atlasLayout).toBe('map');
  });

  it('picks By goal once Goals is on, and Timeline any time', async () => {
    enableExtensions(EXT_GOALS);
    openLayout();
    const goal = await screen.findByTestId('select-option-goal');
    expect(goal.getAttribute('data-disabled')).toBeNull();
    expect(screen.queryByTestId('select-option-note-goal')).toBeNull();
    fireEvent.click(goal);
    expect(useViewStore.getState().atlasLayout).toBe('goal');
  });
});

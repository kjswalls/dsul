import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * What waits on the user rides the Ask key (Kirby's pick, 2026-10-24):
 *
 *  - With Ask, a count in an aurora ring sits on the key's corner and the
 *    mark's top tile is raised; the header pill stays away.
 *  - The count peeks the inbox under the key and never toggles the rail.
 *  - With nothing drawn to hold the inbox, `openNeedsYou` (a grid block's
 *    short card) opens Ask home instead, whose Needs you lists every question.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('@/lib/agent-question', () => ({ answerAgentQuestion: vi.fn(() => true) }));
vi.mock('@/hooks/use-agent-question', () => ({
  useAgentQuestion: () => ({ options: [], ready: true, clear: () => {} }),
}));
vi.mock('@/lib/planner-ready', () => ({ usePlannerLoaded: () => true, isPlannerPreviewing: () => false }));

import { AskOpener } from '@/components/ai/rail/ask-opener';
import { NeedsYouBadge } from '@/components/ai/needs-you/needs-you-badge';
import { openNeedsYou } from '@/lib/needs-you-door';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { usePlannerStore } from '@/lib/planner-store';
import { railModeNow, useRailStore } from '@/lib/rail-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import type { Item } from '@/lib/planner-types';
import { seedAI, CONNECTED_MODEL, AI_HIDDEN } from './helpers/ai-fixtures';

const realMatchMedia = window.matchMedia;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

const ASKED = {
  id: 'a',
  type: 'task',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
  assignee: 'openclaw',
  aiStatus: 'blocked',
  aiStatusAt: '2026-10-24T01:00:00Z',
  aiResult: 'Tue or Thu?',
} as unknown as Item;

let unseed: () => void = () => {};

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  useRailStore.getState().reset();
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false });
  useNeedsYouStore.setState({ pending: {}, inbox: { open: false, focus: null }, hosts: 0 });
  usePlannerStore.setState({ items: [ASKED] });
  unseed = seedAI(CONNECTED_MODEL);
});

afterEach(() => {
  cleanup();
  unseed();
  window.matchMedia = realMatchMedia;
  useRailStore.getState().reset();
});

const renderRow = () =>
  render(
    <div className="flex">
      <NeedsYouBadge />
      <AskOpener className="ml-auto" />
    </div>
  );

describe('the Ask key carries the count', () => {
  it('draws the count and raises the mark, and the header pill stays away', () => {
    renderRow();
    const count = screen.getByTestId('ask-count');
    expect(count).toHaveTextContent('1');
    expect(count).toHaveAccessibleName('1 waiting on you');
    expect(document.querySelector('[data-ask-opener] [data-raised]')).not.toBeNull();
    expect(screen.queryByTestId('needs-you-badge')).toBeNull();
    // The key is where the inbox opens now.
    expect(useNeedsYouStore.getState().hosts).toBe(1);
  });

  it('peeks the inbox under the key, without opening Ask', () => {
    renderRow();
    fireEvent.click(screen.getByTestId('ask-count'));
    expect(useNeedsYouStore.getState().inbox.open).toBe(true);
    expect(screen.getByTestId('needs-you-inbox')).toHaveTextContent('Tue or Thu?');
    expect(railModeNow()).toBe('hidden');
  });

  it('says nothing while nothing waits', () => {
    usePlannerStore.setState({ items: [] });
    renderRow();
    expect(screen.queryByTestId('ask-count')).toBeNull();
    expect(document.querySelector('[data-ask-opener] [data-raised]')).toBeNull();
    expect(useNeedsYouStore.getState().hosts).toBe(0);
  });

  it('leaves the pill to an account with no Ask', () => {
    unseed();
    unseed = seedAI(AI_HIDDEN);
    renderRow();
    expect(screen.queryByTestId('ask-count')).toBeNull();
    expect(screen.getByTestId('needs-you-badge')).toHaveTextContent('1 to answer');
  });
});

describe('openNeedsYou', () => {
  it('opens the inbox where the count holds it', () => {
    renderRow();
    act(() => openNeedsYou('a'));
    expect(useNeedsYouStore.getState().inbox).toEqual({ open: true, focus: 'a' });
    expect(railModeNow()).toBe('hidden');
  });

  it('opens Ask home when nothing drawn holds the inbox', () => {
    act(() => openNeedsYou('a'));
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
    expect(railModeNow()).toBe('ask');
  });
});

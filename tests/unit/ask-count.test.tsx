import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import { AskOpener, PEEK_CLOSE_MS, PEEK_OPEN_MS } from '@/components/ai/rail/ask-opener';
import { NeedsYouBadge } from '@/components/ai/needs-you/needs-you-badge';
import { openNeedsYou } from '@/lib/needs-you-door';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { usePlannerStore } from '@/lib/planner-store';
import { railModeNow, useRailStore } from '@/lib/rail-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { ASK_OPEN_DEFAULT, useSidebarStore } from '@/lib/sidebar-store';
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
  useSidebarStore.setState({ askOpen: ASK_OPEN_DEFAULT });
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

describe('the card hangs from the key', () => {
  // jsdom lays nothing out, so the key alone gets a box: a card measured
  // against anything else (the count, or a node no longer in the page) reads
  // an anchor 0px wide and lands at the window's top left.
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return this.matches('[data-ask-opener]') && this.isConnected
        ? ({ x: 900, y: 16, left: 900, top: 16, right: 1050, bottom: 60, width: 150, height: 44, toJSON() {} } as DOMRect)
        : realRect.call(this);
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });

  it.each(['count', 'hover'])('anchors to the whole key when opened by the %s', async (how) => {
    renderRow();
    if (how === 'count') fireEvent.click(screen.getByTestId('ask-count'));
    else act(() => openNeedsYou());
    const wrapper = () => screen.getByTestId('needs-you-inbox').parentElement!;
    await waitFor(() => expect(wrapper().style.getPropertyValue('--radix-popper-anchor-width')).toBe('150px'));
    expect(wrapper().style.getPropertyValue('--radix-popper-anchor-height')).toBe('44px');
  });

  it('shuts again from the count, and a press on it is not a click away', () => {
    renderRow();
    const count = screen.getByTestId('ask-count');
    fireEvent.click(count);
    expect(count).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(count);
    fireEvent.click(count);
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
    expect(count).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the Ask key carries the count', () => {
  it('draws the count and leaves the mark as it is, and the header pill stays away', () => {
    renderRow();
    const count = screen.getByTestId('ask-count');
    expect(count).toHaveTextContent('1');
    expect(count).toHaveAccessibleName('1 waiting on you');
    // The count alone says something waits; the mark's head is its resting self.
    expect(document.querySelector('[data-ask-opener] [data-ask-mark] rect:last-child')?.getAttribute('class')).not.toMatch(/drop-shadow|(^|\s)scale-125/);
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

  it('keeps the key lit while the questions hang from it', () => {
    renderRow();
    const key = document.querySelector('[data-ask-opener]')!;
    expect(key).not.toHaveAttribute('data-peek');
    fireEvent.click(screen.getByTestId('ask-count'));
    expect(key).toHaveAttribute('data-peek');
    act(() => useNeedsYouStore.getState().closeInbox());
    expect(key).not.toHaveAttribute('data-peek');
  });

  it('says nothing while nothing waits', () => {
    usePlannerStore.setState({ items: [] });
    renderRow();
    expect(screen.queryByTestId('ask-count')).toBeNull();
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

describe('resting on the key peeks the questions', () => {
  const slot = () => document.querySelector<HTMLElement>('[data-ask-opener-slot]')!;
  const over = (el: Element, pointerType = 'mouse') => fireEvent.pointerOver(el, { pointerType });
  const out = (el: Element, pointerType = 'mouse') => fireEvent.pointerOut(el, { pointerType });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens after the delay, never at once, and drops the key tooltip', () => {
    renderRow();
    expect(document.querySelector('[data-ask-opener]')).not.toHaveAttribute('title');
    over(document.querySelector('[data-ask-opener]')!);
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS - 50));
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
    act(() => void vi.advanceTimersByTime(50));
    expect(useNeedsYouStore.getState().inbox.open).toBe(true);
    // A peek never takes the keyboard.
    expect(screen.getByTestId('needs-you-inbox')).not.toContainElement(document.activeElement as HTMLElement);
    expect(railModeNow()).toBe('hidden');
  });

  it('opens nothing for a pointer passing through', () => {
    renderRow();
    over(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS / 2));
    out(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS * 2));
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
  });

  it('waits for the pointer to cross into the card, and closes once it has gone', () => {
    renderRow();
    over(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS));
    out(slot());
    const card = screen.getByTestId('needs-you-inbox');
    over(card);
    act(() => void vi.advanceTimersByTime(PEEK_CLOSE_MS * 2));
    expect(useNeedsYouStore.getState().inbox.open).toBe(true);
    out(card);
    act(() => void vi.advanceTimersByTime(PEEK_CLOSE_MS));
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
  });

  it('stays once pressed in', () => {
    renderRow();
    over(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS));
    const card = screen.getByTestId('needs-you-inbox');
    fireEvent.pointerDown(card);
    out(slot());
    act(() => void vi.advanceTimersByTime(PEEK_CLOSE_MS * 2));
    expect(useNeedsYouStore.getState().inbox.open).toBe(true);
  });

  it('a press on the count over a peek keeps it open', () => {
    renderRow();
    over(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS));
    fireEvent.click(screen.getByTestId('ask-count'));
    out(slot());
    act(() => void vi.advanceTimersByTime(PEEK_CLOSE_MS * 2));
    expect(useNeedsYouStore.getState().inbox.open).toBe(true);
  });

  it('gives way to Ask when the key is pressed', () => {
    renderRow();
    over(slot());
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS));
    fireEvent.click(document.querySelector('[data-ask-opener]')!);
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
    expect(railModeNow()).toBe('ask');
  });

  it('never peeks for touch', () => {
    renderRow();
    over(slot(), 'touch');
    act(() => void vi.advanceTimersByTime(PEEK_OPEN_MS * 2));
    expect(useNeedsYouStore.getState().inbox.open).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * The tab icon (components/providers/favicon-sync.tsx): the picked look, or
 * Lime for the rest of a day whose items are all done. It rewrites the icon
 * links Next rendered in place, and never the apple-touch icon, which is
 * fixed at install time.
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

import { FaviconSync } from '@/components/providers/favicon-sync';
import { useLookStore } from '@/lib/look-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@dsul/types';

const TZ = 'America/New_York';
const DAY = '2026-08-10';
// 23:58 on DAY in New York (EDT, UTC-4).
const NEAR_MIDNIGHT = new Date('2026-08-11T03:58:00Z');

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h', title: 'Vitamins', project: 'G', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const ICONS = ['/icons/icon-16.png', '/icons/icon-32.png', '/icons/icon-192.png', '/icons/icon-512.png'];
const APPLE = '/icons/icon-180.png';

function seedHead() {
  document.head.innerHTML = '';
  for (const href of ICONS) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', href);
    document.head.appendChild(link);
  }
  const apple = document.createElement('link');
  apple.rel = 'apple-touch-icon';
  apple.setAttribute('href', APPLE);
  document.head.appendChild(apple);
}

const iconHrefs = () =>
  [...document.head.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href'));
const appleHref = () => document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
const LIME = ICONS.map((h) => h.replace('/icons/', '/icons/lime/'));

function seedPlanner(items: Item[], over: Record<string, unknown> = {}) {
  usePlannerStore.setState({
    userId: 'u1',
    isLoading: false,
    loadFailedUserId: null,
    userTimezone: TZ,
    items,
    routines: [],
    seasons: [],
    ...over,
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-08-10T16:00:00Z'));
  seedHead();
  useLookStore.setState({ appIcon: 'aurora', appIconKnown: false });
  seedPlanner([habit()]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.head.innerHTML = '';
});

describe('FaviconSync', () => {
  it('leaves Aurora in place on an open day with the default pick', () => {
    render(<FaviconSync />);
    expect(iconHrefs()).toEqual(ICONS);
  });

  it('swaps every tab icon to its lime twin for a Lime pick, and back for Aurora', () => {
    render(<FaviconSync />);
    act(() => useLookStore.getState().setAppIcon('lime'));
    expect(iconHrefs()).toEqual(LIME);

    act(() => useLookStore.getState().setAppIcon('aurora'));
    expect(iconHrefs()).toEqual(ICONS);
  });

  it('turns Lime once the day is cleared, with the setting on Aurora', () => {
    render(<FaviconSync />);
    expect(iconHrefs()).toEqual(ICONS);
    act(() => seedPlanner([habit({ completedDates: [DAY] })]));
    expect(iconHrefs()).toEqual(LIME);
  });

  it('does not read a load that has not settled, or one that failed', () => {
    seedPlanner([habit({ completedDates: [DAY] })], { isLoading: true });
    render(<FaviconSync />);
    expect(iconHrefs()).toEqual(ICONS);

    act(() => usePlannerStore.setState({ isLoading: false, loadFailedUserId: 'u1' } as never));
    expect(iconHrefs()).toEqual(ICONS);
  });

  it('goes back to Aurora when midnight passes in the user’s zone', () => {
    vi.setSystemTime(NEAR_MIDNIGHT);
    seedPlanner([habit({ completedDates: [DAY] })]);
    render(<FaviconSync />);
    expect(iconHrefs()).toEqual(LIME);

    // The minute tick re-renders an idle tab across the boundary.
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(iconHrefs()).toEqual(ICONS);
  });

  it('re-reads the day on coming back to the foreground', () => {
    vi.setSystemTime(NEAR_MIDNIGHT);
    seedPlanner([habit({ completedDates: [DAY] })]);
    render(<FaviconSync />);
    expect(iconHrefs()).toEqual(LIME);

    // A backgrounded tab's timers can be throttled straight through midnight:
    // the clock moves, no tick fires, and the tab comes back.
    vi.setSystemTime(new Date('2026-08-11T12:00:00Z'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(iconHrefs()).toEqual(ICONS);
  });

  it('puts right an href Next re-renders behind its back', async () => {
    render(<FaviconSync />);
    act(() => useLookStore.getState().setAppIcon('lime'));
    const first = document.head.querySelector('link[rel="icon"]')!;
    first.setAttribute('href', ICONS[0]);
    // MutationObserver callbacks are microtasks.
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.getAttribute('href')).toBe(LIME[0]);
  });

  it('never touches the apple-touch icon', () => {
    render(<FaviconSync />);
    act(() => useLookStore.getState().setAppIcon('lime'));
    expect(appleHref()).toBe(APPLE);
    act(() => seedPlanner([habit({ completedDates: [DAY] })]));
    expect(appleHref()).toBe(APPLE);
  });
});

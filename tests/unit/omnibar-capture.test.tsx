import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';

/**
 * The omnibar's `+` capture while the planner's load is in flight.
 *
 * Same contract as the braindump's quick-add row (lib/held-captures.ts): Enter
 * holds the title and it lands once the load finishes, for the account it was
 * typed under. Everything AROUND the add is unchanged — the launcher still
 * closes, the dock still clears and refocuses — so the bar behaves the same
 * whether the add is immediate or held. An intended fix as well as a guard:
 * a capture typed during a cold load used to be erased by the landing set().
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
// The omnibar's command context reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Omnibar } from '@/components/sidebar/omnibar';
import { OmniLauncher } from '@/components/shell/omni-launcher';
import { projectItems, usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useDeferredDialogPromotion } from '@/hooks/use-deferred-dialog';
import { __resetHeldCapturesForTests, useHeldCaptures } from '@/lib/held-captures';
import type { Item } from '@/lib/planner-types';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const pristine = usePlannerStore.getState();

/** Cached rows on screen, the load still out: the look-only preview. */
const seedPreview = () =>
  usePlannerStore.setState({ userId: 'u1', isLoading: true, isPreview: true, error: null });
/** The fresh data lands; held captures follow in a microtask. */
const land = () =>
  act(async () => {
    usePlannerStore.setState({ isLoading: false, isPreview: false });
    await Promise.resolve();
  });

const inputIn = (variant: 'dock' | 'launcher') =>
  document.querySelector(
    `[data-omnibar-variant="${variant}"] [data-testid="omnibar-input"]`
  ) as HTMLInputElement;
const capture = (variant: 'dock' | 'launcher', text: string) => {
  const input = inputIn(variant);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
};
const titled = (title: string) => usePlannerStore.getState().items.filter((i) => i.title === title);

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  useUIStore.setState({ activeDialog: null, deferredDialog: null, confirmRequest: null });
  __resetHeldCapturesForTests();
});
afterEach(() => {
  cleanup();
  __resetHeldCapturesForTests();
  usePlannerStore.setState(pristine, true);
});

describe('the omnibar capture before the planner has loaded', () => {
  it('holds a dock capture, clears and refocuses as for an add, and lands it once', async () => {
    seedPreview();
    render(<Omnibar variant="dock" />);

    capture('dock', '+Gamma');

    expect(titled('Gamma')).toHaveLength(0);
    expect(useHeldCaptures.getState().held).toEqual([{ userId: 'u1', title: 'Gamma' }]);
    expect(inputIn('dock').value).toBe('');
    expect(document.activeElement).toBe(inputIn('dock'));

    await land();
    expect(titled('Gamma')).toHaveLength(1);
    expect(useHeldCaptures.getState().held).toEqual([]);
  });

  it('closes the launcher as for an add, and the held capture outlives it', async () => {
    seedPreview();
    useUIStore.setState({ activeDialog: { type: 'launcher' } });
    const { unmount } = render(<Omnibar variant="launcher" />);

    capture('launcher', '+Gamma');

    expect(useUIStore.getState().activeDialog).toBeNull();
    unmount();

    await land();
    expect(titled('Gamma')).toHaveLength(1);
  });

  it('defers an empty + from the launcher and closes it, so the dialog can open at landing', () => {
    seedPreview();
    useUIStore.setState({ activeDialog: { type: 'launcher' } });
    render(<Omnibar variant="launcher" />);

    capture('launcher', '+');

    // The promotion (hooks/use-deferred-dialog.ts) opens only into a free slot.
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().deferredDialog).toMatchObject({ type: 'add', tab: 'task' });
  });

  it('adds at once when loaded, as it always has', () => {
    usePlannerStore.setState({ userId: 'u1', isLoading: false, error: null });
    render(<Omnibar variant="dock" />);

    capture('dock', '+Gamma');

    expect(titled('Gamma')).toHaveLength(1);
    expect(useHeldCaptures.getState().held).toEqual([]);
  });
});

/**
 * The launcher's other two ways into a data dialog: picking a search result
 * (the item) and pasting a list (bulk-add). Over the preview both are DEFERRED
 * (lib/ui-store.ts), so the launcher must give up the one slot itself, or its
 * promotion at landing (hooks/use-deferred-dialog.ts) finds the slot taken.
 * Through the real host (OmniLauncher) and the real promoter.
 */
describe('the launcher hands the slot back when what it opens is deferred', () => {
  const row = (title: string): Item =>
    ({ type: 'task', id: 'item-1', title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as unknown as Item;

  const previewWith = (item: Item) =>
    usePlannerStore.setState({ userId: 'u1', isLoading: true, isPreview: true, error: null, userTimezone: 'UTC', ...projectItems([item]) });
  const landWith = (item: Item) =>
    act(async () => {
      usePlannerStore.setState({ isLoading: false, isPreview: false, ...projectItems([item]) });
      await Promise.resolve();
    });
  const openLauncher = () => {
    renderHook(() => useDeferredDialogPromotion());
    render(<OmniLauncher />);
    act(() => useUIStore.getState().openDialog({ type: 'launcher' }));
    const input = inputIn('launcher');
    fireEvent.focus(input);
    return input;
  };
  const launcherShown = () => !!document.querySelector('[data-omnibar-variant="launcher"]');

  it('a picked result closes the launcher, and the item opens on the fresh row at landing', async () => {
    previewWith(row('Zebra errand'));
    const input = openLauncher();
    fireEvent.change(input, { target: { value: 'Zebra' } });
    expect(document.querySelectorAll('[data-testid="omnibar-result"]')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().deferredDialog).toMatchObject({ type: 'edit-item', item: { id: 'item-1' } });

    await landWith(row('Zebra errand, renamed elsewhere'));
    expect(useUIStore.getState().activeDialog).toMatchObject({
      type: 'edit-item',
      item: { id: 'item-1', title: 'Zebra errand, renamed elsewhere' },
    });
    expect(useUIStore.getState().deferredDialog).toBeNull();
    expect(launcherShown()).toBe(false);
  });

  it('a pasted list closes the launcher, and opens in bulk-add at landing', async () => {
    previewWith(row('Zebra errand'));
    const input = openLauncher();
    const kept = fireEvent.paste(input, { clipboardData: { getData: () => 'one\ntwo\nthree' } });
    // Consumed by the field: the dialog is the only place the text is now.
    expect(kept).toBe(false);

    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().deferredDialog).toEqual({ type: 'bulk-add', text: 'one\ntwo\nthree' });

    await landWith(row('Zebra errand'));
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'bulk-add', text: 'one\ntwo\nthree' });
    expect(useUIStore.getState().deferredDialog).toBeNull();
  });

  it('on loaded data, a pick opens the item at once, as it always has', () => {
    usePlannerStore.setState({ userId: 'u1', isLoading: false, isPreview: false, error: null, userTimezone: 'UTC', ...projectItems([row('Zebra errand')]) });
    const input = openLauncher();
    fireEvent.change(input, { target: { value: 'Zebra' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'item-1' } });
    expect(useUIStore.getState().deferredDialog).toBeNull();
  });
});

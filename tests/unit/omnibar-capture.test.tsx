import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

/**
 * The omnibar's `+` capture before the planner has LOADED.
 *
 * Same contract as the braindump's quick-add row (lib/held-captures.ts): Enter
 * holds the title and it lands once fresh data does, for the account it was
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
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { __resetHeldCapturesForTests, useHeldCaptures } from '@/lib/held-captures';

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
  useUIStore.setState({ activeDialog: null, deferredDialog: null });
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

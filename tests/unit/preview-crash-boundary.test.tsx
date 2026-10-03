import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Component, type ReactNode } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

/**
 * A cached planner must never be able to break the app (instant planner,
 * design D16 / §7).
 *
 * The look-only preview renders the real views over rows this browser saved
 * last session. If those rows make a render throw, PreviewCrashBoundary drops
 * the preview (the skeleton shows until the in-flight load lands), deletes the
 * snapshot so the next reload doesn't crash the same way, and renders the
 * shell again. A throw that is not the preview's goes on up, exactly as if the
 * boundary weren't there — and nothing loops.
 */

const snapshot = vi.hoisted(() => ({ clearPlannerSnapshot: vi.fn() }));
vi.mock('@/lib/planner-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner-snapshot')>()),
  clearPlannerSnapshot: snapshot.clearPlannerSnapshot,
}));

import { PreviewCrashBoundary } from '@/components/shell/preview-crash-boundary';
import { PlannerSkeleton } from '@/components/primitives/planner-skeleton';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerVisible } from '@/lib/planner-ready';
import type { Item } from '@/lib/planner-types';

const U = 'user-a';

const task = (id: string, title: unknown): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as Item;

/** Last session's rows, one in a shape this build's render no longer survives. */
const CACHED = () => [task('t-ok', 'Cached title'), task('t-bad', null)];
const FRESH = () => [task('t-ok', 'Fresh title'), task('t-new', 'Made elsewhere')];

/** The planner as the preview leaves it: cached rows, still loading. */
function previewing() {
  const items = CACHED();
  usePlannerStore.setState({
    userId: U,
    isLoading: true,
    isPreview: true,
    error: null,
    loadFailedUserId: null,
    items,
    tasks: items as never,
    habits: [] as never,
  } as never);
}

/** The success landing: fresh rows, isPreview and isLoading cleared in one set(). */
function landFresh() {
  const items = FRESH();
  usePlannerStore.setState({
    isLoading: false,
    isPreview: false,
    items,
    tasks: items as never,
  } as never);
}

/** Counts child renders; a call, not a reassigned global, so the render stays pure to the linter. */
const rendered = vi.fn();
const renders = () => rendered.mock.calls.length;

/** A stand-in for the routers: the skeleton until visible, then a row per item. */
function Planner() {
  rendered();
  const visible = usePlannerVisible();
  const items = usePlannerStore((s) => s.items);
  if (!visible) return <PlannerSkeleton variant="list" scope="day" />;
  return (
    <ul>
      {items.map((i) => (
        // `.trim()` on a null title: the cached row's shape is what throws.
        <li key={i.id} data-testid="row">
          {(i.title as string).trim()}
        </li>
      ))}
    </ul>
  );
}

/** Throws whatever the store holds — preview or not. */
function AlwaysThrows(): ReactNode {
  rendered();
  throw new Error('a bug of our own');
}

/** What sits above AppShell when a throw is not the preview's: whatever catches next. */
class Parent extends Component<{ children: ReactNode }, { caught: unknown }> {
  state = { caught: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { caught: error };
  }
  render() {
    if (this.state.caught) return <p data-testid="parent-fallback">{String(this.state.caught)}</p>;
    return this.props.children;
  }
}

const tree = (child: ReactNode) => (
  <Parent>
    <PreviewCrashBoundary>{child}</PreviewCrashBoundary>
  </Parent>
);

beforeEach(() => {
  rendered.mockClear();
  snapshot.clearPlannerSnapshot.mockClear();
  // React reports every caught render error to console.error; the boundary warns.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePlannerStore.getState().clearStore();
});

describe('PreviewCrashBoundary', () => {
  it('drops a preview that throws, deletes the snapshot, shows the skeleton — then the fresh rows at landing', () => {
    previewing();
    render(tree(<Planner />));

    // Dropped: data emptied, still loading, so the skeleton stands in.
    const s = usePlannerStore.getState();
    expect(s.isPreview).toBe(false);
    expect(s.isLoading).toBe(true);
    expect(s.items).toEqual([]);
    expect(screen.getByTestId('planner-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('row')).toBeNull();
    expect(snapshot.clearPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[preview]'),
      expect.any(TypeError)
    );
    // Never reached the parent: the page stayed up.
    expect(screen.queryByTestId('parent-fallback')).toBeNull();

    // The in-flight load lands normally on the re-rendered shell.
    act(landFresh);
    expect(screen.queryByTestId('planner-skeleton')).toBeNull();
    expect(screen.getAllByTestId('row').map((r) => r.textContent)).toEqual(['Fresh title', 'Made elsewhere']);
    expect(snapshot.clearPlannerSnapshot).toHaveBeenCalledTimes(1);
  });

  it('renders the preview through untouched when nothing throws', () => {
    const items = [task('t-ok', 'Cached title')];
    previewing();
    usePlannerStore.setState({ items, tasks: items as never } as never);
    render(tree(<Planner />));
    expect(usePlannerStore.getState().isPreview).toBe(true);
    expect(screen.getByTestId('row')).toHaveTextContent('Cached title');
    expect(snapshot.clearPlannerSnapshot).not.toHaveBeenCalled();
  });

  it('rethrows a throw while NOT previewing to the parent boundary, touching nothing', () => {
    landFresh();
    usePlannerStore.setState({ userId: U, error: null, loadFailedUserId: null });
    const before = usePlannerStore.getState().items;
    render(tree(<AlwaysThrows />));

    expect(screen.getByTestId('parent-fallback')).toHaveTextContent('a bug of our own');
    expect(snapshot.clearPlannerSnapshot).not.toHaveBeenCalled();
    expect(usePlannerStore.getState().items).toBe(before);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('rethrows when the store cannot drop (a mock, a broken store) rather than swallowing', () => {
    previewing();
    vi.spyOn(usePlannerStore, 'getState').mockImplementation(() => {
      throw new Error('no store');
    });
    render(tree(<AlwaysThrows />));
    expect(screen.getByTestId('parent-fallback')).toHaveTextContent('a bug of our own');
    expect(snapshot.clearPlannerSnapshot).not.toHaveBeenCalled();
  });

  it('does not loop: a child that throws with or without the preview is dropped once, then handed on', () => {
    previewing();
    render(tree(<AlwaysThrows />));

    // One drop, one snapshot clear, then the retry (now not previewing) throws
    // again and goes to the parent instead of round again.
    expect(snapshot.clearPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(usePlannerStore.getState().isPreview).toBe(false);
    expect(screen.getByTestId('parent-fallback')).toHaveTextContent('a bug of our own');
    // React may retry a throwing render once per attempt; two attempts, bounded.
    expect(renders()).toBeGreaterThanOrEqual(2);
    expect(renders()).toBeLessThanOrEqual(4);
  });

  it('counts a falsy throw as a throw (no render-the-children-again loop on `throw null`)', () => {
    function ThrowsNull(): ReactNode {
      rendered();
      throw null;
    }
    landFresh();
    usePlannerStore.setState({ userId: U });
    // The parent's own fallback keys on a truthy error, so wrap it in one that does not.
    class Catches extends Component<{ children: ReactNode }, { caught: boolean }> {
      state = { caught: false };
      static getDerivedStateFromError() {
        return { caught: true };
      }
      render() {
        return this.state.caught ? <p data-testid="caught" /> : this.props.children;
      }
    }
    render(
      <Catches>
        <PreviewCrashBoundary>
          <ThrowsNull />
        </PreviewCrashBoundary>
      </Catches>
    );
    expect(screen.getByTestId('caught')).toBeInTheDocument();
    expect(renders()).toBeLessThanOrEqual(4);
  });
});

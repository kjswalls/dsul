import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useEffect } from 'react';

/**
 * The look-only preview's two signals (instant planner, design §10 and §9.4):
 *
 *  - PlannerSyncLine: the neutral 2px hairline over the canvas while this
 *    browser's copy of the last session is up. It completes ("done", then
 *    gone when its sweep ends) only over a real landing it was visibly up
 *    for; a failed load, a crash drop, an account change, reduced motion or a
 *    landing inside the delay end it at once. Never lime.
 *  - SettleHost: the preview's ONE announcement (the lines are aria-hidden),
 *    and the conductor's React end — painted tracking two frames after the
 *    preview commits, the landing in a layout effect.
 */

const settle = vi.hoisted(() => ({
  unregister: vi.fn(),
  registerSettleHost: vi.fn(),
  notePreviewPainted: vi.fn(),
  onLandingCommitted: vi.fn(),
  finishSettle: vi.fn(),
}));
vi.mock('@/lib/settle', () => settle);

import {
  PlannerSyncLine,
  SYNC_LINE_DELAY_MS,
  SYNC_LINE_DONE_MS,
  SYNC_LINE_SWEEP,
} from '@/components/shell/planner-sync-line';
import { PREVIEW_STATUS_TEXT, SettleHost } from '@/components/shell/settle-host';
import { usePlannerStore } from '@/lib/planner-store';

const U = 'user-a';
const base = { error: null, loadFailedUserId: null };

/** The cached planner is up: still loading, previewing. */
const previewing = () => usePlannerStore.setState({ ...base, userId: U, isLoading: true, isPreview: true });
/** The success landing: isPreview and isLoading cleared in one set(). */
const land = () => usePlannerStore.setState({ ...base, userId: U, isLoading: false, isPreview: false });
/** The failure drop (design D5): empty, settled, failed — in one set(). */
const fail = () =>
  usePlannerStore.setState({ userId: U, isLoading: false, isPreview: false, error: 'offline', loadFailedUserId: U });
/** dropPreview (the crash boundary): empty, still loading. */
const crashDrop = () => usePlannerStore.setState({ isPreview: false, items: [] });
/** identifyUser(B): another account, empty, loading. */
const switchAccount = () =>
  usePlannerStore.setState({ ...base, userId: 'user-b', isLoading: true, isPreview: false, items: [] });

const line = () => screen.queryByTestId('planner-sync-line');

/** jsdom plays no animation and has no AnimationEvent: the end of one, named, as a browser reports it. */
function animationEnd(el: Element, animationName: string) {
  const end = new Event('animationend', { bubbles: true });
  Object.defineProperty(end, 'animationName', { value: animationName });
  act(() => {
    el.dispatchEvent(end);
  });
}

/** rAF under the test's control, so frames stand still while timers run. */
function holdFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(next, cb);
    return next++;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    pending: () => frames.size,
    flush: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(performance.now());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  usePlannerStore.setState({ ...base, userId: U, isLoading: false, isPreview: false });
});
afterEach(() => {
  cleanup();
  // Spies first: they wrap the fake timers' rAF, which useRealTimers then removes.
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-reduce-motion');
});

describe('PlannerSyncLine', () => {
  it('is absent at rest', () => {
    render(<PlannerSyncLine />);
    expect(line()).toBeNull();
  });

  it('is absent while loading with nothing to preview (the skeleton is the signal there)', () => {
    usePlannerStore.setState({ userId: U, isLoading: true, isPreview: false });
    render(<PlannerSyncLine />);
    expect(line()).toBeNull();
  });

  it('syncs while previewing: aria-hidden, the placement class passed through', () => {
    previewing();
    render(<PlannerSyncLine className="absolute inset-x-0 top-0 z-[5]" />);
    const el = line()!;
    expect(el).toHaveAttribute('data-state', 'syncing');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveClass('planner-sync-line', 'absolute', 'inset-x-0');
    expect(el.querySelector('.planner-sync-line__track > .planner-sync-line__bar')).not.toBeNull();
  });

  it('appears when the preview starts after mount', () => {
    usePlannerStore.setState({ userId: U, isLoading: true, isPreview: false });
    render(<PlannerSyncLine />);
    expect(line()).toBeNull();
    act(previewing);
    expect(line()).toHaveAttribute('data-state', 'syncing');
  });

  it(`completes on the SAME element, then is gone when its sweep ends, when it was up ≥${SYNC_LINE_DELAY_MS}ms`, () => {
    previewing();
    render(<PlannerSyncLine />);
    const el = line()!;
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 200));
    act(land);
    // The same node: an unmount between the two would restart the root's fade-in.
    expect(line()).toBe(el);
    expect(el).toHaveAttribute('data-state', 'done');
    // Other animations ending on or under the root are not the sweep: the
    // track's fade-out bubbles up, and the root's own fade-in can end mid-done.
    animationEnd(el.querySelector('.planner-sync-line__track')!, 'planner-sync-track-out');
    animationEnd(el, 'planner-sync-in');
    expect(line()).toBe(el);
    animationEnd(el, SYNC_LINE_SWEEP);
    expect(line()).toBeNull();
  });

  it("is not cut short by a landing's synchronous work: nothing counts until two frames have passed", () => {
    // The timer's old start was the landing's own passive effect, which runs
    // inside the landing's task, before the browser has even started the
    // sweep. Work after it (a held capture's addTask) spent the margin, and
    // the line vanished mid-fade. Frames stand still here, as they do while
    // that work runs.
    const raf = holdFrames();
    previewing();
    render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 200));
    act(land);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DONE_MS * 3));
    expect(line()).toHaveAttribute('data-state', 'done');
    act(raf.flush);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DONE_MS * 3));
    expect(line()).toHaveAttribute('data-state', 'done');
    // Then a backstop, for a sweep that never reports its end.
    act(raf.flush);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DONE_MS - 1));
    expect(line()).toHaveAttribute('data-state', 'done');
    act(() => vi.advanceTimersByTime(1));
    expect(line()).toBeNull();
  });

  it('completes at exactly the delay (the boundary is inclusive)', () => {
    previewing();
    render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS));
    act(land);
    expect(line()).toHaveAttribute('data-state', 'done');
  });

  it('is gone at once on a landing before the delay — it was never visible', () => {
    previewing();
    render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS - 1));
    act(land);
    expect(line()).toBeNull();
  });

  const ENDINGS: [string, () => void][] = [
    ['a failed load', fail],
    ['a crash drop', crashDrop],
    ['an account change', switchAccount],
  ];
  for (const [name, end] of ENDINGS) {
    it(`is gone at once on ${name} — nothing synced, so nothing completes`, () => {
      previewing();
      render(<PlannerSyncLine />);
      act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
      act(end);
      expect(line()).toBeNull();
      // …and stays gone: no done timer was left behind.
      act(() => vi.advanceTimersByTime(SYNC_LINE_DONE_MS * 2));
      expect(line()).toBeNull();
    });
  }

  it('is gone at once under the in-app animations toggle', () => {
    previewing();
    render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    act(land);
    expect(line()).toBeNull();
  });

  it('is gone at once under the OS reduced-motion preference', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    );
    previewing();
    render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
    act(land);
    expect(line()).toBeNull();
  });

  it('clears its frames and its backstop on unmount', () => {
    const raf = holdFrames();
    previewing();
    const view = render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
    act(land);
    expect(line()).toHaveAttribute('data-state', 'done');
    act(raf.flush);
    expect(raf.pending()).toBe(1);
    act(raf.flush);
    expect(raf.pending()).toBe(0);
    const pending = vi.getTimerCount();
    view.unmount();
    expect(vi.getTimerCount()).toBe(pending - 1);
  });

  it('cancels its frames on an unmount before them', () => {
    const raf = holdFrames();
    previewing();
    const view = render(<PlannerSyncLine />);
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
    act(land);
    expect(raf.pending()).toBe(1);
    view.unmount();
    expect(raf.pending()).toBe(0);
  });

  it('carries no primary, success, lime or accent class or token, syncing or done', () => {
    const COLOURED = /accent|lime|success|primary|priority/;
    previewing();
    const { container } = render(<PlannerSyncLine className="absolute inset-x-0 top-0 z-[5]" />);
    const check = () => {
      const els = [...container.querySelectorAll('*')];
      // Guard the guard: a line that rendered nothing passes vacuously.
      expect(els.length).toBeGreaterThanOrEqual(3);
      const offenders = els.filter(
        (el) => COLOURED.test(el.getAttribute('class') ?? '') || COLOURED.test(el.getAttribute('style') ?? '')
      );
      expect(offenders.map((el) => el.getAttribute('class'))).toEqual([]);
    };
    check();
    act(() => vi.advanceTimersByTime(SYNC_LINE_DELAY_MS + 500));
    act(land);
    expect(line()).toHaveAttribute('data-state', 'done');
    check();
  });
});

describe('SettleHost', () => {
  /** rAF under the test's control: the painted mark is "two frames later". */
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const flushFrame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(performance.now());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    settle.registerSettleHost.mockImplementation(() => settle.unregister);
    frames = new Map();
    nextFrame = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
  });

  const status = () => screen.getByTestId('planner-preview-status');

  it('announces the preview — and only the preview — in one polite status', () => {
    render(<SettleHost />);
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()).toHaveAttribute('aria-live', 'polite');
    expect(status()).toHaveClass('sr-only');
    expect(status()).toHaveTextContent(/^$/);

    act(previewing);
    expect(status()).toHaveTextContent(PREVIEW_STATUS_TEXT);
    expect(screen.getAllByRole('status')).toHaveLength(1);

    act(land);
    expect(status()).toHaveTextContent(/^$/);
  });

  it('says nothing over a failed load or a crash drop either', () => {
    previewing();
    render(<SettleHost />);
    expect(status()).toHaveTextContent(PREVIEW_STATUS_TEXT);
    act(fail);
    expect(status()).toHaveTextContent(/^$/);

    act(previewing);
    act(crashDrop);
    expect(status()).toHaveTextContent(/^$/);
  });

  it('registers once with the conductor, and unregisters on unmount', () => {
    const view = render(<SettleHost />);
    expect(settle.registerSettleHost).toHaveBeenCalledTimes(1);
    expect(settle.unregister).not.toHaveBeenCalled();
    view.unmount();
    expect(settle.unregister).toHaveBeenCalledTimes(1);
  });

  it('marks the preview painted two frames after it commits — not one', () => {
    render(<SettleHost />);
    act(previewing);
    expect(settle.notePreviewPainted).not.toHaveBeenCalled();
    flushFrame();
    expect(settle.notePreviewPainted).not.toHaveBeenCalled();
    flushFrame();
    expect(settle.notePreviewPainted).toHaveBeenCalledTimes(1);
  });

  it('never marks a preview that landed before it painted', () => {
    render(<SettleHost />);
    act(previewing);
    flushFrame();
    act(land);
    flushFrame();
    flushFrame();
    expect(settle.notePreviewPainted).not.toHaveBeenCalled();
  });

  it('hands the landing to the conductor in a layout effect, on the preview → not-preview edge', () => {
    previewing();
    render(<SettleHost />);
    expect(settle.onLandingCommitted).not.toHaveBeenCalled();
    act(land);
    expect(settle.onLandingCommitted).toHaveBeenCalledTimes(1);
    // Nothing else re-fires it: a later store change is not a landing.
    act(() => usePlannerStore.setState({ items: [] }));
    expect(settle.onLandingCommitted).toHaveBeenCalledTimes(1);
  });

  it('runs the landing BEFORE the browser can paint the fresh rows — a layout effect, not a passive one', () => {
    previewing();
    const order: string[] = [];
    settle.onLandingCommitted.mockImplementation(() => order.push('landing'));
    // A passive effect on the same edge, in the same commit: layout effects all run first.
    function Probe() {
      const isPreview = usePlannerStore((s) => s.isPreview);
      useEffect(() => {
        if (!isPreview) order.push('passive');
      }, [isPreview]);
      return null;
    }
    render(
      <>
        <Probe />
        <SettleHost />
      </>
    );
    act(land);
    expect(order).toEqual(['landing', 'passive']);
  });

  it('a mount is not a landing: mounting over a settled planner hands the conductor nothing', () => {
    render(<SettleHost />);
    expect(settle.onLandingCommitted).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed load', fail],
    ['a crash drop', crashDrop],
    ['an account change', switchAccount],
  ])('hands over %s too — every way the preview ends — and the conductor decides it captured nothing', (_, end) => {
    previewing();
    render(<SettleHost />);
    act(end);
    expect(settle.onLandingCommitted).toHaveBeenCalledTimes(1);
  });
});

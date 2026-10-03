import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const renders = vi.hoisted(() => ({ braindump: 0 }));
vi.mock('@/components/sidebar/braindump', () => ({
  Braindump: () => {
    renders.braindump += 1;
    return null;
  },
}));
vi.mock('@/components/sidebar/sidebar-dock', () => ({ SidebarDock: () => null }));

import { Sidebar } from '@/components/sidebar/sidebar';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, useSidebarStore } from '@/lib/sidebar-store';
import { RAIL_RESERVE_PX, useRailStore } from '@/lib/rail-store';

/**
 * The braindump beside a docked right rail (an item, or Ask resting open:
 * Kirby's 1280 window). The column YIELDS: it renders at
 * max(MIN, min(stored, 1280 - 520 - 432)) = 328 while the rail is docked, so
 * the day keeps its 520, and goes back to the stored width when the rail
 * closes. The yield is never written to the store (lib/sidebar-store.ts
 * renderedSidebarWidth). The sash shows and steps from what renders, and
 * caps its growth with the reserve (clampSidebarGrowth); a gesture that cannot
 * move the column, or that ends where it began, writes nothing, so the stored
 * width survives every press, tremor and wobble. Only the column's first frame
 * lands a width at once; every change of the stored width after it eases.
 */

const realRect = HTMLElement.prototype.getBoundingClientRect;
const realInnerWidth = window.innerWidth;
const realMatchMedia = window.matchMedia;

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

const setViewport = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });

beforeEach(() => {
  setViewport(1280);
  // The column as laid out: what a drag starts from.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.testid === 'sidebar-column') {
      const w = parseFloat(document.documentElement.style.getPropertyValue('--sidebar-w')) || 0;
      return { x: 12, y: 12, left: 12, top: 12, width: w, height: 776, right: 12 + w, bottom: 788, toJSON() {} } as DOMRect;
    }
    return realRect.call(this);
  };
  useSidebarStore.setState({
    leftSidebarOpen: true,
    leftSidebarHovered: false,
    leftSidebarHoverEnabled: false,
    leftSidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
  useRailStore.getState().setReserve(RAIL_RESERVE_PX);
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  setViewport(realInnerWidth);
  window.matchMedia = realMatchMedia;
  document.documentElement.removeAttribute('data-reduce-motion');
  useRailStore.getState().setReserve(0);
  document.documentElement.style.removeProperty('--sidebar-w');
});

const handle = () => screen.getByTestId('sidebar-resize-handle');
const column = () => screen.getByTestId('sidebar-column');
const stored = () => useSidebarStore.getState().leftSidebarWidth;
const published = () => document.documentElement.style.getPropertyValue('--sidebar-w');
const dock = (o?: { instant?: boolean }) => act(() => useRailStore.getState().setReserve(RAIL_RESERVE_PX, o));
const undock = () => act(() => useRailStore.getState().setReserve(0));
const resize = (w: number) =>
  act(() => {
    setViewport(w);
    window.dispatchEvent(new Event('resize'));
  });
/** The column's first frame is over: its mount-only instant landing is spent. */
const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
const valueNow = () => handle().getAttribute('aria-valuenow');
/** A sash drag: down at `from`, through each of `moves`, up at the last. */
function drag(target: HTMLElement, from: number, ...moves: number[]) {
  fireEvent.pointerDown(target, { button: 0, clientX: from, pointerId: 1 });
  for (const x of moves) fireEvent.pointerMove(handle(), { clientX: x, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientX: moves.at(-1) ?? from, pointerId: 1 });
}

/**
 * Every write of --sidebar-w, with whether the column's transition was held
 * off for it (publishInstant): `true` lands at once, `false` eases.
 */
function recordPublishes() {
  const style = document.documentElement.style;
  const real = style.setProperty.bind(style);
  const writes: Array<{ px: string; instant: boolean }> = [];
  const spy = vi
    .spyOn(style, 'setProperty')
    .mockImplementation((name: string, value: string | null, priority?: string) => {
      if (name === '--sidebar-w') {
        const col = document.querySelector<HTMLElement>('[data-testid="sidebar-column"]');
        writes.push({ px: String(value), instant: col?.style.transition === 'none' });
      }
      return real(name, value, priority);
    });
  return { writes, restore: () => spy.mockRestore() };
}

function reduceMotion() {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

describe('the braindump yields to a docked rail', () => {
  it('renders at the yielded width while the rail is docked, and never stores it', () => {
    render(<Sidebar />);
    expect(published()).toBe('328px');
    expect(stored()).toBe(406);
    expect(handle()).toHaveAttribute('aria-valuenow', '328');
  });

  it('gives the stored width back when the rail closes, and yields again when it docks', () => {
    render(<Sidebar />);
    undock();
    expect(published()).toBe('406px');
    expect(handle()).toHaveAttribute('aria-valuenow', '406');
    dock();
    expect(published()).toBe('328px');
    undock();
    expect(published()).toBe('406px');
    expect(stored()).toBe(406);
  });

  it('follows the window: yields less as it grows, down to MIN as it shrinks', () => {
    render(<Sidebar />);
    resize(1300); // 1300 - 952
    expect(published()).toBe('348px');
    resize(1600); // room for all of it
    expect(published()).toBe('406px');
    resize(1181); // the narrowest that docks: 229, floored
    expect(published()).toBe(`${SIDEBAR_MIN_WIDTH}px`);
    resize(1280);
    expect(published()).toBe('328px');
    expect(stored()).toBe(406);
  });

  it('does not yield while nothing is held back (the rail hidden, or overlaying)', () => {
    // RailColumn publishes 0 for both (rail-desktop.test.tsx pins that side).
    undock();
    render(<Sidebar />);
    expect(published()).toBe('406px');
    resize(1100);
    expect(published()).toBe('406px');
  });

  it('eases a yield as the rail docks, and lands it at once for the boot reveal', () => {
    undock();
    render(<Sidebar />);
    const rec = recordPublishes();
    try {
      dock();
      expect(rec.writes.at(-1)).toEqual({ px: '328px', instant: false });
      undock();
      expect(rec.writes.at(-1)).toEqual({ px: '406px', instant: false });
      // The rail's own instant first reveal (Ask resting open at launch).
      dock({ instant: true });
      expect(rec.writes.at(-1)).toEqual({ px: '328px', instant: true });
      // The hold-off is for that one change: the transition is back after it.
      expect(column().style.transition).toBe('');
    } finally {
      rec.restore();
    }
  });

  it('lands the yield at once when it mounts beside a rail already docked', () => {
    const rec = recordPublishes();
    try {
      render(<Sidebar />);
      expect(rec.writes[0]).toEqual({ px: '328px', instant: true });
    } finally {
      rec.restore();
    }
    // With nothing docked the mount publishes as it always has.
    cleanup();
    undock();
    const again = recordPublishes();
    try {
      render(<Sidebar />);
      expect(again.writes[0]).toEqual({ px: '406px', instant: false });
    } finally {
      again.restore();
    }
  });

  it('lands a second publish in its first frame at once too: the persisted width hydrating', async () => {
    const rec = recordPublishes();
    try {
      render(<Sidebar />);
      // zustand's server snapshot is the default; the persisted width lands
      // a commit later, in the same frame.
      act(() => useSidebarStore.setState({ leftSidebarWidth: 300 }));
      expect(rec.writes.at(-1)).toEqual({ px: '300px', instant: true });
      await nextFrame();
      act(() => useSidebarStore.setState({ leftSidebarWidth: 290 }));
      expect(rec.writes.at(-1)).toEqual({ px: '290px', instant: false });
    } finally {
      rec.restore();
    }
  });

  it('eases every change of the stored width after that, beside a docked rail as without one', async () => {
    // 1440: docked but not yielded (its ceiling is 488).
    resize(1440);
    render(<Sidebar />);
    await nextFrame();
    const rec = recordPublishes();
    try {
      fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
      expect(rec.writes.at(-1)).toEqual({ px: '358px', instant: false });
      fireEvent.keyDown(handle(), { key: 'Enter' });
      expect(rec.writes.at(-1)).toEqual({ px: '406px', instant: false });
      fireEvent.keyDown(handle(), { key: 'Home' });
      expect(rec.writes.at(-1)).toEqual({ px: '280px', instant: false });
      fireEvent.doubleClick(handle());
      expect(rec.writes.at(-1)).toEqual({ px: '406px', instant: false });
      // 1280: yielded, and a nudge from the yield eases the same.
      resize(1280);
      fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
      expect(rec.writes.at(-1)).toEqual({ px: '320px', instant: false });
      // A drag's commit too: 32px left of the 320 it starts from.
      drag(handle(), 340, 330, 308);
      expect(stored()).toBe(288);
      expect(rec.writes.at(-1)).toEqual({ px: '288px', instant: false });
    } finally {
      rec.restore();
    }
  });

  it('never eases the yield under reduced motion, either way', () => {
    undock();
    reduceMotion();
    render(<Sidebar />);
    const rec = recordPublishes();
    try {
      dock();
      expect(rec.writes.at(-1)).toEqual({ px: '328px', instant: true });
      undock();
      expect(rec.writes.at(-1)).toEqual({ px: '406px', instant: true });
    } finally {
      rec.restore();
    }
  });

  it("honours the app's own reduced-motion setting too", () => {
    undock();
    document.documentElement.setAttribute('data-reduce-motion', '');
    render(<Sidebar />);
    const rec = recordPublishes();
    try {
      dock();
      expect(rec.writes.at(-1)).toEqual({ px: '328px', instant: true });
    } finally {
      rec.restore();
    }
  });
});

describe('the sash beside a docked rail, at 1280', () => {
  it('writes nothing on a press that never moves', () => {
    render(<Sidebar />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 340, pointerId: 1 });
    fireEvent.pointerUp(handle(), { button: 0, clientX: 340, pointerId: 1 });
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');
    undock();
    expect(published()).toBe('406px');
  });

  it('keeps the width on a press of the collapse grip, so it reopens as it was', () => {
    render(<Sidebar />);
    const grip = document.querySelector('[data-sash-collapse]') as HTMLElement;
    fireEvent.pointerDown(grip, { button: 0, clientX: 340, pointerId: 1 });
    fireEvent.pointerUp(handle(), { button: 0, clientX: 340, pointerId: 1 });
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
    expect(stored()).toBe(406);
  });

  it('drags from the rendered width: no growth while yielded, and a shrink is stored', () => {
    render(<Sidebar />);
    // From 328 (laid out), 100px right: capped at 328, so it never moved.
    fireEvent.pointerDown(handle(), { button: 0, clientX: 340, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 440, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 440, pointerId: 1 });
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');

    // 28px left of 328: the user chose 300, and that is what is stored.
    fireEvent.pointerDown(handle(), { button: 0, clientX: 340, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 312, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 312, pointerId: 1 });
    expect(stored()).toBe(300);
    expect(published()).toBe('300px');
    undock();
    expect(published()).toBe('300px');
  });

  it('writes nothing for a drag that comes back to where it began', () => {
    render(<Sidebar />);
    drag(handle(), 340, 330, 340);
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');
    expect(valueNow()).toBe('328');
    undock();
    expect(published()).toBe('406px');
  });

  it('writes nothing for a shrink dragged back out into the growth cap, which is where it began', () => {
    render(<Sidebar />);
    drag(handle(), 340, 335, 500);
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');
    undock();
    expect(published()).toBe('406px');
  });

  it('is still a press under 3px of travel: a tremor writes nothing, and on the grip it collapses', () => {
    render(<Sidebar />);
    drag(handle(), 340, 339, 338);
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');

    const grip = document.querySelector('[data-sash-collapse]') as HTMLElement;
    drag(grip, 340, 342);
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
    expect(stored()).toBe(406);
  });

  it('never collapses on a drag out and back on the grip: it moved', () => {
    render(<Sidebar />);
    const grip = document.querySelector('[data-sash-collapse]') as HTMLElement;
    drag(grip, 340, 320, 340);
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
    expect(stored()).toBe(406);
  });

  it('yields at the end of a drag the rail docked in the middle of', () => {
    undock();
    render(<Sidebar />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 418, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 410, pointerId: 1 });
    dock();
    // The live drag owns the variable until it ends, and it ends on the width
    // it started from, so the store never changes.
    fireEvent.pointerMove(handle(), { clientX: 418, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 418, pointerId: 1 });
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');
  });

  it('steps from the rendered width with the keys, writing only a step that moves it', () => {
    render(<Sidebar />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(stored()).toBe(406);
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(stored()).toBe(406);
    expect(published()).toBe('328px');
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(stored()).toBe(320);
    expect(handle()).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(stored()).toBe(SIDEBAR_MIN_WIDTH);
    // From below the ceiling, growth stops at it.
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(stored()).toBe(328);
    // Enter is the reset: it stores the default, and the column stays yielded.
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(stored()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(published()).toBe('328px');
    undock();
    expect(published()).toBe('406px');
  });

  it('reports the width on screen without re-rendering the braindump for it', () => {
    render(<Sidebar />);
    const base = renders.braindump;
    expect(valueNow()).toBe('328');
    resize(1300);
    expect(valueNow()).toBe('348');
    resize(1181);
    expect(valueNow()).toBe('280');
    resize(1280);
    undock();
    expect(valueNow()).toBe('406');
    dock();
    expect(valueNow()).toBe('328');
    // Ask's own flag lives in this store too: not the braindump's business.
    act(() => useSidebarStore.setState({ askOpen: !useSidebarStore.getState().askOpen }));
    expect(renders.braindump).toBe(base);
  });

  it("reads the width on screen into the sash's tooltip when it opens", () => {
    render(<Sidebar />);
    act(() => handle().focus());
    expect(screen.getAllByText('328px').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('default')).toHaveLength(0);
    // A nudge with the tooltip up re-reads it.
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(screen.getAllByText('320px').length).toBeGreaterThan(0);
  });

  it('is the plain clamp with no rail docked', () => {
    undock();
    render(<Sidebar />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(stored()).toBe(414);
    expect(published()).toBe('414px');
  });
});

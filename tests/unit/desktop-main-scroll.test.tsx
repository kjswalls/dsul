import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

// DesktopShell with its columns stubbed: the header row keeps controls that
// show at rest, one the right edge cuts, one the docked item panel has pushed
// wholly past <main>'s edge, and one wider than <main>.
vi.mock('@/components/sidebar/sidebar', () => ({
  Sidebar: () => <button data-testid="sidebar-control">Braindump</button>,
}));
vi.mock('@/components/views/view-router', () => ({
  ViewRouter: () => (
    // overflowX, not overflow: jsdom computes no longhands from the shorthand.
    <div data-testid="grid-viewport" style={{ overflowX: 'hidden' }}>
      <button data-testid="grid-heading">Home</button>
    </div>
  ),
}));
vi.mock('@/components/views/program-notice', () => ({ ProgramNotice: () => null }));
vi.mock('@/components/notices/notice-slot', () => ({ DayHeaderNotice: () => null }));
vi.mock('@/components/canvas/week-scale', () => ({ WeekScale: () => null }));
vi.mock('@/components/planner/item-dialog', () => ({ ItemDialog: () => null }));
vi.mock('@/components/canvas/header-capsule', () => ({
  HeaderCapsule: () => (
    <div>
      <button data-testid="seen-control">Today</button>
      <button data-testid="mid-control">Next day</button>
      <span data-testid="scale-thumb" role="slider" tabIndex={0} aria-valuenow={0} />
      <button data-testid="cut-control">Zen</button>
      <button data-testid="clipped-control">Reset display</button>
      <button data-testid="wide-control">Grouped by Project · Showing Tasks</button>
    </div>
  ),
}));

/** jsdom has no ResizeObserver; this one lets a test say when <main> resized. */
const resizeCallbacks = new Set<() => void>();
vi.stubGlobal(
  'ResizeObserver',
  class {
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {
      resizeCallbacks.add(this.notify);
    }
    unobserve() {
      resizeCallbacks.delete(this.notify);
    }
    disconnect() {
      resizeCallbacks.delete(this.notify);
    }
  }
);

/**
 * Nor an IntersectionObserver; this one keeps what it watches, and lets a test
 * say that what shows of it changed.
 */
const watched = new Set<Element>();
const seenCallbacks = new Set<() => void>();
vi.stubGlobal(
  'IntersectionObserver',
  class {
    notify: () => void;
    constructor(callback: IntersectionObserverCallback) {
      this.notify = () => callback([], this as unknown as IntersectionObserver);
      seenCallbacks.add(this.notify);
    }
    observe(el: Element) {
      watched.add(el);
    }
    unobserve(el: Element) {
      watched.delete(el);
    }
    disconnect() {
      watched.clear();
      seenCallbacks.delete(this.notify);
    }
  }
);

import { DesktopShell } from '@/components/shell/desktop-shell';

/** Gives a control its place at rest, which moves left as <main> scrolls. */
function place(id: string, left: number, width: number) {
  const main = document.querySelector('main')!;
  screen.getByTestId(id).getBoundingClientRect = () =>
    new DOMRect(left - main.scrollLeft, 40, width, 32);
}

function size(main: HTMLElement, width: number) {
  Object.defineProperty(main, 'clientWidth', { configurable: true, value: width });
  main.getBoundingClientRect = () => new DOMRect(100, 0, width + 2, 800);
}

/**
 * jsdom lays nothing out, so <main> gets a box (101 to 401px inside its 1px
 * border, with 400px of content) and each control a place at rest, the way a
 * browser's would. 51 is the least slide that shows the clipped control (420
 * to 452) whole, and at 51 the left edge cuts the seen one (120 to 160) while
 * the mid one (200 to 232) still shows. The right edge cuts the cut one (390
 * to 422) at rest, and 9 puts the wide one's start (110) at the edge. A
 * browser's ResizeObserver then says <main> has its size, and a frame passes.
 */
async function layOut(width = 300) {
  const main = document.querySelector('main')!;
  Object.defineProperty(main, 'clientLeft', { configurable: true, value: 1 });
  Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 400 });
  size(main, width);
  place('seen-control', 120, 40);
  place('mid-control', 200, 32);
  place('scale-thumb', 300, 16);
  place('cut-control', 390, 32);
  place('clipped-control', 420, 32);
  place('wide-control', 110, 370);
  // The schedule's own viewport fills <main>, and a full-width heading in it
  // runs 59px past both: the viewport cuts it, not <main>.
  place('grid-viewport', 101, 300);
  place('grid-heading', 140, 320);
  act(() => resizeCallbacks.forEach((notify) => notify()));
  await frame();
  return main;
}

/** What the browser does when focus lands on a control past the edge. */
function focusAndReveal(main: HTMLElement, id: string, by: number) {
  act(() => screen.getByTestId(id).focus());
  main.scrollLeft = by;
  fireEvent.scroll(main);
}

/** A Radix menu portals its content into <body>, outside the shell. */
function openMenu() {
  const item = document.createElement('button');
  item.dataset.testid = 'menu-item';
  document.body.appendChild(item);
  act(() => item.focus());
  return item;
}

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

afterEach(() => {
  cleanup();
  document.body.querySelectorAll('[data-testid="menu-item"]').forEach((el) => el.remove());
});

describe("DesktopShell's <main>: focus may scroll it sideways, and only focus", () => {
  it('is overflow-hidden, so focus can scroll it, never overflow-clip', () => {
    render(<DesktopShell />);
    const main = document.querySelector('main')!;
    expect(main).toHaveClass('overflow-hidden');
    // A clip box never scrolls, so Tab would land on a control nobody can see.
    expect(main).not.toHaveClass('overflow-clip');
  });

  it('brings a centring reveal back to the least slide that shows the control whole, and keeps it there', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // Chromium centres a control it reveals, as far as the box will scroll.
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    expect(main.scrollLeft).toBe(51);
    fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Shift' });
    await frame();
    expect(main.scrollLeft).toBe(51);
  });

  it('shows a focused control that is wholly out of sight when the browser did not', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(51);
  });

  it('leaves a control the right edge cuts as the browser does, so nothing closes its tooltip', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // Chromium scrolls only for a control wholly hidden: this one shows 11px of 32.
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('brings a slide it did not make back to the start of a control wider than <main>, and never slides out to one from rest', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'wide-control', 30);
    await frame();
    expect(main.scrollLeft).toBe(9);
    act(() => screen.getByTestId('seen-control').focus());
    await frame();
    act(() => screen.getByTestId('wide-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('keeps its own slide while focus moves between controls that show there, so no scroll closes a tooltip', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Whole at 51, and 21 would do: moving there would close the tooltip focus opens.
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    // Cut at both edges, as the browser would leave it.
    act(() => screen.getByTestId('wide-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
  });

  it('brings a slide it did not make back as far as the least one', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // Find-in-page, say, which can scroll a hidden box too.
    main.scrollLeft = 90;
    fireEvent.scroll(main);
    await frame();
    expect(main.scrollLeft).toBe(21);
  });

  it('scrolls back once focus moves on to a control that shows at rest, even one that shows where it is', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('mid-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back when Shift+Tab lands on a control the left edge cuts, if it shows at rest', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Partly in view, so Chromium leaves it cut.
    act(() => screen.getByTestId('seen-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back once focus moves into the schedule, judging a heading by what its viewport shows', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('grid-heading').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back for a control a box inside <main> hides, which no slide of <main> could show', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Wholly past the viewport's right edge, though <main> could show its box.
    place('grid-heading', 410, 30);
    act(() => screen.getByTestId('grid-heading').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back when focus leaves for the sidebar', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('sidebar-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back when focus is dropped', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('clipped-control').blur());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('puts back a scroll that nothing focused asked for', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('seen-control').focus());
    await frame();
    // Find-in-page, say: it can scroll a hidden box too.
    main.scrollLeft = 40;
    fireEvent.scroll(main);
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  describe('while a menu opened from the canvas has focus', () => {
    it('holds still, so the control the menu hands focus back to still shows', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      openMenu();
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Radix hands focus back with a plain focus(), to a control that shows.
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('scrolls back when the menu hands focus to a control that shows at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      openMenu();
      await frame();
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('scrolls back when the menu hands focus to the sidebar', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      openMenu();
      await frame();
      // Focus never passes through <main> on the way, so only the document hears it.
      act(() => screen.getByTestId('sidebar-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('scrolls back when the menu drops focus', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const item = openMenu();
      await frame();
      act(() => item.blur());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });
  });

  describe('while a pointer is down', () => {
    it('holds still, so a press lands where it started, and settles on the release', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      // A press moves focus on mousedown, frames before the button comes up.
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      await frame();
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.pointerUp(target, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('waits for every pointer to come up', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      fireEvent.pointerDown(target, { pointerId: 1 });
      fireEvent.pointerDown(target, { pointerId: 2 });
      act(() => target.focus());
      fireEvent.pointerUp(target, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.pointerCancel(target, { pointerId: 2 });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go when the window loses a press whose release it never heard', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.blur(window);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go when a native context menu takes the release', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      fireEvent.pointerDown(target, { pointerId: 1, button: 2 });
      act(() => target.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.contextMenu(target);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });
  });

  it('checks again after a key in <main>, so a slider thumb the key moved past the edge comes into view', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    const thumb = screen.getByTestId('scale-thumb');
    act(() => thumb.focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // End moves the thumb to the far end of its track, and focus stays on it.
    place('scale-thumb', 430, 16);
    fireEvent.keyDown(thumb, { key: 'End' });
    await frame();
    expect(main.scrollLeft).toBe(45);
  });

  it('judges its slide afresh when <main> widens, coming back as far as the new least one', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('clipped-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    size(main, 330);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(21);
  });

  it('brings in a slider thumb that a key moved out of sight past the left edge', async () => {
    render(<DesktopShell />);
    // Narrow enough that the least slide for the clipped control (201) hides
    // the thumb's whole track, which ends at 176.
    const main = await layOut(150);
    act(() => screen.getByTestId('clipped-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(201);
    const thumb = screen.getByTestId('scale-thumb');
    act(() => thumb.focus({ preventScroll: true }));
    place('scale-thumb', 261, 16);
    fireEvent.keyDown(thumb, { key: 'Home' });
    await frame();
    expect(main.scrollLeft).toBe(26);
  });

  it('checks again when <main> narrows, so a control the item panel docks over comes into view', async () => {
    render(<DesktopShell />);
    const main = await layOut(360);
    act(() => screen.getByTestId('clipped-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    size(main, 300);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(51);
  });

  it('places it afresh when <main> narrows under a control it already shows, so none is left cut', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('clipped-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    // The item panel docks a frame at a time: 10px narrower cuts 10px off it.
    size(main, 290);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(61);
  });

  it('keeps its slide when <main> changes only its height, so no scroll closes a tooltip', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(51);
  });

  it('places it afresh when the layout moves the focused control, which only what shows of it tells', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    const control = screen.getByTestId('clipped-control');
    act(() => control.focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    expect([...watched]).toEqual([control]);
    // A view switched from the store moves it 20px on, with no event at all:
    // 20px of it now past the edge, and 71 shows it whole again.
    place('clipped-control', 440, 32);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(71);
    // Only a control in <main> is watched.
    act(() => screen.getByTestId('sidebar-control').focus());
    await frame();
    expect(watched.size).toBe(0);
  });

  it('places it afresh when the focused control grows at either end', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    // 20px wider at its start, its end where it was: 21 shows it whole.
    place('cut-control', 370, 52);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(21);
    // Then 20px wider at its end, which cuts it again.
    place('cut-control', 370, 72);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(41);
  });

  it('places it afresh when the item panel docks again, after closing left nothing to slide', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // The panel closes: all 400px of the row fit.
    size(main, 420);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    // And docks again, at the width the hook last placed <main> for.
    size(main, 300);
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(21);
  });
});

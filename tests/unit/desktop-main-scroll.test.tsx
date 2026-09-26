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

/**
 * jsdom has no ResizeObserver; this one keeps what it observes, and lets a test
 * say when <main> resized.
 */
const resizeCallbacks = new Set<() => void>();
const resizeTargets = new Set<Element>();
vi.stubGlobal(
  'ResizeObserver',
  class {
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe(el: Element) {
      resizeTargets.add(el);
      resizeCallbacks.add(this.notify);
    }
    unobserve(el: Element) {
      resizeTargets.delete(el);
      resizeCallbacks.delete(this.notify);
    }
    disconnect() {
      resizeTargets.clear();
      resizeCallbacks.delete(this.notify);
    }
  }
);

/**
 * Nor an IntersectionObserver; this one keeps what it watches and how, and
 * lets a test say that what shows of it changed.
 */
const watched = new Set<Element>();
const seenCallbacks = new Set<() => void>();
let seenOptions: IntersectionObserverInit | undefined;
vi.stubGlobal(
  'IntersectionObserver',
  class {
    notify: () => void;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      seenOptions = options;
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

    it('places it afresh when <main> changed width while the menu had focus', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      openMenu();
      await frame();
      size(main, 290);
      act(() => resizeCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(51);
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(61);
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

    it('holds for a press whose control stops it from bubbling', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      target.addEventListener('pointerdown', (e) => e.stopPropagation());
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
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

  it('places it afresh when the layout moves either end of a control it leaves cut', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Cut at both edges at 51, as the browser would leave it.
    act(() => screen.getByTestId('wide-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    // Its start moves 20.6px on, its end where it was: 29 shows its start whole.
    place('wide-control', 130.6, 349.4);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(29);
    // The cut one shows whole at 29, until it grows 20px at its end.
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(29);
    place('cut-control', 390, 52);
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

  describe('while a control the layout moved still shows whole', () => {
    it('holds its slide as a key moves it, and places it afresh once a move cuts it', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // Next, paging the date: the label beside it changes width on every press.
      const control = screen.getByTestId('clipped-control');
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      place('clipped-control', 410, 32);
      fireEvent.keyDown(control, { key: 'Enter' });
      await frame();
      // Whole at 51, where 41 would do: moving would slide the whole canvas.
      expect(main.scrollLeft).toBe(51);
      place('clipped-control', 430, 32);
      fireEvent.keyDown(control, { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(61);
    });

    it('holds its slide while keys move a slider thumb end to end, until focus moves on', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      // Home takes it back to where it shows at rest, and it still shows whole at 45.
      place('scale-thumb', 300, 16);
      fireEvent.keyDown(thumb, { key: 'Home' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go once a move cuts it at the left edge', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      // Home, on a longer track that starts past the left edge at 45: it shows at rest.
      place('scale-thumb', 140, 16);
      fireEvent.keyDown(thumb, { key: 'Home' });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go when <main> changes width', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      size(main, 310);
      act(() => resizeCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(31);
    });

    it('lets go when focus leaves <main>, so a reveal on the way back comes back as far as the least slide', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      act(() => screen.getByTestId('sidebar-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Back again, wholly out of sight at rest: the browser centres it.
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(41);
    });

    it('lets go when focus leaves <main>, so a control that shows part-way at rest stays as it is on the way back', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      act(() => screen.getByTestId('sidebar-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
      // No slide is held any more, so nothing places this one afresh.
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('never holds a slide something else made', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      place('scale-thumb', 300, 16);
      fireEvent.keyDown(thumb, { key: 'Home' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      // Find in page slides <main> on, and the thumb shows at rest.
      main.scrollLeft = 80;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('never holds a slide it did not make, when a menu closes on a control the layout moved', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const control = screen.getByTestId('clipped-control');
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      openMenu();
      await frame();
      // A pick in the menu moves the control 50px on, wholly out of sight at 51,
      // and the menu hands focus back: the browser centres it.
      place('clipped-control', 470, 32);
      act(() => control.focus());
      main.scrollLeft = 150;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(101);
    });

    it('places afresh a control focus moves on to that the held slide cuts', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Go to today, which paging brought in after Next: 20px of it past the
      // edge at the held slide, which the browser leaves alone.
      place('seen-control', 440, 32);
      act(() => screen.getByTestId('seen-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
    });

    it('keeps the held slide for a control focus moves on to that shows whole there', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('holds through a menu opened and closed over the control it holds for', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      place('scale-thumb', 300, 16);
      fireEvent.keyDown(thumb, { key: 'Home' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      const item = openMenu();
      await frame();
      act(() => thumb.focus());
      item.remove();
      await frame();
      expect(main.scrollLeft).toBe(45);
    });

    it('lets go when a menu hands focus on to another control', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      place('scale-thumb', 300, 16);
      fireEvent.keyDown(thumb, { key: 'Home' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      const item = openMenu();
      await frame();
      // Handed to a control that shows at rest, and whole at the held slide too.
      act(() => screen.getByTestId('mid-control').focus());
      item.remove();
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('places afresh a button a click moves, so it stays under the pointer for the next click', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A click on Next pages the date, and the label beside it moves Next 10px on.
      fireEvent.pointerDown(window, { pointerId: 1 });
      place('clipped-control', 430, 32);
      fireEvent.pointerUp(window, { pointerId: 1 });
      await frame();
      // 61 keeps it at <main>'s edge, where the pointer is.
      expect(main.scrollLeft).toBe(61);
      // Moved 10px back, it shows whole at 61; the click still places it afresh.
      fireEvent.pointerDown(window, { pointerId: 1 });
      place('clipped-control', 420, 32);
      fireEvent.pointerUp(window, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A key, and Enter holds again.
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('holds its slide for a slider thumb a pointer drags, which lands under the pointer', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const thumb = screen.getByTestId('scale-thumb');
      act(() => thumb.focus());
      await frame();
      place('scale-thumb', 430, 16);
      fireEvent.keyDown(thumb, { key: 'End' });
      await frame();
      expect(main.scrollLeft).toBe(45);
      fireEvent.pointerDown(window, { pointerId: 1 });
      place('scale-thumb', 300, 16);
      fireEvent.pointerUp(window, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(45);
    });
  });

  it("holds still while the shell is inert, as Zen's switch lifts the canvas away and drops focus", async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    expect(main.scrollLeft).toBe(51);
    const shell = main.parentElement!;
    shell.setAttribute('inert', '');
    act(() => screen.getByTestId('clipped-control').blur());
    await frame();
    expect(main.scrollLeft).toBe(51);
    // The switch turned back: the next resize, key or focus move settles it.
    shell.removeAttribute('inert');
    act(() => resizeCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it("does not hold for <main>'s own inert, which the overlaid item panel sets", async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    main.setAttribute('inert', '');
    act(() => screen.getByTestId('clipped-control').blur());
    await frame();
    expect(main.scrollLeft).toBe(0);
    main.removeAttribute('inert');
  });

  it('takes a control that shows a pixel or less at the right edge as out of sight', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // Its start 0.8px short of <main>'s inner right edge, as a least slide can
    // leave the control after the one it was made for: a sliver, not a control.
    place('clipped-control', 400.2, 32);
    act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
    await frame();
    // Its end at 331.2 from the origin: 32 shows it whole.
    expect(main.scrollLeft).toBe(32);
  });

  it('leaves a control that shows more than a pixel at the right edge as the browser does', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    place('clipped-control', 399.8, 32);
    act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('takes a control that shows a pixel or less at the left edge as out of sight', async () => {
    render(<DesktopShell />);
    const main = await layOut(150);
    act(() => screen.getByTestId('clipped-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(201);
    // The thumb's end 0.8px inside the left edge at 201: a sliver, so it comes in whole.
    place('scale-thumb', 286.8, 16);
    act(() => screen.getByTestId('scale-thumb').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(52);
  });

  it('slides to show a control whole to the last fraction of a pixel, which the observer measures exactly', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // Its end at 351.3 from the origin: 52 shows it whole, where 51 leaves 0.3px
    // cut, too little to see and enough that a later cut is never heard.
    place('clipped-control', 420.3, 32);
    act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(52);
  });

  it('takes a control half a pixel or less past the edge at rest as showing there', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    expect(main.scrollLeft).toBe(51);
    // Its end 0.4px past <main>'s inner right edge at rest.
    place('mid-control', 369.4, 32);
    act(() => screen.getByTestId('mid-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('takes a control more than half a pixel past the edge at rest as cut, so a slide it did not make comes back to one pixel', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // Its end 0.7px past <main>'s inner right edge at rest: the browser leaves it.
    place('mid-control', 369.7, 32);
    act(() => screen.getByTestId('mid-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // Find in page slides <main> on; the least slide that shows it whole is 1.
    main.scrollLeft = 50;
    fireEvent.scroll(main);
    await frame();
    expect(main.scrollLeft).toBe(1);
  });

  it('takes a move of a pixel for a move, and a third of one for rounding', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    act(() => screen.getByTestId('wide-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(51);
    place('wide-control', 110.3, 370);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(51);
    place('wide-control', 111, 370);
    act(() => seenCallbacks.forEach((notify) => notify()));
    await frame();
    expect(main.scrollLeft).toBe(10);
  });

  it('shows what a control squeezed to 0px paints past it, its icon and focus ring', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // The program line's button, shrunk to nothing at 460 with its 12px icon
    // overflowing it: 71 shows the icon, which at rest sits wholly past the edge.
    const button = screen.getByTestId('wide-control');
    place('wide-control', 460, 0);
    Object.defineProperty(button, 'scrollWidth', { configurable: true, value: 12 });
    act(() => button.focus());
    await frame();
    expect(main.scrollLeft).toBe(71);
  });

  it('measures a control that clips what overflows it by its own box', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Truncated text: 40px wide, with 400px of it hidden inside.
    const control = screen.getByTestId('seen-control');
    control.style.overflowX = 'hidden';
    Object.defineProperty(control, 'scrollWidth', { configurable: true, value: 400 });
    act(() => control.focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('measures a control squeezed below its content by what it paints past its box', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // The review notice's button, squeezed to its 16px of padding at 410, with
    // its icon and "Start" painting 40px: 49 shows them, where 25 shows the box.
    const button = screen.getByTestId('wide-control');
    place('wide-control', 410, 16);
    Object.defineProperty(button, 'scrollWidth', { configurable: true, value: 40 });
    act(() => button.focus());
    await frame();
    expect(main.scrollLeft).toBe(49);
  });

  it('measures a control by its box when what it paints differs only by rounding', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // 31.6px wide, and scrollWidth rounds that up to 32: nothing paints past it.
    const control = screen.getByTestId('clipped-control');
    place('clipped-control', 420.2, 31.6);
    Object.defineProperty(control, 'scrollWidth', { configurable: true, value: 32 });
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // Its end at 350.8 from the origin: 51, where 32px from its start would ask 52.
    expect(main.scrollLeft).toBe(51);
  });

  it('shows the focus ring of a control squeezed to 0px that paints nothing else', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    const button = screen.getByTestId('wide-control');
    place('wide-control', 460, 0);
    Object.defineProperty(button, 'scrollWidth', { configurable: true, value: 0 });
    act(() => button.focus());
    await frame();
    expect(main.scrollLeft).toBe(60);
  });

  it('measures a heading by what its own viewport shows at its start, too', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    // The week grid's viewport scrolls, and starts 49px in; a heading wider than
    // <main> starts 30px before it, so the viewport shows it from 49.
    const viewport = screen.getByTestId('grid-viewport');
    viewport.style.overflowX = 'scroll';
    place('grid-viewport', 150, 410);
    place('grid-heading', 120, 420);
    focusAndReveal(main, 'grid-heading', 100);
    await frame();
    expect(main.scrollLeft).toBe(49);
  });

  describe('its observers', () => {
    it('watch <main> itself: its size, and whether the focused control shows whole or at all', () => {
      render(<DesktopShell />);
      const main = document.querySelector('main')!;
      expect([...resizeTargets]).toEqual([main]);
      expect(seenOptions?.root).toBe(main);
      expect(seenOptions?.threshold).toEqual([0, 1]);
    });

    it('watch the control focus lands on while <main> is at rest, so a row that grows under it is heard', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The row fits.
      Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 300 });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect([...watched]).toEqual([screen.getByTestId('mid-control')]);
    });

    it('let go of everything on unmount', async () => {
      const { unmount } = render(<DesktopShell />);
      const main = await layOut();
      const removals = [window, document, main].map((target) => vi.spyOn(target, 'removeEventListener'));
      // A frame asked for and not yet run when the shell goes.
      act(() => screen.getByTestId('clipped-control').focus());
      const cancelled = vi.spyOn(window, 'cancelAnimationFrame');
      unmount();
      expect(cancelled).toHaveBeenCalled();
      expect(resizeCallbacks.size).toBe(0);
      expect(seenCallbacks.size).toBe(0);
      const [fromWindow, fromDocument, fromMain] = removals.map((spy) =>
        spy.mock.calls.map(([type, , capture]) => (capture ? `${type} (capture)` : type))
      );
      expect(fromWindow).toEqual(
        expect.arrayContaining([
          'pointerdown (capture)',
          'pointerup (capture)',
          'pointercancel (capture)',
          'blur',
          'contextmenu (capture)',
        ])
      );
      expect(fromDocument).toEqual(expect.arrayContaining(['focusin', 'focusout']));
      expect(fromMain).toEqual(expect.arrayContaining(['keydown (capture)', 'scroll']));
      const asked = vi.spyOn(window, 'requestAnimationFrame');
      const other = document.createElement('button');
      document.body.appendChild(other);
      act(() => other.focus());
      act(() => other.blur());
      fireEvent.pointerDown(window, { pointerId: 3 });
      fireEvent.pointerUp(window, { pointerId: 3 });
      fireEvent.pointerCancel(window, { pointerId: 4 });
      fireEvent.blur(window);
      fireEvent.contextMenu(window);
      fireEvent.scroll(main);
      fireEvent.keyDown(main, { key: 'Tab' });
      expect(asked).not.toHaveBeenCalled();
      other.remove();
      [...removals, cancelled, asked].forEach((spy) => spy.mockRestore());
    });

    it.each(['IntersectionObserver', 'ResizeObserver'])(
      'are not needed for the shell to mount: without %s it does nothing',
      (name) => {
        const real = (globalThis as Record<string, unknown>)[name];
        vi.stubGlobal(name, undefined);
        try {
          expect(() => render(<DesktopShell />)).not.toThrow();
        } finally {
          vi.stubGlobal(name, real);
        }
      }
    );
  });
});

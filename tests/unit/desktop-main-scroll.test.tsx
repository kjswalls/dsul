import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('@/components/views/season-notice', () => ({ SeasonNotice: () => null }));
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
import { usePlannerStore } from '@/lib/planner-store';

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
 * border, with 400px of content, which it scrolls no further than) and each
 * control a place at rest, the way a browser's would. 51 is the least slide
 * that shows the clipped control (420 to 452) whole, and at 51 the left edge
 * cuts the seen one (120 to 160) while the mid one (200 to 232) still shows.
 * The right edge cuts the cut one (390 to 422) at rest, and 9 puts the wide
 * one's start (110) at the edge. A browser's ResizeObserver then says <main>
 * has its size, and a frame passes.
 */
async function layOut(width = 300) {
  const main = document.querySelector('main')!;
  Object.defineProperty(main, 'clientLeft', { configurable: true, value: 1 });
  Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 400 });
  let slid = 0;
  Object.defineProperty(main, 'scrollLeft', {
    configurable: true,
    get: () => slid,
    set: (to: number) => {
      slid = Math.max(0, Math.min(to, main.scrollWidth - main.clientWidth));
    },
  });
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

/** A control the layout mounts in the header row after the fact. */
function mount(id: string, left: number, width: number) {
  const el = document.createElement('button');
  el.dataset.testid = id;
  screen.getByTestId('cut-control').parentElement!.appendChild(el);
  place(id, left, width);
  return el;
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

/**
 * Whether the browser draws focus where it lands (:focus-visible). jsdom's
 * answer turns on what earlier cases dispatched, so here it is drawn wherever
 * it lands, but on a control a case says a click left undrawn.
 */
const undrawnControls = new Set<Element>();
const undrawn = (id: string) => undrawnControls.add(screen.getByTestId(id));
const realMatches = Element.prototype.matches;
let focusVisible: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  focusVisible = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? !undrawnControls.has(this) : realMatches.call(this, selector);
  });
});

afterEach(() => {
  cleanup();
  focusVisible?.mockRestore();
  undrawnControls.clear();
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
    fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'v' });
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
    act(() => screen.getByTestId('grid-heading').focus());
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

  it('leaves a slide something else made that is short of the least one', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // Find in page, say: 10, where Zen needs 21.
    main.scrollLeft = 10;
    fireEvent.scroll(main);
    await frame();
    expect(main.scrollLeft).toBe(10);
  });

  it('scrolls back once focus moves on to a control in another row that shows at rest, even one that shows where it is', async () => {
    render(<DesktopShell />);
    const main = await layOut();
    focusAndReveal(main, 'clipped-control', 100);
    await frame();
    // A heading in the schedule, whole at 51 as at rest.
    place('grid-heading', 200, 32);
    act(() => screen.getByTestId('grid-heading').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  describe('while keys move focus along the row it slid for', () => {
    it('keeps its slide for a control that shows at rest if it shows whole there, so no scroll closes its tooltip', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Shift+Tab onto a setting's ✕, say: whole at rest, and at 51.
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A key that moves nothing, and the Shift of the next Shift+Tab, which
      // the hook does not hear.
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'v' });
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Shift' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // And back again: the slide is the one it made for this control.
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('scrolls back once one the slide cuts shows at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // At 51 the left edge cuts it; at rest it shows.
      act(() => screen.getByTestId('seen-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go once the control it kept the slide for stops showing whole there', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The layout moves it 60px left with no event of its own (a view
      // switched from a store): cut at 51, and whole at rest.
      place('mid-control', 140, 32);
      act(() => seenCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('lets go when <main> changes width', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The item panel closing a frame at a time: whole at 51 still, and at rest.
      size(main, 310);
      act(() => resizeCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('never keeps a slide something else made as focus moved', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      act(() => screen.getByTestId('mid-control').focus());
      // Find in page, say, in the same frame as the focus move.
      main.scrollLeft = 70;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('takes focus that comes from nothing as coming along no row', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      // Zen's switch lifts the planner away and drops focus, and is turned back.
      const shell = main.parentElement!;
      shell.setAttribute('inert', '');
      act(() => screen.getByTestId('clipped-control').blur());
      await frame();
      shell.removeAttribute('inert');
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(document.body, { key: 'Tab' });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('places afresh a button a click moves, even one it kept the slide for', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      // The browser draws no focus on a button a click lands on.
      undrawn('mid-control');
      act(() => target.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A click on it moves it 10px on, still whole at 51 and at rest.
      fireEvent.pointerDown(target, { pointerId: 1 });
      fireEvent.pointerUp(target, { pointerId: 1 });
      place('mid-control', 210, 32);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('places a control a click moves focus to as before, at rest where it shows there', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      // Undrawn, as the browser leaves focus a click gives: it is the click
      // landing on it, not a click handing focus on, so it is placed.
      undrawn('mid-control');
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      fireEvent.pointerUp(target, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('keeps its slide for a control a click moves focus to that shows whole there and is cut at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('cut-control');
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      fireEvent.pointerUp(target, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it("takes focus a press moves as the pointer's, though a key goes down before the release", async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const target = screen.getByTestId('mid-control');
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      fireEvent.keyDown(target, { key: 'v' });
      fireEvent.pointerUp(target, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('counts a control half a pixel or less past the edge at the slide it keeps as whole', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Its start 0.3px past the left edge at 51, and whole at rest.
      place('mid-control', 151.7, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it.each([
      ['a pointer', true],
      ['keys', false],
    ])('keeps its slide for a control a menu hands focus back to, picked by %s', async (_, pointer) => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      const control = screen.getByTestId('mid-control');
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => control.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      if (!pointer) fireEvent.keyDown(control, { key: 'Enter' });
      const item = openMenu();
      await frame();
      if (pointer) {
        fireEvent.pointerDown(item, { pointerId: 1 });
        fireEvent.pointerUp(item, { pointerId: 1 });
      }
      act(() => control.focus());
      item.remove();
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    /** Shift+Tab from the schedule onto Reset, and back along the row to Scope. */
    async function backToScope() {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      return main;
    }

    /** Enter on Scope, and a pick in its menu that switches Day to Week. */
    async function switchFromMenu(moves: () => void) {
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Enter' });
      const item = openMenu();
      await frame();
      moves();
      act(() => screen.getByTestId('mid-control').focus());
      item.remove();
      await frame();
    }

    it('places afresh a control the layout moved since the slide was made, where the slide the row kept cuts it', async () => {
      const main = await backToScope();
      // Scope's label widens, and Zen moves 50px on.
      await switchFromMenu(() => {
        place('mid-control', 200, 40);
        place('cut-control', 440, 32);
      });
      expect(main.scrollLeft).toBe(51);
      // Tab on along the row: the Display trigger shows whole at 51...
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('scale-thumb').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // ...and Zen, which needs 71 now, shows 12px of 32 at 51.
      fireEvent.keyDown(screen.getByTestId('scale-thumb'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
    });

    it('places afresh a control a switch moved while focus sat on one it left in place', async () => {
      const main = await backToScope();
      // `v` switches Day to Week with focus on the Layout pill, before Scope:
      // everything after Scope moves 40px on, and the pill, left in place, holds
      // nothing.
      place('scale-thumb', 340, 16);
      place('cut-control', 430, 32);
      place('clipped-control', 460, 32);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'v' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('scale-thumb').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Zen needs 61 now, and shows 22px of 32 at 51.
      fireEvent.keyDown(screen.getByTestId('scale-thumb'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(61);
    });

    it('keeps the slide, cut part-way, for a control that has not moved since it was made, though the one it was made for has', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // Zen needs 21 here (390 to 422), and Reset, 10px on, 31.
      place('clipped-control', 400, 32);
      focusAndReveal(main, 'cut-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(21);
      fireEvent.keyDown(screen.getByTestId('cut-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(21);
      // Zen moves; Reset does not.
      place('cut-control', 350, 32);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(21);
      // Reset shows 22px of 32 at 21: kept, as the browser would leave it.
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(21);
    });

    it('notes where the row sits again with each slide it makes', async () => {
      const main = await backToScope();
      // The switch moves the shelf's text 10px on as well.
      await switchFromMenu(() => {
        place('mid-control', 200, 40);
        place('cut-control', 440, 32);
        place('wide-control', 120, 370);
      });
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
      // The text shows part-way at 71, where it sat when 71 was made: kept.
      fireEvent.keyDown(screen.getByTestId('cut-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
    });

    it('forgets where the row sat once it goes to rest', async () => {
      const main = await backToScope();
      await switchFromMenu(() => {
        place('mid-control', 200, 40);
        place('cut-control', 440, 32);
      });
      // Into the schedule: at rest.
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('grid-heading').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Back onto Zen, 5px on from where it sat at 51 and 6px of it showing at
      // rest: left as the browser leaves it.
      place('cut-control', 395, 32);
      fireEvent.keyDown(screen.getByTestId('grid-heading'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('cut-control').focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('keeps the slide for a control it cuts at its start, which sits where it did, though a switch moved its end', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The shelf's text, 40 to 320 from <main>'s inner edge: 20 shows its
      // end, and 51 cuts its start. A setting's ✕ sits on it, 150 to 164.
      place('wide-control', 141, 280);
      const x = mount('x-control', 251, 14);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Week to Day from Scope's menu: its label narrows 10px, and what comes
      // after it, the text's end and its ✕ with it, comes 10px back.
      await switchFromMenu(() => {
        place('mid-control', 200, 22);
        place('cut-control', 380, 32);
        place('clipped-control', 410, 32);
        place('wide-control', 141, 270);
        place('x-control', 241, 14);
      });
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Cut at its start at 51 as it was when 51 was made: kept...
      fireEvent.keyDown(screen.getByTestId('cut-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // ...and so is the ✕ on it, whole at 51, and Reset two stops on, whole
      // there too, keeps its tooltip.
      fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab' });
      act(() => x.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(x, { key: 'Tab' });
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('keeps the slide for the shelf text a setting lengthened at its end, which shows part-way there, and for Reset after it', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The text, 49 to 329: 29 shows it whole, and 51 cuts 2px at its start.
      place('wide-control', 150, 280);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A setting comes on from the Display menu: the text runs 10px further,
      // its start where it was.
      place('wide-control', 150, 290);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Reset (319 to 351) shows whole at 51, and its tooltip stays up.
      fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab' });
      act(() => screen.getByTestId('clipped-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('places afresh a control it cuts at an end the layout has moved, though its start sits where it did', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // Zen, 299 to 331, shows whole at 51.
      place('cut-control', 400, 32);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // It widens at its end to 359, which 51 cuts by 8px: 59 shows it.
      place('cut-control', 400, 60);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(59);
    });

    it('places afresh a control it cuts at a start the layout has moved, though its end sits where it did', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The text, 40 to 320: 51 cuts its start, and 20 shows it whole.
      place('wide-control', 141, 280);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Its start comes 10px back, to 30, and its end stays at 320.
      place('wide-control', 131, 290);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(20);
    });

    it('places afresh a control mounted in the row since the slide was made, where the slide cuts it', async () => {
      const main = await backToScope();
      // Reset mounted again as a fourth ✕ comes on: 324 to 356, which needs
      // 56 and shows 27px of 32 at 51.
      const mounted = mount('mounted-control', 425, 32);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => mounted.focus());
      await frame();
      expect(main.scrollLeft).toBe(56);
    });

    it('keeps the slide for a control mounted in the row since it was made, where it cuts it by a pixel or less', async () => {
      const main = await backToScope();
      // 330 to 352, a pixel past the edge at 51, which the observer counts as whole.
      const mounted = mount('mounted-control', 431, 22);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => mounted.focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('keeps the slide, cut part-way, for a slider thumb that has not moved since it was made', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The thumb, 344 to 360: 51 cuts 9px of it.
      place('scale-thumb', 445, 16);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('scale-thumb').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('takes a move of half a pixel or less since the slide for rounding, and keeps the slide', async () => {
      const main = await backToScope();
      // The text, cut at both ends at 51, a third of a pixel on from where it sat.
      place('wide-control', 110.3, 370);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('takes a cut edge that moved more than half a pixel since the slide as moved', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // 330 to 362: 51 cuts 11px of it at its end.
      const far = mount('far-control', 431, 32);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Its end runs 0.7px on: placed afresh, at 63.
      place('far-control', 431, 32.7);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => far.focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(63);
    });

    it('takes an edge half a pixel or less past the edge as one the slide leaves whole, whatever moved it', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The text, 40 to 339.7: 51 cuts its start and shows its end.
      place('wide-control', 141, 299.7);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // A setting runs its end on to 351.3, 0.3px past the right edge at 51.
      place('wide-control', 141, 311.3);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('notes the row again when it brings in a control out of sight at the slide it keeps', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // 359 to 391, out of sight at 51: 91 shows it.
      const far = mount('far-control', 460, 32);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The text moves 10px on with no event of its own (it has no focus).
      place('wide-control', 120, 350);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab' });
      act(() => far.focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(91);
      // Back onto the text, cut at its start at 91 where it sat when 91 was made.
      fireEvent.keyDown(far, { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(91);
    });

    it('notes nothing when it only keeps its slide for a control it cuts that has not moved', async () => {
      const main = await backToScope();
      await switchFromMenu(() => {
        place('mid-control', 200, 40);
        place('cut-control', 440, 32);
      });
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('scale-thumb').focus());
      await frame();
      // The text has not moved: cut at both ends at 51, and kept.
      fireEvent.keyDown(screen.getByTestId('scale-thumb'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Zen has: 12px of 32 at 51, placed afresh.
      fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
    });

    it('notes the row when the browser revealed the control at exactly its least slide', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 51);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      await switchFromMenu(() => {
        place('mid-control', 200, 40);
        place('cut-control', 440, 32);
      });
      fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
      act(() => screen.getByTestId('scale-thumb').focus());
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.keyDown(screen.getByTestId('scale-thumb'), { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(71);
    });

    it.each([
      ['moved it since the slide was made', false],
      ['left a held slide', true],
    ])(
      'shows whole the control after the shelf text, wider than <main>, that focus reaches after a switch %s',
      async (_, fromMenu) => {
        const main = await backToScope();
        // The switch moves the shelf's text 10px on, and Zen 10px past its old place.
        const moves = () => {
          place('cut-control', 400, 32);
          place('wide-control', 120, 370);
        };
        if (fromMenu) {
          await switchFromMenu(() => {
            place('mid-control', 200, 40);
            moves();
          });
        } else {
          moves();
          fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'v' });
          await frame();
        }
        expect(main.scrollLeft).toBe(51);
        // The text is placed afresh, its start at the edge (19).
        fireEvent.keyDown(screen.getByTestId('mid-control'), { key: 'Tab' });
        act(() => screen.getByTestId('wide-control').focus());
        await frame();
        expect(main.scrollLeft).toBe(19);
        // Zen (299 to 331) shows whole from 31 on; at 19 the right edge cuts
        // 12px of it, and the slide made for the text is no slide for Zen.
        fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab' });
        act(() => screen.getByTestId('cut-control').focus());
        await frame();
        expect(main.scrollLeft).toBe(31);
      }
    );

    it('shows whole a control cut by the slide made for the shelf text, wider than <main>, when the item panel docked under the text', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // 235 to 267 from <main>'s edge.
      place('mid-control', 336, 32);
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
      // The panel docks: <main> narrows to 250, and the text is placed afresh,
      // at its start.
      size(main, 250);
      act(() => resizeCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(9);
      // At 9 the right edge cuts 8px of the next control; 17 shows it whole.
      fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab' });
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(17);
    });

    // A cut of a pixel or less, which the observer counts as whole, keeps the
    // slide, where 10 would close the ✕'s tooltip. A cut of more is placed
    // afresh.
    it.each([
      ['0.55px, and keeps it', 0.55, 9],
      ['a pixel, and keeps it', 1, 9],
      ['1.01px, and places it afresh', 1.01, 11],
    ])(
      'judges a control the slide made for the shelf text, wider than <main>, cuts by %s',
      async (_, cut, slide) => {
        render(<DesktopShell />);
        const main = await layOut();
        // A setting's ✕, 14px wide, its end `cut` past the edge at 9.
        place('mid-control', 101 + 245 + cut, 14);
        act(() => screen.getByTestId('wide-control').focus());
        await frame();
        size(main, 250);
        act(() => resizeCallbacks.forEach((notify) => notify()));
        await frame();
        expect(main.scrollLeft).toBe(9);
        fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab' });
        act(() => screen.getByTestId('mid-control').focus());
        await frame();
        expect(main.scrollLeft).toBe(slide);
      }
    );

    it('keeps the slide made for a control exactly as wide as <main>, which shows it whole, for the next control it cuts', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // 10 to 310, exactly 300 wide: 10 shows it whole.
      place('wide-control', 111, 300);
      focusAndReveal(main, 'wide-control', 30);
      await frame();
      expect(main.scrollLeft).toBe(10);
      // Zen (289 to 321) shows 21px of 32 at 10, where it sat when 10 was made.
      fireEvent.keyDown(screen.getByTestId('wide-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(10);
    });

    it('forgets the slide it noted while the row fits at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The row shrinks to fit: the browser clamps <main> to rest.
      Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 300 });
      main.scrollLeft = 0;
      fireEvent.scroll(main);
      await frame();
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      // The row grows back, and Zen lands 5px on from where it sat when 51
      // was made, 6px of it showing: left as the browser leaves it.
      Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 400 });
      place('cut-control', 395, 32);
      act(() => seenCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(0);
    });
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

    it('keeps its slide for a control the menu hands focus to that shows whole there and is cut at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      const item = openMenu();
      await frame();
      act(() => screen.getByTestId('cut-control').focus());
      item.remove();
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

  // A Display shelf ✕ hands focus on as its own setting goes: to the shelf's
  // text, to the next ✕, or with the last setting to the Display trigger.
  // After a click that control is undrawn (no :focus-visible), and with the
  // item panel docked it can sit past the edge: showing it slid the canvas
  // under the pointer, for a control nobody could see.
  describe('after a click in it hands focus on to another control', () => {
    /** A click on `pressed` whose handler hands focus to `to`, which the browser reveals. */
    function clickHandingOn(main: HTMLElement, pressed: string, to: string, revealTo: number) {
      const target = screen.getByTestId(pressed);
      fireEvent.pointerDown(target, { pointerId: 1 });
      act(() => target.focus());
      fireEvent.pointerUp(target, { pointerId: 1 });
      focusAndReveal(main, to, revealTo);
    }

    it('leaves the box at rest for an undrawn control past the edge, undoing the browser’s reveal', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('leaves a slide it made where it was, for an undrawn control the slide cuts', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The seen control shows whole at rest, and 51 cuts it.
      undrawn('seen-control');
      clickHandingOn(main, 'cut-control', 'seen-control', 0);
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('keeps it there through a modifier on its own, Shift included, and places it once a key draws it', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      const control = screen.getByTestId('clipped-control');
      fireEvent.keyDown(control, { key: 'Meta' });
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Chromium draws focus on a lone Shift, the first half of a Shift-click:
      // placing it then slid the canvas just as the click came down.
      undrawnControls.clear();
      fireEvent.keyDown(control, { key: 'Shift' });
      await frame();
      expect(main.scrollLeft).toBe(0);
      fireEvent.keyDown(control, { key: 'v' });
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    // Chromium draws focus on a lone Shift, Caps Lock or AltGr, and a Ctrl, Alt or ⌘ held
    // after Shift finds it drawn: none of them may place the control.
    it.each(['Shift', 'CapsLock', 'AltGraph', 'Control', 'Alt', 'Meta'])(
      'keeps it there through a lone %s with focus drawn',
      async (key) => {
        render(<DesktopShell />);
        const main = await layOut();
        undrawn('clipped-control');
        clickHandingOn(main, 'mid-control', 'clipped-control', 100);
        await frame();
        undrawnControls.clear();
        fireEvent.keyDown(screen.getByTestId('clipped-control'), { key });
        await frame();
        expect(main.scrollLeft).toBe(0);
      }
    );

    // Radix's trigger opens its menu on the keydown, and focus is in the menu
    // by the next frame, when the hook stands down for a layer.
    it.each(['Enter', ' ', 'ArrowDown'])(
      'places it before %j reaches it, so a menu it opens is drawn against a control in view',
      async (k) => {
        render(<DesktopShell />);
        const main = await layOut();
        undrawn('clipped-control');
        clickHandingOn(main, 'mid-control', 'clipped-control', 100);
        await frame();
        expect(main.scrollLeft).toBe(0);
        const control = screen.getByTestId('clipped-control');
        control.setAttribute('aria-haspopup', 'menu');
        let whenOpened: number | null = null;
        control.addEventListener('keydown', () => {
          whenOpened = main.scrollLeft;
          openMenu();
        });
        fireEvent.keyDown(control, { key: k });
        expect(whenOpened).toBe(51);
        await frame();
        expect(main.scrollLeft).toBe(51);
      }
    );

    // A ✕ a tap handed focus to, on a tablet: its Enter takes its setting off
    // and hands focus on again, so the ✕ is gone by the time anything shows.
    it('leaves a key on a control that opens no menu to place where focus ends up, a frame later', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      const control = screen.getByTestId('clipped-control');
      let whenPressed: number | null = null;
      control.addEventListener('keydown', () => {
        whenPressed = main.scrollLeft;
        act(() => screen.getByTestId('mid-control').focus());
      });
      fireEvent.keyDown(control, { key: 'Enter' });
      expect(whenPressed).toBe(0);
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    it('leaves a key that moves focus on to place what it moves to, a frame later', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      // Even off a control that opens a menu: only a key that opens one is placed first.
      screen.getByTestId('clipped-control').setAttribute('aria-haspopup', 'menu');
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab', shiftKey: true });
      expect(main.scrollLeft).toBe(0);
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    // Focus a script moved on before the frame fell: a key on where it went is
    // not a key on the control the last pass left undrawn.
    it('leaves a key on a control focus moved to since the last pass to place where focus ends up, a frame later', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      screen.getByTestId('clipped-control').setAttribute('aria-haspopup', 'menu');
      const late = mount('late-control', 430, 40);
      act(() => late.focus({ preventScroll: true }));
      late.addEventListener('keydown', () => act(() => screen.getByTestId('mid-control').focus()));
      fireEvent.keyDown(late, { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(0);
    });

    // A click counts until a key other than a modifier on its own goes down, so a button the
    // layout moves after a lone ⌘ is still placed afresh, as after the click alone.
    it('counts a click through a modifier on its own', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.pointerDown(window, { pointerId: 1 });
      place('clipped-control', 430, 32);
      fireEvent.pointerUp(window, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(61);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Meta' });
      place('clipped-control', 420, 32);
      act(() => seenCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('places a control the browser draws as focused as ever', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      clickHandingOn(main, 'mid-control', 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('places focus a key moves on afterwards as ever', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('cut-control');
      clickHandingOn(main, 'mid-control', 'cut-control', 0);
      await frame();
      expect(main.scrollLeft).toBe(0);
      fireEvent.keyDown(screen.getByTestId('cut-control'), { key: 'Tab' });
      act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('takes focus a menu hands back after a pick, the press outside the box, as ever', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const control = screen.getByTestId('clipped-control');
      undrawn('clipped-control');
      const item = openMenu();
      await frame();
      fireEvent.pointerDown(item, { pointerId: 1 });
      fireEvent.pointerUp(item, { pointerId: 1 });
      act(() => control.focus({ preventScroll: true }));
      item.remove();
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('takes focus a menu hands back after a pick as ever, though an earlier click in the box handed nothing', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const mid = screen.getByTestId('mid-control');
      fireEvent.pointerDown(mid, { pointerId: 1 });
      act(() => mid.focus());
      fireEvent.pointerUp(mid, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(0);
      const control = screen.getByTestId('clipped-control');
      undrawn('clipped-control');
      const item = openMenu();
      await frame();
      fireEvent.pointerDown(item, { pointerId: 1 });
      fireEvent.pointerUp(item, { pointerId: 1 });
      act(() => control.focus({ preventScroll: true }));
      item.remove();
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('notes no slide for a control it leaves undrawn, so a click on along the row keeps the slide it made before', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      const late = mount('late-control', 430, 40);
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      expect(main.scrollLeft).toBe(51);
      undrawn('wide-control');
      clickHandingOn(main, 'cut-control', 'wide-control', 30);
      await frame();
      expect(main.scrollLeft).toBe(51);
      fireEvent.pointerDown(late, { pointerId: 1 });
      act(() => late.focus());
      fireEvent.pointerUp(late, { pointerId: 1 });
      await frame();
      expect(main.scrollLeft).toBe(51);
    });

    it('places focus a script moves on after a key, which no click handed', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      undrawn('cut-control');
      undrawn('clipped-control');
      clickHandingOn(main, 'mid-control', 'cut-control', 0);
      await frame();
      expect(main.scrollLeft).toBe(0);
      fireEvent.keyDown(screen.getByTestId('cut-control'), { key: 'v' });
      await frame();
      act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(51);
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

    it('holds its slide while keys move a slider thumb end to end, and along the row, until focus leaves the row', async () => {
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
      // On along the row to a control that shows whole there, and then out of it.
      act(() => screen.getByTestId('mid-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(45);
      act(() => screen.getByTestId('grid-heading').focus());
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

    it('places afresh a control focus moves on to that the slide cuts, though <main> changed width under the hold', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // 330 to 362: 62 shows it whole in 300px, and 52 in 310.
      const far = mount('far-control', 431, 32);
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
      // 11px of it shows at 31: the control focus left still holds, so this
      // one is placed afresh.
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab' });
      act(() => far.focus({ preventScroll: true }));
      await frame();
      expect(main.scrollLeft).toBe(52);
    });

    it('places afresh a control focus moves on to that rest cuts, though a width change put the hold at rest', async () => {
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
      // <main> widens 10px, and the thumb, which shows at rest, goes there.
      size(main, 310);
      act(() => resizeCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Zen (289 to 321), 21px of 32 showing at rest: 11 shows it whole.
      fireEvent.keyDown(thumb, { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(11);
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
      // Focus comes from outside <main>, not from the control that held, so
      // nothing places this one afresh.
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

    it('places afresh a control focus moves on to that rest cuts, though something else slid <main> under the hold', async () => {
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
      main.scrollLeft = 80;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Zen (289 to 321), 11px of 32 showing at rest: 21 shows it whole.
      fireEvent.keyDown(thumb, { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(21);
    });

    it('leaves a held control where a scroll something else made cuts it, short of its least slide', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // Find in page: 20, where the control needs 41 and shows 11px of 32.
      main.scrollLeft = 20;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(20);
    });

    it('holds rest for a control a key moves at rest, and places afresh a control focus moves on to that rest cuts', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      // The Display trigger, as v switches Week to Day under it: 4px on,
      // whole at rest.
      const mid = screen.getByTestId('mid-control');
      act(() => mid.focus());
      await frame();
      place('mid-control', 204, 32);
      fireEvent.keyDown(mid, { key: 'v' });
      await frame();
      expect(main.scrollLeft).toBe(0);
      // Zen (289 to 321), 11px of 32 showing at rest: 21 shows it whole.
      fireEvent.keyDown(mid, { key: 'Tab' });
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(21);
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
      // A pick in the menu moves the control 40px on, wholly out of sight at 51,
      // and the menu hands focus back: the browser slides as far as it goes.
      place('clipped-control', 460, 32);
      act(() => control.focus());
      main.scrollLeft = 150;
      fireEvent.scroll(main);
      await frame();
      expect(main.scrollLeft).toBe(91);
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

    it('places afresh a control focus moves on to that the held slide cuts, though it has not moved since the slide was made', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The text, where it sat when 51 was made, cut at both ends there: 9
      // puts its start at the edge.
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab' });
      act(() => screen.getByTestId('wide-control').focus());
      await frame();
      expect(main.scrollLeft).toBe(9);
    });

    // A cut of a pixel or less, which the observer counts as whole, keeps the
    // held slide; a cut of more places the control afresh. At its end, a
    // control from 330 runs `cut` past 351; at its start, the text, to 331
    // less `cut`, starts `cut` short of 51.
    it.each([
      ['end', 1, 51],
      ['end', 1.01, 53],
      ['start', 1, 51],
      ['start', 1.01, 30],
    ])(
      'judges a control focus moves on to that the held slide cuts at its %s by %spx',
      async (edge, cut, slide) => {
        render(<DesktopShell />);
        const main = await layOut();
        let next = screen.getByTestId('wide-control');
        if (edge === 'end') next = mount('next-control', 431, 21 + cut);
        else place('wide-control', 101 + 51 - cut, 280);
        focusAndReveal(main, 'clipped-control', 100);
        await frame();
        place('clipped-control', 410, 32);
        fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
        await frame();
        expect(main.scrollLeft).toBe(51);
        fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Tab' });
        act(() => next.focus({ preventScroll: true }));
        await frame();
        expect(main.scrollLeft).toBe(slide);
      }
    );

    it('drops its hold while the row fits at rest', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      // The row shrinks to fit, and the browser clamps <main> to rest.
      Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 300 });
      main.scrollLeft = 0;
      fireEvent.scroll(main);
      await frame();
      act(() => screen.getByTestId('cut-control').focus());
      await frame();
      // It grows back with Zen cut part-way at rest (21px of 32): left as the
      // browser leaves it, the hold long gone.
      Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 400 });
      act(() => seenCallbacks.forEach((notify) => notify()));
      await frame();
      expect(main.scrollLeft).toBe(0);
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

    it('keeps the held slide for a control a menu hands focus on to that shows whole there', async () => {
      render(<DesktopShell />);
      const main = await layOut();
      focusAndReveal(main, 'clipped-control', 100);
      await frame();
      place('clipped-control', 410, 32);
      fireEvent.keyDown(screen.getByTestId('clipped-control'), { key: 'Enter' });
      await frame();
      expect(main.scrollLeft).toBe(51);
      const item = openMenu();
      await frame();
      act(() => screen.getByTestId('cut-control').focus());
      item.remove();
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
    // The switch turned back: the next focus move, scroll or resize settles
    // it. Not a key, which on nothing never reaches <main>.
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
    // Its end 0.4px past <main>'s inner right edge at rest.
    place('mid-control', 369.4, 32);
    act(() => screen.getByTestId('mid-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
    // Find in page slides <main> on, and it goes back to rest, where this shows.
    main.scrollLeft = 50;
    fireEvent.scroll(main);
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
    // The season line's button, shrunk to nothing at 460 with its 12px icon
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
      // A pixel past each side, so a control a slide shows whole to within a
      // fraction counts as whole, and a later cut is heard.
      expect(seenOptions?.rootMargin).toBe('0px 1px');
    });

    it("watch the focused control's children too, which it can paint past its box", async () => {
      render(<DesktopShell />);
      await layOut();
      const control = screen.getByTestId('clipped-control');
      const label = document.createElement('span');
      control.appendChild(label);
      act(() => control.focus());
      await frame();
      expect([...watched]).toEqual([control, label]);
      const next = screen.getByTestId('mid-control');
      act(() => next.focus());
      await frame();
      expect([...watched]).toEqual([next]);
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

describe("DesktopShell's <main>: the preview's sync line", () => {
  afterEach(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));

  it("is <main>'s first child while previewing, and absent at rest", () => {
    usePlannerStore.setState({ userId: 'u1', isLoading: true, isPreview: true });
    render(<DesktopShell />);
    const main = document.querySelector('main')!;
    const line = screen.getByTestId('planner-sync-line');
    // First child: absolute over the header row, clipped by <main>'s rounded top.
    expect(main.firstElementChild).toBe(line);
    expect(line).toHaveClass('absolute', 'top-0', 'inset-x-0');
    cleanup();

    usePlannerStore.setState({ isLoading: false, isPreview: false });
    render(<DesktopShell />);
    expect(screen.queryByTestId('planner-sync-line')).toBeNull();
  });
});

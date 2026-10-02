import { act, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';

/**
 * What the Display shelf's two suites share: the braindump's
 * (display-shelf.test.tsx) and the canvas capsule's and phone's
 * (canvas-display-shelf.test.tsx). The shelf measures nothing, and each
 * suite's "measures nothing" case rests on what these watch, so there is one
 * copy: a read added to one suite's list and not the other's would leave that
 * other suite blind to it.
 */

/**
 * Every layout read made from here until `stop`, for a case to ask which of
 * them landed on the shelf: a box's size or place on either axis, its rects,
 * or its computed style. jsdom answers each one with 0 or an empty value, so a
 * shelf that measured would still render; the reads themselves are the
 * evidence.
 */
export function watchLayoutReads() {
  const getters = [
    vi.spyOn(Element.prototype, 'getBoundingClientRect'),
    vi.spyOn(Element.prototype, 'getClientRects'),
    vi.spyOn(Element.prototype, 'clientWidth', 'get'),
    vi.spyOn(Element.prototype, 'clientHeight', 'get'),
    vi.spyOn(Element.prototype, 'scrollWidth', 'get'),
    vi.spyOn(Element.prototype, 'scrollHeight', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get'),
  ];
  // Called with the element rather than on it, so it is the argument that says where.
  const styles = vi.spyOn(window, 'getComputedStyle');
  return {
    readsIn: (root: Element) =>
      [...getters.flatMap((s) => s.mock.contexts as unknown[]), ...styles.mock.calls.map(([el]) => el)].filter(
        (el) => el instanceof Element && root.contains(el)
      ),
    stop: () => [...getters, styles].forEach((s) => s.mockRestore()),
  };
}

/**
 * Past anything a measure could be put off to: two frames, then a task. The
 * measured shelf compared its widths a frame after a resize, and measured
 * again once the fonts were in.
 */
export async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Let a closing menu go. jsdom plays no animation, so where a stylesheet gives
 * the closed content one (vaul's own does, for the sheet), Radix's Presence
 * holds it mounted until an `animationend` naming it arrives. The focus return
 * rides that unmount, a tick after it.
 */
export async function finishExit() {
  const menu = screen.getByTestId('display-menu');
  await waitFor(() => expect(menu).toHaveAttribute('data-state', 'closed'));
  const end = new Event('animationend');
  Object.defineProperty(end, 'animationName', { value: getComputedStyle(menu).animationName });
  act(() => {
    menu.dispatchEvent(end);
  });
  await waitFor(() => expect(screen.queryByTestId('display-menu')).toBeNull());
}

/** One ResizeObserver made while the recorder was in, and every element it was ever asked to watch. */
export type Observation = { cb: ResizeObserverCallback; els: Element[] };

/**
 * Put in a ResizeObserver that records each one made and what it watches,
 * until `restore`. jsdom has none, and a shelf that guarded its own would make
 * none here whatever it made in a browser. What each was asked to watch stays
 * on the record after it lets go, so a case sees an observer the shelf made
 * and dropped again as plainly as one still running.
 */
export function recordResizeObservers() {
  const made: Observation[] = [];
  class RecordingResizeObserver {
    private readonly els: Element[] = [];
    constructor(cb: ResizeObserverCallback) {
      made.push({ cb, els: this.els });
    }
    observe(el: Element) {
      this.els.push(el);
    }
    unobserve() {}
    disconnect() {}
  }
  const real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
  return {
    made,
    restore: () => {
      if (real) globalThis.ResizeObserver = real;
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    },
  };
}

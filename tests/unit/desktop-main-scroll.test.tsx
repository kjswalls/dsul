import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

// DesktopShell with its columns stubbed: the header row keeps one control that
// shows at rest and one the docked item panel has pushed past <main>'s edge.
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
      <button data-testid="seen-control">Next day</button>
      <button data-testid="cut-control">Zen</button>
      <button data-testid="clipped-control">Reset display</button>
      <button data-testid="wide-control">Grouped by Project · Showing Tasks</button>
    </div>
  ),
}));

import { DesktopShell } from '@/components/shell/desktop-shell';

/**
 * jsdom lays nothing out, so <main> gets a box (101 to 401px inside its 1px
 * border, with 400px of content) and each control a place at rest, which moves
 * left as <main> scrolls, the way a browser's would. The clipped control rests
 * at 420 to 452, wholly past the right edge; the cut one straddles it; the wide
 * one is wider than <main>.
 */
function layOut() {
  const main = document.querySelector('main')!;
  Object.defineProperty(main, 'clientLeft', { configurable: true, value: 1 });
  Object.defineProperty(main, 'clientWidth', { configurable: true, value: 300 });
  Object.defineProperty(main, 'scrollWidth', { configurable: true, value: 400 });
  main.getBoundingClientRect = () => new DOMRect(100, 0, 302, 800);
  const place = (id: string, left: number, width: number) => {
    screen.getByTestId(id).getBoundingClientRect = () =>
      new DOMRect(left - main.scrollLeft, 40, width, 32);
  };
  place('seen-control', 120, 30);
  place('cut-control', 390, 32);
  place('clipped-control', 420, 32);
  place('wide-control', 110, 370);
  // The schedule's own viewport fills <main>, and a full-width heading in it
  // runs 59px past both: the viewport cuts it, not <main>.
  place('grid-viewport', 101, 300);
  place('grid-heading', 140, 320);
  return main;
}

/** What the browser does when focus lands on a control past the edge. */
function focusAndReveal(main: HTMLElement, id: string, by: number) {
  act(() => screen.getByTestId(id).focus());
  main.scrollLeft = by;
  fireEvent.scroll(main);
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

  it('keeps the scroll that shows a clipped header control while it has focus', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    expect(main.scrollLeft).toBe(52);
  });

  it('stays where the browser showed a control whole, even past the nearest place that would', async () => {
    render(<DesktopShell />);
    const main = layOut();
    // 51 would do; a browser that centres it goes further, and that is fine.
    focusAndReveal(main, 'clipped-control', 80);
    await frame();
    expect(main.scrollLeft).toBe(80);
  });

  it('scrolls the rest of the way to a control the browser left cut at the edge', async () => {
    render(<DesktopShell />);
    const main = layOut();
    // Chromium scrolls only for a control wholly hidden: this one shows 11px of 32.
    act(() => screen.getByTestId('cut-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(21);
  });

  it('leaves a control wider than <main> where the browser put it', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'wide-control', 30);
    await frame();
    expect(main.scrollLeft).toBe(30);
  });

  it('scrolls back once focus moves on to a control that shows at rest', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    act(() => screen.getByTestId('seen-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back once focus moves into the schedule, judging a heading by what its viewport shows', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    act(() => screen.getByTestId('grid-heading').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back when focus leaves for the sidebar', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    act(() => screen.getByTestId('sidebar-control').focus());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('scrolls back when focus is dropped', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    act(() => screen.getByTestId('clipped-control').blur());
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('stays while a menu opened over the canvas holds focus, so the control it hands focus back to still shows', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    // A Radix menu portals its content into <body>, outside the shell.
    const item = document.createElement('button');
    item.dataset.testid = 'menu-item';
    document.body.appendChild(item);
    act(() => item.focus());
    await frame();
    expect(main.scrollLeft).toBe(52);
    // Radix hands focus back with preventScroll, so nothing re-reveals it.
    act(() => screen.getByTestId('clipped-control').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(52);
  });

  it('scrolls back when a menu hands focus to a control that shows at rest', async () => {
    render(<DesktopShell />);
    const main = layOut();
    focusAndReveal(main, 'clipped-control', 52);
    await frame();
    const item = document.createElement('button');
    item.dataset.testid = 'menu-item';
    document.body.appendChild(item);
    act(() => item.focus());
    await frame();
    // No focus leaves <main> here and nothing scrolls: only its arrival says so.
    act(() => screen.getByTestId('seen-control').focus({ preventScroll: true }));
    await frame();
    expect(main.scrollLeft).toBe(0);
  });

  it('puts back a scroll that nothing focused asked for', async () => {
    render(<DesktopShell />);
    const main = layOut();
    act(() => screen.getByTestId('seen-control').focus());
    await frame();
    // Find-in-page, say: it can scroll a hidden box too.
    main.scrollLeft = 40;
    fireEvent.scroll(main);
    await frame();
    expect(main.scrollLeft).toBe(0);
  });
});

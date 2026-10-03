import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The Ask button (components/ai/rail/ask-opener.tsx): Ask starts closed, and
 * this is the way to it that needs no chord.
 *
 *  - It shows only while something answers (the gate, asked; unknown is no),
 *    on the desktop, outside Zen, and while the right column is not shown
 *    (Ask closed, no item open). Hidden, it stays mounted for the hand-back.
 *  - A click is Ctrl+J from closed: Ask summoned, its box asked for, and
 *    `askOpen` written.
 *  - Its words and title name the live binding through chordLabel.
 *  - It gives way to the rest of the header row: whole, the spark alone, or
 *    nothing, by the room the row leaves it.
 *
 * The focus hand-back runs through the real shell in rail-desktop.test.tsx.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));

import { AskOpener } from '@/components/ai/rail/ask-opener';
import { ASK_OPEN_DEFAULT, useSidebarStore } from '@/lib/sidebar-store';
import { useRailStore } from '@/lib/rail-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { chordLabel } from '@/lib/commands/keys';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN, type SeedAI } from './helpers/ai-fixtures';

const realMatchMedia = window.matchMedia;
const realInnerWidth = window.innerWidth;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

beforeEach(() => {
  // No query matches: a docked window, wide enough for the desktop.
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  useSidebarStore.setState({ askOpen: ASK_OPEN_DEFAULT });
  useRailStore.getState().reset();
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false });
  useKeyboardShortcutsStore.setState({ overrides: {} });
  seed(CONNECTED_MODEL);
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  window.matchMedia = realMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: realInnerWidth });
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useRailStore.getState().reset();
});

/** The header row it sits in, with the capsule beside it. */
const renderRow = () =>
  render(
    <div data-testid="row" className="flex gap-3">
      <div data-testid="capsule" />
      <AskOpener rowOffset="mt-2" className="ml-auto" />
    </div>
  );

const opener = () => document.querySelector<HTMLButtonElement>('[data-ask-opener]');
/** Its pill: the row's child, the thing that hides and gives way. */
const pill = () => document.querySelector<HTMLElement>('[data-ask-opener-pill]');

describe('when it shows', () => {
  it('shows, Ask closed by default, as "✦ Ask" and the chord, named for what it does', () => {
    expect(useSidebarStore.getState().askOpen).toBe(false);
    renderRow();
    const button = screen.getByRole('button', { name: 'Open Ask' });
    expect(button).toBe(opener());
    expect(pill()).not.toHaveAttribute('hidden');
    expect(pill()).toContainElement(button);
    expect(button).toHaveTextContent(`Ask${chordLabel(['meta', 'j'], false)}`);
    expect(button).toHaveAttribute('title', `Open Ask (${chordLabel(['meta', 'j'], false)})`);
    expect(button).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
    // On the date's line, at the row's far end, clickable in the desktop app's drag band.
    expect(pill()).toHaveClass('mt-2', 'ml-auto');
    expect(button).toHaveClass('h-8', 'titlebar-hole');
    // The capsule's pill, by the capsule's own hook, so a layout that takes the
    // capsule's chrome away (header 'plain', 'masthead') takes this one's too.
    expect(pill()).toHaveAttribute('data-header-pill');
    expect(pill()).toHaveClass('bg-surface-2');
    // The rail header's spark: the AI's colour, never lime.
    expect(button.querySelector('svg')).toHaveClass('text-ai');
  });

  it('is not there while the gate has not answered, nor with nothing to answer', () => {
    seed();
    const { rerender } = renderRow();
    expect(opener()).toBeNull();
    act(() => seed(NOTHING_CONNECTED));
    rerender(
      <div className="flex gap-3">
        <AskOpener rowOffset="mt-2" />
      </div>
    );
    expect(opener()).toBeNull();
    // OpenClaw answering is something answering.
    act(() => seed(OPENCLAW_PLUGIN));
    expect(opener()).not.toBeNull();
  });

  it('hides while Ask shows, and comes back when it closes', () => {
    renderRow();
    act(() => useSidebarStore.getState().setAskOpen(true));
    expect(pill()).toHaveAttribute('hidden');
    expect(screen.queryByRole('button', { name: 'Open Ask' })).toBeNull();
    act(() => useRailStore.getState().closeRail());
    expect(pill()).not.toHaveAttribute('hidden');
  });

  it('hides while an item is open in the column', () => {
    renderRow();
    act(() => useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 't1' } } as never }));
    expect(pill()).toHaveAttribute('hidden');
    act(() => useUIStore.setState({ activeDialog: null }));
    expect(pill()).not.toHaveAttribute('hidden');
  });

  it('hides in Zen', () => {
    renderRow();
    act(() => useViewStore.setState({ zenOpen: true }));
    expect(pill()).toHaveAttribute('hidden');
  });

  it('is never on the phone, which has the Ask tab', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderRow();
    expect(opener()).toBeNull();
  });
});

describe('a click', () => {
  it('is Ctrl+J from closed: Ask summoned with its box asked for, and kept open', () => {
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Open Ask' }));
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(useRailStore.getState().summoned).toBe(true);
    expect(useRailStore.getState().pendingFocus).toEqual({ target: 'composer' });
    // It holds focus as it goes (Safari would not give it any), so the
    // summon notes it as where focus came from.
    expect(document.activeElement).toBe(opener());
    // And it has done its job: Ask shows, and it hides.
    expect(pill()).toHaveAttribute('hidden');
  });
});

describe('the chord', () => {
  it('names the binding as it is now, after a rebinding', () => {
    renderRow();
    act(() => useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } }));
    const label = chordLabel(['meta', 'shift', 'k'], false);
    expect(label).toBe('Ctrl+Shift+K');
    expect(opener()).toHaveAttribute('title', `Open Ask (${label})`);
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toHaveTextContent(label);
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toHaveClass('font-mono', 'text-muted-foreground');
  });
});

describe('room on the header row', () => {
  /**
   * The row as laid out: `content` px inside its 32px gutters, a 12px gap,
   * the capsule at `capsule` px, and the button's own words at 106px.
   */
  function layOut(content: number, capsule: number) {
    const row = screen.getByTestId('row');
    const cap = screen.getByTestId('capsule');
    row.style.paddingLeft = '32px';
    row.style.paddingRight = '32px';
    row.style.columnGap = '12px';
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => content + 64 });
    cap.getBoundingClientRect = () => ({ width: capsule }) as DOMRect;
    Object.defineProperty(opener() as HTMLElement, 'scrollWidth', { configurable: true, get: () => 106 });
  }

  /** The row reports a change of size. */
  function resized(observers: (() => void)[]) {
    act(() => observers.forEach((fire) => fire()));
  }

  it('is whole while its words fit, the spark alone when only that does, and gone when not even that', () => {
    const RealRO = globalThis.ResizeObserver;
    const observers: (() => void)[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(() => cb([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      renderRow();
      // 374 + 12 + 106 = 492: whole.
      layOut(500, 374);
      resized(observers);
      expect(pill()).toHaveAttribute('data-fit', 'full');
      expect(opener()).toHaveTextContent('Ask');
      expect(opener()!.querySelector('svg')).toHaveClass('text-ai');

      // 374 + 12 + 32 = 418 fits, 492 does not: the spark alone, still named.
      layOut(450, 374);
      resized(observers);
      expect(pill()).toHaveAttribute('data-fit', 'icon');
      expect(opener()).not.toHaveTextContent('Ask');
      expect(screen.getByRole('button', { name: 'Open Ask' })).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
      // Alone it is the whole control: the words' colour, since honey reads
      // about 1.6:1 on the light surface (WCAG 1.4.11 asks 3:1).
      expect(opener()!.querySelector('svg')).toHaveClass('text-foreground');
      expect(opener()!.querySelector('svg')).not.toHaveClass('text-ai');

      // Not even the spark: nothing, rather than over the capsule or a line of its own.
      layOut(400, 374);
      resized(observers);
      expect(pill()).toHaveAttribute('data-fit', 'none');
      expect(pill()).toHaveAttribute('hidden');

      // Room again: whole again, at the width it was read at.
      layOut(600, 374);
      resized(observers);
      expect(pill()).toHaveAttribute('data-fit', 'full');
      expect(pill()).not.toHaveAttribute('hidden');
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });

  it('gives way to the row and never the other way: it shrinks first, and to nothing', () => {
    renderRow();
    expect(pill()).toHaveClass('min-w-0', 'shrink-[1000]');
    expect(opener()).toHaveClass('min-w-0', 'overflow-hidden');
  });
});

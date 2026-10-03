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
 *    `askOpen` written. A pointer's click also holds Ask's header against the
 *    pointer for a moment; a key's does not.
 *  - Its chord and title name the live binding through chordLabel.
 *  - It gives way to the rest of the header row: the key and its chord, the
 *    key without the chord, the key alone, or nothing, by the room the row
 *    leaves it, against the widths it read off what it drew.
 *  - It is a raised key carrying the AI's mark (components/ai/ask-mark.tsx),
 *    whose rim is lit from the mark's lit part; its paint is app/globals.css
 *    ("Ask's key"), held by ask-key.test.tsx.
 *
 * The focus hand-back runs through the real shell in rail-desktop.test.tsx.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
// The platform, per test (isApplePlatform caches navigator.platform for the session).
const platform = vi.hoisted(() => ({ mac: false }));
vi.mock('@/lib/commands/keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/commands/keys')>()),
  isApplePlatform: () => platform.mac,
}));

import { AskOpener, ASK_OPENER_CLOSE_WAIT_MS } from '@/components/ai/rail/ask-opener';
import { ASK_MARK_LIGHT } from '@/components/ai/ask-mark';
import { useLookStore } from '@/lib/look-store';
import { ASK_OPEN_DEFAULT, useSidebarStore } from '@/lib/sidebar-store';
import {
  RAIL_HANDBACK_WAIT_MS,
  RAIL_HEADER_HOLD_MS,
  SUMMON_SPOT_SLOP_PX,
  railHeaderHeld,
  useRailStore,
} from '@/lib/rail-store';
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
  useLookStore.setState({ layout: 'classic' });
  platform.mac = false;
  seed(CONNECTED_MODEL);
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  window.matchMedia = realMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: realInnerWidth });
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useLookStore.setState({ layout: 'classic' });
  useRailStore.getState().reset();
});

/** The header row it sits in, with the capsule beside it. */
const renderRow = () =>
  render(
    <div data-testid="row" className="flex gap-3">
      <div data-testid="capsule" />
      <AskOpener className="ml-auto" />
    </div>
  );

const opener = () => document.querySelector<HTMLButtonElement>('[data-ask-opener]');
/** Its slot: the row's child, the thing that hides and gives way. */
const pill = () => document.querySelector<HTMLElement>('[data-ask-opener-slot]');
/** The raised key inside it, and the AI's mark inside that. */
const key = () => opener()?.querySelector<HTMLElement>('[data-ask-key]') ?? null;
const mark = () => opener()?.querySelector<SVGElement>('[data-ask-mark]') ?? null;

describe('when it shows', () => {
  it('shows, Ask closed by default, as the key "Ask" and the chord beside it, named for what it does', () => {
    expect(useSidebarStore.getState().askOpen).toBe(false);
    renderRow();
    const button = screen.getByRole('button', { name: 'Open Ask' });
    expect(button).toBe(opener());
    expect(pill()).not.toHaveAttribute('hidden');
    expect(pill()).toContainElement(button);
    expect(button).toHaveTextContent(`Ask${chordLabel(['meta', 'j'], false)}`);
    expect(button).toHaveAttribute('title', `Open Ask (${chordLabel(['meta', 'j'], false)})`);
    expect(button).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
    expect(button).toHaveAttribute('data-form', 'full');
    // Clickable in the desktop app's drag band, at the row's far end.
    expect(button).toHaveClass('titlebar-hole');
    expect(pill()).toHaveClass('ml-auto');
    // The key holds the mark and the word; the chord is printed beside it, on the plate.
    expect(key()).toHaveTextContent(/^Ask$/);
    expect(key()).toContainElement(mark() as unknown as HTMLElement);
    expect(button.querySelector('[data-ask-opener-chord]')?.closest('[data-ask-key]')).toBeNull();
    // The mark is decorative: the button is named by its label, not by a picture.
    expect(mark()).toHaveAttribute('aria-hidden', 'true');
    expect(button.querySelector('[data-ask-opener-chord]')).toHaveAttribute('aria-hidden');
    // The sparkle it replaced is gone.
    expect(button.querySelector('.lucide-sparkles')).toBeNull();
  });

  // Ask's header row opens where the key was (railHeaderRowOffset is the rail
  // header's own rule), so the plate stands proud of that line by its padding.
  it("puts the key on the date's line in every header: the plate stands proud of it by its own padding", () => {
    renderRow();
    // The capsule (Classic): the rail row sits mt-2 under the capsule's p-2;
    // the 48px plate's py-2 puts its 32px key there from the row's top.
    expect(pill()).toHaveClass('mt-0');
    expect(opener()).toHaveClass('h-12', 'py-2');
    expect(key()).toHaveClass('h-8');
    // The plain and masthead headers: the rail row at the top, the 40px
    // plate's py-1 under a -4px margin, and the key drawn on the page.
    act(() => useLookStore.setState({ layout: 'writer' }));
    expect(pill()).toHaveClass('-mt-1');
    expect(opener()).toHaveClass('h-10', 'py-1');
    act(() => useLookStore.setState({ layout: 'notebook' }));
    expect(pill()).toHaveClass('-mt-1');
  });

  // The key's rim is lit from the mark's lit part (app/globals.css reads the
  // two lengths), so the brightest arc is the one beside the lit tile.
  it("aims the rim's light at the mark's lit part", () => {
    renderRow();
    expect(opener()?.style.getPropertyValue('--ask-light-x')).toBe(`${ASK_MARK_LIGHT.x}px`);
    expect(opener()?.style.getPropertyValue('--ask-light-y')).toBe(`${ASK_MARK_LIGHT.y}px`);
  });

  it('is not there while the gate has not answered, nor with nothing to answer', () => {
    seed();
    const { rerender } = renderRow();
    expect(opener()).toBeNull();
    act(() => seed(NOTHING_CONNECTED));
    rerender(
      <div className="flex gap-3">
        <AskOpener />
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

  // Ask's header row opens where the button was, so a double-click's second
  // click would land on History, "+" or ✕ (rail-header.tsx swallows it).
  it("by the pointer holds Ask's header against the pointer for a moment; by a key, not at all", () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      renderRow();
      // Enter or Space: a button's click with no click count. Nothing is held.
      fireEvent.click(screen.getByRole('button', { name: 'Open Ask' }));
      expect(useRailStore.getState().summoned).toBe(true);
      expect(railHeaderHeld()).toBe(false);
      act(() => useRailStore.getState().closeRail());

      // A pointer's click carries its count.
      fireEvent.click(screen.getByRole('button', { name: 'Open Ask' }), { detail: 1 });
      expect(useRailStore.getState().summoned).toBe(true);
      expect(railHeaderHeld()).toBe(true);
      now += RAIL_HEADER_HOLD_MS - 1;
      expect(railHeaderHeld()).toBe(true);
      now += 1;
      expect(railHeaderHeld()).toBe(false);
      expect(RAIL_HEADER_HOLD_MS).toBeGreaterThanOrEqual(400);
      expect(RAIL_HEADER_HOLD_MS).toBeLessThanOrEqual(500);
    } finally {
      clock.mockRestore();
    }
  });
});

// In Console the braindump slides left under the pointer while the column
// eases in, so a quick second click lands on whatever of it just arrived.
describe("a pointer summon shields the button's own spot", () => {
  /** The button's box on screen: 80x32 at (1000, 10). */
  const BOX = { left: 1000, top: 10, right: 1080, bottom: 42, width: 80, height: 32, x: 1000, y: 10 };
  const SPOT = { clientX: 1040, clientY: 26 };

  /** Something that slid under the spot (the braindump's pill), with a spy on everything it hears. */
  function underneath() {
    const heard: string[] = [];
    const el = document.createElement('button');
    el.textContent = 'Organize projects & groups';
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      el.addEventListener(type, () => heard.push(type));
    }
    document.body.appendChild(el);
    return { el, heard, remove: () => el.remove() };
  }
  const Pointer = (typeof PointerEvent === 'function' ? PointerEvent : MouseEvent) as typeof MouseEvent;
  /** A real pointer's press and click: Chromium's pointerdown has a count of 0, its mouse events the real one. */
  function press(el: Element, at: { clientX: number; clientY: number }, count: number) {
    const opts = { bubbles: true, cancelable: true, ...at };
    const down = new Pointer('pointerdown', { ...opts, detail: 0 });
    const mouse = new MouseEvent('mousedown', { ...opts, detail: count });
    act(() => {
      el.dispatchEvent(down);
      el.dispatchEvent(mouse);
    });
    return { down, mouse };
  }
  function click(el: Element, at: { clientX: number; clientY: number }, count: number) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, ...at, detail: count });
    const dbl = new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at, detail: count });
    act(() => {
      el.dispatchEvent(e);
      if (count === 2) el.dispatchEvent(dbl);
    });
    return { click: e, dbl };
  }

  it('swallows a press and its click there, whatever is under it, for the hold only', () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const under = underneath();
    try {
      renderRow();
      vi.spyOn(opener() as HTMLButtonElement, 'getBoundingClientRect').mockReturnValue(BOX as DOMRect);
      fireEvent.click(opener() as HTMLButtonElement, { detail: 1, ...SPOT });
      expect(useRailStore.getState().summoned).toBe(true);
      const focused = document.activeElement;

      // A double-click's second press and click, 120ms on, land on what slid in.
      now += 120;
      const { down, mouse } = press(under.el, SPOT, 2);
      const second = click(under.el, SPOT, 2);
      expect(under.heard).toEqual([]);
      expect(down.defaultPrevented).toBe(true);
      expect(mouse.defaultPrevented).toBe(true);
      expect(second.click.defaultPrevented).toBe(true);
      expect(second.dbl.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focused);

      // Just past the button's edge, within the slop: still its spot.
      press(under.el, { clientX: BOX.right + SUMMON_SPOT_SLOP_PX, clientY: BOX.bottom }, 1);
      expect(under.heard).toEqual([]);
      // Anywhere else on the page, never.
      press(under.el, { clientX: 400, clientY: 300 }, 1);
      click(under.el, { clientX: 400, clientY: 300 }, 1);
      expect(under.heard).toEqual(['pointerdown', 'mousedown', 'click']);
      under.heard.length = 0;

      // A key's click (no count) is never the pointer's.
      click(under.el, SPOT, 0);
      expect(under.heard).toEqual(['click']);
      under.heard.length = 0;

      // A press swallowed just before the hold ends takes its click after it.
      now += RAIL_HEADER_HOLD_MS - 120 - 1;
      press(under.el, SPOT, 1);
      now += 50;
      click(under.el, SPOT, 1);
      expect(under.heard).toEqual([]);

      // Past the hold, the spot is the page's again.
      press(under.el, SPOT, 1);
      click(under.el, SPOT, 1);
      expect(under.heard).toEqual(['pointerdown', 'mousedown', 'click']);
    } finally {
      under.remove();
      clock.mockRestore();
    }
  });

  it('is never raised by a key, and a sign-out takes it down', () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const under = underneath();
    try {
      renderRow();
      vi.spyOn(opener() as HTMLButtonElement, 'getBoundingClientRect').mockReturnValue(BOX as DOMRect);
      // Enter or Space: no count, no shield.
      fireEvent.click(opener() as HTMLButtonElement, SPOT);
      now += 100;
      press(under.el, SPOT, 1);
      expect(under.heard).toEqual(['pointerdown', 'mousedown']);
      under.heard.length = 0;
      act(() => useRailStore.getState().closeRail());

      fireEvent.click(opener() as HTMLButtonElement, { detail: 1, ...SPOT });
      now += 100;
      press(under.el, SPOT, 1);
      expect(under.heard).toEqual([]);
      act(() => useRailStore.getState().reset());
      press(under.el, SPOT, 1);
      expect(under.heard).toEqual(['pointerdown', 'mousedown']);
    } finally {
      under.remove();
      clock.mockRestore();
    }
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
    expect(opener()).toHaveTextContent(`Ask${label}`);
    expect(opener()).toHaveAccessibleName('Open Ask');
  });

  it('prints the Mac chord on a Mac, from the same binding', () => {
    platform.mac = true;
    renderRow();
    const label = chordLabel(['meta', 'j'], true);
    expect(label).toBe('⌘J');
    expect(opener()).toHaveAttribute('title', `Open Ask (${label})`);
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toHaveTextContent(label);
  });
});

describe('room on the header row', () => {
  /** The key form's width: the key's far edge, 72px in, and an even 8px well past it. */
  const KEY_FORM = 80;
  /** The whole button's width for a chord: 70px and 6px a character (106 with Ctrl+J). */
  const wholeFor = (chord: string) => 70 + 6 * chord.length;

  let RealRO: typeof ResizeObserver;
  let observers: (() => void)[] = [];
  let observed: Element[] = [];
  beforeEach(() => {
    RealRO = globalThis.ResizeObserver;
    observers = [];
    observed = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(() => cb([], this as unknown as ResizeObserver));
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = RealRO;
  });

  /** The row reports a change of size. */
  const resized = () => act(() => observers.forEach((fire) => fire()));

  /**
   * The row as laid out: `content` px inside its 32px gutters, a 12px gap,
   * the capsule at `capsule` px, and the button drawing what it holds: whole,
   * wholeFor(chord); the key form, KEY_FORM, with the key's far edge 72px in
   * past its 8px start padding (so the whole button says the same of it),
   * unless the key form is to draw some other width (`keyForm`).
   */
  function layOut(content: number, capsule: number, keyForm = KEY_FORM) {
    const row = screen.getByTestId('row');
    const cap = screen.getByTestId('capsule');
    row.style.paddingLeft = '32px';
    row.style.paddingRight = '32px';
    row.style.columnGap = '12px';
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => content + 64 });
    cap.getBoundingClientRect = () => ({ width: capsule }) as DOMRect;
    const button = opener() as HTMLElement;
    button.style.paddingLeft = '8px';
    Object.defineProperty(button, 'scrollWidth', {
      configurable: true,
      get: () => {
        const chord = button.querySelector('[data-ask-opener-chord]');
        if (chord) return wholeFor(chord.textContent ?? '');
        return key()?.textContent === 'Ask' ? keyForm : 32;
      },
    });
    (key() as HTMLElement).getBoundingClientRect = () => ({ left: 8, right: 72, width: 64 }) as DOMRect;
  }

  /** Lay the row out to leave the button `room` px beside a 374px capsule, and read the form. */
  const at = (room: number, keyForm = KEY_FORM) => {
    layOut(374 + 12 + room, 374, keyForm);
    resized();
    return pill()?.dataset.fit;
  };

  it('is whole while key and chord fit, the key while only it fits, the key alone when only that does, and gone when not even that', () => {
    renderRow();
    // 374 + 12 + 106 = 492: whole.
    layOut(500, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'full');
    expect(opener()).toHaveAttribute('data-form', 'full');
    expect(opener()).toHaveTextContent('Ask');
    expect(opener()?.querySelector('[data-ask-opener-chord]')).not.toBeNull();

    // 374 + 12 + 80 = 466 fits, 492 does not: the key and "Ask", no chord.
    layOut(470, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'key');
    expect(opener()).toHaveAttribute('data-form', 'key');
    expect(opener()).toHaveTextContent(/^Ask$/);
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toBeNull();

    // 374 + 12 + 32 = 418 fits, 466 does not: the 32px key alone, still named.
    layOut(450, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'icon');
    expect(opener()).toHaveAttribute('data-form', 'icon');
    expect(opener()).not.toHaveTextContent('Ask');
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toBeNull();
    expect(opener()).toHaveClass('size-8', 'titlebar-hole');
    expect(key()).toHaveClass('w-8', 'h-8');
    // The mark carries it, still decorative: the name and title do the naming.
    expect(mark()).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Open Ask' })).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
    // Its key is on the rail header's own line (Classic's capsule: mt-2), with no plate around it.
    expect(pill()).toHaveClass('mt-2');

    // Not even the key: nothing, rather than over the capsule or a line of its own.
    layOut(400, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'none');
    expect(pill()).toHaveAttribute('hidden');

    // Room again: whole again, at the width it was read at.
    layOut(600, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'full');
    expect(pill()).not.toHaveAttribute('hidden');
  });

  // The ladder's rungs are the two widths it read and the 32px key, each with
  // the button's own margins (the drawn key's 14px inset): room exactly at a
  // rung takes it, a pixel short takes the next one down, both ways.
  it('steps full, key, icon, none at its rungs, its own margins counted in each, and back up the same way', () => {
    renderRow();
    for (const margin of [0, 14]) {
      (opener() as HTMLElement).style.marginRight = `${margin}px`;
      const fullRung = wholeFor('Ctrl+J') + margin;
      const keyRung = KEY_FORM + margin;
      const iconRung = 32 + margin;
      expect(at(fullRung), `${margin}px`).toBe('full');
      expect(at(fullRung - 1), `${margin}px`).toBe('key');
      expect(at(keyRung), `${margin}px`).toBe('key');
      expect(at(keyRung - 1), `${margin}px`).toBe('icon');
      expect(at(iconRung), `${margin}px`).toBe('icon');
      expect(at(iconRung - 1), `${margin}px`).toBe('none');
      expect(at(iconRung), `${margin}px`).toBe('icon');
      expect(at(keyRung - 1), `${margin}px`).toBe('icon');
      expect(at(keyRung), `${margin}px`).toBe('key');
      expect(at(fullRung - 1), `${margin}px`).toBe('key');
      expect(at(fullRung), `${margin}px`).toBe('full');
    }
    // With the inset, 106px of room is the key without its chord: 14px short.
    expect(at(106)).toBe('key');
  });

  it('keeps the chord in the title and the name in the key form: the same raised key on the same plate, the well even round it', () => {
    renderRow();
    expect(at(90)).toBe('key');
    const button = screen.getByRole('button', { name: 'Open Ask' });
    expect(button).toBe(opener());
    expect(button).toHaveAttribute('data-form', 'key');
    expect(button).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
    expect(button).toHaveAccessibleName('Open Ask');
    expect(button).toHaveClass('titlebar-hole');
    // The key holds the mark and "Ask", as whole; only the chord has gone.
    expect(button).toHaveTextContent(/^Ask$/);
    expect(button.querySelector('[data-ask-opener-chord]')).toBeNull();
    expect(key()).toHaveTextContent(/^Ask$/);
    expect(key()).toContainElement(mark() as unknown as HTMLElement);
    expect(mark()).toHaveAttribute('aria-hidden', 'true');
    expect(key()).toHaveClass('h-8', 'pr-[11px]', 'pl-[9px]', 'rounded-[10px]');
    expect(key()).not.toHaveClass('w-8');
    // The capsule's plate: 48px, 8px round the key on every side, the key on the date's line.
    expect(button).toHaveClass('h-12', 'rounded-[10px]', 'py-2', 'pl-2', 'pr-2');
    expect(button).not.toHaveClass('size-8', 'pr-2.5');
    expect(pill()).toHaveClass('mt-0');
    // Drawn on the page: the 40px plate, 4px round the key, and the 14px inset.
    for (const layout of ['notebook', 'notepad', 'writer'] as const) {
      act(() => useLookStore.setState({ layout }));
      expect(opener(), layout).toHaveAttribute('data-form', 'key');
      expect(opener(), layout).toHaveClass('h-10', 'rounded-[12px]', 'py-1', 'pl-1', 'pr-1', 'mr-3.5');
      expect(opener(), layout).not.toHaveClass('pr-2');
      expect(key(), layout).toHaveClass('rounded-[8px]');
      expect(pill(), layout).toHaveClass('-mt-1');
      expect(opener(), layout).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
    }
  });

  it("titles the key form with the Mac chord on a Mac, and fits the Mac chord's own width", () => {
    platform.mac = true;
    renderRow();
    // ⌘J is narrower than Ctrl+J: 82px whole.
    expect(at(82)).toBe('full');
    expect(at(81)).toBe('key');
    expect(opener()).toHaveAttribute('title', 'Open Ask (⌘J)');
    expect(opener()).toHaveAccessibleName('Open Ask');
  });

  // The chord is read off the plate, so a longer binding needs more room to
  // stay whole, and the key without it is what shows in between.
  it("moves the full/key rung with a rebinding's longer chord, and back", () => {
    renderRow();
    expect(at(110)).toBe('full');
    act(() => useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } }));
    const long = chordLabel(['meta', 'shift', 'k'], false);
    expect(long).toBe('Ctrl+Shift+K');
    // 142px whole now: 110 holds the key, still titled with the binding as it is.
    expect(pill()).toHaveAttribute('data-fit', 'key');
    expect(opener()).toHaveAttribute('title', `Open Ask (${long})`);
    expect(at(wholeFor(long) - 1)).toBe('key');
    expect(at(wholeFor(long))).toBe('full');
    expect(opener()?.querySelector('[data-ask-opener-chord]')).toHaveTextContent(long);
    // The key form's rung has not moved: the chord is not in it.
    expect(at(KEY_FORM)).toBe('key');
    expect(at(KEY_FORM - 1)).toBe('icon');
    // Back to the short chord while the key form shows: read afresh, and whole.
    expect(at(110)).toBe('key');
    act(() => useKeyboardShortcutsStore.setState({ overrides: {} }));
    expect(pill()).toHaveAttribute('data-fit', 'full');
    expect(opener()).toHaveAttribute('title', 'Open Ask (Ctrl+J)');
  });

  // Room exactly at a rung takes it, and nothing it then draws re-reads the
  // width that put it there: no frame of the next form up or down.
  it('holds its form with the room exactly at a rung, however often the row is re-read, and steps one rung at a time', () => {
    renderRow();
    // Every form the slot is given, in order, whether or not a frame would show it.
    const changes: string[] = [];
    const slot = pill() as HTMLElement;
    const setAttribute = slot.setAttribute;
    slot.setAttribute = function (name: string, value: string) {
      if (name === 'data-fit') changes.push(value);
      setAttribute.call(this, name, value);
    };
    const settled = () => changes.splice(0);
    try {
      for (const [room, form] of [
        [106, 'full'],
        [80, 'key'],
        [32, 'icon'],
      ] as const) {
        expect(at(room)).toBe(form);
        settled();
        for (let i = 0; i < 5; i++) resized();
        expect(settled(), `${form} at ${room}px`).toEqual([]);
        expect(pill()).toHaveAttribute('data-fit', form);
      }
      // A pixel at a time, down then up: each change is one rung, never a frame of another.
      at(107);
      settled();
      expect([at(106), at(105)]).toEqual(['full', 'key']);
      expect(settled()).toEqual(['key']);
      expect([at(80), at(79)]).toEqual(['key', 'icon']);
      expect(settled()).toEqual(['icon']);
      expect([at(32), at(31)]).toEqual(['icon', 'none']);
      expect(settled()).toEqual(['none']);
      expect([at(32), at(80), at(106)]).toEqual(['icon', 'key', 'full']);
      expect(settled()).toEqual(['icon', 'key', 'full']);
      // Straight from whole to a room the key form does not fit: the key
      // alone at once, the key form's width read off the whole button, with
      // no pass through the key form; and to one it fits, the key form.
      expect(at(79)).toBe('icon');
      expect(settled()).toEqual(['icon']);
      expect(at(106)).toBe('full');
      expect(at(80)).toBe('key');
      expect(settled()).toEqual(['full', 'key']);
      at(106);
      settled();

      // Even a key form that draws a pixel wider than the whole button said
      // settles at once on the key alone, and stays there: the width is read
      // again only when the key form shows, never by the key alone.
      expect(at(80, KEY_FORM + 1)).toBe('icon');
      expect(settled()).toEqual(['key', 'icon']);
      for (let i = 0; i < 5; i++) resized();
      expect(settled()).toEqual([]);
      expect(at(81, KEY_FORM + 1)).toBe('key');
      for (let i = 0; i < 5; i++) resized();
      expect(settled()).toEqual(['key']);
    } finally {
      slot.setAttribute = setAttribute;
    }
  });

  it("counts its own margins as room it needs (the drawn key's inset)", () => {
    renderRow();
    // 374 + 12 + 106 = 492 fits a 500px row...
    layOut(500, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'full');
    // ...but not with 14px of its own margin beside it: the key without its chord.
    (opener() as HTMLElement).style.marginRight = '14px';
    layOut(500, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'key');
    // The key alone needs it too: 34px holds the 32px key, not its inset.
    layOut(420, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'none');
    layOut(432, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'icon');
  });

  // Drawn on the page (Notebook, Notepad, Writer), the key keeps D's 14px
  // inset off the row's end alone as well as whole: flush, Notebook's
  // bookmark ribbon sat 4px past it and its focus ring came within 2px.
  it("keeps the drawn key's inset when it is the key alone; the capsule's key has none", () => {
    renderRow();
    layOut(450, 374);
    resized();
    expect(opener()).toHaveAttribute('data-form', 'icon');
    expect(opener()).not.toHaveClass('mr-3.5');
    for (const layout of ['notebook', 'notepad', 'writer'] as const) {
      act(() => useLookStore.setState({ layout }));
      resized();
      expect(opener(), layout).toHaveAttribute('data-form', 'icon');
      expect(opener(), layout).toHaveClass('size-8', 'mr-3.5');
    }
    layOut(600, 374);
    resized();
    expect(opener()).toHaveAttribute('data-form', 'full');
    expect(opener()).toHaveClass('mr-3.5');
  });

  // Its overflow is visible (the rim light and the ring paint past it), and a
  // squeezed box with visible overflow reports a scrollWidth that stops at its
  // children and leaves its end padding out: read alone, a button 8-10px short
  // of its width stayed whole, the well and the ring cutting into the chord.
  it('reads its natural width off what it draws, squeezed, not off a scrollWidth short by its end padding', () => {
    renderRow();
    // 374 + 12 + 106 = 492 fits a 500px row: whole.
    layOut(500, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'full');

    // 7px short (a 485px row, 99px of room): the slot squeezes the button
    // to 99px. It still draws its chord out to 96px, with 10px of end
    // padding past that (106 whole), but its scrollWidth says 96, which
    // would "fit" in 99.
    layOut(485, 374);
    const button = opener() as HTMLButtonElement;
    button.style.paddingRight = '10px';
    Object.defineProperty(button, 'scrollWidth', { configurable: true, get: () => 96 });
    button.getBoundingClientRect = () => ({ left: 1000, right: 1099, width: 99 }) as DOMRect;
    (key() as HTMLElement).getBoundingClientRect = () => ({ left: 1008, right: 1072, width: 64 }) as DOMRect;
    const chord = button.querySelector('[data-ask-opener-chord]') as HTMLElement;
    expect(button.lastElementChild).toBe(chord);
    chord.getBoundingClientRect = () => ({ left: 1050, right: 1096, width: 46 }) as DOMRect;
    resized();
    // Not whole: the key without its chord (80px, read off the whole button) fits.
    expect(pill()).toHaveAttribute('data-fit', 'key');
    expect(opener()).toHaveAttribute('data-form', 'key');
  });

  // A scrollWidth is whole pixels: taken when it was the larger, it read the
  // key form 82px where the whole button had said 81.64, so the ladder's two
  // reads of one width disagreed by the rounding.
  it('reads what it draws to the subpixel, laid out, not a scrollWidth rounded up', () => {
    renderRow();
    const button = opener() as HTMLButtonElement;
    /**
     * Laid out (in layout's 1/64px units, as a browser reports them): the
     * key's far edge 73.640625px in, the chord's 96.375px; the scrollWidth
     * rounded up.
     */
    const drawAt = (room: number, endPad: string, scroll: number) => {
      layOut(374 + 12 + room, 374);
      button.style.paddingRight = endPad;
      Object.defineProperty(button, 'scrollWidth', { configurable: true, get: () => scroll });
      button.getBoundingClientRect = () => ({ left: 1000, right: 1000 + room, width: room }) as DOMRect;
      (key() as HTMLElement).getBoundingClientRect = () => ({ left: 1008, right: 1073.640625, width: 65.640625 }) as DOMRect;
      const chord = button.querySelector('[data-ask-opener-chord]');
      if (chord) chord.getBoundingClientRect = () => ({ left: 1050, right: 1096.375, width: 46.375 }) as DOMRect;
      resized();
      return pill()?.dataset.fit;
    };
    // 106.375px whole: that much room holds it, though the scrollWidth says 107.
    expect(drawAt(106.375, '10px', 107)).toBe('full');
    // 81.640625px as the key, read off the whole button and then off the key
    // form alike (its well even, 8px), though the key form's scrollWidth says 82.
    expect(drawAt(81.640625, '8px', 82)).toBe('key');
    for (let i = 0; i < 3; i++) resized();
    expect(pill()).toHaveAttribute('data-fit', 'key');
  });

  it("forgets the widths it read in another header's face", () => {
    renderRow();
    // 106px whole and 80px as the key do not fit beside a 374px capsule in 450: the key alone.
    layOut(450, 374);
    resized();
    expect(pill()).toHaveAttribute('data-fit', 'icon');
    // Writer's face is narrower (say 50px whole): it is read again, and fits.
    Object.defineProperty(opener() as HTMLElement, 'scrollWidth', { configurable: true, get: () => 50 });
    (key() as HTMLElement).getBoundingClientRect = () => ({ left: 4, right: 30, width: 26 }) as DOMRect;
    act(() => useLookStore.setState({ layout: 'writer' }));
    expect(pill()).toHaveAttribute('data-fit', 'full');
  });

  it('gives way to the row and never the other way: it shrinks first, and to nothing', () => {
    renderRow();
    expect(pill()).toHaveClass('min-w-0', 'shrink-[1000]');
    expect(opener()).toHaveClass('min-w-0');
  });

  // Closing Ask hands the button back while the docked column is still easing
  // shut, the row narrower than it is about to be: read as it stood, the key
  // alone stood in for a few frames before the whole key came back.
  it('waits, unseen, for a form the row is about to have room for while the column eases shut', () => {
    // The docked column, beside the canvas: `width` px still to go.
    const rail = document.createElement('div');
    rail.setAttribute('data-rail', '');
    document.body.appendChild(rail);
    let width = 0;
    rail.getBoundingClientRect = () => ({ width }) as DOMRect;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      renderRow();
      layOut(500, 374);
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'full');
      act(() => useSidebarStore.getState().setAskOpen(true));
      expect(pill()).toHaveAttribute('hidden');

      // Closed: the column has 300px to go and the row has 64px of room. The
      // key alone would fit now; the whole key will once the column has gone,
      // so nothing shows meanwhile.
      width = 300;
      layOut(450, 374);
      act(() => useRailStore.getState().closeRail());
      resized();
      expect(observed).toContain(rail);
      expect(pill()).toHaveAttribute('data-fit', 'none');
      expect(pill()).toHaveAttribute('hidden');
      // The row grows as the column goes. The key without its chord fits at
      // 94px and does not stand in either; the whole key comes back as soon as
      // it fits.
      width = 150;
      layOut(480, 374);
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'none');
      expect(pill()).toHaveAttribute('hidden');
      width = 60;
      layOut(492, 374);
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'full');
      expect(pill()).not.toHaveAttribute('hidden');

      // A form it will not have room for even then gives way at once: 64px
      // now and 74px once the column has gone hold the key alone, either way.
      width = 10;
      layOut(450, 374);
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'icon');
      // And an overlay takes no width from the row: nothing to wait for.
      rail.style.position = 'absolute';
      width = 420;
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'icon');
      rail.style.position = '';
      width = 0;

      // Nothing waited for, nothing hidden: room for the whole key at once.
      act(() => useSidebarStore.getState().setAskOpen(true));
      layOut(500, 374);
      act(() => useRailStore.getState().closeRail());
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'full');

      // The key form fits only once the column's last few px have gone, the
      // slow tail of its ease-out: past two thirds of the 300ms the column
      // still takes 20px, and the key alone, which fits now, does not stand
      // in for it. Once the column has gone, the key form shows directly.
      const changes: string[] = [];
      const slot = pill() as HTMLElement;
      const setAttribute = slot.setAttribute;
      slot.setAttribute = function (name: string, value: string) {
        if (name === 'data-fit') changes.push(value);
        setAttribute.call(this, name, value);
      };
      try {
        act(() => useSidebarStore.getState().setAskOpen(true));
        width = 300;
        at(90 - 300);
        act(() => useRailStore.getState().closeRail());
        resized();
        expect(pill()).toHaveAttribute('hidden');
        act(() => vi.advanceTimersByTime(250));
        width = 20;
        expect(at(70)).toBe('none');
        expect(pill()).toHaveAttribute('hidden');
        act(() => vi.advanceTimersByTime(60));
        width = 0;
        expect(at(90)).toBe('key');
        expect(pill()).not.toHaveAttribute('hidden');
        expect(changes).not.toContain('icon');
      } finally {
        slot.setAttribute = setAttribute;
      }

      // The guess can be generous (a braindump the column narrowed takes some
      // room back as it goes), which only waits out the rest of the ease:
      // with the column gone, what fits shows.
      act(() => useSidebarStore.getState().setAskOpen(true));
      width = 300;
      layOut(450, 374);
      act(() => useRailStore.getState().closeRail());
      resized();
      expect(pill()).toHaveAttribute('hidden');
      act(() => vi.advanceTimersByTime(300));
      width = 0;
      resized();
      expect(pill()).toHaveAttribute('data-fit', 'icon');
      expect(pill()).not.toHaveAttribute('hidden');

      // A column that never goes is waited for only so long: past the cap
      // what fits shows, inside the focus hand-back's own wait for the button
      // to be drawn (two frames short of it), and past the column's 300ms ease.
      act(() => useSidebarStore.getState().setAskOpen(true));
      width = 300;
      act(() => useRailStore.getState().closeRail());
      resized();
      expect(pill()).toHaveAttribute('hidden');
      act(() => vi.advanceTimersByTime(ASK_OPENER_CLOSE_WAIT_MS - 1));
      resized();
      expect(pill()).toHaveAttribute('hidden');
      act(() => vi.advanceTimersByTime(1));
      expect(pill()).toHaveAttribute('data-fit', 'icon');
      expect(pill()).not.toHaveAttribute('hidden');
      expect(ASK_OPENER_CLOSE_WAIT_MS).toBeLessThanOrEqual(RAIL_HANDBACK_WAIT_MS - 2 * 16);
      expect(ASK_OPENER_CLOSE_WAIT_MS).toBeGreaterThan(300);
      // Each close waits afresh.
      act(() => useSidebarStore.getState().setAskOpen(true));
      act(() => useRailStore.getState().closeRail());
      resized();
      expect(pill()).toHaveAttribute('hidden');
    } finally {
      vi.useRealTimers();
      rail.remove();
    }
  });
});

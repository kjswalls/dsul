import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The mode sheet (components/mobile/mode-switcher-sheet.tsx): what it calls
 * the chat surface, and its focus return.
 *
 * The chat surface is Ask while something answers, and while nothing does but
 * the AI gate invites or offers the fix it holds the setup page or the fix
 * home, named as the desktop's key names them ("Set up AI", "Fix AI"), in the
 * unlit mark, with a quiet note of how much it matters. None of it lime.
 *
 * `onCloseAutoFocus`: closing hands focus back to the mode card unless the
 * sheet sent you to Ask from another surface and the box is about to take it
 * there: a conversation or an item on top (rail-store's phoneArrivalFocuses,
 * D11), the dock's own arrival rule. At Ask home and History the card gets it
 * back, rather than <body>, and so it does on the setup page, whatever the
 * stack kept from before, on a setup page that turns into Ask during the
 * close, and for the row already current: none of them moves the dock to
 * focus anything. With the dock rendered, a sheet that stands down leaves
 * focus in Ask's box.
 *
 * vaul never unmounts its content under jsdom, so the drawer is a stand-in
 * that keeps the handler the sheet hands it, and the test calls it as Radix
 * does when the close animation ends.
 */

const drawer = vi.hoisted(() => ({
  onCloseAutoFocus: null as null | ((event: { preventDefault: () => void }) => void),
}));

vi.mock('@/components/ui/drawer', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Drawer: Pass,
    DrawerTrigger: Pass,
    DrawerHeader: Pass,
    DrawerTitle: Pass,
    DrawerDescription: Pass,
    DrawerContent: ({
      children,
      onCloseAutoFocus,
    }: {
      children?: ReactNode;
      onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
    }) => {
      drawer.onCloseAutoFocus = onCloseAutoFocus ?? null;
      return <div>{children}</div>;
    },
  };
});

// The dock around the sheet: the omnibar's command context reaches for the
// router, and the dock's settings for the server.
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { MobileBottomDock } from '@/components/mobile/mobile-bottom-dock';
import { ModeSwitcherSheet } from '@/components/mobile/mode-switcher-sheet';
import { useConversationsStore } from '@/lib/conversations-store';
import { useMobileNavStore, type MobileTab } from '@/lib/mobile-nav-store';
import { useRailStore, type AskView } from '@/lib/rail-store';
import {
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  seedAI,
  type SeedAI,
} from './helpers/ai-fixtures';

let unseed: () => void = () => {};

beforeEach(() => {
  unseed = seedAI(CONNECTED_MODEL);
  useRailStore.getState().reset();
  useMobileNavStore.setState({ activeTab: 'today' });
  drawer.onCloseAutoFocus = null;
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  useRailStore.getState().reset();
});

const reseed = (s: SeedAI) => {
  act(() => {
    unseed();
    unseed = seedAI(s);
  });
};

/** Close the sheet as Radix does when its animation ends: does it keep focus off the card? */
function close(): boolean {
  const preventDefault = vi.fn();
  drawer.onCloseAutoFocus?.({ preventDefault });
  return preventDefault.mock.calls.length > 0;
}

/** From `from`, pick a surface in the sheet, then close it. */
function pickAndClose(tab: 'chat' | 'today', stack: AskView[], from: MobileTab = 'today'): boolean {
  act(() => {
    useMobileNavStore.setState({ activeTab: from });
    useRailStore.getState().reset();
    for (const view of stack) useRailStore.getState().push('phone', view);
  });
  fireEvent.click(screen.getByTestId(`mode-option-${tab}`));
  return close();
}

describe("the mode sheet's focus return", () => {
  it('stands down for an arrival on Ask where the box takes focus: a conversation or an item', () => {
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('chat', [{ kind: 'conversation', id: 'c1' }])).toBe(true);
    expect(pickAndClose('chat', [{ kind: 'history' }, { kind: 'item', itemId: 'i1' }])).toBe(true);
  });

  it('hands focus back to the card at Ask home and History, where nothing takes it', () => {
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('chat', [])).toBe(false);
    expect(pickAndClose('chat', [{ kind: 'history' }])).toBe(false);
  });

  it('hands it back for any other surface, whatever the Ask stack holds', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('today', [{ kind: 'conversation', id: 'c1' }], 'chat')).toBe(false);
  });

  it('hands it back for the Ask row already current: the tab does not move, so neither does the box', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('chat', [{ kind: 'conversation', id: 'c1' }], 'chat')).toBe(false);
  });
});

describe('the chat surface, by what it holds', () => {
  const row = () => screen.getByTestId('mode-option-chat');
  const card = () => screen.getByTestId('mobile-mode-card');
  const note = () => row().querySelector('[data-mode-note]');
  const mark = (el: Element) => el.querySelector('[data-ask-mark]');
  const ACCENT = /--(?:lime-solid|ask-icon-accent|ask-key-accent)\b|primary|lime/;
  // The stand-in drawer renders the sr-only description as bare text, so it
  // is read off the page rather than found as an element.

  it.each<[string, SeedAI]>([
    ['a model', CONNECTED_MODEL],
    ['OpenClaw', OPENCLAW_PLUGIN],
  ])('is Ask with %s answering: no note, and Ask\'s one-ink mark', (_, s) => {
    reseed(s);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);

    expect(row()).toHaveTextContent(/^Ask$/);
    expect(note()).toBeNull();
    expect(card()).toHaveAttribute('aria-label', 'Surface: Ask. Change surface.');
    expect(document.body).toHaveTextContent('Switch between the Braindump, Today and Ask surfaces.');
    for (const el of [row(), card()]) {
      expect(mark(el)).toHaveAttribute('data-tone', 'ink');
      expect(mark(el)).not.toHaveAttribute('data-lit');
    }
  });

  it.each<[string, SeedAI, string, string]>([
    ['invites', NOTHING_CONNECTED, 'Set up AI', 'Optional'],
    ['offers the fix', KEY_TURNED_DOWN, 'Fix AI', 'Needs attention'],
  ])('is the setup page while the gate %s: its word, its note, the unlit mark', (_, s, word, aside) => {
    reseed(s);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);

    // The note is its own muted span after the label, read with a space
    // between, and never part of the name the card and the description use.
    expect(row()).toHaveTextContent(`${word} ${aside}`);
    expect(note()).toHaveTextContent(aside);
    expect(note()!.className).toContain('text-xs');
    expect(note()!.className).toContain('text-muted-foreground');
    expect(card()).toHaveAttribute('aria-label', `Surface: ${word}. Change surface.`);
    expect(document.body).toHaveTextContent(`Switch between the Braindump, Today and ${word} surfaces.`);
    for (const el of [row(), card()]) {
      expect(mark(el)).toHaveAttribute('data-tone', 'aurora');
      expect(mark(el)).toHaveAttribute('data-lit', 'false');
      expect(el.outerHTML).not.toMatch(ACCENT);
    }
  });

  it('keeps the note off the card and the other rows: the card shows the glyph and the Today row its word', () => {
    reseed(NOTHING_CONNECTED);
    render(<ModeSwitcherSheet />);

    expect(card()).toHaveAttribute('aria-label', 'Surface: Today. Change surface.');
    expect(card().querySelector('[data-mode-note]')).toBeNull();
    expect(document.querySelectorAll('[data-mode-note]')).toHaveLength(1);
    expect(screen.getByTestId('mode-option-today')).toHaveTextContent(/^Today$/);
  });

  it('is not listed at all once the account has said No AI', () => {
    reseed(AI_HIDDEN);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);

    expect(screen.queryByTestId('mode-option-chat')).toBeNull();
    expect(card()).toHaveAttribute('data-surface', 'today');
    expect(document.body).toHaveTextContent('Switch between the Braindump and Today surfaces.');
  });
});

describe("the mode sheet's focus return on the setup page", () => {
  // The phone's stack outlives the gate: a conversation from before the key
  // went is still on it, under a page with no box to take focus. The card
  // gets it back.
  it.each<[string, SeedAI]>([
    ['the setup page', NOTHING_CONNECTED],
    ['the fix home', KEY_TURNED_DOWN],
  ])('hands focus back to the card on %s, whatever the stack kept', (_, s) => {
    reseed(s);
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('chat', [{ kind: 'conversation', id: 'c1' }])).toBe(false);
    expect(pickAndClose('chat', [{ kind: 'history' }, { kind: 'item', itemId: 'i1' }])).toBe(false);
  });

  // The dock gives no focus when the setup page turns into Ask under the
  // person (mobile-bottom-dock.tsx), so neither may the sheet take it.
  it('a setup page that turns into Ask during the close is no arrival: the card gets focus back', () => {
    reseed(NOTHING_CONNECTED);
    render(<ModeSwitcherSheet />);
    act(() => {
      useRailStore.getState().push('phone', { kind: 'conversation', id: 'c1' });
    });
    fireEvent.click(screen.getByTestId('mode-option-chat'));
    reseed(CONNECTED_MODEL);
    expect(close()).toBe(false);
  });

  it('nor is the current row tapped on a setup page that already turned into Ask', () => {
    reseed(NOTHING_CONNECTED);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<ModeSwitcherSheet />);
    reseed(CONNECTED_MODEL);
    act(() => {
      useRailStore.getState().push('phone', { kind: 'conversation', id: 'c1' });
    });
    expect(screen.getByTestId('mode-option-chat')).toHaveTextContent(/^Ask$/);
    fireEvent.click(screen.getByTestId('mode-option-chat'));
    expect(close()).toBe(false);
  });

  it('while a connected tap from Today, with a conversation on top, still stands down', () => {
    render(<ModeSwitcherSheet />);
    expect(pickAndClose('chat', [{ kind: 'conversation', id: 'c1' }])).toBe(true);
  });

  // The box that took it at the tap goes with Ask, so the card takes it back.
  it('unless Ask goes out during the close: the card gets focus back', () => {
    render(<ModeSwitcherSheet />);
    act(() => {
      useRailStore.getState().push('phone', { kind: 'conversation', id: 'c1' });
    });
    fireEvent.click(screen.getByTestId('mode-option-chat'));
    reseed(NOTHING_CONNECTED);
    expect(close()).toBe(false);
  });
});

describe('with the dock around it: the sheet stands down only for a box that takes the focus', () => {
  beforeAll(() => {
    if (!('ResizeObserver' in globalThis)) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  /** The macrotask the box's focus request lands in. */
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  const box = () => document.querySelector('[data-ask-composer]');
  const inBox = () => document.activeElement?.closest('[data-ask-composer]') ?? null;
  /** A conversation on the phone's stack, kept from before. */
  const conversationOnTop = () =>
    act(() => {
      useRailStore.getState().push('phone', { kind: 'conversation', id: useConversationsStore.getState().newDraft() });
    });

  /** Tap the chat row, let the dock answer, then close: true when the sheet stood down. */
  async function tapChatAndClose(o: { lightDuringClose?: boolean } = {}) {
    fireEvent.click(screen.getByTestId('mode-option-chat'));
    await settle();
    if (o.lightDuringClose) reseed(CONNECTED_MODEL);
    await settle();
    return close();
  }

  it('a connected tap from Today: it stands down, and the box has the focus', async () => {
    await conversationOnTop();
    render(<MobileBottomDock />);
    expect(await tapChatAndClose()).toBe(true);
    expect(inBox()).not.toBeNull();
  });

  it('the setup page lighting during the close: no box takes it, so the card gets it back', async () => {
    reseed(NOTHING_CONNECTED);
    await conversationOnTop();
    render(<MobileBottomDock />);
    expect(await tapChatAndClose({ lightDuringClose: true })).toBe(false);
    expect(box()).not.toBeNull();
    expect(inBox()).toBeNull();
  });

  it('the current row tapped after the setup page lit: the same', async () => {
    reseed(NOTHING_CONNECTED);
    useMobileNavStore.setState({ activeTab: 'chat' });
    await conversationOnTop();
    render(<MobileBottomDock />);
    reseed(CONNECTED_MODEL);
    await settle();
    expect(await tapChatAndClose()).toBe(false);
    expect(box()).not.toBeNull();
    expect(inBox()).toBeNull();
  });
});

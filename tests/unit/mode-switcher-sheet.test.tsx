import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The mode sheet's focus return (components/mobile/mode-switcher-sheet.tsx
 * `onCloseAutoFocus`). Closing hands focus back to the mode card unless the
 * sheet sent you to Ask and the box is about to take it there: a conversation
 * or an item on top (rail-store's phoneArrivalFocuses, D11). At Ask home and
 * History the card gets it back, rather than <body>.
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

import { ModeSwitcherSheet } from '@/components/mobile/mode-switcher-sheet';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useRailStore, type AskView } from '@/lib/rail-store';
import { CONNECTED_MODEL, seedAI } from './helpers/ai-fixtures';

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

/** Pick a surface in the sheet, then close it as Radix does: does the sheet keep focus off the card? */
function pickAndClose(tab: 'chat' | 'today', stack: AskView[]): boolean {
  useRailStore.getState().reset();
  for (const view of stack) useRailStore.getState().push('phone', view);
  fireEvent.click(screen.getByTestId(`mode-option-${tab}`));
  const preventDefault = vi.fn();
  drawer.onCloseAutoFocus?.({ preventDefault });
  return preventDefault.mock.calls.length > 0;
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
    expect(pickAndClose('today', [{ kind: 'conversation', id: 'c1' }])).toBe(false);
  });
});

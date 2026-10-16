import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';

/**
 * Pocket (memory/plans/power-mode.md, the polish round): the page publishes the
 * current item to the desktop shell's pocket, does what its buttons ask only for
 * the item it showed, and draws the pocket button only in the desktop app.
 */

const done = vi.fn();
const skip = vi.fn();
vi.mock('@/lib/do-stuff', async (orig) => ({
  ...(await orig<typeof import('@/lib/do-stuff')>()),
  doneNext: (id: string) => done(id),
  skipNext: (id: string) => skip(id),
}));

import { useDoStuffStore } from '@/lib/do-stuff';
import { PocketButton, PocketSync } from '@/components/sidebar/do-stuff-pocket';
import type { DsulDesktop } from '@/lib/desktop';

type Action = { action: 'done' | 'skip'; id: string };

function fakeShell() {
  const published: unknown[] = [];
  let press: ((m: Action) => void) | null = null;
  const bridge = {
    version: 1,
    setPocket: vi.fn((s: unknown) => published.push(s)),
    openPocket: vi.fn(async () => true),
    onPocketAction: vi.fn((cb: (m: Action) => void) => {
      press = cb;
      return () => {
        press = null;
      };
    }),
  } as unknown as DsulDesktop;
  (window as unknown as { dsulDesktop?: DsulDesktop }).dsulDesktop = bridge;
  return { bridge, published, press: (m: Action) => press?.(m) };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { dsulDesktop?: DsulDesktop }).dsulDesktop;
  useDoStuffStore.setState({ on: false, next: null, doneCount: 0, sprint: null });
  done.mockClear();
  skip.mockClear();
});

describe('PocketSync', () => {
  it('publishes the current item, once per change, and nothing when the mode stops', () => {
    const { published } = fakeShell();
    render(<PocketSync />);
    expect(published).toEqual([null]);
    act(() => useDoStuffStore.setState({ on: true, next: { id: 'a', title: 'Text Priya' }, doneCount: 1 }));
    expect(published.at(-1)).toEqual({ id: 'a', title: 'Text Priya', done: 1, sprint: null });
    const count = published.length;
    // A change the pocket doesn't show publishes nothing.
    act(() => useDoStuffStore.setState({ skipped: ['z'] }));
    expect(published).toHaveLength(count);
    const sprint = { startedAt: 1, endsAt: 2, until: 'Lunch' };
    act(() => useDoStuffStore.setState({ sprint }));
    expect(published.at(-1)).toEqual({ id: 'a', title: 'Text Priya', done: 1, sprint });
    act(() => useDoStuffStore.setState({ on: false }));
    expect(published.at(-1)).toBeNull();
  });

  it('does done and skip only for the item the pocket showed', () => {
    const shell = fakeShell();
    render(<PocketSync />);
    act(() => useDoStuffStore.setState({ on: true, next: { id: 'a', title: 'Text Priya' } }));
    shell.press({ action: 'done', id: 'a' });
    shell.press({ action: 'skip', id: 'a' });
    expect(done).toHaveBeenCalledWith('a');
    expect(skip).toHaveBeenCalledWith('a');
    // The walk moved on between the press and its arrival.
    shell.press({ action: 'done', id: 'old' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('says nothing is current when it goes', () => {
    const { published } = fakeShell();
    act(() => useDoStuffStore.setState({ on: true, next: { id: 'a', title: 'x' } }));
    const { unmount } = render(<PocketSync />);
    unmount();
    expect(published.at(-1)).toBeNull();
  });

  it('is nothing in a browser, or in a shell without the pocket', () => {
    render(<PocketButton />);
    expect(screen.queryByTestId('do-stuff-pocket')).toBeNull();
    cleanup();
    (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
    render(
      <>
        <PocketSync />
        <PocketButton />
      </>
    );
    expect(screen.queryByTestId('do-stuff-pocket')).toBeNull();
  });
});

describe('PocketButton', () => {
  it('opens the pocket in the desktop app', () => {
    const { bridge } = fakeShell();
    render(<PocketButton />);
    fireEvent.click(screen.getByTestId('do-stuff-pocket'));
    expect(bridge.openPocket).toHaveBeenCalled();
  });
});

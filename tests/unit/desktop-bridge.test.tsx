import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

/**
 * The web side of the desktop app's bridge (components/providers/desktop-bridge.tsx).
 *
 * A quick-capture press from the shell's global shortcut or tray has to land as
 * the launcher in add mode, on the planner, from whatever route the window was
 * showing, and nowhere else. These drive the real provider beside the real
 * OmniLauncher, so "it opened" is asserted on the omnibar's input rather than
 * on the store slot alone: the slot can say `+` while a still-mounted omnibar
 * shows whatever was typed before (see openQuickCapture in lib/ui-store.ts).
 *
 * The bridge is a fake with the contract's shape (lib/desktop.ts); a press is
 * main sending 'dsul:quick-capture', which the preload hands to the callback.
 */

const nav = vi.hoisted(() => {
  const push = vi.fn();
  const router = { push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return {
    pathname: '/',
    push,
    // Stable, as Next's is: the provider subscribes once per router.
    useRouter: vi.fn(() => router),
    usePathname: vi.fn(() => nav.pathname),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: nav.useRouter,
  usePathname: nav.usePathname,
  useSearchParams: () => new URLSearchParams(),
}));

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));

import { DesktopBridge } from '@/components/providers/desktop-bridge';
import { OmniLauncher } from '@/components/shell/omni-launcher';
import type { DsulDesktop } from '@/lib/desktop';
import { usePlannerStore } from '@/lib/planner-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useUIStore } from '@/lib/ui-store';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** A bridge with the contract's shape, and a way to press the shortcut. */
function installBridge(overrides: Partial<DsulDesktop> = {}) {
  const listeners = new Set<() => void>();
  const bridge = {
    version: 1 as const,
    shellVersion: '0.1.0',
    electronVersion: '44.5.1',
    platform: 'win32' as const,
    onQuickCapture: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    openAuthUrl: vi.fn(async () => true),
    armEmailSignIn: vi.fn(async () => {}),
    takeSignInNotice: vi.fn(async () => false),
    ...overrides,
  };
  window.dsulDesktop = bridge;
  const press = () =>
    act(() => {
      for (const cb of listeners) cb();
    });
  return { bridge, press, listeners };
}

/** The provider where the root layout puts it, and the launcher where AppShell does. */
const Tree = () => (
  <>
    <DesktopBridge />
    <OmniLauncher />
  </>
);

const slot = () => useUIStore.getState().activeDialog;
const launcherInput = () =>
  document.querySelector<HTMLInputElement>(
    '[data-omnibar-variant="launcher"] [data-testid="omnibar-input"]'
  );

/** Counts the times the launcher goes from shut to open. */
function countLauncherOpens() {
  let opens = 0;
  const stop = useUIStore.subscribe((s, prev) => {
    if (s.activeDialog?.type === 'launcher' && prev.activeDialog?.type !== 'launcher') opens += 1;
  });
  return { opens: () => opens, stop };
}

beforeEach(() => {
  nav.pathname = '/';
  nav.push.mockClear();
  nav.useRouter.mockClear();
  nav.usePathname.mockClear();
  toast.mockClear();
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
  useSessionUserStore.setState({ user: null });
  usePlannerStore.setState({ userId: 'u1', isLoading: false } as never);
});

afterEach(() => {
  cleanup();
  delete window.dsulDesktop;
});

describe('in a browser', () => {
  it('renders nothing and runs none of the live half', () => {
    const { container } = render(<DesktopBridge />);
    expect(container).toBeEmptyDOMElement();
    // The router and pathname hooks belong to the live half; not calling them
    // is how "subscribes to nothing" shows from outside.
    expect(nav.useRouter).not.toHaveBeenCalled();
    expect(nav.usePathname).not.toHaveBeenCalled();
  });

  it('leaves a bridge of a version it does not know alone', () => {
    const { bridge } = installBridge();
    window.dsulDesktop = { ...bridge, version: 2 } as unknown as DsulDesktop;
    render(<DesktopBridge />);
    expect(bridge.onQuickCapture).not.toHaveBeenCalled();
    expect(bridge.takeSignInNotice).not.toHaveBeenCalled();
  });
});

describe('a quick-capture press', () => {
  it('is ignored on a signed-out page', () => {
    nav.pathname = '/login';
    const { press } = installBridge();
    render(<Tree />);
    press();

    expect(nav.push).not.toHaveBeenCalled();
    expect(slot()).toBeNull();
  });

  it('from /settings goes home once, then opens the launcher once the planner settles', () => {
    nav.pathname = '/settings';
    usePlannerStore.setState({ isLoading: true } as never);
    const { press } = installBridge();
    const opens = countLauncherOpens();
    const { rerender } = render(<Tree />);

    press();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/');
    // Not before arriving: the launcher is not mounted off the planner.
    expect(slot()).toBeNull();

    nav.pathname = '/';
    rerender(<Tree />);
    // Home, but the load has not landed, so still nothing.
    expect(slot()).toBeNull();

    act(() => usePlannerStore.setState({ isLoading: false } as never));
    expect(slot()).toEqual({ type: 'launcher', query: '+' });
    expect(launcherInput()?.value).toBe('+');
    expect(opens.opens()).toBe(1);
    expect(nav.push).toHaveBeenCalledTimes(1);
    opens.stop();
  });

  it('on the planner opens the launcher in add mode without navigating', () => {
    const { press } = installBridge();
    render(<Tree />);
    press();

    expect(nav.push).not.toHaveBeenCalled();
    expect(launcherInput()?.value).toBe('+');
  });

  it('a second press with the launcher open re-seeds it', async () => {
    const { press } = installBridge();
    render(<Tree />);
    press();
    fireEvent.change(launcherInput()!, { target: { value: '+buy milk' } });
    expect(launcherInput()?.value).toBe('+buy milk');

    press();
    // Re-seeded on a fresh omnibar, not the one still holding the typing.
    await waitFor(() => expect(launcherInput()?.value).toBe('+'));
    expect(slot()).toEqual({ type: 'launcher', query: '+' });
  });

  it('leaves an open Add dialog alone, and does not wait to ambush it', () => {
    const add = { type: 'add' as const, tab: 'task' };
    useUIStore.setState({ activeDialog: add });
    const { press } = installBridge();
    const { rerender } = render(<Tree />);
    press();

    expect(slot()).toBe(add);
    // Closing it later does not let the press through after the fact.
    act(() => useUIStore.getState().closeDialog());
    rerender(<Tree />);
    expect(slot()).toBeNull();
  });

  it('takes the slot from the docked item panel, as ⌘K does', () => {
    // A row click leaves the item open in the docked panel, which is this same
    // slot, so it is the state a press usually finds the planner in. Only the
    // slot's type matters to this tree; the panel itself is not mounted here.
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
    const { press } = installBridge();
    render(<Tree />);
    press();

    expect(slot()).toEqual({ type: 'launcher', query: '+' });
    expect(launcherInput()?.value).toBe('+');
  });

  it('leaves an open confirm alone, rather than stacking the launcher over it', () => {
    useUIStore.getState().confirm({ title: 'Delete task?', description: 'x', onConfirm: vi.fn() });
    const { press } = installBridge();
    render(<Tree />);
    press();

    expect(slot()).toBeNull();
    expect(launcherInput()).toBeNull();
    expect(useUIStore.getState().confirmRequest?.title).toBe('Delete task?');
  });

  it('does not reopen the launcher over a confirm raised while it was closing', async () => {
    const { press } = installBridge();
    render(<Tree />);
    press();
    expect(launcherInput()?.value).toBe('+');

    // A second press closes the launcher and reopens it a task later. A confirm
    // that lands in between keeps it shut.
    press();
    act(() => {
      useUIStore.getState().confirm({ title: 'Delete task?', description: 'x', onConfirm: vi.fn() });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(slot()).toBeNull();
    expect(useUIStore.getState().confirmRequest?.title).toBe('Delete task?');
  });

  it('is dropped by a bounce to /login on the way home', () => {
    nav.pathname = '/settings';
    usePlannerStore.setState({ isLoading: true } as never);
    const { press } = installBridge();
    const { rerender } = render(<Tree />);
    press();

    nav.pathname = '/login';
    rerender(<Tree />);
    // Signed in again and home: the old press must not open anything.
    nav.pathname = '/';
    rerender(<Tree />);
    act(() => usePlannerStore.setState({ isLoading: false } as never));
    expect(slot()).toBeNull();
  });

  it('unsubscribes when it unmounts', () => {
    const { listeners } = installBridge();
    const { unmount } = render(<Tree />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe('the "Signed in as" notice', () => {
  const user = { id: 'u1', email: 'kirby@example.com', displayName: null, avatarUrl: null };

  it('waits for the session, then names its account once', async () => {
    const { bridge } = installBridge({ takeSignInNotice: vi.fn(async () => true) });
    render(<DesktopBridge />);
    await act(async () => {});

    expect(bridge.takeSignInNotice).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();

    act(() => useSessionUserStore.getState().setUser(user));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Signed in as kirby@example.com');

    // One-shot: a later session update does not raise it again.
    act(() => useSessionUserStore.getState().setUser({ ...user, email: 'other@example.com' }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('says nothing when main has no notice to give', async () => {
    useSessionUserStore.setState({ user });
    installBridge();
    render(<DesktopBridge />);
    await act(async () => {});
    expect(toast).not.toHaveBeenCalled();
  });

  it('asks main once under StrictMode, so the one-shot true is not spent on a discarded run', async () => {
    useSessionUserStore.setState({ user });
    const take = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false);
    installBridge({ takeSignInNotice: take });
    render(
      <StrictMode>
        <DesktopBridge />
      </StrictMode>
    );
    await act(async () => {});

    expect(take).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('a refused ask is no notice, not an error', async () => {
    useSessionUserStore.setState({ user });
    installBridge({ takeSignInNotice: vi.fn(async () => Promise.reject(new Error('refused'))) });
    render(<DesktopBridge />);
    await act(async () => {});
    expect(toast).not.toHaveBeenCalled();
  });
});

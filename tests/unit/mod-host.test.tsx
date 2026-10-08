// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * components/mods/mod-host.tsx: the runtime starts only once the planner has
 * settled for this account with a switched-on mod and no safe mode, wires
 * the event buses and the ⌘K slot, and lets everything go when that stops.
 */

const rt = vi.hoisted(() => ({
  created: 0,
  deps: null as null | Record<string, unknown>,
  runtime: {
    dispatch: vi.fn(),
    dispatchUndo: vi.fn(),
    runCommand: vi.fn(),
    rowsChanged: vi.fn(),
    saved: vi.fn(),
    enabled: vi.fn(),
    noteHidden: vi.fn(),
    flushAll: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    loadedIds: () => [],
    resolvePanel: vi.fn(async () => ({ ok: true }) as const),
    runAction: vi.fn(async () => 'dropped' as const),
    atomChanged: vi.fn(async () => 'dropped' as const),
    resolvesPanels: vi.fn(() => true),
    settingsChanged: vi.fn(),
    panelFault: vi.fn(),
  },
}));
vi.mock('@/lib/mods/runtime-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mods/runtime-manager')>();
  return {
    ...actual,
    createModRuntime: (deps: Record<string, unknown>) => {
      rt.created++;
      rt.deps = deps;
      return rt.runtime;
    },
  };
});
const release = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mods/sandbox-host', () => ({ modSandbox: { hold: () => release } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { ModHost } from '@/components/mods/mod-host';
import { usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import { __resetModEventsForTests, raiseModEvent } from '@/lib/mod-events';
import { runModCommand } from '@/lib/mods/command-run';
import { activeModRuntime } from '@/lib/mods/runtime-manager';
import { hasModPanelRunner, resolvePanel } from '@/lib/mods/ui/panel-run';
import { __resetPanelStoreForTests, panelBridge, usePanelStore } from '@/lib/mods/ui/panel-store';
import type { UserMod } from '@/lib/mods/schema';

/** The store's own actions, put back before each test (some tests swap one for a spy). */
const ACTIONS = { ...usePanelStore.getState() };

const USER = '11111111-1111-4111-8111-111111111111';

const mod = (over: Partial<UserMod> = {}): UserMod => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: USER,
  kind: 'mod',
  slug: 'water',
  name: 'Water',
  enabled: true,
  manifest: { version: 1, uses: [], commands: [] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

function seed(rows: UserMod[], plannerOver: Record<string, unknown> = {}) {
  usePlannerStore.setState({ userId: USER, isLoading: false, loadFailedUserId: null, ...plannerOver } as never);
  useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, safeMode: false, rows });
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetModEventsForTests();
  usePanelStore.setState(ACTIONS);
  __resetPanelStoreForTests();
  rt.created = 0;
  release.mockClear();
  for (const fn of Object.values(rt.runtime)) if (vi.isMockFunction(fn)) fn.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ModHost', () => {
  it('starts the runtime with a mod on, wires the events and ⌘K, and lets go on unmount', () => {
    seed([mod()]);
    const { unmount } = render(<ModHost />);
    expect(rt.created).toBe(1);
    expect(activeModRuntime()).toBe(rt.runtime);

    raiseModEvent({ kind: 'review.saved', date: '2026-03-10' });
    vi.runAllTimers();
    expect(rt.runtime.dispatch).toHaveBeenCalledWith({ kind: 'review.saved', date: '2026-03-10' });
    runModCommand('m', 'log');
    expect(rt.runtime.runCommand).toHaveBeenCalledWith('m', 'log');

    unmount();
    expect(rt.runtime.stop).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(activeModRuntime()).toBeNull();
    runModCommand('m', 'log');
    expect(rt.runtime.runCommand).toHaveBeenCalledTimes(1);
  });

  it('stays off while the planner is loading, in safe mode, or with every mod off', () => {
    seed([mod()], { isLoading: true });
    render(<ModHost />);
    cleanup();
    seed([mod()]);
    useModsStore.setState({ safeMode: true });
    render(<ModHost />);
    cleanup();
    seed([mod({ enabled: false }), mod({ kind: 'recipe' })]);
    render(<ModHost />);
    expect(rt.created).toBe(0);
  });

  it('stops when the last mod goes off, and tells the runtime when rows change', () => {
    seed([mod(), mod({ id: '00000000-0000-4000-8000-000000000002', slug: 'b', enabled: false })]);
    render(<ModHost />);
    act(() => {
      useModsStore.setState({ rows: [mod(), mod({ id: '00000000-0000-4000-8000-000000000002', slug: 'b' })] });
    });
    expect(rt.runtime.enabled).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002');
    expect(rt.runtime.rowsChanged).toHaveBeenCalled();
    act(() => {
      useModsStore.setState({ rows: [mod({ enabled: false })] });
    });
    expect(rt.runtime.stop).toHaveBeenCalled();
  });

  it('flushes the store when the tab hides or the page goes', () => {
    seed([mod()]);
    render(<ModHost />);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rt.runtime.noteHidden).toHaveBeenCalled();
    expect(rt.runtime.flushAll).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(rt.runtime.flushAll).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('re-reads the rows on focus, at most every 30s', () => {
    const refresh = vi.fn(async () => {});
    seed([]);
    useModsStore.setState({ refresh });
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    render(<ModHost />);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-03-10T12:00:31Z'));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith(USER);
  });

  it('fills the panel slot, hands the runtime the panel store, and empties both when it stops', async () => {
    seed([mod()]);
    const { unmount } = render(<ModHost />);
    expect(hasModPanelRunner()).toBe(true);
    await resolvePanel({ modId: 'm', panelId: 'p' });
    expect(rt.runtime.resolvePanel).toHaveBeenCalledWith('m', 'p');
    expect(rt.deps?.panels).toBe(panelBridge);

    const invalidate = vi.fn();
    const slowDown = vi.fn();
    usePanelStore.setState({ invalidate, slowDown });
    (rt.deps?.onPanelsStale as (id: string, why: string) => void)('m', 'saved');
    expect(invalidate).toHaveBeenCalledWith('m', 'saved');
    (rt.deps?.onUserHooksSlowed as (id: string) => void)('m');
    expect(slowDown).toHaveBeenCalledWith('m');

    const reset = vi.fn();
    usePanelStore.setState({ reset });
    unmount();
    expect(hasModPanelRunner()).toBe(false);
    expect(reset).toHaveBeenCalled();
  });

  it('redraws the panels of mods that draw any, a second after the items settle, only while one shows', () => {
    seed([mod()]);
    render(<ModHost />);
    const invalidate = vi.fn();
    usePanelStore.setState({ invalidate });
    act(() => usePlannerStore.setState({ items: [] }));
    vi.advanceTimersByTime(2000);
    expect(invalidate).not.toHaveBeenCalled();

    usePanelStore.setState({ visible: { 'x:y': 1 } });
    act(() => usePlannerStore.setState({ items: [] }));
    vi.advanceTimersByTime(500);
    act(() => usePlannerStore.setState({ items: [] }));
    vi.advanceTimersByTime(999);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(mod().id, 'items');

    rt.runtime.resolvesPanels.mockReturnValue(false);
    act(() => usePlannerStore.setState({ items: [] }));
    vi.advanceTimersByTime(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    rt.runtime.resolvesPanels.mockReturnValue(true);
  });

  it('forgets a mod’s panels when it goes off, and resets the panels for another account', () => {
    const second = mod({ id: '00000000-0000-4000-8000-000000000002', slug: 'b' });
    seed([mod(), second]);
    render(<ModHost />);
    const forgetMod = vi.fn();
    const reset = vi.fn();
    usePanelStore.setState({ forgetMod, reset });
    act(() => useModsStore.setState({ rows: [mod(), { ...second, enabled: false }] }));
    expect(forgetMod).toHaveBeenCalledWith(second.id);
    act(() => usePlannerStore.setState({ userId: '22222222-2222-4222-8222-222222222222' } as never));
    expect(reset).toHaveBeenCalled();
  });
});

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
  },
}));
vi.mock('@/lib/mods/runtime-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mods/runtime-manager')>();
  return {
    ...actual,
    createModRuntime: () => {
      rt.created++;
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
import type { UserMod } from '@/lib/mods/schema';

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

  it('builds nothing over the look-only preview, even with Make hydrated early, and starts at the landing', () => {
    // memory/plans/instant-planner.md: ThemeInjector may hydrate Make's rows
    // while the cached rows are up. The preview keeps isLoading on, so no
    // runtime, no ⌘K slot, no bus and no refresh until the fresh rows land.
    const refresh = vi.fn(async () => {});
    seed([mod()], { isLoading: true, isPreview: true });
    useModsStore.setState({ refresh });
    render(<ModHost />);
    expect(rt.created).toBe(0);
    expect(activeModRuntime()).toBeNull();
    runModCommand('m', 'log');
    raiseModEvent({ kind: 'review.saved', date: '2026-03-10' });
    vi.runAllTimers();
    window.dispatchEvent(new Event('focus'));
    expect(rt.runtime.runCommand).not.toHaveBeenCalled();
    expect(rt.runtime.dispatch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    act(() => {
      usePlannerStore.setState({ isLoading: false, isPreview: false } as never);
    });
    expect(rt.created).toBe(1);
    expect(activeModRuntime()).toBe(rt.runtime);
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
});

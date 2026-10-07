// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * components/recipes/recipe-host.tsx: the engine starts only once the planner
 * has settled for this account with a switched-on recipe, and the clock ticks
 * in ONE tab per browser (the holder of a Web Lock), or directly where there
 * are no Web Locks.
 */

const engine = vi.hoisted(() => ({
  runClock: vi.fn(async () => {}),
  stop: vi.fn(),
  startRecipeEngine: vi.fn(),
}));
vi.mock('@/lib/recipes/engine', () => ({
  runClock: engine.runClock,
  startRecipeEngine: (...args: unknown[]) => {
    engine.startRecipeEngine(...args);
    return engine.stop;
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { RecipeHost } from '@/components/recipes/recipe-host';
import { usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import type { UserMod } from '@/lib/mods/schema';

const USER = '11111111-1111-4111-8111-111111111111';

const row = (on: string, over: Partial<UserMod> = {}): UserMod => ({
  id: crypto.randomUUID(),
  userId: USER,
  kind: 'recipe',
  slug: 'r',
  name: 'R',
  enabled: true,
  manifest: { version: 1, trigger: { on }, filters: {}, steps: [{ do: 'toast', text: 'x' }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

/** A Web Lock that grants the first requester and queues the rest until it is released. */
function fakeLocks() {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    request: vi.fn((_name: string, opts: { signal: AbortSignal }, cb: () => Promise<void>) => {
      return new Promise<void>((resolve, reject) => {
        const grant = () => {
          held = true;
          cb().then(() => {
            held = false;
            waiting.shift()?.();
            resolve();
          });
        };
        opts.signal.addEventListener('abort', () => {
          const at = waiting.indexOf(grant);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
        });
        if (held) waiting.push(grant);
        else grant();
      });
    }),
  };
}

function seed(rows: UserMod[], plannerOver: Record<string, unknown> = {}) {
  usePlannerStore.setState({ userId: USER, isLoading: false, loadFailedUserId: null, ...plannerOver } as never);
  useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, safeMode: false, rows });
}

beforeEach(() => {
  vi.useFakeTimers();
  engine.runClock.mockClear();
  engine.startRecipeEngine.mockClear();
  engine.stop.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
});

describe('RecipeHost', () => {
  it('starts the engine once settled with a switched-on recipe, and stops it on unmount', () => {
    seed([row('item.completed')]);
    const { unmount } = render(<RecipeHost />);
    expect(engine.startRecipeEngine).toHaveBeenCalledTimes(1);
    // No clock recipe, no clock.
    expect(engine.runClock).not.toHaveBeenCalled();
    unmount();
    expect(engine.stop).toHaveBeenCalled();
  });

  it('stays off while the planner is loading, in safe mode, or with every recipe off', () => {
    seed([row('item.completed')], { isLoading: true });
    render(<RecipeHost />);
    cleanup();
    seed([row('item.completed')]);
    useModsStore.setState({ safeMode: true });
    render(<RecipeHost />);
    cleanup();
    seed([row('item.completed', { enabled: false })]);
    render(<RecipeHost />);
    expect(engine.startRecipeEngine).not.toHaveBeenCalled();
  });

  it('without Web Locks every tab ticks; the claims keep a run to once', () => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    seed([row('day.opened')]);
    render(
      <>
        <RecipeHost />
        <RecipeHost />
      </>
    );
    expect(engine.runClock).toHaveBeenCalledTimes(2);
  });

  it('with Web Locks only the holder ticks, and the next takes over when it goes', async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    seed([row('day.opened')]);
    const first = render(<RecipeHost />);
    render(<RecipeHost />);
    expect(locks.request).toHaveBeenCalledTimes(2);
    expect(engine.runClock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(engine.runClock).toHaveBeenCalledTimes(2);

    first.unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(engine.runClock).toHaveBeenCalledTimes(3);
  });
});

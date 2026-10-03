import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

/**
 * The extensions half of the planner preview: a display-only `previewEnabled`
 * map, seeded from the planner snapshot while the real fetch is in flight.
 *
 * Without it a goal-grouped canvas paints ungrouped from the cache, then
 * regroups mid-preview with nothing animating it. With it done wrong, a cached
 * toggle beats server truth — `enabled` entries present when the fetch lands
 * are merged OVER the server rows as in-flight toggles — or reaches something
 * that ACTS: `isEnabled()` feeds Beeminder live and the completion confetti.
 */

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchUserExtensions: vi.fn(async () => ({})),
  fetchUserExtensionConfigs: vi.fn(async () => ({})),
  setUserExtensionEnabled: vi.fn(async () => {}),
  setUserExtensionConfig: vi.fn(async () => {}),
}));

import { fetchUserExtensions } from '@/lib/db';
import { useExtensionsStore } from '@/lib/extensions-store';
import {
  extensionEnabled,
  goalsEnabled,
  groupByOptionsFor,
  organizeEnabled,
  resolvedCanvasGroupBy,
  useBraindumpGroupBy,
  useCanvasGroupBy,
  useExtensionEnabled,
  useExtensionPredicate,
} from '@/lib/extension-gates';
import { EXT_GOALS, EXT_ORGANIZE, EXT_STREAKS } from '@/lib/extension-registry';
import { CANVAS_GROUP_BY_OPTIONS } from '@/lib/view-options';
import { useViewStore } from '@/lib/view-store';

const mockFetch = vi.mocked(fetchUserExtensions);

const U = 'user-a';
const V = 'user-b';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Start `userId`'s hydrate and hold its toggle fetch open. */
function hydrateHeld(userId: string) {
  const fetch = deferred<Record<string, boolean> | null>();
  mockFetch.mockReturnValueOnce(fetch.promise);
  const done = useExtensionsStore.getState().hydrate(userId);
  return { fetch, done };
}

const store = () => useExtensionsStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  store().reset();
  // Goals ships OFF, so a goal grouping is exactly the one the manifest
  // default would throw away mid-preview.
  useViewStore.setState({ canvasGroupBy: 'goal', braindumpGroupBy: 'goal' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a goal-grouped snapshot previews grouped by goal', () => {
  it('useCanvasGroupBy reads previewEnabled while the fetch is in flight', async () => {
    const { fetch, done } = hydrateHeld(U);
    const { result } = renderHook(() => useCanvasGroupBy());
    expect(result.current).toBe('none'); // the manifest default: Goals off

    act(() => store().seedPreviewEnabled(U, { [EXT_GOALS]: true }));
    expect(result.current).toBe('goal');

    await act(async () => {
      fetch.resolve({ [EXT_GOALS]: true });
      await done;
    });
    expect(result.current).toBe('goal');
  });

  it('and so does every other display gate', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true, [EXT_ORGANIZE]: false });

    expect(renderHook(() => useExtensionEnabled(EXT_GOALS)).result.current).toBe(true);
    expect(extensionEnabled(EXT_GOALS)).toBe(true);
    expect(goalsEnabled()).toBe(true);
    expect(organizeEnabled()).toBe(false); // ships on; the preview says the user turned it off
    expect(renderHook(() => useExtensionPredicate()).result.current(EXT_ORGANIZE)).toBe(false);
    expect(resolvedCanvasGroupBy()).toBe('goal');
    expect(groupByOptionsFor(CANVAS_GROUP_BY_OPTIONS).map((o) => o.value)).toContain('goal');
    expect(renderHook(() => useBraindumpGroupBy()).result.current).toBe('goal');
  });

  it('the predicate keeps its identity while the preview map does', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    const { result, rerender } = renderHook(() => useExtensionPredicate());
    const first = result.current;
    act(() => useExtensionsStore.setState({ configs: { other: {} } }));
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('isEnabled() ignores previewEnabled', () => {
  it('answers from server truth (or the manifest) and nothing else', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true, [EXT_STREAKS]: false });

    expect(store().isEnabled(EXT_GOALS)).toBe(false);
    expect(store().isEnabled(EXT_STREAKS)).toBe(true);
    // And the seed never lands in `enabled`, where hydrate would merge it OVER the server rows.
    expect(store().enabled).toEqual({});
  });

  it('so a cached toggle cannot beat the server once the fetch lands', async () => {
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    fetch.resolve({ [EXT_GOALS]: false });
    await done;
    expect(store().enabled).toEqual({ [EXT_GOALS]: false });
    expect(goalsEnabled()).toBe(false);
  });
});

describe('the seed is refused', () => {
  it('once configs have loaded', async () => {
    await store().hydrate(U);
    expect(store().configsLoaded).toBe(true);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    expect(store().previewEnabled).toBeNull();
  });

  it('for an account other than the one being hydrated', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(V, { [EXT_GOALS]: true });
    expect(store().previewEnabled).toBeNull();
  });

  it('before any hydrate has stamped an account', () => {
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    expect(store().previewEnabled).toBeNull();
  });

  it('after the table proved missing, where nothing would ever clear it again', async () => {
    mockFetch.mockResolvedValueOnce(null);
    await store().hydrate(U);
    expect(store().available).toBe(false);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    expect(store().previewEnabled).toBeNull();
  });

  it('is copied, not aliased', () => {
    hydrateHeld(U);
    const map = { [EXT_GOALS]: true };
    store().seedPreviewEnabled(U, map);
    map[EXT_GOALS] = false;
    expect(store().previewEnabled).toEqual({ [EXT_GOALS]: true });
  });
});

describe('previewEnabled is cleared', () => {
  it('by the synchronous hydrate reset, so a previous account’s map cannot survive', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    hydrateHeld(V);
    expect(store().previewEnabled).toBeNull();
  });

  it('by a successful fetch', async () => {
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    fetch.resolve({});
    await done;
    expect(store().previewEnabled).toBeNull();
  });

  it('by the missing-table answer', async () => {
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    fetch.resolve(null);
    await done;
    expect(store().previewEnabled).toBeNull();
    expect(store().available).toBe(false);
  });

  it('by a transient failure, which also un-stamps for the retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    fetch.reject(new Error('network'));
    await done;
    expect(store().previewEnabled).toBeNull();
    expect(store().hydratedUserId).toBeNull();
  });

  it('by reset()', () => {
    hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    store().reset();
    expect(store().previewEnabled).toBeNull();
  });
});

describe('a hydrate returning the same values', () => {
  it('causes no regroup — not even one render through the default', async () => {
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });

    const seen: string[] = [];
    renderHook(() => {
      const value = useCanvasGroupBy();
      seen.push(value);
      return value;
    });
    const rendersBefore = seen.length;

    await act(async () => {
      fetch.resolve({ [EXT_GOALS]: true });
      await done;
    });

    expect(seen.every((v) => v === 'goal')).toBe(true);
    expect(seen.length).toBe(rendersBefore); // same string out of the selector: no re-render
  });

  it('while different values do regroup, once, at the fetch', async () => {
    const { fetch, done } = hydrateHeld(U);
    store().seedPreviewEnabled(U, { [EXT_GOALS]: true });
    const { result } = renderHook(() => useCanvasGroupBy());
    expect(result.current).toBe('goal');

    await act(async () => {
      fetch.resolve({ [EXT_GOALS]: false });
      await done;
    });
    expect(result.current).toBe('none');
  });
});

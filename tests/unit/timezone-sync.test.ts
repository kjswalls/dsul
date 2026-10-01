import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { shouldSyncTimezone, useTimezoneSync } from '@/hooks/use-timezone-sync';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';

/**
 * The timezone PATCH used to fire on every mount, inside the cold-start burst.
 * It now waits for this account's settings and a settled load, and only goes
 * out when the browser's zone differs from the stored one.
 */

describe('shouldSyncTimezone', () => {
  it.each([
    ['Europe/London', 'Europe/London', false],
    [null, 'Europe/London', true],
    [undefined, 'Europe/London', true],
    ['', 'Europe/London', true],
    ['   ', 'Europe/London', true],
    ['America/New_York', 'Europe/London', true],
    ['Europe/London', '', false],
    [null, undefined, false],
  ] as const)('stored %j, browser %j → %s', (stored, browser, expected) => {
    expect(shouldSyncTimezone(stored, browser)).toBe(expected);
  });
});

describe('useTimezoneSync', () => {
  const USER = 'user-a';
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetchMock = vi.fn(async () => ({ ok: true }) as Response);

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    usePlannerStore.setState({ userId: null, isLoading: false, userTimezone: null });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    usePlannerStore.setState({ userId: null, isLoading: false, userTimezone: null });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  it('waits for this account’s settings, then for the load', () => {
    usePlannerStore.setState({ userId: USER, isLoading: true, userTimezone: 'Nowhere/Else' });
    renderHook(() => useTimezoneSync());
    expect(fetchMock).not.toHaveBeenCalled();

    // Settings landed, but the load is still in the burst.
    act(() => useMorningStore.setState({ settingsHydratedUserId: USER }));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not trust settings stamped for another account', () => {
    usePlannerStore.setState({ userId: USER, isLoading: false, userTimezone: 'Nowhere/Else' });
    useMorningStore.setState({ settingsHydratedUserId: 'someone-else' });
    renderHook(() => useTimezoneSync());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PATCHes once on a mismatch', () => {
    usePlannerStore.setState({ userId: USER, isLoading: false, userTimezone: 'Nowhere/Else' });
    useMorningStore.setState({ settingsHydratedUserId: USER });
    renderHook(() => useTimezoneSync());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/user/timezone');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ timezone: browserTz });
  });

  it('sends nothing when the stored zone already matches', () => {
    usePlannerStore.setState({ userId: USER, isLoading: false, userTimezone: browserTz });
    useMorningStore.setState({ settingsHydratedUserId: USER });
    renderHook(() => useTimezoneSync());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never a second PATCH for the same account — re-render or a changed stored value', () => {
    usePlannerStore.setState({ userId: USER, isLoading: false, userTimezone: 'Nowhere/Else' });
    useMorningStore.setState({ settingsHydratedUserId: USER });
    const { rerender } = renderHook(() => useTimezoneSync());
    rerender();
    act(() => usePlannerStore.setState({ userTimezone: 'Still/Wrong' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

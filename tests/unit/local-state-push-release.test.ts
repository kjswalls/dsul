import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #254, the wiring: lib/local-state.ts is where the app learns the person at
 * this browser changed, so it is where the push subscription is let go. Every
 * KNOWN change releases; an unchanged owner and an unstamped browser do not
 * (the second is every load in a browser that cannot write the stamp, where a
 * release would switch the owner's own reminders off on every visit).
 */

const release = vi.fn(async () => {});
vi.mock('@/lib/push-release', () => ({ releaseThisBrowserPush: () => release() }));

import { LOCAL_STATE_OWNER_KEY, adoptLocalState, clearUserScopedLocalState } from '@/lib/local-state';

beforeEach(() => {
  window.localStorage.clear();
  release.mockClear();
});

describe('push release on a change of user', () => {
  it('releases on sign-out', () => {
    adoptLocalState('user-a');
    release.mockClear();

    clearUserScopedLocalState();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when the stamp names someone else (a browser that wakes as a new user)', () => {
    window.localStorage.setItem(LOCAL_STATE_OWNER_KEY, 'user-a');

    adoptLocalState('user-b');

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not release when the same account re-adopts', () => {
    window.localStorage.setItem(LOCAL_STATE_OWNER_KEY, 'user-a');

    adoptLocalState('user-a');

    expect(release).not.toHaveBeenCalled();
  });

  it('does not release on an unstamped browser', () => {
    adoptLocalState('user-a');

    expect(release).not.toHaveBeenCalled();
  });

  it('releases when a sibling tab re-stamps the owner', () => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: LOCAL_STATE_OWNER_KEY, oldValue: 'user-a', newValue: 'user-b' }),
    );
    expect(release).toHaveBeenCalledTimes(1);

    release.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: 'dsul-view', newValue: '{}' }));
    expect(release).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openReviewFromLink } from '@/lib/eod-link';
import { useEODStore } from '@/lib/eod-store';

/**
 * The review's push lands on `/?eod=<yyyy-MM-dd>`, and this is the one step
 * that turns that address into an open review carrying the day it invites.
 * Dropped on the way in (opened with a plain `open()`), the 6th's push
 * finished at 00:15 on the 7th records the 7th and retires the 7th's
 * invitation before it is sent; read as `?eod=1` only, every tap of a push
 * the scan sends today lands on the planner with no review open. Both pass
 * every other test, which is why this one exists.
 */

type S = { userId: string | null; isLoading: boolean };

/** A minimal zustand-shaped planner store: getState + subscribe + set. */
function fakePlanner(initial: S) {
  let state = initial;
  const subs = new Set<(s: S) => void>();
  return {
    getState: () => state,
    subscribe: (fn: (s: S) => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    set: (patch: Partial<S>) => {
      state = { ...state, ...patch };
      subs.forEach((fn) => fn(state));
    },
  };
}

const LOADED: S = { userId: 'user-1', isLoading: false };

function follow(search: string, initial: S = LOADED) {
  const planner = fakePlanner(initial);
  const clearLink = vi.fn();
  const dispose = openReviewFromLink(search, {
    getState: planner.getState,
    subscribe: planner.subscribe,
    clearLink,
  });
  return { planner, clearLink, dispose };
}

const review = () => {
  const { isOpen, invitedFor } = useEODStore.getState();
  return { isOpen, invitedFor };
};

beforeEach(() => {
  useEODStore.getState().clearUserScopedState();
});

describe('openReviewFromLink', () => {
  it('opens the review the push invited, naming its day, and clears the link', () => {
    const { clearLink } = follow('?eod=2026-10-06');
    expect(review()).toEqual({ isOpen: true, invitedFor: '2026-10-06' });
    expect(clearLink).toHaveBeenCalledTimes(1);
  });

  // Pushes sent before 2026-10-06 said ?eod=1, and a notification can wait in
  // the shade: it still opens the review, naming no day.
  it('opens the bare ?eod=1 of an older push, naming no day', () => {
    const { clearLink } = follow('?eod=1');
    expect(review()).toEqual({ isOpen: true, invitedFor: null });
    expect(clearLink).toHaveBeenCalledTimes(1);
  });

  // An opening never inherits the last one's day: a push for the 6th, closed,
  // and then an older ?eod=1 records the day that one opens on.
  it('a bare ?eod=1 drops the day an earlier push named', () => {
    useEODStore.getState().openInvited('2026-10-06');
    useEODStore.getState().close();
    follow('?eod=1');
    expect(review()).toEqual({ isOpen: true, invitedFor: null });
  });

  it.each(['?eod=junk', '?eod=2026-10-6', '?eod=', '?other=1', ''])('leaves %j closed, and the link where it is', (search) => {
    const { clearLink } = follow(search);
    expect(review()).toEqual({ isOpen: false, invitedFor: null });
    expect(clearLink).not.toHaveBeenCalled();
  });

  // The store initialises with isLoading:false and no account, and AppShell's
  // effect runs before the load has begun. Opened then, the review snapshots
  // an empty pending list and never re-snapshots it.
  it('waits for the planner load to land before it opens', () => {
    const { planner, clearLink } = follow('?eod=2026-10-06', { userId: null, isLoading: false });
    expect(review().isOpen).toBe(false);

    planner.set({ userId: 'user-1', isLoading: true });
    expect(review().isOpen).toBe(false);
    expect(clearLink).not.toHaveBeenCalled();

    planner.set({ isLoading: false });
    expect(review()).toEqual({ isOpen: true, invitedFor: '2026-10-06' });
    expect(clearLink).toHaveBeenCalledTimes(1);

    // Once: a later load (a refetch, a retry) does not reopen a review closed since.
    useEODStore.getState().close();
    planner.set({ isLoading: true });
    planner.set({ isLoading: false });
    expect(review().isOpen).toBe(false);
    expect(clearLink).toHaveBeenCalledTimes(1);
  });

  it('opens nothing once the effect is cleaned up', () => {
    const { planner, dispose } = follow('?eod=2026-10-06', { userId: 'user-1', isLoading: true });
    dispose();
    planner.set({ isLoading: false });
    expect(review().isOpen).toBe(false);
  });
});

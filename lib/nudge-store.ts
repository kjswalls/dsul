'use client';

import { create } from 'zustand';
import { loadDismissedNudges, saveDismissedNudges } from '@/lib/nudges/service';

/**
 * Per-user dismissed-forever set for one-time nudges — its own concern, one
 * store per concern (the extensions-store posture). NOT persist()ed: the server
 * is truth, and a stale localStorage copy is exactly how a nudge would nag on
 * the wrong account after a browser is shared.
 *
 * Hydrated from supabase-provider once the planner load has settled (its
 * `hydrateAfterLoad` — nothing here paints the grid, and a nudge has no
 * business firing before the items exist), and reset on sign-out with the rest
 * of the account-scoped stores.
 */
interface NudgeStore {
  /** Ids the current user has dismissed. Sparse — absence means "not dismissed". */
  dismissed: string[];
  /**
   * The account whose dismissed set is loaded, stamped in the SAME set() as the
   * values — so `hydratedUserId === userId` is the one signal that means "this
   * user's real dismissals are here" (the morning-store settingsHydratedUserId
   * pattern). Until it matches the live user, useOneTimeNudge stays inert: no
   * pre-hydration flash firing a nudge against an empty set, and no dismiss
   * written into the previous account's row on a shared browser.
   *
   * The two fields move together, so the stamp can never disagree with the
   * values — even a stale response for a previous account leaves a CONSISTENT
   * (id-set, owner) pair, and the hook simply finds the owner isn't the live
   * user and shows nothing.
   */
  hydratedUserId: string | null;

  hydrate: (userId: string) => Promise<void>;
  /** Mark a nudge dismissed forever for this user. Optimistic; then persisted. */
  dismiss: (userId: string, id: string) => void;
  reset: () => void;
}

const INITIAL = {
  dismissed: [] as string[],
  hydratedUserId: null as string | null,
};

/**
 * The most recently REQUESTED hydrate — a synchronous claim, separate from the
 * store's `hydratedUserId` (which is stamped atomically WITH the values, after
 * the await, and so cannot double as an in-flight marker). Mirrors the
 * provider's `hydratedUserId.current` ref: when a slow load for a
 * just-switched-away account resolves last, its claim has been superseded, so it
 * drops its result instead of clobbering the newer account's owner stamp.
 */
let hydratingFor: string | null = null;

export const useNudgeStore = create<NudgeStore>((set, get) => ({
  ...INITIAL,

  hydrate: async (userId) => {
    // Duplicate-event guard (TOKEN_REFRESHED, repeated SIGNED_IN) — same shape
    // as the extensions store, so an auth refresh can't re-fetch over a dismiss
    // made this session.
    // The in-flight claim joins it: the provider can ask twice for one account
    // (the load's `.then` and the navigation flush to a lean route), and the
    // second ask must not spend a second read.
    if (get().hydratedUserId === userId || hydratingFor === userId) return;
    hydratingFor = userId;

    const ids = await loadDismissedNudges(userId);
    // A newer account's hydrate claimed the store while ours was in flight (or
    // reset() dropped the claim) — the post-await stale-drop guard the sibling
    // stores make (extensions-store, supabase-provider). Applying now would
    // strand the store owned by the previous user and suppress the current
    // user's nudge. Checked BEFORE the null path, so a superseded failure
    // cannot release the newer account's claim.
    if (hydratingFor !== userId) return;
    // Null = couldn't read (transient, or migration 043 not applied here): stay
    // unhydrated so nudges remain inert rather than firing against an empty set,
    // and RELEASE the claim, so the next auth event retries instead of finding
    // a read "in flight" forever.
    if (ids === null) {
      hydratingFor = null;
      return;
    }

    set({ dismissed: ids, hydratedUserId: userId });
  },

  dismiss: (userId, id) => {
    if (get().dismissed.includes(id)) return;
    const next = [...get().dismissed, id];
    set({ dismissed: next });
    void saveDismissedNudges(userId, next);
  },

  reset: () => {
    hydratingFor = null;
    set({ ...INITIAL });
  },
}));

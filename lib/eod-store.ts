import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createClient } from '@/lib/supabase';
import { saveSettings } from '@/lib/settings-service';
import { usePlannerStore } from '@/lib/planner-store';
import { raiseModEvent } from '@/lib/mod-events';

interface EODStore {
  _hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  isOpen: boolean;
  eodReviewEnabled: boolean;
  eodReviewTime: string; // HH:mm
  lastEodReviewDate: string | null; // yyyy-MM-dd
  /**
   * yyyy-MM-dd the user has waved tonight's review line away on.
   *
   * The one piece of state the dock's EOD notice needed that did not already
   * exist. `lastEodReviewDate` says the review is DONE and `isOpen` says the
   * modal is up; neither can express "I have seen the line, not tonight" — and
   * without a third answer the line would sit on the dock every evening until
   * midnight with no way to put it down. That is precisely the nagging the
   * guilt-free ruling forbids.
   *
   * It hides the LINE, not the obligation: lib/eod.ts keeps `isEodOwed` and
   * `shouldShowEodNotice` separate so nothing else mistakes a deferral for a
   * completed review.
   */
  eodDeferredDate: string | null;
  /**
   * The day the open review was invited for, when it was opened from the
   * review's push (`?eod=<yyyy-MM-dd>`); null when it was opened any other way.
   * Read once, by Done, through lib/eod.ts's `reviewedDay`, so a review the push
   * for the 6th opens at 00:15 on the 7th is recorded as the 6th's (and one it
   * opens at 20:30 on the 7th, from a shade nobody cleared, as the 7th's). Like
   * `isOpen`, never persisted: it describes this opening and nothing after it.
   */
  invitedFor: string | null;
  open: () => void;
  /** Open the review the push for `dateStr` invited. */
  openInvited: (dateStr: string) => void;
  close: () => void;
  /** "Not tonight" — hide the dock line until the date rolls over. */
  deferToday: (date: string) => void;
  setEodReviewEnabled: (enabled: boolean) => void;
  setEodReviewTime: (time: string) => void;
  saveLastReviewDate: (userId: string | null, date: string) => Promise<void>;
  /** Drop this account's review settings and records — see lib/local-state.ts. */
  clearUserScopedState: () => void;
}

/**
 * The account-owned slice, at its defaults.
 *
 * The first two are `user_settings` columns and come back on the next sign-in.
 * The last two are records ABOUT an account — "this person finished their
 * review on the 14th", "this person waved tonight's line away" — and although
 * they are deliberately local-only (see partialize), local-only never meant
 * account-agnostic: inherited, they suppress the next user's review line for a
 * night they were never asked about.
 *
 * `isOpen` and `invitedFor` describe the review on screen, and go with the
 * account that opened it: a Done the next user presses must not be recorded
 * against a day the last one was invited to review.
 *
 * `_hasHydrated` stays out. It is a fact about this page load, not about anyone.
 */
const USER_SCOPED_DEFAULTS = {
  isOpen: false,
  eodReviewEnabled: false,
  eodReviewTime: '21:00',
  lastEodReviewDate: null as string | null,
  eodDeferredDate: null as string | null,
  invitedFor: null as string | null,
};

export const useEODStore = create<EODStore>()(
  persist(
    (set, get) => ({
      _hasHydrated: false,
      setHasHydrated: (v) => set({ _hasHydrated: v }),

      ...USER_SCOPED_DEFAULTS,

      clearUserScopedState: () => set({ ...USER_SCOPED_DEFAULTS }),

      open: () => set({ isOpen: true, invitedFor: null }),
      openInvited: (dateStr) => set({ isOpen: true, invitedFor: dateStr }),
      close: () => set({ isOpen: false }),
      deferToday: (date) => set({ eodDeferredDate: date, isOpen: false }),

      setEodReviewEnabled: (enabled) => {
        set({ eodReviewEnabled: enabled });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { eod_review_enabled: enabled });
      },

      setEodReviewTime: (time) => {
        set({ eodReviewTime: time });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { eod_review_time: time });
      },

      saveLastReviewDate: async (userId, date) => {
        const prev = get().lastEodReviewDate;
        set({ lastEodReviewDate: date, isOpen: false });
        // For recipes (lib/mod-events.ts): only a review that moved the date.
        if (prev !== date) raiseModEvent({ kind: 'review.saved', date });
        if (!userId) return;
        const supabase = createClient();
        await supabase
          .from('user_settings')
          .upsert(
            { user_id: userId, last_eod_review_date: date },
            { onConflict: 'user_id' }
          )
          .then(({ error }) => {
            if (error) console.error('[EOD] Failed to save last review date:', error.message);
          });
      },
    }),
    {
      name: 'dsul-eod-store',
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
      partialize: (state) => ({
        eodReviewEnabled: state.eodReviewEnabled,
        eodReviewTime: state.eodReviewTime,
        lastEodReviewDate: state.lastEodReviewDate,
        // Persisted, and local-only like the morning check's dismissal: it is a
        // record of what this device has already asked you, not an account
        // fact, and it self-expires because it is compared against today's
        // date. `isOpen` stays out — a modal must never survive a reload.
        eodDeferredDate: state.eodDeferredDate,
      }),
    }
  )
);

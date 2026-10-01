'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { format } from 'date-fns';
import { saveSettings } from './settings-service';
import { usePlannerStore } from './planner-store';

/**
 * localStorage key for the persisted slice.
 *
 * Exported because the auto-age sweep re-reads this record straight off disk
 * immediately before it mutates data (the cross-tab check in
 * `readPersistedAutoAgeLastRunDate`), and the key plus the envelope shape must
 * exist as a literal in exactly one file.
 */
export const MORNING_STORE_PERSIST_KEY = 'dsul-morning-store';

/** The account-owned settings, exactly as they arrive from user_settings. */
export interface MorningServerSettings {
  morningCheckEnabled: boolean;
  morningCheckTime: string;
  morningCheckDismissedDate: string | null;
  morningAutoAgeEnabled: boolean;
  morningAutoAgeDays: number;
}

/**
 * The account-owned slice at its fail-closed defaults.
 *
 * `clearUserScopedState` restores exactly this. Auto-age off and a 30-day
 * threshold are the values a brand-new account gets from settings-service, so
 * a signed-out browser is indistinguishable from a fresh one — which is the
 * whole point: nothing here may ever be handed to the *next* account.
 */
const USER_SCOPED_DEFAULTS = {
  morningCheckDismissedDate: null as string | null,
  // Off until the account says otherwise: rituals are opt-in (migration 054).
  morningCheckEnabled: false,
  morningCheckTime: '08:00',
  morningAutoAgeEnabled: false,
  morningAutoAgeDays: 30,
  settingsHydratedUserId: null as string | null,
  isOpen: false,
};

interface MorningStore {
  morningCheckDismissedDate: string | null; // yyyy-MM-dd
  morningCheckEnabled: boolean;
  morningCheckTime: string; // HH:mm
  /**
   * Past-due tray open state. EPHEMERAL, per-session, per-tab UI state — it is
   * deliberately absent from `partialize` and has no Supabase column. The bar
   * itself is always 50px in flow; the tray is a portaled popover, so this flag
   * costs the canvas zero layout pixels and must never survive a reload.
   */
  isOpen: boolean;
  /** Opt-in decay: unschedule items past due by more than morningAutoAgeDays. */
  morningAutoAgeEnabled: boolean;
  morningAutoAgeDays: number;
  /**
   * The account whose settings are actually in memory right now, or null when
   * the values above are unverified.
   *
   * This is the ONLY honest answer to "may a background job act on these
   * settings yet?", and it exists because everything else that looks like an
   * answer is a coincidence. The auto-age fields reach this store by two
   * paths: localStorage rehydration (synchronous, browser-global, belongs to
   * whoever used this browser last) and `applyServerSettings` (asynchronous,
   * authoritative). Nothing in `morningAutoAgeEnabled` itself distinguishes
   * the two, and the planner store's load flags say nothing about settings —
   * they race the settings request and frequently win.
   *
   * DELIBERATELY NOT PERSISTED, and enforced on BOTH sides of the persist
   * middleware — see the custom `merge` below for why leaving it out of
   * `partialize` is not by itself enough. A fresh page load starts at null no
   * matter what is on disk, so the sweep is blocked until a Supabase response
   * for the *currently signed-in* user has landed. Compare it against
   * `usePlannerStore.getState().userId` — equal is the only value that means
   * "these settings are this user's".
   */
  settingsHydratedUserId: string | null;
  /**
   * yyyy-MM-dd of the last auto-age sweep, KEYED BY userId. LOCAL-ONLY (in
   * partialize, no Supabase column) — the sweep is idempotent, so a per-device
   * once-per-day guard is sufficient.
   *
   * Keyed rather than a bare string because a shared browser previously let
   * one account's sweep suppress the next account's for the rest of the day:
   * the flag means "have I already bothered THIS PERSON today on this device",
   * and a browser-global string cannot express that.
   */
  morningAutoAgeLastRunByUser: Record<string, string>;
  /**
   * What today's sweep actually took, so the dock can say so and hand it back.
   *
   * The sweep is the app's only unattended writer — it unschedules work while
   * nobody is looking — and until now its entire receipt was the global undo
   * toast, which fires for five seconds on load and is gone. If it ran at 6am
   * and you opened the tab at nine, there was no evidence it had happened.
   *
   * PRIOR FIELD VALUES, not just ids. "Put them back" has to be a FORWARD
   * action: an hour later the sweep is no longer the top of the history stack,
   * so a stack pop would undo whatever you did last instead. Restoring the four
   * fields `unscheduleTasks` clears is the same outcome addressed at these
   * specific rows, and it stays correct however long the line sits there.
   *
   * LOCAL-ONLY and per-device, exactly like the stamp above and for the same
   * reason: this is a record of what you have been TOLD on this device, the
   * sweep that produced it was already device-gated, and keeping it out of
   * Supabase means the feature needs no migration. Self-pruning on write, so
   * expiry is free — a receipt for an earlier day can never be shown again.
   */
  morningAutoAgeReceiptByUser: Record<string, AutoAgeReceipt>;
  dismiss: () => void;
  /** Undo today's dismissal so the morning check renders again. */
  resetDismissal: () => void;
  isDismissedToday: () => boolean;
  setMorningCheckEnabled: (enabled: boolean) => void;
  setMorningCheckTime: (time: string) => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setMorningAutoAgeEnabled: (enabled: boolean) => void;
  setMorningAutoAgeDays: (days: number) => void;
  /** Adopt server settings and record whose they are, in one set(). */
  applyServerSettings: (userId: string, settings: MorningServerSettings) => void;
  /**
   * Drop the previous account's settings on sign-out / account switch.
   *
   * Takes the INCOMING account (null on a sign-out) because one field is not
   * dropped but pruned to it — see the note on the implementation.
   */
  clearUserScopedState: (incomingUserId: string | null) => void;
  getAutoAgeLastRunDate: (userId: string) => string | null;
  setAutoAgeLastRunDate: (userId: string, date: string) => void;
  /** Today's receipt, or null once it has been acted on or the day has turned. */
  getAutoAgeReceipt: (userId: string, todayStr: string) => AutoAgeReceipt | null;
  setAutoAgeReceipt: (userId: string, receipt: AutoAgeReceipt) => void;
  /** After "Put them back", or after the user waves the line away. */
  clearAutoAgeReceipt: (userId: string) => void;
}

/** One row as it stood immediately before the sweep unscheduled it. */
export interface SweptItem {
  id: string;
  title: string;
  isScheduled: boolean;
  startDate?: string;
  timeBucket?: string;
  startTime?: string;
}

export interface AutoAgeReceipt {
  /** The day the sweep ran. A receipt is only ever shown on its own day. */
  date: string;
  items: SweptItem[];
}

export const useMorningStore = create<MorningStore>()(
  persist(
    (set, get) => ({
      ...USER_SCOPED_DEFAULTS,
      morningAutoAgeLastRunByUser: {},
      morningAutoAgeReceiptByUser: {},

      dismiss: () => {
        const today = format(new Date(), 'yyyy-MM-dd');
        set({ morningCheckDismissedDate: today, isOpen: false });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_check_dismissed_date: today });
      },

      /**
       * Clears BOTH the local date and the server-persisted one. Clearing only
       * local state (which is what the dev button in desktop-shell used to do)
       * shows the banner until the next reload, when settings hydrate from
       * Supabase and re-dismiss it.
       */
      resetDismissal: () => {
        set({ morningCheckDismissedDate: null });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_check_dismissed_date: null });
      },

      isDismissedToday: () => {
        const today = format(new Date(), 'yyyy-MM-dd');
        return get().morningCheckDismissedDate === today;
      },

      setMorningCheckEnabled: (enabled) => {
        set({ morningCheckEnabled: enabled });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_check_enabled: enabled });
      },

      setMorningCheckTime: (time) => {
        set({ morningCheckTime: time });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_check_time: time });
      },

      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),

      setMorningAutoAgeEnabled: (enabled) => {
        set({ morningAutoAgeEnabled: enabled });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_auto_age_enabled: enabled });
      },

      setMorningAutoAgeDays: (days) => {
        set({ morningAutoAgeDays: days });
        const userId = usePlannerStore.getState().userId;
        if (userId) saveSettings(userId, { morning_auto_age_days: days });
      },

      /**
       * One set(), so `settingsHydratedUserId` can never disagree with the
       * values it vouches for — not for a render, not for a microtask. The
       * provider used to call `useMorningStore.setState({...})` inline; that
       * left no way for a consumer to tell hydrated values from localStorage
       * leftovers, which is how a background mutation ended up running on
       * another account's settings. Going through the store keeps the pairing
       * atomic and keeps the signal impossible to forget.
       */
      applyServerSettings: (userId, settings) =>
        set({ ...settings, settingsHydratedUserId: userId }),

      /**
       * The morning store's answer to planner-store's `clearStore`.
       *
       * Chosen over namespacing the persisted blob by userId (the other option
       * on the table) because it is the pattern this codebase already uses for
       * account-owned state — clearStore, `hydratedUserId.current = null` in
       * supabase-provider, the userId flush in settings-service all reset on
       * sign-out rather than shard by account. Namespacing would also need a
       * userId at module-evaluation time, which is exactly when we do not have
       * one: the store is created before any auth call resolves.
       *
       * `morningAutoAgeReceiptByUser` is cleared outright. It is keyed by
       * account, but KEYING DECIDES WHO A VALUE IS APPLIED TO, NOT WHO CAN READ
       * IT — and a receipt holds the TITLES of the rows the sweep touched. On a
       * shared browser that is one account's task list sitting in the next
       * account's devtools. The cost is the "Put them back" line, which is only
       * ever offered on the day of the sweep anyway.
       *
       * `morningAutoAgeLastRunByUser` is PRUNED to the incoming account rather
       * than dropped or kept whole, and the same sentence explains why. Its
       * values are dates and disclose nothing; its KEYS are Supabase user ids,
       * and nothing here ever pruned them, so on a shared or kiosk browser the
       * map accumulates a roster — how many accounts have used this machine,
       * their stable ids, and when each last did. Keeping only
       * `[incomingUserId]` preserves the entire stated benefit (sign back in on
       * the same device the same day and the sweep does not re-run) and drops
       * everyone else. A sign-out passes null, which empties it: the sweep is
       * idempotent, so the worst case is one extra run that finds nothing left
       * to unschedule.
       */
      clearUserScopedState: (incomingUserId) =>
        set((state) => {
          const kept = incomingUserId ? state.morningAutoAgeLastRunByUser[incomingUserId] : undefined;
          return {
            ...USER_SCOPED_DEFAULTS,
            morningAutoAgeReceiptByUser: {},
            morningAutoAgeLastRunByUser:
              incomingUserId && kept ? { [incomingUserId]: kept } : {},
          };
        }),

      getAutoAgeLastRunDate: (userId) => get().morningAutoAgeLastRunByUser[userId] ?? null,

      setAutoAgeLastRunDate: (userId, date) =>
        set((state) => ({
          morningAutoAgeLastRunByUser: {
            // Self-pruning: a stamp from an earlier day can never suppress
            // anything again, so dropping it keeps this map at roughly one
            // entry per account that signed in today instead of growing for
            // the lifetime of the browser profile.
            ...Object.fromEntries(
              Object.entries(state.morningAutoAgeLastRunByUser).filter(([, d]) => d === date),
            ),
            [userId]: date,
          },
        })),

      // Date-checked on READ as well as pruned on write. The write-side prune
      // only runs when a sweep happens, and a receipt outlives the tab it was
      // written in — leave a laptop open across midnight and yesterday's
      // "12 items were put aside this morning" is still sitting in the map.
      getAutoAgeReceipt: (userId, todayStr) => {
        const receipt = get().morningAutoAgeReceiptByUser[userId];
        return receipt && receipt.date === todayStr && receipt.items.length > 0 ? receipt : null;
      },

      setAutoAgeReceipt: (userId, receipt) =>
        set((state) => ({
          morningAutoAgeReceiptByUser: {
            // Same self-pruning as the stamp above, and load-bearing here in a
            // way it is not there: a receipt carries a row per swept item, so
            // an unpruned map would accumulate every sweep every account on
            // this browser ever ran.
            ...Object.fromEntries(
              Object.entries(state.morningAutoAgeReceiptByUser).filter(
                ([, r]) => r.date === receipt.date
              )
            ),
            [userId]: receipt,
          },
        })),

      clearAutoAgeReceipt: (userId) =>
        set((state) => {
          const next = { ...state.morningAutoAgeReceiptByUser };
          delete next[userId];
          return { morningAutoAgeReceiptByUser: next };
        }),
    }),
    {
      name: MORNING_STORE_PERSIST_KEY,
      version: 1,
      migrate: (persisted) => {
        // v0 → v1: `morningAutoAgeLastRunDate` was a single browser-global
        // string, so on a shared browser one account's sweep suppressed the
        // next account's for the rest of the day. It is dropped rather than
        // re-keyed under the current user, because nothing on disk records who
        // wrote it — and the cost of dropping it is at most one extra sweep
        // today, which is a no-op (the items it would match are already
        // unscheduled, so it returns before mutating or raising a toast).
        const state = (persisted ?? {}) as Record<string, unknown>;
        return {
          morningCheckDismissedDate: (state.morningCheckDismissedDate as string | null) ?? null,
          morningCheckEnabled: (state.morningCheckEnabled as boolean) ?? false,
          morningCheckTime: (state.morningCheckTime as string) ?? '08:00',
          morningAutoAgeEnabled: (state.morningAutoAgeEnabled as boolean) ?? false,
          morningAutoAgeDays: (state.morningAutoAgeDays as number) ?? 30,
          morningAutoAgeLastRunByUser: {},
          // Nothing to migrate — receipts did not exist before, and one is only
          // ever valid on the day it was written anyway.
          morningAutoAgeReceiptByUser: {},
        };
      },
      /**
       * The other half of "not persisted". `partialize` only governs what is
       * WRITTEN; zustand's default merge is `{...currentState, ...persistedState}`
       * over the whole stored blob, so any key that reaches disk by some other
       * route — a hand-edited localStorage entry, a blob written by a build whose
       * partialize listed more keys, a future edit to the list below — comes
       * straight back into the store. That is fine for the settings; it is not
       * fine for `settingsHydratedUserId`, which is the ONLY thing standing
       * between rehydrated localStorage and an unattended data mutation
       * (hooks/use-overdue-sweep.ts gate 2). A signal that a stored string can
       * forge is not a signal.
       *
       * So the two ephemeral keys are stripped here unconditionally. `isOpen`
       * rides along for the same class of reason: it is per-tab UI state, and a
       * persisted `true` would open the tray by itself on load.
       */
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<MorningStore>),
        // Re-asserted AFTER the spread, so it does not matter what the blob
        // claims: the live store's value always wins for these two. At creation
        // that is the fail-closed initial state (null / false); on a manual
        // rehydrate() it is whatever the session has legitimately established,
        // which is the right answer in both cases.
        settingsHydratedUserId: current.settingsHydratedUserId,
        isOpen: current.isOpen,
      }),
      partialize: (state) => ({
        morningCheckDismissedDate: state.morningCheckDismissedDate,
        morningCheckEnabled: state.morningCheckEnabled,
        morningCheckTime: state.morningCheckTime,
        // Still persisted so the settings dialog opens on the right values
        // without a flicker. They are NOT trustworthy on their own — every
        // consumer that acts on them unattended must first check
        // `settingsHydratedUserId`, which is not persisted.
        morningAutoAgeEnabled: state.morningAutoAgeEnabled,
        morningAutoAgeDays: state.morningAutoAgeDays,
        morningAutoAgeLastRunByUser: state.morningAutoAgeLastRunByUser,
        // Persisted for the whole point of it: a receipt has to survive the
        // reload that the undo toast could not.
        morningAutoAgeReceiptByUser: state.morningAutoAgeReceiptByUser,
      }),
    }
  )
);

/**
 * Read the persisted auto-age stamp for `userId` straight off disk.
 *
 * Two tabs each hold their own copy of this store and zustand's persist
 * middleware has no cross-tab sync, so both can pass the in-memory
 * once-per-day guard in the same moment. Persist writes localStorage
 * synchronously inside set(), which makes a raw read the cheapest honest way
 * to see a sibling tab's stamp: calling this immediately before the mutation
 * narrows the double-sweep window from "the whole load + hydration window" to
 * the few microseconds between this read and the set() that follows it. It is
 * a race NARROWER, not a lock, and the residual outcome is harmless anyway —
 * the second sweep finds nothing left to unschedule.
 *
 * Returns null (i.e. "no stamp — go ahead") when storage is unreadable. That
 * is fail-open on purpose: this is a toast-noise optimisation layered on top
 * of the real in-memory guard, and a browser with localStorage blocked must
 * still be able to run the feature at all.
 */
export function readPersistedAutoAgeLastRunDate(userId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MORNING_STORE_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { morningAutoAgeLastRunByUser?: Record<string, string> };
    };
    return parsed?.state?.morningAutoAgeLastRunByUser?.[userId] ?? null;
  } catch {
    return null;
  }
}

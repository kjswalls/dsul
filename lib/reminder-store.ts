'use client';

import { create } from 'zustand';
import { saveSettings } from '@/lib/settings-service';
import { usePlannerStore } from '@/lib/planner-store';
import { toDateStr } from '@/lib/recurrence';

/**
 * Per-user reminder and stakes settings — everything the unattended tick reads.
 *
 * One store per concern, like every other ritual (morning-store).
 *
 * NOT persist()ed, deliberately, and unlike the retired eod-store was. These three
 * values are read by exactly one consumer that matters — the server-side
 * reminder scan — and by one surface that already waits for hydration (the
 * settings page gates its whole render on it). A localStorage mirror could
 * therefore only ever be WRONG in a way nobody notices until dsul is silent:
 * a stale `remindersEnabled: true` shows a switch that is on while the row that
 * actually governs delivery says off. The server is truth, so it is the only
 * copy. (Same reasoning extensions-store wrote down for the same shape.)
 */
interface ReminderStore {
  /** Master switch. Every per-item cue is gated behind it. */
  remindersEnabled: boolean;
  /** The streak-at-risk last call. */
  lastCallEnabled: boolean;
  /** HH:mm, local. */
  lastCallTime: string;
  /**
   * The nightly settlement (migration 034). Its own switch, NOT folded into
   * remindersEnabled: keeping the accounting while turning off the nagging is a
   * real thing to want, and one switch for both would make silencing dsul
   * also silently forgive every miss.
   */
  stakesEnabled: boolean;
  /** HH:mm, local — settles the day BEFORE it. */
  stakesSettleTime: string;
  /**
   * eod_review_enabled: the switch of the retired end of day review, which the
   * iPhone app still reads to plan its nightly local notification (until ghost
   * rows phase 3 drops it there). The web shows no review, but this is the
   * only off switch for that notification, so it stays writable.
   */
  iphoneEveningNudge: boolean;
  /**
   * Whether the account's stored value was ON when its settings landed. The
   * row (`rituals.eod`) is drawn only then, so an account that never had the
   * review sees nothing, and turning it off does not make it vanish mid-click.
   */
  iphoneEveningNudgeShown: boolean;

  setRemindersEnabled: (enabled: boolean) => void;
  setLastCallEnabled: (enabled: boolean) => void;
  setLastCallTime: (time: string) => void;
  setStakesEnabled: (enabled: boolean) => void;
  setStakesSettleTime: (time: string) => void;
  setIphoneEveningNudge: (enabled: boolean) => void;
}

export const REMINDER_DEFAULTS = {
  remindersEnabled: false,
  lastCallEnabled: false,
  lastCallTime: '20:30',
  stakesEnabled: false,
  // 03:00, not midnight: a habit ticked for yesterday just after midnight
  // still counts, and a settlement that ran first would report a miss the app
  // itself does not believe in.
  stakesSettleTime: '03:00',
  iphoneEveningNudge: false,
  iphoneEveningNudgeShown: false,
} as const;

/**
 * Both time columns carry a CHECK constraint (migrations 029 and 031), so an
 * empty string does not degrade — it rejects the ENTIRE debounced upsert, and
 * settings-service merges patches across that window, so clearing this field
 * silently takes whatever else was being saved down with it.
 *
 * Clearing a `<input type="time">` is one Backspace away, so this is a normal
 * gesture and not an edge case. The store keeps the last good value.
 */
const isTimeOfDay = (value: string): boolean => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);

export const useReminderStore = create<ReminderStore>((set) => ({
  ...REMINDER_DEFAULTS,

  setRemindersEnabled: (enabled) => {
    set({ remindersEnabled: enabled });
    const userId = usePlannerStore.getState().userId;
    if (userId) saveSettings(userId, { habit_reminders_enabled: enabled });
  },

  setLastCallEnabled: (enabled) => {
    set({ lastCallEnabled: enabled });
    const userId = usePlannerStore.getState().userId;
    if (userId) saveSettings(userId, { habit_last_call_enabled: enabled });
  },

  setLastCallTime: (time) => {
    if (!isTimeOfDay(time)) return;
    set({ lastCallTime: time });
    const userId = usePlannerStore.getState().userId;
    if (userId) saveSettings(userId, { habit_last_call_time: time });
  },

  setStakesEnabled: (enabled) => {
    set({ stakesEnabled: enabled });
    const userId = usePlannerStore.getState().userId;
    if (!userId) return;

    if (!enabled) {
      saveSettings(userId, { stakes_enabled: false });
      return;
    }

    // Switching stakes ON also closes the books on everything before today.
    //
    // Without this, stakes_settled_date is still whatever it was — usually null
    // — so the first settlement runs its catch-up and bills for days the user
    // had stakes switched OFF and no way to act on. Someone enabling the pledge
    // tier at lunchtime would wake up owing money for a week they never agreed
    // to. Stamping yesterday means the first day that can cost anything is the
    // one that starts now.
    const timezone =
      usePlannerStore.getState().userTimezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    saveSettings(userId, {
      stakes_enabled: true,
      stakes_settled_date: toDateStr(yesterday, timezone),
    });
  },

  setStakesSettleTime: (time) => {
    if (!isTimeOfDay(time)) return;
    set({ stakesSettleTime: time });
    const userId = usePlannerStore.getState().userId;
    if (userId) saveSettings(userId, { stakes_settle_time: time });
  },

  setIphoneEveningNudge: (enabled) => {
    set({ iphoneEveningNudge: enabled });
    const userId = usePlannerStore.getState().userId;
    if (userId) saveSettings(userId, { eod_review_enabled: enabled });
  },
}));

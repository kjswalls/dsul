import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

/**
 * The one line lib/settings/hydration.ts stakes the whole gate on:
 *
 *   "supabase-provider's `hydrateSettings` applies the planner / sidebar / eod
 *    / reminder / theme / palette values in the same synchronous block — so the
 *    stamp speaks for all of them, not just morning's."
 *
 * The settings page renders as soon as `settingsHydratedUserId` names the
 * signed-in account. That stamp is set inside morning-store's
 * applyServerSettings, and the EOD and reminder values are applied AFTER it.
 * They are safe only because nothing can run in between: there is exactly one
 * `await` in hydrateSettings (loadSettings), and it is before the stamp. Add a
 * second await anywhere after the stamp and the page can paint with the stamp
 * for user B standing over user A's persisted EOD and reminder values — which
 * are live controls, so a click writes them into B's row.
 *
 * That is an ordering guarantee, not a value, and no assertion made after
 * hydrate has finished can see it — afterwards is the one moment that was never
 * in doubt. So this drives the REAL provider and plants an observer at the
 * exact instant of the stamp:
 *
 *   · one synchronous read, inside the morning-store subscriber, for the values
 *     applied BEFORE the stamp (planner, sidebar);
 *   · one microtask, queued from that same subscriber, for the values applied
 *     AFTER it (eod, reminder).
 *
 * The microtask is the whole test. A microtask queued during the stamp runs
 * before any continuation of an `await` that is reached later, and after all
 * code that merely runs to completion. So it sees the EOD values if and only if
 * the block is unbroken. Verified by mutation: inserting `await
 * Promise.resolve()` between the stamp and `useEODStore.setState` in
 * supabase-provider.tsx fails this file and nothing else in the suite.
 */

const USER = 'user-a';

/** Deliberately not the store defaults — a stale read has to be visible. */
const SERVER = {
  theme: 'dark',
  time_format: '24h',
  left_sidebar_hover: true,
  morning_check_enabled: true,
  morning_check_time: '06:45',
  morning_check_dismissed_date: null,
  morning_auto_age_enabled: true,
  morning_auto_age_days: 14,
  eod_review_enabled: true,
  eod_review_time: '19:15',
  habit_reminders_enabled: true,
  habit_last_call_enabled: true,
  habit_last_call_time: '20:30',
  stakes_enabled: true,
  stakes_settle_time: '23:45',
};

const loadSettings = vi.fn<(userId: string) => Promise<Record<string, unknown>>>(async () => SERVER);

vi.mock('@/lib/settings-service', () => ({
  loadSettings: (userId: string) => loadSettings(userId),
  saveSettings: vi.fn(),
  flushSettings: vi.fn(async () => {}),
}));

// One signed-in session, delivered the way the provider asks for it on mount.
// onAuthStateChange never fires: getSession is enough to reach hydrateSettings,
// and a second delivery would only re-enter the dedupe guard.
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

const setTheme = vi.fn();
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme }) }));

import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMorningStore } from '@/lib/morning-store';
import { useEODStore } from '@/lib/eod-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';

/** The four loads that are not under test, stubbed at the store boundary. */
const original = {
  initializeStore: usePlannerStore.getState().initializeStore,
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
  ai: useAIConnectionStore.getState().hydrate,
};

describe('hydrateSettings applies every store in one uninterrupted block', () => {
  beforeEach(() => {
    loadSettings.mockClear();
    loadSettings.mockImplementation(async () => SERVER);
    usePlannerStore.setState({ initializeStore: async () => {}, timeFormat: '12h' });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    useAIConnectionStore.setState({ hydrate: async () => {} });
    useSidebarStore.setState({ leftSidebarHoverEnabled: false });
    useMorningStore.setState({ settingsHydratedUserId: null });
    // The previous account's values, as localStorage would have left them.
    useEODStore.setState({ eodReviewEnabled: false, eodReviewTime: '21:00' });
    useReminderStore.setState({
      remindersEnabled: false,
      lastCallEnabled: false,
      lastCallTime: '19:00',
      stakesEnabled: false,
      stakesSettleTime: '23:00',
    });
  });

  afterEach(() => {
    cleanup();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useAIConnectionStore.setState({ hydrate: original.ai });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  /**
   * Rituals are opt-in. A NULL `morning_check_enabled` — a row from before the
   * column had a default, or a fresh account's first read — is a person who
   * never turned the morning check on, so it hydrates OFF. The previous
   * account's `true` is left in the store first, so a pass cannot be the
   * store's own default showing through.
   */
  it('reads a NULL morning_check_enabled as off', async () => {
    useMorningStore.setState({ morningCheckEnabled: true });
    loadSettings.mockImplementation(async () => ({ ...SERVER, morning_check_enabled: null }));

    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(useMorningStore.getState().settingsHydratedUserId).toBe(USER));
    expect(useMorningStore.getState().morningCheckEnabled).toBe(false);
  });

  it('keeps a stored true as true — existing accounts are untouched', async () => {
    useMorningStore.setState({ morningCheckEnabled: false });

    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(useMorningStore.getState().settingsHydratedUserId).toBe(USER));
    expect(useMorningStore.getState().morningCheckEnabled).toBe(true);
  });

  it('never lets the stamp be observed ahead of the values it vouches for', async () => {
    let stamps = 0;
    let atStamp: Record<string, unknown> | null = null;
    let afterStamp: Record<string, unknown> | null = null;

    const unsubscribe = useMorningStore.subscribe((s) => {
      if (s.settingsHydratedUserId !== USER || atStamp) return;
      stamps += 1;
      // Applied before the stamp — readable synchronously, from inside it.
      atStamp = {
        timeFormat: usePlannerStore.getState().timeFormat,
        leftSidebarHover: useSidebarStore.getState().leftSidebarHoverEnabled,
        morningCheckTime: s.morningCheckTime,
        autoAgeDays: s.morningAutoAgeDays,
      };
      // Applied after it. This runs at the first opportunity any other code
      // gets — which, in an unbroken block, is after hydrateSettings is done.
      void Promise.resolve().then(() => {
        const eod = useEODStore.getState();
        const rem = useReminderStore.getState();
        afterStamp = {
          eodReviewEnabled: eod.eodReviewEnabled,
          eodReviewTime: eod.eodReviewTime,
          remindersEnabled: rem.remindersEnabled,
          lastCallTime: rem.lastCallTime,
          stakesEnabled: rem.stakesEnabled,
          stakesSettleTime: rem.stakesSettleTime,
        };
      });
    });

    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(afterStamp).not.toBeNull());
    unsubscribe();

    // One stamp, and the values that precede it are already in place when it
    // lands — no observer ever sees this account's stamp over the last
    // account's planner or sidebar settings.
    expect(stamps).toBe(1);
    expect(atStamp).toEqual({
      timeFormat: '24h',
      leftSidebarHover: true,
      morningCheckTime: '06:45',
      autoAgeDays: 14,
    });

    // And the values that FOLLOW it are in place before anything else can run.
    // This is the assertion an `await` between the stamp and useEODStore.setState
    // breaks: the probe would land first and read '21:00' — the previous
    // account's review time, on a settings page the gate has already opened.
    expect(afterStamp).toEqual({
      eodReviewEnabled: true,
      eodReviewTime: '19:15',
      remindersEnabled: true,
      lastCallTime: '20:30',
      stakesEnabled: true,
      stakesSettleTime: '23:45',
    });

    // Sanity: the settings under test really did come from the response.
    expect(useEODStore.getState().eodReviewTime).toBe('19:15');
    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});

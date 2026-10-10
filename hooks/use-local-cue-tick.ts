'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase';
import { storedDeviceId } from '@/lib/devices/web-client';
import { usePlannerStore } from '@/lib/planner-store';
import { useReminderStore } from '@/lib/reminder-store';
import {
  createLocalCueTick,
  deviceClaims,
  DEVICE_PREFS_TTL_MS,
  LOCAL_TICK_MS,
  type Presenter,
  type ThisDevice,
} from '@/lib/reminders/local-tick';
import { SNOOZED_MESSAGE, type SnoozedMessage } from '@/lib/sw/handlers';

/**
 * The open page as a device (memory/plans/reminders-platforms.md §5.2, PR-1b):
 * once a minute, while someone is using this page, claim the cues that are
 * due and ring them here instead of everywhere. The decisions are
 * lib/reminders/local-tick.ts's; this wires them to the window.
 *
 * Mounted beside useDeviceRegistration in AppShell, so it runs on the planner
 * and nowhere else, and starts once the planner load has settled.
 *
 * "Someone is here" is the page visible and an input (a key, a click, a
 * scroll, the pointer moving) in the last five minutes. Notifications are
 * shown through the service worker's registration, never `new Notification`
 * (tests/unit/no-new-notification.test.ts): only the worker's carry buttons,
 * and only its click handler can act on them.
 *
 * `online` used to reload the whole page (Serwist's reloadOnOnline, now off in
 * next.config.mjs): it threw away this tick's memory, every draft and the
 * undo history. Instead it re-reads this device's switch, retries a planner
 * load that failed while offline, and ticks at once.
 */
export function useLocalCueTick() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);

  useEffect(() => {
    if (!userId || isLoading) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let lastInput = 0;
    let deviceCache: { at: number; value: ThisDevice | null } | null = null;

    const readDevice = async (): Promise<ThisDevice | null> => {
      if (deviceCache && Date.now() - deviceCache.at < DEVICE_PREFS_TTL_MS) return deviceCache.value;
      const deviceId = storedDeviceId();
      let value: ThisDevice | null = null;
      if (deviceId) {
        // The session client, under 065's column grant: `prefs` is the
        // owner's to read. No row (push never turned on here, or a registry
        // that is not there yet) is not a device, and a page that is not a
        // device never claims.
        const { data, error } = await createClient()
          .from('devices')
          .select('prefs')
          .eq('device_id', deviceId)
          .maybeSingle();
        if (!error && data) value = { deviceId, claimsLocally: deviceClaims((data as { prefs: unknown }).prefs) };
      }
      deviceCache = { at: Date.now(), value };
      return value;
    };

    const tick = createLocalCueTick({
      now: () => Date.now(),
      visible: () => document.visibilityState === 'visible',
      lastInputMs: () => lastInput,
      permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
      planner: () => {
        const p = usePlannerStore.getState();
        return {
          userId: p.userId,
          items: p.items,
          routines: p.routines,
          seasons: p.seasons,
          timezone: p.userTimezone,
          timeFormat: p.timeFormat === '24h' ? '24h' : '12h',
          remindersEnabled: useReminderStore.getState().remindersEnabled,
        };
      },
      device: readDevice,
      presenter: async () => ((await navigator.serviceWorker.getRegistration()) ?? null) as Presenter | null,
      post: (path, body) =>
        fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    });

    const onInput = () => {
      lastInput = Date.now();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick.tick();
    };
    const onOnline = () => {
      deviceCache = null;
      const planner = usePlannerStore.getState();
      if (planner.userId && planner.loadFailedUserId === planner.userId) {
        void planner.initializeStore(planner.userId);
      }
      void tick.tick();
    };
    const onMessage = (event: MessageEvent) => {
      const m = event.data as Partial<SnoozedMessage> | null;
      if (!m || m.type !== SNOOZED_MESSAGE) return;
      if (typeof m.itemId !== 'string' || typeof m.dateStr !== 'string' || typeof m.until !== 'string') return;
      tick.noteSnooze({ itemId: m.itemId, dateStr: m.dateStr, held: m.until });
    };

    const inputs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of inputs) window.addEventListener(name, onInput, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    navigator.serviceWorker.addEventListener('message', onMessage);
    const timer = window.setInterval(() => void tick.tick(), LOCAL_TICK_MS);

    return () => {
      for (const name of inputs) window.removeEventListener(name, onInput);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  }, [userId, isLoading]);
}

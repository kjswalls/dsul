'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { desktopNotifier, type DesktopNotifier } from '@/lib/desktop';
import { actOnDesktopNotification, atTheDesk, desktopPresenter } from '@/lib/reminders/desktop-presenter';
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
 *
 * IN THE DESKTOP APP (PR-1c) the same tick runs with three things swapped,
 * because Web Push and service-worker notifications never worked in Electron:
 * main draws the notification (lib/reminders/desktop-presenter.ts), "someone
 * is here" is any input on the computer in the last five minutes (the window
 * can be behind another app or closed to the tray), and a click or a button
 * comes back over the bridge instead of to a worker. A shell whose probe says
 * nobody would see a notification (an unsigned Mac build) never claims, so it
 * never silences the phone. A wake or an unlock ticks at once.
 */
export function useLocalCueTick() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const router = useRouter();

  useEffect(() => {
    if (!userId || isLoading) return;
    if (typeof window === 'undefined') return;
    const desktop = desktopNotifier();
    if (!desktop && !('serviceWorker' in navigator)) return;

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

    // The desktop's answer to "would a notification be seen here", asked once.
    let probe: 'ok' | 'unsupported' | 'unsigned' | null = null;
    if (desktop) {
      void desktop.notifyProbe().then(
        (answer) => {
          probe = answer;
        },
        () => {
          probe = 'unsupported';
        }
      );
    }

    const tick = createLocalCueTick({
      now: () => Date.now(),
      visible: () => document.visibilityState === 'visible',
      lastInputMs: () => lastInput,
      permission: () =>
        desktop
          ? probe === 'ok'
            ? 'granted'
            : 'denied'
          : typeof Notification === 'undefined'
            ? 'unsupported'
            : Notification.permission,
      ...(desktop ? { presence: () => atTheDesk(desktop) } : {}),
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
      presenter: async () =>
        desktop
          ? desktopPresenter(desktop)
          : (((await navigator.serviceWorker.getRegistration()) ?? null) as Presenter | null),
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
    const worker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    worker?.addEventListener('message', onMessage);
    const timer = window.setInterval(() => void tick.tick(), LOCAL_TICK_MS);
    const offDesktop = desktop ? listenToDesktop(desktop, tick, (url) => router.push(url)) : () => {};

    return () => {
      for (const name of inputs) window.removeEventListener(name, onInput);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      worker?.removeEventListener('message', onMessage);
      window.clearInterval(timer);
      offDesktop();
    };
  }, [userId, isLoading, router]);
}

/** The desktop's clicks, buttons and wakes, wired to the tick. Returns the unsubscribe. */
function listenToDesktop(
  desktop: DesktopNotifier,
  tick: { tick(): Promise<void>; noteSnooze: (s: { itemId: string; dateStr: string; held: string }) => void },
  navigate: (url: string) => void
): () => void {
  const offClick = desktop.onNotification((event) => {
    const itemId = event.data?.itemId;
    const title = itemId ? usePlannerStore.getState().items.find((i) => i.id === itemId)?.title : undefined;
    void actOnDesktopNotification(
      event,
      {
        post: (path, body) =>
          fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        navigate,
        noteSnooze: (snooze) => tick.noteSnooze(snooze),
        failed: (itemTitle, url) =>
          toast(itemTitle ? `${itemTitle} is still open` : 'That reminder could not be marked', {
            action: { label: 'Open', onClick: () => navigate(url) },
          }),
      },
      title
    );
  });
  const offWake = desktop.onWake(() => void tick.tick());
  return () => {
    offClick();
    offWake();
  };
}

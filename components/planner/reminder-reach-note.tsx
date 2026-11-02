'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { getDesktopBridge } from '@/lib/desktop';
import { isMissingRegistry } from '@/lib/devices/db';
import { kindOn, type RosterRow } from '@/lib/devices/roster';
import { usePlannerStore } from '@/lib/planner-store';
import { useReminderStore } from '@/lib/reminder-store';
import { REACH_COPY, isIosBrowserTabHere, reminderReach } from '@/lib/reminders/reach';
import { createClient } from '@/lib/supabase';

/**
 * Under the Remind control, once a time is set: says what would stop this
 * reminder from ringing, and offers the one-tap fix (lib/reminders/reach.ts).
 * Says nothing when the reminder will reach a device, or while that is unknown.
 *
 * Mounted only inside the open Remind popover, so the device read and the
 * push hook's service-worker check happen when someone is setting a reminder,
 * never on every item open.
 */
/** Devices on the account that take cues, or null when that can't be read (a build ahead of 065, a failed read). */
async function countDevicesWithCue(): Promise<number | null> {
  try {
    const { data, error } = await createClient().from('devices').select('prefs');
    if (error) {
      if (!isMissingRegistry(error)) console.error('[remind] device read failed:', error.message);
      return null;
    }
    const rows = (data ?? []) as unknown as RosterRow[];
    return rows.filter((r) => kindOn(r, 'cue')).length;
  } catch {
    return null;
  }
}

export function ReminderReachNote() {
  // Sample data and a signed-out planner have no account to reach: say nothing.
  const userId = usePlannerStore((s) => s.userId);
  return userId ? <ReachNote /> : null;
}

function ReachNote() {
  const remindersOn = useReminderStore((s) => s.remindersEnabled);
  const setRemindersEnabled = useReminderStore((s) => s.setRemindersEnabled);
  const push = usePushSubscription();
  const [devicesWithCue, setDevicesWithCue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [env] = useState(() => ({ iosTab: isIosBrowserTabHere(), desktop: getDesktopBridge() !== null }));

  const loadDevices = useCallback(async () => setDevicesWithCue(await countDevicesWithCue()), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const n = await countDevicesWithCue();
      if (live) setDevicesWithCue(n);
    })();
    return () => {
      live = false;
    };
  }, []);

  const reach = reminderReach({
    remindersOn,
    devicesWithCue,
    here: {
      isSupported: push.isSupported,
      permissionState: push.permissionState,
      iosTab: env.iosTab,
      desktop: env.desktop,
    },
  });

  // Turning reminders on also asks this device, when no device takes them yet
  // and this one can: one tap, rather than a second trip to Settings.
  const canAskHere =
    !env.desktop && !env.iosTab && push.isSupported && push.permissionState !== 'denied' && devicesWithCue === 0;

  const fix = useCallback(async () => {
    setBusy(true);
    try {
      if (!remindersOn) setRemindersEnabled(true);
      if (canAskHere && !push.isSubscribed) {
        await push.subscribe();
        await loadDevices();
      }
    } catch (err) {
      console.error('[remind] turning reminders on failed:', err);
    } finally {
      setBusy(false);
    }
  }, [remindersOn, setRemindersEnabled, canAskHere, push, loadDevices]);

  if (reach === 'ok') return null;
  const copy = REACH_COPY[reach];
  // An action is offered for the master switch always, and for this device
  // only when it can take push.
  const showAction = copy.action && (reach === 'reminders_off' || canAskHere);

  return (
    <div className="px-2 pt-1 pb-2" data-testid="reminder-reach-note" data-reach={reach}>
      <p className="text-muted-foreground text-[10px]" role="status">
        {copy.text}
      </p>
      {showAction && (
        <button
          type="button"
          className="text-foreground mt-1 text-[11px] font-medium underline underline-offset-2 disabled:opacity-60"
          onClick={() => void fix()}
          disabled={busy}
          data-testid="reminder-reach-fix"
          data-sub-input
        >
          {copy.action}
        </button>
      )}
    </div>
  );
}

/**
 * reach.ts — will a reminder set here actually reach anyone?
 *
 * A reminder needs three things to ring: the master switch (Settings →
 * Rituals, `habit_reminders_enabled`), the item's own time, and at least one
 * device that takes cues. Setting the time while either of the other two is
 * missing used to say nothing at all, and the reminder simply never came.
 * This is the one answer to "what is missing", asked by the Remind control so
 * it can say so where the time is being set, and offer the fix.
 *
 * Pure: the caller passes what it knows. `devicesWithCue` is null while the
 * device list is unknown (not loaded, or unreadable), and an unknown answer
 * says nothing rather than a warning that may be wrong.
 */

export type ReminderReach =
  /** The master switch is off: no reminder rings anywhere. */
  | 'reminders_off'
  /** No device takes cues, and this one could: offer to turn it on here. */
  | 'no_device_here'
  /** No device takes cues, and this browser cannot take push at all. */
  | 'no_device_elsewhere'
  /** No device takes cues, and this is iPhone Safari in a tab: install first. */
  | 'install_first'
  /** No device takes cues, and this browser has notifications blocked. */
  | 'blocked'
  /** Nothing to say. */
  | 'ok'

export interface ReachInput {
  remindersOn: boolean
  /** Devices on the account that take cues, or null when unknown. */
  devicesWithCue: number | null
  here: {
    isSupported: boolean
    permissionState: NotificationPermission | 'unknown'
    /** iPhone or iPad Safari in a tab, where iOS allows no web push (isIosBrowserTab). */
    iosTab: boolean
    /** The desktop app: push is not available there yet. */
    desktop: boolean
  }
}

export function reminderReach(input: ReachInput): ReminderReach {
  if (!input.remindersOn) return 'reminders_off'
  if (input.devicesWithCue === null || input.devicesWithCue > 0) return 'ok'
  const { here } = input
  if (here.iosTab) return 'install_first'
  if (here.desktop || !here.isSupported) return 'no_device_elsewhere'
  if (here.permissionState === 'denied') return 'blocked'
  return 'no_device_here'
}

/**
 * Is this iPhone or iPad Safari in a browser tab rather than the Home Screen
 * app? iOS gives web push only to a web app added to the Home Screen (16.4+),
 * so in a tab `PushManager` is missing and the plain answer, "not supported in
 * this browser", hides the one step that fixes it.
 *
 * An iPad asking for the desktop site reports a Mac user agent, so a Mac with
 * a touch screen counts as one (no Mac has one). `standalone` is the
 * `(display-mode: standalone)` match or Safari's own `navigator.standalone`.
 */
export function isIosBrowserTab(ua: string, maxTouchPoints: number, standalone: boolean): boolean {
  if (standalone) return false
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  return ios
}

/** The same question, asked of the running browser. False on the server. */
export function isIosBrowserTabHere(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const standalone =
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return isIosBrowserTab(navigator.userAgent, navigator.maxTouchPoints ?? 0, standalone)
}

/** What the Remind control says for each answer, and its one button. */
export const REACH_COPY: Record<Exclude<ReminderReach, 'ok'>, { text: string; action?: string }> = {
  reminders_off: {
    text: 'Reminders are off, so this one won’t ring.',
    action: 'Turn on reminders',
  },
  no_device_here: {
    text: 'No device is set to get reminders yet.',
    action: 'Get them on this device',
  },
  no_device_elsewhere: {
    text: 'No device is set to get reminders yet. Turn on Push notifications in Settings, under Rituals, on your phone or in a browser.',
  },
  install_first: {
    text: 'No device is set to get reminders yet. On iPhone, add dsul to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn on Push notifications in Settings.',
  },
  blocked: {
    text: 'No device is set to get reminders yet, and notifications are blocked in this browser. Allow them in the browser’s settings, then reload.',
  },
}

/** The Push notifications row's word for an iPhone tab (lib/settings/manifest.ts). */
export const IOS_TAB_PUSH_COPY =
  'on iPhone, add dsul to your Home Screen first (Share, then Add to Home Screen) and open it from there'

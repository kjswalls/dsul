/**
 * The Devices list's reading of a roster row: its name, and what the sender
 * will do with it. Pure, so the list's words are tested without a browser.
 */

import type { DeviceSendKind } from '@dsul/types'
import { prefsOf } from './select'

/** A row as the owner reads it (DEVICE_ROSTER_COLUMNS): never `token` or `keys`. */
export interface RosterRow {
  id: string
  device_id: string
  platform: string
  transport: string
  delivery: string
  os: string | null
  form: string | null
  label: string | null
  prefs: unknown
  last_seen_at: string
  last_sent_at: string | null
  last_failure: string | null
}

/** The switches a device shows, one per kind a person would recognise. */
export const DEVICE_KIND_SWITCHES: { kind: DeviceSendKind; label: string }[] = [
  { kind: 'cue', label: 'Habit reminders' },
  { kind: 'last-call', label: 'Last call' },
  { kind: 'eod', label: 'End-of-day review' },
]

const PLACES: Record<string, string> = {
  'ios:phone': 'iPhone',
  'ios:tablet': 'iPad',
  'android:phone': 'Android phone',
  'android:tablet': 'Android tablet',
  'macos:desktop': 'Mac',
  'windows:desktop': 'Windows',
  'linux:desktop': 'Linux',
  'chromeos:desktop': 'Chromebook',
}

/** The row's own label, or a name from what it is. */
export function deviceName(row: RosterRow): string {
  if (row.label) return row.label
  if (row.platform === 'ios') return 'dsul on iPhone'
  if (row.platform === 'electron') return 'dsul for desktop'
  const place = PLACES[`${row.os}:${row.form}`]
  return place ? `Browser on ${place}` : 'Browser'
}

/** Is this kind on for the device? An absent kind is on. */
export function kindOn(row: RosterRow, kind: DeviceSendKind): boolean {
  return prefsOf(row.prefs).kinds?.[kind] !== false
}

/**
 * Does the iPhone app cover this row's reminders? The Home Screen app on an
 * iPhone that also has the app gets its cues from the app
 * (lib/devices/select.ts's native-wins rule), and the list says so rather than
 * showing switches that do nothing.
 */
export function coveredByIphoneApp(row: RosterRow, rows: readonly RosterRow[]): boolean {
  return (
    row.transport === 'webpush' &&
    row.os === 'ios' &&
    row.form === 'phone' &&
    rows.some((r) => r.platform === 'ios')
  )
}

/** The prefs blob with one kind switched, every other key kept. */
export function withKind(prefs: unknown, kind: DeviceSendKind, on: boolean): Record<string, unknown> {
  const base = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {}
  const kinds =
    base.kinds && typeof base.kinds === 'object' && !Array.isArray(base.kinds)
      ? (base.kinds as Record<string, unknown>)
      : {}
  return { ...base, kinds: { ...kinds, [kind]: on } }
}

/**
 * Can this row ring a cue at the desk itself (the page as a device,
 * reminders PR-1b)? A browser or the desktop app: a screen with dsul open on
 * it. The iPhone app schedules its own and never claims.
 */
export function claimsAtDesk(row: RosterRow): boolean {
  return row.platform === 'web' || row.platform === 'electron'
}

/** `prefs.claimsLocally`: absent is on, so every new browser starts with it on. */
export function claimsLocallyOn(row: RosterRow): boolean {
  return prefsOf(row.prefs).claimsLocally !== false
}

/** The prefs blob with `claimsLocally` set, every other key kept. */
export function withClaimsLocally(prefs: unknown, on: boolean): Record<string, unknown> {
  const base = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {}
  return { ...base, claimsLocally: on }
}

/** The switch's words, and what it costs. Tested in devices-web-client.test.ts. */
export const CLAIMS_LOCALLY_COPY = {
  label: 'Ring here while I’m using it',
  help:
    'When dsul is open on a screen with “Ring here while I’m using it” on, and you’ve used it in the last five ' +
    'minutes, a habit’s reminder rings there and nowhere else: not on your phone, and no text or call for it ' +
    'either. Each browser has its own switch, and a new browser starts with it on.',
} as const

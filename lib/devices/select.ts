/**
 * Which of a user's devices a send goes to. Pure: rows and a kind in, the
 * eligible rows and the held ones out, so every rule below is a table test
 * (tests/unit/devices-select.test.ts).
 *
 * In order, the first rule that holds a row names the reason:
 *
 *   1. `transport 'none'` — nothing can push to it (the desktop app, Phase 1c).
 *   2. `delivery 'local'` for cue, snooze and eod — the device arms its own
 *      triggers for those (decision 18: one scheduler per device). Last call,
 *      pledge and the rest still go.
 *   3. native-wins — a phone with the iPhone app AND the Home Screen app gets
 *      cue, snooze and eod from the app only: the webpush row with
 *      os 'ios' + form 'phone' is held while a live `ios` row exists, and for
 *      last call too once that row's transport is apns. A per-device override
 *      (`prefs.kinds[kind] === true`, set on the web row) wins. An iPad is
 *      never held by it: it is not the phone the app is on.
 *   4. `prefs.muted`.
 *   5. `prefs.kinds[kind] === false` — an absent kind is on.
 *   6. stale — unseen past STALE_DAYS; tonight's prune would delete it.
 *   7. quiet hours — `prefs.quiet` in the device's own zone. A device with no
 *      zone has no quiet hours: there is no clock to read them on.
 */

import { DevicePrefsSchema } from '@dsul/types'
import { localClock } from '../reminders/clock'
import { minutesOfDay } from '../reminders/due'
import { isStale } from './prune'
import type { DevicePrefs, DeviceRow, DeviceSendKind, HeldReason } from './types'

/** The kinds a device that schedules its own cues never takes from the server. */
const LOCAL_KINDS: ReadonlySet<DeviceSendKind> = new Set<DeviceSendKind>(['cue', 'snooze', 'eod'])

/** A row's prefs, or none: a malformed blob turns nothing off. */
export function prefsOf(raw: unknown): DevicePrefs {
  const parsed = DevicePrefsSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/** Is `minutes` inside [start, end), wrapping midnight when start > end? Equal ends are no quiet at all. */
export function inQuietHours(minutes: number, quiet: { start: string; end: string }): boolean {
  const start = minutesOfDay(quiet.start)
  const end = minutesOfDay(quiet.end)
  if (start === null || end === null || start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

function quietNow(row: DeviceRow, prefs: DevicePrefs, nowMs: number): boolean {
  if (!prefs.quiet || !row.timezone) return false
  try {
    return inQuietHours(localClock(new Date(nowMs), row.timezone).nowMinutes, prefs.quiet)
  } catch {
    // A zone the runtime does not know. No clock, no quiet hours.
    return false
  }
}

/** Does a native iPhone app row hold this webpush row back for this kind? */
function nativeWins(row: DeviceRow, kind: DeviceSendKind, rows: readonly DeviceRow[], nowMs: number): boolean {
  if (row.transport !== 'webpush' || row.os !== 'ios' || row.form !== 'phone') return false
  const natives = rows.filter((r) => r.platform === 'ios' && !isStale(r, nowMs))
  if (natives.length === 0) return false
  if (LOCAL_KINDS.has(kind)) return true
  return kind === 'last-call' && natives.some((r) => r.transport === 'apns')
}

export interface Selection {
  eligible: DeviceRow[]
  held: { row: DeviceRow; reason: HeldReason }[]
}

export function selectDevices(rows: readonly DeviceRow[], kind: DeviceSendKind, nowMs: number): Selection {
  const eligible: DeviceRow[] = []
  const held: Selection['held'] = []
  for (const row of rows) {
    const reason = heldReason(row, kind, rows, nowMs)
    if (reason) held.push({ row, reason })
    else eligible.push(row)
  }
  return { eligible, held }
}

function heldReason(
  row: DeviceRow,
  kind: DeviceSendKind,
  rows: readonly DeviceRow[],
  nowMs: number,
): HeldReason | null {
  const prefs = prefsOf(row.prefs)
  const override = prefs.kinds?.[kind]
  if (row.transport === 'none') return 'no_transport'
  if (row.delivery === 'local' && LOCAL_KINDS.has(kind)) return 'local'
  if (override !== true && nativeWins(row, kind, rows, nowMs)) return 'native_wins'
  if (prefs.muted) return 'muted'
  if (override === false) return 'kind_off'
  if (isStale(row, nowMs)) return 'stale'
  if (quietNow(row, prefs, nowMs)) return 'quiet'
  return null
}

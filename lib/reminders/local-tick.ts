/**
 * local-tick.ts — an open page as a device: the page tick's decisions
 * (memory/plans/reminders-platforms.md §5.2, PR-1b). Client-safe and pure of
 * the browser: every effect comes in through `LocalTickDeps`, which
 * hooks/use-local-cue-tick.ts builds on the window and a test fakes.
 *
 * ONCE A MINUTE, WHILE SOMEONE IS HERE. A tick does anything only when the
 * page is visible, has had input in the last five minutes, holds notification
 * permission, and is this account's registered device with `claimsLocally`
 * not switched off (Rituals → Devices). Then it asks lib/reminders/due.ts's
 * dueReminders, on the planner's items and the account's stored zone, which
 * cues are due, and claims them (POST /api/reminders/claim). The server
 * re-asks the same question of the database and its own clock before the
 * compare-and-swap, so a page with stale items or a fast clock cannot spend a
 * cue the server would not have sent.
 *
 * A WON CLAIM IS SHOWN HERE AND NOWHERE ELSE: the claim is the scan's own, so
 * no push goes to any device and no text or call goes out for that cue
 * (decision 4). It is shown through the service worker's registration
 * (`showNotification`, never `new Notification`, so its buttons reach the same
 * notificationclick as a pushed cue's), with the push's tag, so one cue is one
 * notification whatever delivered it. Then it is acked. If the presenter
 * throws after the claim, the cue is released (decision 20), and the scan
 * takes it inside its window.
 *
 * A LOST CLAIM IS NEVER ASKED AGAIN: someone discharged it, or there was
 * nothing to discharge. `later` is asked again next tick.
 *
 * SNOOZES. A Snooze tapped on this browser's notification is told to the page
 * by the service worker (lib/sw/handlers.ts, SNOOZED_MESSAGE), kept here with
 * the instant the server stored, and re-claimed at that instant with
 * `{ kind: 'snooze', held }`. A snooze whose instant is past its day's local
 * midnight is dropped, never rung (the day gate, habit-reminders.md decision 8).
 * One tapped on another device is that device's, or the scan's.
 */

import type { ActivationContext } from '../active'
import type { Item, Routine, Season } from '../planner-types'
// The buttons and the snooze length from the worker's mirror, never from
// ./channels/push, which would pull the sender (web-push) into the page.
import { ACTION_DONE, ACTION_SNOOZE, notificationFor, SNOOZE_MINUTES, type SwNotificationOptions } from '../sw/handlers'
import { candidateId, type ClaimAnswer, type ClaimCandidate } from './claim-wire'
import { localClock, type LocalClock } from './clock'
import { reminderCopy, type TimeFormat } from './copy'
import { cueKey, snoozeKey } from './cue-log'
import { dueReminders, REMINDER_GRACE_MINUTES, type ReminderCandidate, type ScanRow } from './due'
import { ringsOnDay } from './snooze'

/** How often the page asks. */
export const LOCAL_TICK_MS = 60_000

/** How recent the last input must be for the page to count as someone being here. */
export const PRESENCE_MS = 5 * 60_000

/** How long this device's own prefs are trusted before they are read again. */
export const DEVICE_PREFS_TTL_MS = 10 * 60_000

export interface PlannerView {
  userId: string | null
  items: readonly Item[]
  routines?: readonly Routine[]
  seasons?: readonly Season[]
  /** The account's STORED zone, the one the scan reads, never the browser's. */
  timezone: string | null
  timeFormat: TimeFormat
  /** The master switch (habit_reminders_enabled). */
  remindersEnabled: boolean
}

export interface ThisDevice {
  deviceId: string
  /** prefs.claimsLocally, and the cue kind not switched off or muted on this device. */
  claimsLocally: boolean
}

export interface Presenter {
  showNotification(title: string, options: SwNotificationOptions): Promise<void>
}

export interface LocalTickDeps {
  now(): number
  visible(): boolean
  lastInputMs(): number
  permission(): string
  planner(): PlannerView
  /** This browser's row, or null when it is not a registered device of this account. */
  device(): Promise<ThisDevice | null>
  /** The service worker's registration, or null with no worker to show through. */
  presenter(): Promise<Presenter | null>
  post(path: string, body: unknown): Promise<{ ok: boolean; json(): Promise<unknown> }>
}

export interface HeldSnooze {
  itemId: string
  dateStr: string
  /** reminder_snooze_until as stored. */
  held: string
}

export interface LocalCueTick {
  tick(): Promise<void>
  /** A Snooze tapped on this browser was stored. */
  noteSnooze(snooze: HeldSnooze): void
}

export function createLocalCueTick(deps: LocalTickDeps): LocalCueTick {
  /** candidateIds this page showed or lost, for one local day; reset when the day turns. */
  let resolved = new Set<string>()
  let resolvedDay: string | null = null
  const snoozes = new Map<string, HeldSnooze>()
  let running = false

  const present = () =>
    deps.visible() && deps.now() - deps.lastInputMs() <= PRESENCE_MS && deps.permission() === 'granted'

  async function run(): Promise<void> {
    if (!present()) return
    const view = deps.planner()
    if (!view.userId || !view.remindersEnabled || !view.timezone) return
    const zone = view.timezone

    let clock: LocalClock
    try {
      clock = localClock(new Date(deps.now()), zone)
    } catch {
      return
    }
    if (resolvedDay !== clock.dateStr) {
      resolved = new Set()
      resolvedDay = clock.dateStr
    }

    // A snooze past its day's midnight is nothing: dropped, never rung.
    for (const [id, s] of snoozes) {
      if (s.dateStr !== clock.dateStr || !ringsOnDay(Date.parse(s.held), zone, s.dateStr)) snoozes.delete(id)
    }

    const rows: ScanRow[] = view.items.map((item) => {
      const s = snoozes.get(item.id)
      return s ? { item, snoozeUntil: s.held, snoozeDate: s.dateStr } : { item }
    })
    const ctx: ActivationContext = {
      userTimezone: zone,
      routines: view.routines ? [...view.routines] : undefined,
      seasons: view.seasons ? [...view.seasons] : undefined,
    }
    const due = dueReminders(rows, { ...clock, graceMinutes: REMINDER_GRACE_MINUTES }, ctx)

    const asks: { candidate: ClaimCandidate; due: ReminderCandidate }[] = []
    for (const d of due) {
      const candidate: ClaimCandidate = d.snoozed
        ? { kind: 'snooze', itemId: d.item.id, dateStr: clock.dateStr, held: snoozes.get(d.item.id)!.held }
        : { kind: 'cue', itemId: d.item.id, dateStr: clock.dateStr, at: d.at }
      if (!resolved.has(candidateId(candidate))) asks.push({ candidate, due: d })
    }
    if (asks.length === 0) return

    // Only now the two reads: most minutes have nothing due and ask nothing.
    const device = await deps.device()
    if (!device?.claimsLocally) return
    const presenter = await deps.presenter()
    // A claim is never best-effort: a page that cannot show does not claim.
    if (!presenter) return

    const res = await deps.post('/api/reminders/claim', { candidates: asks.map((a) => a.candidate) })
    if (!res.ok) return
    const answer = (await res.json()) as Partial<ClaimAnswer>
    const won = new Set((answer.won ?? []).map(candidateId))
    const lost = new Set((answer.lost ?? []).map(candidateId))

    for (const { candidate, due: d } of asks) {
      const id = candidateId(candidate)
      if (lost.has(id)) {
        resolved.add(id)
        if (candidate.kind === 'snooze') snoozes.delete(candidate.itemId)
        continue
      }
      if (!won.has(id)) continue
      resolved.add(id)
      if (candidate.kind === 'snooze') snoozes.delete(candidate.itemId)
      await show(presenter, device, view.timeFormat, clock, candidate, d)
    }
  }

  async function show(
    presenter: Presenter,
    device: ThisDevice,
    timeFormat: TimeFormat,
    clock: LocalClock,
    candidate: ClaimCandidate,
    d: ReminderCandidate,
  ): Promise<void> {
    const { title, body } = reminderCopy(d, timeFormat)
    const itemId = d.item.id
    const key = candidate.kind === 'snooze' ? snoozeKey(itemId, candidate.held) : cueKey(itemId, clock.dateStr, d.at)
    // The push channel's notification, field for field (lib/reminders/channels/push.ts).
    const { title: t, options } = notificationFor({
      title,
      body,
      url: `/item/${itemId}`,
      tag: `dsul-item-${itemId}`,
      actions: [
        { action: ACTION_DONE, title: 'Done' },
        { action: ACTION_SNOOZE, title: `Snooze ${SNOOZE_MINUTES}m` },
      ],
      data: { url: `/item/${itemId}`, itemId, dateStr: clock.dateStr, kind: 'cue', ...(key ? { key } : {}) },
    })
    try {
      await presenter.showNotification(t, options)
    } catch {
      // Won and not shown. A cue goes back for the scan to take (decision 20);
      // a snooze's columns are already cleared, so there is nothing to give back.
      if (candidate.kind === 'cue') {
        await deps
          .post('/api/reminders/claim', {
            candidates: [{ kind: 'release', itemId, dateStr: candidate.dateStr, at: candidate.at }],
          })
          .catch(() => undefined)
      }
      return
    }
    if (!key) return
    await deps.post('/api/reminders/ack', { key, deviceId: device.deviceId }).catch(() => undefined)
  }

  return {
    async tick() {
      if (running) return
      running = true
      try {
        await run()
      } catch {
        // A network blip or a store mid-reset. The next minute asks again.
      } finally {
        running = false
      }
    },
    noteSnooze(snooze) {
      snoozes.set(snooze.itemId, snooze)
    },
  }
}

/** prefs → whether this device claims: claimsLocally (absent = on), the cue kind on, not muted. */
export function deviceClaims(prefs: unknown): boolean {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return true
  const p = prefs as { claimsLocally?: unknown; muted?: unknown; kinds?: unknown }
  if (p.claimsLocally === false || p.muted === true) return false
  const kinds = p.kinds && typeof p.kinds === 'object' ? (p.kinds as Record<string, unknown>) : {}
  return kinds.cue !== false
}

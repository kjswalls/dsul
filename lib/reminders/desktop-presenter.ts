/**
 * desktop-presenter.ts — the desktop app as the page tick's presenter
 * (memory/plans/reminders-platforms.md §5.2, PR-1c). Client-safe.
 *
 * Web Push never worked in Electron (memory/plans/desktop-app.md,
 * "Notifications and push"), so the desktop's reminders come from its own
 * page tick (lib/reminders/local-tick.ts), drawn by the main process over the
 * bridge (electron/lib/notify.cjs) instead of a service worker. Two jobs here:
 *
 *   · `desktopPresenter`: the tick's Presenter, turning the notification the
 *     push channel would have shown, field for field, into the bridge's spec.
 *     A refusal (main said false) throws, so the tick gives the claim back for
 *     the scan to take, exactly as a service worker that failed to show does.
 *   · `actOnDesktopNotification`: what a click or a button does, which is the
 *     service worker's notificationclick (lib/sw/handlers.ts) said again: a
 *     click opens the link, Done and Snooze call /api/reminders/act with the
 *     cookie, and a stored Snooze is handed to the tick to ring at its time.
 */

import type { DesktopNotificationEvent, DesktopNotificationSpec, DesktopNotifier } from '../desktop'
import { ACTION_DONE, ACTION_SNOOZE, type SwNotificationOptions } from '../sw/handlers'
import type { HeldSnooze, Presenter } from './local-tick'

/** How long the computer may sit untouched and still count as someone at the desk. Matches PRESENCE_MS. */
export const DESKTOP_IDLE_SECONDS = 5 * 60

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** The bridge's spec for a notification the tick built for a service worker. */
export function specFor(title: string, options: SwNotificationOptions): DesktopNotificationSpec {
  const data = isRecord(options.data) ? options.data : {}
  const actions = (options.actions ?? []).filter(
    (a): a is { action: 'done' | 'snooze'; title: string } => a.action === ACTION_DONE || a.action === ACTION_SNOOZE,
  )
  const spec: DesktopNotificationSpec = {
    tag: options.tag ?? '',
    title,
    body: options.body ?? '',
    url: str(data.url) ?? '/',
    data: {
      ...(str(data.itemId) ? { itemId: str(data.itemId) } : {}),
      ...(str(data.dateStr) ? { dateStr: str(data.dateStr) } : {}),
      ...(data.kind === 'cue' ? { kind: 'cue' as const } : {}),
      ...(str(data.key) ? { key: str(data.key) } : {}),
    },
  }
  if (actions.length > 0) spec.actions = actions
  return spec
}

export function desktopPresenter(notifier: Pick<DesktopNotifier, 'notify'>): Presenter {
  return {
    async showNotification(title, options) {
      const shown = await notifier.notify(specFor(title, options))
      if (!shown) throw new Error('the desktop app did not show the notification')
    },
  }
}

/** Is someone at this computer: input anywhere on it in the last five minutes. */
export async function atTheDesk(notifier: Pick<DesktopNotifier, 'idleSeconds'>): Promise<boolean> {
  const idle = await notifier.idleSeconds()
  return typeof idle === 'number' && idle < DESKTOP_IDLE_SECONDS
}

export interface ActDeps {
  post(path: string, body: unknown): Promise<{ ok: boolean; json(): Promise<unknown> }>
  /** Opens an in-app path. */
  navigate(url: string): void
  noteSnooze(snooze: HeldSnooze): void
  /** A button that could not act: the item is still open, and the user is told so. */
  failed(itemTitle: string | undefined, url: string): void
}

/** A click or a button on a desktop reminder. Never throws. */
export async function actOnDesktopNotification(
  event: DesktopNotificationEvent,
  deps: ActDeps,
  itemTitle?: string,
): Promise<void> {
  const data = isRecord(event.data) ? event.data : { url: '/' }
  const url = str(data.url) ?? '/'
  if (event.type !== 'action') {
    deps.navigate(url)
    return
  }
  const action = event.action
  const itemId = str(data.itemId)
  const dateStr = str(data.dateStr)
  if ((action !== ACTION_DONE && action !== ACTION_SNOOZE) || !itemId || !dateStr) {
    deps.navigate(url)
    return
  }
  try {
    const res = await deps.post('/api/reminders/act', { action, itemId, dateStr })
    if (!res.ok) {
      deps.failed(itemTitle, url)
      return
    }
    if (action !== ACTION_SNOOZE) return
    const body = await res.json().catch(() => null)
    const until = isRecord(body) ? str(body.snoozedUntil) : undefined
    if (until) deps.noteSnooze({ itemId, dateStr, held: until })
  } catch {
    deps.failed(itemTitle, url)
  }
}

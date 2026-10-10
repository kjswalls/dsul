import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';

// This is injected by @serwist/next during build
declare global {
  interface ServiceWorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // Push-only setup — no precaching in this PR
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
});

serwist.addEventListeners();

/**
 * Action ids, mirrored from lib/reminders/channels/push.ts.
 *
 * Duplicated rather than imported because this file is bundled as a service
 * worker and pulling in the app's module graph to share two string literals
 * would drag Supabase and the whole registry into the worker. The values are
 * part of an already-delivered notification's payload, so they are effectively
 * frozen: a notification sitting on a lock screen was written by a build that
 * may be days older than the worker handling its click.
 */
const ACTION_DONE = 'done';
const ACTION_SNOOZE = 'snooze';

/**
 * `actions` is real on ServiceWorkerRegistration.showNotification but absent
 * from the DOM lib's NotificationOptions, which is the type that resolves here
 * (this project's tsconfig has no webworker lib — see the other errors this
 * file already reports). Declared locally rather than left to `any`, so a typo
 * in an action id is still caught.
 */
interface SwNotificationOptions extends NotificationOptions {
  actions?: { action: string; title: string }[];
  /**
   * Alert again when replacing a notification that shares this one's tag.
   *
   * Without it, a replacement over an existing tag lands SILENTLY — per the
   * Notifications spec, replacing suppresses the alert unless renotify is set.
   * The cue's tag is item-scoped (`dsul-item-<id>`), so yesterday's cue
   * sitting unread in the shade would silently swallow today's.
   */
  renotify?: boolean;
}

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  actions?: { action: string; title: string }[];
  data?: Record<string, unknown>;
}

// Handle push events from server
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: PushPayload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'dsul', body: event.data.text() };
  }

  const title = payload.title ?? 'dsul';
  const options: SwNotificationOptions = {
    body: payload.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Collapse key: a re-delivered cue REPLACES the one already on screen
    // instead of stacking beside it.
    tag: payload.tag,
    // Only meaningful with a tag, and only correct with one: renotify without a
    // tag throws a TypeError.
    renotify: Boolean(payload.tag),
    actions: payload.actions,
    data: { url: payload.url ?? '/', ...(payload.data ?? {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Tell the user when an action button did NOT do what it promised.
 *
 * Without this, a failed Done is indistinguishable from a successful one — the
 * notification closes either way — and the habit silently goes unmarked. That
 * is worse than never offering the button, because the user believes the day is
 * handled. `requireInteraction` keeps the correction on screen.
 */
async function reportActionFailure(itemTitle: string | undefined): Promise<void> {
  await self.registration.showNotification("Couldn't save that", {
    body: itemTitle
      ? `${itemTitle} is still open. Tap to mark it in dsul.`
      : 'Tap to mark it in dsul.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'dsul-action-failed',
    requireInteraction: true,
    data: { url: '/' },
  });
}

/** Focus an existing tab on this URL if there is one, else open a new one. */
async function openOrFocus(url: string): Promise<void> {
  // client.url is absolute; `url` is a path off our own origin. Comparing them
  // raw never matched, so every click opened a second tab.
  const target = new URL(url, self.location.origin).href;
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if (client.url === target && 'focus' in client) return void client.focus();
  }
  // Fall back to focusing ANY open dsul tab and steering it, rather than
  // opening a duplicate: the PWA is usually already running.
  for (const client of clientList) {
    if (!('navigate' in client) || !('focus' in client)) continue;
    try {
      await client.focus();
      await client.navigate(target);
      return;
    } catch {
      // navigate() rejects with a TypeError on a client this worker does not
      // control — which matchAll({includeUncontrolled: true}) deliberately
      // returns. Uncaught, that rejection skipped openWindow entirely and the
      // tap did nothing at all.
      break;
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? {}) as {
    url?: string;
    itemId?: string;
    dateStr?: string;
  };
  const url = data.url ?? '/';
  const action = event.action;

  // A plain click (no action button) opens the app, as it always did.
  if (action !== ACTION_DONE && action !== ACTION_SNOOZE) {
    event.waitUntil(openOrFocus(url));
    return;
  }

  event.waitUntil(
    (async () => {
      if (!data.itemId) return reportActionFailure(event.notification.title);
      try {
        const res = await fetch('/api/reminders/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Same-origin, and the session cookie is what authorises the write.
          // Without this the route sees an anonymous request and 401s.
          credentials: 'include',
          body: JSON.stringify({ action, itemId: data.itemId, dateStr: data.dateStr }),
        });
        if (!res.ok) await reportActionFailure(event.notification.title);
      } catch {
        // Offline, most likely. Say so rather than swallowing it.
        await reportActionFailure(event.notification.title);
      }
    })(),
  );
});

/**
 * The browser replaced this worker's push subscription (an expiry, a key
 * rotation, a push service's own housekeeping). Without this the device row
 * keeps the dead endpoint, every push to it answers 410, and the row is pruned:
 * reminders stop until the app is next opened.
 *
 * `newSubscription` is often absent (Chrome has never filled it in), so the
 * worker re-subscribes with the old subscription's key. Then it tells the
 * server, with the session cookie: /api/devices/rotate moves the row holding
 * the old endpoint onto the new one and keeps its id and switches. A rotation
 * the server cannot place (no old endpoint, a session that has gone) is left to
 * the app's next boot, which registers whatever subscription it finds
 * (hooks/use-device-registration.ts). Never throws.
 */
interface PushSubscriptionChange {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
  waitUntil(promise: Promise<unknown>): void;
}

async function resubscribe(old: PushSubscription | null): Promise<PushSubscription | null> {
  const key = old?.options?.applicationServerKey;
  if (!key) return null;
  const manager: PushManager = self.registration.pushManager;
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const change = event as unknown as PushSubscriptionChange;
  change.waitUntil(
    (async () => {
      const old = change.oldSubscription;
      const next = change.newSubscription ?? (await resubscribe(old));
      if (!next) return;
      const json = next.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
      await fetch('/api/devices/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          oldToken: old?.endpoint ?? null,
          token: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        }),
      });
    })().catch(() => {
      // Offline, or the push service refused. The next boot heals it.
    }),
  );
});

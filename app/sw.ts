import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';
import {
  handleNotificationClick,
  handlePush,
  handleSubscriptionChange,
  type SwContext,
} from '../lib/sw/handlers';

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
 * The listeners, and nothing else. What each one does is lib/sw/handlers.ts,
 * against this context, so a unit test drives the same code with a fake one
 * (memory/plans/reminders-platforms.md §2.1, PR-1b).
 */
const ctx: SwContext = {
  origin: self.location.origin,
  showNotification: (title, options) => self.registration.showNotification(title, options),
  fetch: (input, init) => fetch(input, init),
  matchClients: () => self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
  openWindow: (url) => self.clients.openWindow(url),
  pushEndpoint: async () => (await self.registration.pushManager.getSubscription())?.endpoint ?? null,
};

// Handle push events from server
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw: unknown;
  try {
    raw = event.data.json();
  } catch {
    raw = event.data.text();
  }
  event.waitUntil(handlePush(ctx, raw));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    handleNotificationClick(ctx, {
      action: event.action,
      title: event.notification.title,
      data: event.notification.data,
    }),
  );
});

/**
 * The browser replaced this worker's push subscription (an expiry, a key
 * rotation, a push service's own housekeeping). Without this the device row
 * keeps the dead endpoint, every push to it answers 410, and the row is pruned:
 * reminders stop until the app is next opened.
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
      await handleSubscriptionChange(ctx, old?.endpoint ?? null, next ? next.toJSON() : null);
    })().catch(() => {
      // Offline, or the push service refused. The next boot heals it.
    }),
  );
});

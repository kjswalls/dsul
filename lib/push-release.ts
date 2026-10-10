'use client';

/**
 * Let go of this browser's push subscription, because the person at it changed
 * (#254).
 *
 * The subscription lives outside localStorage — in the service worker's
 * PushManager and in a `devices` row (migration 064; `push_subscriptions`
 * before it) — so lib/local-state.ts's
 * clear never reached it, and the previous account's reminders, titles and
 * all, kept arriving in a browser now signed in as someone else.
 *
 * Both halves, in this order:
 *   1. POST /api/devices/release — the row goes, keyed on the endpoint alone, so it
 *      works with no session (sign-out has already dropped it by the time
 *      SIGNED_OUT fires, and a browser that wakes as someone new never had it).
 *   2. `subscription.unsubscribe()` — the endpoint stops being deliverable.
 * Row first: the reverse leaves a window where the endpoint is live and the row
 * still names the previous account, which is the leak itself. The unsubscribe
 * runs even if the release failed — a dead endpoint answers 410 on the next
 * push and lib/devices/send.ts prunes the row then.
 *
 * NEVER THROWS, and callers do not await it: it runs from synchronous
 * account-change paths (sign-out, adoption of a new owner, a sibling tab's
 * re-stamp) that must not stall or fail on a push service. Repeats are
 * harmless — a second call finds no subscription and does nothing.
 *
 * `getRegistration()`, not `serviceWorker.ready`: `ready` never settles in a
 * browser that has no worker registered, and that is exactly the browser with
 * nothing to release.
 */
export async function releaseThisBrowserPush(): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;

    try {
      await fetch('/api/devices/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transport: 'webpush', token: subscription.endpoint }),
        // Sign-out navigates to /login straight after; let the request finish.
        keepalive: true,
      });
    } catch (err) {
      console.warn('[push] release request failed; unsubscribing anyway:', err);
    }

    await subscription.unsubscribe();
  } catch (err) {
    console.warn('[push] could not release this browser’s subscription:', err);
  }
}

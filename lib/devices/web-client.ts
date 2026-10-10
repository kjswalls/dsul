'use client';

/**
 * This browser as a device (migration 065; memory/plans/reminders-platforms.md §3.2).
 *
 * A browser has one stable id, `dsul-device-id` in localStorage, made once and
 * never cleared: it is a property of the browser, like the sidebar width, and
 * says nothing about whoever is signed in (lib/local-state.ts does not list
 * it, on purpose). The push endpoint can rotate under it; the id is what keeps
 * the device's switches and its name across a rotation.
 *
 * The browser registers whenever it holds a push subscription: when push is
 * turned on, and again on every boot (AppShell), which moves a row 065's
 * backfill made onto this real id and keeps `last_seen_at` fresh. The server
 * writes nothing for an unchanged registration seen in the last 12 hours.
 * Without a subscription nothing is registered: this PR's devices are the
 * ones push can reach.
 *
 * NEVER THROWS. Both are called from paths that must not stall on a push
 * service or a network.
 */

import type { DeviceForm, DeviceRegistration } from '@dsul/types';

export const DEVICE_ID_KEY = 'dsul-device-id';

/** For a browser whose storage refuses both read and write: one id for this page's life. */
let memoryId: string | null = null;

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `web-${random}`;
}

/** This browser's device id, made on first ask. */
export function thisDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && /^[A-Za-z0-9:._-]{8,128}$/.test(stored)) return stored;
    const id = newId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // Private mode, blocked storage. A new id each page load registers a new
    // row each time, and register_device retires the last one: it held the
    // same endpoint.
    memoryId ??= newId();
    return memoryId;
  }
}

/** The id without making one: what the Devices list marks as "this browser". */
export function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_ID_KEY) ?? memoryId;
  } catch {
    return memoryId;
  }
}

export interface UaHints {
  os?: string;
  form?: DeviceForm;
  /** A name for a new row, "Safari on iPhone". The owner can rename it; it is never re-sent over a rename. */
  label?: string;
}

/**
 * Which OS and form factor a user agent is, for the sender's iPhone rule
 * (lib/devices/select.ts holds a Home Screen app's cues while the iPhone app
 * is on the same phone). Hints, not facts: an iPad asking for the desktop site
 * says Macintosh, and only its touch points give it away.
 */
export function uaHints(ua: string, maxTouchPoints = 0): UaHints {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua)
      ? 'Firefox'
      : /CriOS\/|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const on = (place: string) => `${browser} on ${place}`;
  if (/iPhone|iPod/.test(ua)) return { os: 'ios', form: 'phone', label: on('iPhone') };
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) {
    return { os: 'ios', form: 'tablet', label: on('iPad') };
  }
  if (/Android/.test(ua)) {
    const phone = /Mobile/.test(ua);
    return { os: 'android', form: phone ? 'phone' : 'tablet', label: on(phone ? 'Android' : 'Android tablet') };
  }
  if (/CrOS/.test(ua)) return { os: 'chromeos', form: 'desktop', label: on('Chromebook') };
  if (/Macintosh|Mac OS X/.test(ua)) return { os: 'macos', form: 'desktop', label: on('Mac') };
  if (/Windows/.test(ua)) return { os: 'windows', form: 'desktop', label: on('Windows') };
  if (/Linux/.test(ua)) return { os: 'linux', form: 'desktop', label: on('Linux') };
  return { label: browser };
}

function timeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length <= 64 ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** The registration body for a subscription, or null when it is not one a push service can use. */
export function registrationFor(
  subscription: PushSubscription,
  hints: UaHints,
  deviceId: string,
): DeviceRegistration | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  const body: DeviceRegistration = {
    deviceId,
    platform: 'web',
    transport: 'webpush',
    delivery: 'push',
    token: json.endpoint,
    keys: { p256dh, auth },
  };
  if (hints.os) body.os = hints.os;
  if (hints.form) body.form = hints.form;
  if (hints.label) body.label = hints.label;
  const zone = timeZone();
  if (zone) body.timezone = zone;
  return body;
}

/** The current subscription, without waiting on a worker that may never register (see lib/push-release.ts). */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Register this browser's push subscription with the signed-in account.
 * `subscription` is the one just made; without it, the current one, if any.
 * Returns whether the server took it.
 */
export async function registerThisBrowser(subscription?: PushSubscription): Promise<boolean> {
  try {
    const sub = subscription ?? (await currentSubscription());
    if (!sub) return false;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return false;
    const body = registrationFor(sub, uaHints(navigator.userAgent, navigator.maxTouchPoints ?? 0), thisDeviceId());
    if (!body) return false;
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.warn('[devices] could not register this browser:', err);
    return false;
  }
}

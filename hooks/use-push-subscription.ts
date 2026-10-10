'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { registerThisBrowser } from '@/lib/devices/web-client';
import { releaseThisBrowserPush } from '@/lib/push-release';

// VAPID public key — must also be set in Vercel env vars (NEXT_PUBLIC_VAPID_PUBLIC_KEY)
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export interface UsePushSubscriptionReturn {
  isSupported: boolean;
  isSubscribed: boolean;
  permissionState: NotificationPermission | 'unknown';
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

export function usePushSubscription(): UsePushSubscriptionReturn {
  const isSupported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const [isSubscribed, setIsSubscribed] = useState(false);
  const [permissionState, setPermissionState] = useState<NotificationPermission | 'unknown'>('unknown');

  // Sync current subscription state on mount
  useEffect(() => {
    if (!isSupported) return;
    
    // Explicitly register SW to prevent hanging on iOS Safari
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.error('[push] SW registration failed:', err);
    });

    setPermissionState(Notification.permission);

    navigator.serviceWorker.ready.then(async (reg) => {
      const existing = await reg.pushManager.getSubscription();
      setIsSubscribed(!!existing);
    });
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported) return;
    if (!VAPID_PUBLIC_KEY) {
      console.error('[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set');
      return;
    }

    // Only request permission if not already granted
    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
      setPermissionState(permission);
    }
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    // This browser becomes a device on the account (lib/devices/web-client.ts).
    if (!(await registerThisBrowser(subscription))) {
      console.error('[push] the subscription was made but the server did not take it');
    }

    setIsSubscribed(true);
    setPermissionState(Notification.permission);
  }, [isSupported]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported) return;
    // The device row first, then the subscription: the order #254 needs, and
    // the same call every change of user makes (lib/push-release.ts).
    await releaseThisBrowserPush();
    setIsSubscribed(false);
  }, [isSupported]);

  // Memoized because the settings route folds this straight into a useMemo'd
  // context object: a fresh literal every render made that memo a no-op, so the
  // whole settings surface re-rendered on every keystroke in the search field.
  // subscribe/unsubscribe are already useCallback-stable.
  return useMemo(
    () => ({ isSupported, isSubscribed, permissionState, subscribe, unsubscribe }),
    [isSupported, isSubscribed, permissionState, subscribe, unsubscribe]
  );
}

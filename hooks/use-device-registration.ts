'use client';

import { useEffect, useRef } from 'react';
import { registerThisBrowser } from '@/lib/devices/web-client';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * The boot re-post (memory/plans/reminders-platforms.md §5.2, PR-1a): once per
 * account per app load, a browser that holds a push subscription registers it
 * again (lib/devices/web-client.ts).
 *
 * It is what moves a row 065's backfill made (a placeholder id per endpoint)
 * onto this browser's real id, what keeps `last_seen_at` fresh for the nightly
 * prune, and what heals an endpoint the browser rotated while no page was open
 * to hear it. The server writes nothing for an unchanged registration seen in
 * the last 12 hours, so the cost is one request a load.
 *
 * Waits for the planner load to settle, as useTimezoneSync does, to stay out of
 * the cold-start burst. A browser with no subscription posts nothing.
 */
export function useDeviceRegistration() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const done = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || isLoading || done.current === userId) return;
    done.current = userId;
    void registerThisBrowser();
  }, [userId, isLoading]);
}

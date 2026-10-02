'use client';

import { useEffect, useMemo, useReducer } from 'react';

import { iconHrefFor, type AppIcon } from '@/lib/app-icons';
import { useToday } from '@/lib/collections';
import { isDayCleared } from '@/lib/day-done';
import { useLookStore } from '@/lib/look-store';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useNowMinutes } from '@/lib/use-now-minutes';

/** Saved on each icon link the first time it is touched: the href Next rendered. */
const ORIGINAL_HREF = 'data-dsul-href';

/**
 * The browser tab's icon: the picked one (Settings → Look → App icon), or Lime
 * for the rest of a day whose items are all done (lib/day-done.ts). A Lime pick
 * shows no change on a cleared day; the reward is for Aurora users.
 *
 * It rewrites the hrefs of the `<link rel="icon">` elements Next renders from
 * app/layout.tsx's metadata, swapping /icons/ for /icons/lime/ (the twins
 * share file names, see lib/app-icons.ts). Mutating the existing links rather
 * than appending new ones is what browsers pick up most reliably, and it
 * leaves nothing behind. The apple-touch-icon is never touched: a home-screen
 * icon is fixed at install time, and `rel~="icon"` does not match it.
 *
 * The desktop shell shows no favicon, so the Dock is the bridge's business
 * (components/providers/desktop-bridge.tsx), and it follows the setting only.
 *
 * Renders nothing. Route-level, inside SupabaseProvider, so it runs on every
 * page; on a route with no item load (lib/route-data.ts) the planner never
 * settles and the tab simply shows the pick.
 */
export function FaviconSync() {
  const appIcon = useLookStore((s) => s.appIcon);
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  // A failed load counts as settled (lib/planner-ready.ts), but its store is
  // not the account's items, so it is not read as today's.
  const loaded = usePlannerStore((s) => selectPlannerSettled(s) && s.loadFailedUserId !== s.userId);
  const { todayStr, tz } = useToday();

  // `today` is recomputed every render (useToday), so all an idle tab needs to
  // fall back to Aurora at midnight is a render: once a minute while it runs,
  // and on coming back to the foreground, where a backgrounded tab's timers
  // may have been throttled through the boundary. The values are not read.
  useNowMinutes(tz);
  const [, wake] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const dayDone = useMemo(
    () => loaded && isDayCleared(items, todayStr, { userTimezone: tz, routines, seasons }),
    [loaded, items, todayStr, tz, routines, seasons]
  );
  const variant: AppIcon = appIcon === 'lime' || dayDone ? 'lime' : 'aurora';

  useEffect(() => {
    const apply = () => {
      for (const link of document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
        const href = link.getAttribute('href');
        if (href === null) continue;
        let original = link.getAttribute(ORIGINAL_HREF);
        // A link Next has re-rendered with an href that is neither the saved
        // one nor its lime twin is a new original, not ours to undo.
        if (original === null || (href !== original && href !== iconHrefFor(original, 'lime'))) {
          original = href;
          link.setAttribute(ORIGINAL_HREF, original);
        }
        const next = iconHrefFor(original, variant);
        // Only on a difference: the observer below hears this write too.
        if (href !== next) link.setAttribute('href', next);
      }
    };
    apply();
    // Next owns these links and may re-render them on navigation; whatever it
    // puts back is put right again.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    return () => observer.disconnect();
  }, [variant]);

  return null;
}

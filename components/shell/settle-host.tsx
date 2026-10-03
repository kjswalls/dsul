'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

import { usePlannerPreviewing } from '@/lib/planner-ready';
import { notePreviewPainted, onLandingCommitted, registerSettleHost } from '@/lib/settle';

/** What a screen reader hears while the cached planner is up. The rows themselves are inert, so hidden from it. */
export const PREVIEW_STATUS_TEXT = 'Showing your last session. Syncing…';

/**
 * The settle conductor's React end (lib/settle.ts), and the preview's one
 * announcement.
 *
 * Mounted ONCE, at AppShell's top level outside the desktop/mobile/Zen swap,
 * so a shell change mid-preview neither loses the edge nor announces twice.
 * The sync lines (planner-sync-line.tsx) are aria-hidden; this is the only
 * live region.
 *
 *  - Registration: the conductor's planner-store subscription lives exactly
 *    as long as a host is mounted. It captures the preview's geometry INSIDE
 *    the landing set(), before React commits the fresh rows.
 *  - "Painted": two frames after the preview commits, the cached planner has
 *    reached the screen. A landing before that has nothing visible to settle
 *    from.
 *  - The landing: a LAYOUT effect on the preview → not-preview edge, so the
 *    conductor measures the fresh DOM after React's mutations and before the
 *    browser paints it — and holds the preview geometry for that first paint.
 *    Every way the preview ends passes here (a failed load and a crash drop
 *    too); the conductor finds nothing captured for those. A mount is not an
 *    edge.
 */
export function SettleHost() {
  const previewing = usePlannerPreviewing();
  const wasPreviewing = useRef(previewing);

  useEffect(() => registerSettleHost(), []);

  useEffect(() => {
    if (!previewing) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => notePreviewPainted());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [previewing]);

  useLayoutEffect(() => {
    const landed = wasPreviewing.current && !previewing;
    wasPreviewing.current = previewing;
    if (landed) onLandingCommitted();
  }, [previewing]);

  return (
    <span role="status" aria-live="polite" className="sr-only" data-testid="planner-preview-status">
      {previewing ? PREVIEW_STATUS_TEXT : ''}
    </span>
  );
}

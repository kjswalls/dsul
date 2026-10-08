'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

import { usePlannerPreviewing } from '@/lib/planner-ready';
import { notePreviewRendered } from '@/lib/planner-snapshot';
import { registerShimmerHost, shimmerLandingCommitted, shimmerPreviewCommitted } from '@/lib/planner-shimmer';
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
 *  - "Rendered": from the commit until the preview ends or this unmounts, a
 *    hold that tells the crash marker the preview did not crash the page
 *    (lib/planner-snapshot.ts). A throw above AppShell unmounts this, which
 *    releases it, so that page's marker survives its pagehide.
 *  - The landing: a LAYOUT effect on the preview → not-preview edge, so the
 *    conductor measures the fresh DOM after React's mutations and before the
 *    browser paints it — and holds the preview geometry for that first paint.
 *    Every way the preview ends passes here (a failed load and a crash drop
 *    too); the conductor finds nothing captured for those. A mount is not an
 *    edge.
 *  - The waiting shimmer (lib/planner-shimmer.ts): its wait starts in a
 *    layout effect on the preview's commit, before the cached rows are first
 *    styled, and its landing pass measures the fresh titles in the landing's
 *    layout effect, just before the conductor holds the glide.
 */
export function SettleHost() {
  const previewing = usePlannerPreviewing();
  const wasPreviewing = useRef(previewing);

  useEffect(() => registerSettleHost(), []);
  // After the conductor's, so its subscriber reads the preview's rects
  // before the shimmer's re-styles the titles for the landing.
  useEffect(() => registerShimmerHost(), []);

  useLayoutEffect(() => {
    if (previewing) shimmerPreviewCommitted();
  }, [previewing]);

  useEffect(() => {
    if (!previewing) return;
    const release = notePreviewRendered();
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => notePreviewPainted());
    });
    return () => {
      release();
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [previewing]);

  useLayoutEffect(() => {
    const landed = wasPreviewing.current && !previewing;
    wasPreviewing.current = previewing;
    if (landed) {
      // Before the conductor's hold, so each title is read where it now rests.
      shimmerLandingCommitted();
      onLandingCommitted();
    }
  }, [previewing]);

  return (
    <span role="status" aria-live="polite" className="sr-only" data-testid="planner-preview-status">
      {previewing ? PREVIEW_STATUS_TEXT : ''}
    </span>
  );
}

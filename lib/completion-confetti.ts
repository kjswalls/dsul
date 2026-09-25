'use client';

import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_COMPLETION_CONFETTI } from '@/lib/extension-registry';
import { useUndoStripStore } from '@/lib/undo-strip-store';

/**
 * The completion-confetti extension's whole surface. Called from the two
 * completion funnels in planner-store (toggleTaskStatus / toggleHabitStatus) —
 * every surface (dialog, command palette, EOD review, bulk bar) goes through
 * those actions, so the gate lives in exactly one place per funnel and only
 * fires on the way TO done, never on un-complete.
 *
 * canvas-confetti is imported lazily: the library never loads for users who
 * keep the extension off (it stays out of the main bundle), and planner-store
 * — which imports this module — stays importable in node-side unit tests.
 */
export function celebrateCompletion(): void {
  if (typeof window === 'undefined') return;
  if (!useExtensionsStore.getState().isEnabled(EXT_COMPLETION_CONFETTI)) return;
  // Two vetoes: dsul's own animations toggle (stamped on <html> by
  // supabase-provider) and the OS preference, which canvas-confetti checks
  // itself via disableForReducedMotion.
  if (document.documentElement.hasAttribute('data-reduce-motion')) return;
  // Whatever row is up NOW belongs to an earlier action; only a row raised
  // after this call is this completion's receipt.
  const staleRowId = useUndoStripStore.getState().entry?.id ?? null;
  import('canvas-confetti')
    .then(({ default: confetti }) => {
      // Aimed after the next paint, not now: completing raises the activity
      // row through an effect (hooks/use-undo-toast.ts), so at call time it
      // is not on screen yet — and the import can resolve before React commits.
      return nextPaint().then(() => {
        confetti({
          particleCount: 70,
          spread: 60,
          startVelocity: 28,
          origin: burstOrigin(staleRowId),
          // Lime-family hexes — a canvas can't read CSS custom properties, and
          // the burst should read as dsul, not a generic party (the onboarding
          // tour's purple burst predates the brand rule).
          colors: ['#b8e45c', '#8fd14f', '#5a8f22', '#e8c96a'],
          disableForReducedMotion: true,
        });
      });
    })
    .catch(() => {
      // Some mobile browsers refuse the canvas — a celebration is never an error.
    });
}

/** Where the burst starts today when there is no activity row to stand on. */
const DEFAULT_ORIGIN = { x: 0.5, y: 0.7 };

function nextPaint(): Promise<void> {
  // Two frames: the first runs before the pending commit's paint, the second
  // after it, so the row the completion raised has a box by then.
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * The burst rises from the top edge of the activity row ("Complete task: …"),
 * so the celebration sits on the receipt for the thing that earned it rather
 * than in the middle of the screen.
 *
 * Only a row raised by this completion counts. Not every completion raises
 * one (a recurring task's "Complete task on <date>: …" is not in
 * use-undo-toast's list), and a row still standing from an earlier action —
 * "Delete task: A" — is a receipt for something else; both fall back to the
 * old centre origin. Both docks mount an UndoStrip, but only the one in the
 * visible shell has a box, and an off-screen row falls back too.
 *
 * Exported for the unit test.
 */
export function burstOrigin(staleRowId: string | null): { x: number; y: number } {
  const entry = useUndoStripStore.getState().entry;
  if (!entry || entry.id === staleRowId) return DEFAULT_ORIGIN;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return DEFAULT_ORIGIN;
  const rows = document.querySelectorAll<HTMLElement>('[data-testid="undo-strip"]');
  for (const row of rows) {
    if (row.dataset.undoId !== entry.id) continue;
    const r = row.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom <= 0 || r.top >= h || r.right <= 0 || r.left >= w) continue;
    return {
      x: (r.left + r.width / 2) / w,
      y: Math.max(0, r.top) / h,
    };
  }
  return DEFAULT_ORIGIN;
}

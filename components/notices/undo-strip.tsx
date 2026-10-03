'use client';

import { Undo2, X } from 'lucide-react';

import { TypewriterText } from '@/components/primitives/typewriter-text';
import { usePlannerStore } from '@/lib/planner-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { cn } from '@/lib/utils';

/**
 * The activity row — direction C's shape, carrying direction E's ink.
 *
 * WHY IT IS NOT A NOTICE. It has no object, and it is the one thing here that
 * genuinely cannot have one: "Delete task: Swim" is about a row that no longer
 * exists. So it does not go through `placeNotices`, it does not take a rank, and
 * it never occupies the dock's one line — it sits above the dock as its own
 * transient row and leaves on its own.
 *
 * WHY IT LOOKS LIKE ONE ANYWAY. A toast and a notice are the same sentence said
 * by the same voice, and the old sonner card said it in a second visual language
 * eight pixels away from the first. Same 26px, same glyph-then-line-then-verb
 * reading, same ink.
 *
 * IT TYPES, unlike the dock's line. The rule is that anything urgent must be
 * legible instantly, and this is the least urgent thing the app ever says: it is
 * a receipt for something the user did deliberately one moment ago. The reveal
 * costs at most 640ms of a 5000ms life and is what tells the eye this row is new
 * rather than the dock line it is sitting on top of.
 *
 * The hairline is the expiry, and it animates WIDTH. Lime never takes alpha in
 * this palette, and it is its own element so no parent can fade it (CLAUDE.md).
 *
 * WHY THE CALLER OWNS POSITIONING. On the desktop this row is taken OUT of flow
 * (`absolute bottom-full`) and overlays the braindump instead of displacing it.
 * That is not tidiness — it is measured. In a short window the sidebar column
 * has no slack, and a 26px row that
 * appears and vanishes on a 5s timer the instant after the user acts is the
 * "moves under your cursor" complaint being caused by the fix for it. Out of
 * flow, it costs the column nothing at any viewport height. The phone keeps it in
 * flow: its dock is bottom-anchored in a fixed-height column and measured 0px of
 * movement in every configuration, so there is nothing to take it out of.
 *
 * The overlay therefore needs an opaque ground from the caller (it covers a
 * braindump row) — the surface it would otherwise be sitting on.
 */
export function UndoStrip({ className }: { className?: string }) {
  const entry = useUndoStripStore((s) => s.entry);
  const dismiss = useUndoStripStore((s) => s.dismiss);

  if (!entry) return null;

  return (
    <div
      data-testid="undo-strip"
      data-undo-id={entry.id}
      className={cn('relative flex items-center overflow-hidden rounded-[6px]', className)}
    >
      <div className="flex h-[26px] min-w-0 flex-1 items-center gap-2 px-2">
        <Undo2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <TypewriterText
          revealKey={entry.id}
          className="min-w-0 flex-1 font-num text-xs tracking-[0.04em] text-foreground"
        >
          {entry.label}
          {entry.receipt && (
            <span className="text-muted-foreground"> — {entry.receipt}</span>
          )}
        </TypewriterText>
      </div>
      <button
        type="button"
        onClick={() => {
          // Read fresh at click time: between the row appearing and the press,
          // the stack can have moved under it.
          const state = usePlannerStore.getState();
          if (state.canUndo) state.undo();
          dismiss(entry.id);
        }}
        /* No `title` here on purpose. tests/e2e/undo-redo.spec.ts addresses the
           history control as getByTitle('Undo'), and Playwright matches a title
           by substring — a tooltip on this button would put a second, transient
           match in front of it. The visible word is the accessible name. */
        className="hover-wash flex h-[26px] flex-shrink-0 items-center rounded-[6px] px-2 font-num text-xs tracking-[0.04em] text-foreground"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={() => dismiss(entry.id)}
        aria-label="Dismiss"
        className="hover-wash flex h-[26px] w-6 flex-shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>

      {/* Keyed on the entry so a replacement row restarts the drain rather than
          inheriting however much of the previous one's clock was left. */}
      <span
        key={entry.id}
        aria-hidden
        data-testid="undo-expiry"
        className={cn('notice-expiry absolute bottom-0 left-0 h-px bg-success-text')}
        style={{ animationDuration: `${entry.durationMs}ms` }}
      />
    </div>
  );
}

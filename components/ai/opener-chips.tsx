'use client';

import type { ChatOpener } from '@/lib/ai-openers';
import { ChipLabel, quietChip } from '@/components/ai/quiet-chip';
import { cn } from '@/lib/utils';

/**
 * Something to say instead of a blank box: the chips over Ask home's box (two)
 * and, later, a new chat's empty state (three and "Help me start…"). Which
 * chips, and why they are not a static list, is lib/ai-openers.ts; what a tap
 * does is the surface's (`onPick`), since a send from Ask home starts a new
 * conversation and a prefill fills whichever box is on screen.
 *
 * Drawn as quiet chips (components/ai/quiet-chip.tsx), the same chip as the
 * item box's asks.
 *
 * Keeps `data-testid="chat-openers"`, the old chat's, so every query for the
 * chips finds them wherever they render.
 */
export function OpenerChips({
  openers,
  onPick,
  className,
}: {
  openers: readonly ChatOpener[];
  onPick: (opener: ChatOpener) => void;
  className?: string;
}) {
  if (openers.length === 0) return null;
  return (
    <div data-testid="chat-openers" className={cn('flex flex-wrap gap-0.5', className)}>
      {openers.map((opener) => (
        <button
          key={opener.id}
          type="button"
          data-opener={opener.id}
          onClick={() => onPick(opener)}
          className={quietChip}
        >
          <ChipLabel>{opener.label}</ChipLabel>
        </button>
      ))}
    </div>
  );
}

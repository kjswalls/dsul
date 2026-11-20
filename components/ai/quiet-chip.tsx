'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * THE QUIET CHIP: a suggestion, not a button (Kirby, 2026-11-15). Muted ink,
 * no border, no fill and no colour at rest; under the pointer, an open menu or
 * keyboard focus the words go to full ink and take a thin dashed underline.
 * The chips over the item's box (components/planner/item-box-asks.tsx) and
 * over Ask's box (components/ai/opener-chips.tsx) are both this one chip, so
 * they never drift apart. The lit rim stays the Ask key's.
 */
export const quietChip = cn(
  'group/chip text-muted-foreground inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors',
  'hover:text-foreground data-[state=open]:text-foreground focus-visible:text-foreground focus-visible:outline-none',
  'disabled:opacity-50'
);

/** The chip's words: the underline is drawn on them alone, so an icon or a chevron stays clean. */
export function ChipLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        'underline decoration-transparent decoration-dashed decoration-1 underline-offset-4 transition-[text-decoration-color]',
        'group-hover/chip:decoration-current group-focus-visible/chip:decoration-current group-data-[state=open]/chip:decoration-current',
        'group-disabled/chip:decoration-transparent'
      )}
    >
      {children}
    </span>
  );
}

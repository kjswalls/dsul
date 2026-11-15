'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

type AddIconButtonSize = 'sm' | 'md' | 'lg' | 'input';

/**
 * Box footprint per size — sm 14 / md 16 / lg 18px. `md` is the mockup default
 * (Figma node 62:38 is a 16px box). `input` is the h-9 (36px) form-row variant:
 * it matches an adjacent Input / IconPicker, switches to rounded-md so it frames
 * the field symmetrically, and drops back to a 1px border to match those fields.
 */
const BOX: Record<AddIconButtonSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-[18px] w-[18px]',
  input: 'h-9 w-9 rounded-md border',
};

/** Plus glyph ≈ ⅔ of the box (8 / 10 / 12 / 16px). */
const ICON: Record<AddIconButtonSize, string> = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
  input: 'h-4 w-4',
};

interface AddIconButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  /** Box footprint. sm=14 / md=16 (default) / lg=18px / input=36px form-row. */
  size?: AddIconButtonSize;
  /** Override the Plus glyph size (rare). */
  iconClassName?: string;
}

/**
 * Standalone "add" affordance: a rounded-square box (r5, 1px hairline on the
 * raised card fill) wrapping a Plus glyph — the boxed-plus from the
 * Figma redesign (node 62:38, a 16px box). Shared so every icon-only add button
 * reads identically across buckets, the sidebar Braindump, and dialogs. Settles
 * to full contrast (border + glyph + subtle wash) on hover. Use `size="input"`
 * for the confirm-add button beside a form field so it matches the row height
 * (and its lighter 1px border). Inline "+ label" text buttons keep their bare
 * plus; this is for icon-only.
 */
export function AddIconButton({
  size = 'md',
  iconClassName,
  className,
  type = 'button',
  ...props
}: AddIconButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        // The light box (the quick-add round, 2026-11-15): a 1px hairline on the
        // raised card, the plus muted until hovered. The quick-add rows draw
        // the same box (components/primitives/quick-add-row.tsx QuickAddBox).
        'flex flex-shrink-0 items-center justify-center rounded-[5px] border border-border bg-card text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        BOX[size],
        className
      )}
      {...props}
    >
      <Plus className={cn(ICON[size], iconClassName)} />
    </button>
  );
}

'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The quick-add row, one look for every list that ends in one: the braindump's
 * foot, the planner's "Add to …" rows, Organize's sections and an item's
 * subtasks (the quick-add round, Kirby's pick "Draft row", 2026-11-15).
 *
 * At rest it is a boxed + and a muted line of words, with the row hover wash.
 * Focused, it becomes the row you are about to make: a raised white (card)
 * row with a hairline, and the + box turns into an empty checkbox. The accent
 * lives only in the caret. Everything here is CSS off `:focus-within`, so a
 * surface keeps its own state and its own keys.
 *
 * The keys every row answers the same way (each surface wires them):
 *   ↵      add, and stay in the field for the next one
 *   ⇧↵     add, then open it with all the details (where a row has details)
 *   esc    clear what is typed; on an empty field, leave it
 *   paste  a pasted list adds every line (or opens the bulk add, which shows
 *          the split first, where that is the surface's way)
 */

/** The field's own look. Each call site adds its padding (`-mx-1 px-1`, which
 *  tests/unit/caret-room.test.ts reads there) and its type size. */
export const QUICK_ADD_INPUT =
  'min-w-0 flex-1 bg-transparent text-foreground caret-[var(--success-text)] outline-none placeholder:text-muted-foreground';

export const QuickAddRow = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function QuickAddRow(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      data-quick-add=""
      className={cn(
        'group/qa flex items-center gap-2.5 rounded-md transition-[background-color,box-shadow] duration-150 hover:bg-accent',
        // The draft: raised, with the field's ink hairline held faint.
        'focus-within:bg-card focus-within:shadow-[0_0_0_1px_var(--border),0_2px_8px_oklch(0_0_0/6%)] focus-within:hover:bg-card',
        className
      )}
      {...props}
    />
  );
});

/**
 * The boxed + at the row's start, and the empty checkbox it turns into while
 * the row is a draft. Still a button in both looks: a click adds with all the
 * details (or opens them), the same as ⇧↵.
 */
export function QuickAddBox({ className, ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      // Keep the caret in the field when the box is pressed mid-draft.
      onPointerDown={(e) => e.preventDefault()}
      className={cn(
        'group/qabox relative -ml-px grid size-[18px] shrink-0 place-items-center rounded-[5px] text-muted-foreground',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
      {...props}
    >
      {/* At rest: the light box from the mocks. */}
      <span
        aria-hidden
        className="border-border bg-card group-hover/qabox:border-muted-foreground/50 group-hover/qabox:text-foreground absolute inset-0 grid place-items-center rounded-[5px] border transition-colors group-focus-within/qa:hidden"
      >
        <Plus className="size-3" />
      </span>
      {/* Drafting: the checkbox the new row will have. */}
      <span
        aria-hidden
        className="inset-ring-muted-foreground/45 hidden size-4 rounded-[5px] inset-ring group-focus-within/qa:block"
      />
    </button>
  );
}

/** The ↵ at the row's end once something is typed: a key you can also click. */
export function QuickAddEnter({
  className,
  label = 'Add',
  ...props
}: ComponentPropsWithoutRef<'button'> & { label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (↵)`}
      onPointerDown={(e) => e.preventDefault()}
      className={cn(
        'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 shrink-0 rounded-xs border px-1 font-mono text-[10px] leading-4 transition-colors',
        className
      )}
      {...props}
    >
      ↵
    </button>
  );
}

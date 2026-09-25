'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ACCENT_RAMP } from '@/lib/accent-colors';
import { cn } from '@/lib/utils';

/**
 * Accent-ramp color picker for user categories (projects, habit groups, custom
 * item types). The choices are the eight --accent-N theme tokens, stored as
 * var() strings so a picked color re-tunes per theme exactly like a derived
 * one — plus Auto, which clears the stored color back to the name-hash default.
 *
 * The trigger is the identity square from the item dialog's chip vocabulary
 * (square = identity, dot = value), sized up to a tap target.
 */

/** Display names for --accent-1..8, from the ramp comments in globals.css. */
export const ACCENT_NAMES = ['Moss', 'Teal', 'Indigo', 'Plum', 'Coral', 'Honey', 'Slate', 'Lime'];

interface ColorSwatchPickerProps {
  /** Stored color (a var(--accent-N) token, or legacy free text). Unset = Auto. */
  value?: string;
  /** What Auto resolves to today, so the trigger square is never empty. */
  fallback: string;
  /** `undefined` = Auto — clear the stored color. */
  onSelect: (color: string | undefined) => void;
  className?: string;
  'aria-label'?: string;
}

export function ColorSwatchPicker({
  value,
  fallback,
  onSelect,
  className,
  'aria-label': ariaLabel,
}: ColorSwatchPickerProps) {
  const [open, setOpen] = useState(false);

  const pick = (color: string | undefined) => {
    onSelect(color);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7 flex-shrink-0', className)}
          aria-label={ariaLabel ?? 'Choose color'}
        >
          <span
            className="size-[11px] rounded-[3.5px]"
            style={{ background: value || fallback }}
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="end">
        <ColorSwatchGrid value={value} onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

/** The palette row itself — eight ramp swatches and Auto — for a picker that
 *  brings its own trigger (the organizer ColorChip). `undefined` = Auto. */
export function ColorSwatchGrid({
  value,
  onPick,
}: {
  value?: string;
  onPick: (color: string | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {ACCENT_RAMP.map((color, i) => (
        <button
          key={color}
          type="button"
          title={ACCENT_NAMES[i]}
          aria-label={ACCENT_NAMES[i]}
          onClick={() => onPick(color)}
          className={cn(
            'flex size-7 items-center justify-center rounded-md hover:bg-accent',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            value === color && 'bg-secondary ring-1 ring-primary'
          )}
        >
          <span className="size-[13px] rounded-[4px]" style={{ background: color }} aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPick(undefined)}
        className={cn(
          'ml-1 h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          !value && 'bg-secondary font-medium text-foreground'
        )}
      >
        Auto
      </button>
    </div>
  );
}

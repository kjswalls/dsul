'use client';

import { useRef } from 'react';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { RowControl } from '@/components/primitives/row-control';
import { parseDay } from '@/lib/collections';

/**
 * "Put it on a day I choose" — the open-ended sibling of the next-day carry: a
 * RowControl that opens a calendar. One component for every surface that
 * offers it (day rows, schedule blocks, braindump rows, console member rows),
 * so the picker can't drift between them. WHICH items may take it is the
 * `canReschedule` (lib/row-moves.ts): the next-day verb's gate with the day left
 * open, plus recurring tasks; callers ask that, this only renders.
 *
 * Controlled, because every host reveals its controls on hover: the host keeps
 * the capsule pinned visible while `open`, or the trigger would fade out from
 * under the calendar the moment the pointer moves onto it.
 *
 * The calendar portals out, but React events still bubble through the portal
 * to the host — every host already swallows click/pointerdown on its control
 * capsule (so a click in the calendar can't open the editor or start a drag).
 */
export function RescheduleControl({
  open,
  onOpenChange,
  value,
  todayStr,
  onPick,
  label = value ? 'Reschedule' : 'Schedule',
  testId,
  popoverTestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item's current day (YYYY-MM-DD), selected in the calendar. */
  value?: string;
  /** Where the calendar opens when there is no `value`. Passed in rather than
   *  read here: every row would otherwise subscribe to the store for it. */
  todayStr: string;
  onPick: (dateStr: string) => void;
  label?: string;
  testId?: string;
  popoverTestId?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} className="flex">
          <RowControl icon={CalendarDays} label={label} testId={testId} onClick={() => onOpenChange(!open)} />
        </span>
      </PopoverAnchor>
      <PopoverContent
        className="w-auto p-0"
        align="end"
        data-testid={popoverTestId}
        // A press on the control itself is its own toggle; without this the
        // outside-press closes the calendar and the click then reopens it.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <Calendar
          mode="single"
          selected={parseDay(value)}
          defaultMonth={parseDay(value) ?? parseDay(todayStr)}
          onSelect={(date) => {
            if (!date) return;
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            onPick(`${y}-${m}-${d}`);
            onOpenChange(false);
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

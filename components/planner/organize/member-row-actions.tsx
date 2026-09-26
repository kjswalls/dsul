'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeftToLine,
  CalendarDays,
  Check,
  Maximize2,
  MoreHorizontal,
  Pause,
  Play,
  Redo2,
  SkipForward,
  Trash2,
  Unlink,
} from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RowControl, RowControlDivider, RowControlGroup } from '@/components/primitives/row-control';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useToday, parseDay } from '@/lib/collections';
import { isRecurring } from '@/lib/recurrence';
import { getItemTypeConfig, isPausable, isSkippable, itemTypeName } from '@/lib/item-registry';
import { milestoneItemIds } from '@/lib/goals';
import { toggleRowDone, toggleTaskDone } from '@/lib/item-toggle';
import { toDateStr } from '@/lib/recurrence';
import { isPausedOn } from '@/lib/active';
import {
  canMoveToNextDay,
  canSendToBraindump,
  formatTargetDay,
  nextDayLabel,
  nextDayTarget,
} from '@/lib/row-moves';
import { addDaysStr, weekStartOf, type OccurrenceState } from '@/lib/container-schedule';
import { cn } from '@/lib/utils';
import type { HabitItem, Item, Task } from '@/lib/planner-types';

/**
 * CONTROLS ON A CONSOLE MEMBER ROW (Kirby, 2026-09-26; design boards 4A + 4B).
 *
 * This REVERSES a recorded decision — memory/plans/organize-console.md said
 * "Member rows are addresses, not editors" — at Kirby's request; the plan now
 * records it. What survives of the old rule: nothing here opens the item panel
 * over the console (a second role="dialog" cannot coexist with it), so "Open
 * item" LEAVES for /item/[id] and closes the console on the way.
 *
 * Nothing here decides anything new. Every verb is the planner row's own store
 * action behind the planner row's own gate:
 *  · the put-off verbs (next day, braindump) ask lib/row-moves.ts, which refuses
 *    recurring items (their date is the series anchor), habits, finished work,
 *    in-block tasks and — for the braindump — milestones;
 *  · a tick goes through lib/item-toggle.ts (counted habits step, a skip is a
 *    third state), for TODAY, and only when the item actually occurs today —
 *    ticking a weekday habit on a Saturday would write an off-schedule
 *    completion and bump its streak;
 *  · skip and pause pass today explicitly rather than the planner's browsed day.
 *
 * The bin keeps its old meaning — remove from this container. Delete lives in
 * the ⋯ menu only, behind the registry's own confirm copy, so muscle memory
 * built on the bin never deletes an item.
 */

export interface MemberActionOptions {
  /** "Mornings" — for "Remove from Mornings". */
  ownerName: string;
  /** Absent: this list's members cannot be removed from here (see ItemMemberList.removable). */
  onRemove: (itemId: string) => void;
  removable?: (item: Item) => boolean;
  /** Today's occurrence per item, from the row's week schedule (useWeekDotsFor). */
  todayState: (itemId: string) => OccurrenceState | undefined;
}

export function useMemberActions({ ownerName, onRemove, removable, todayState }: MemberActionOptions) {
  const goals = usePlannerStore((s) => s.goals);
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const milestoneIds = useMemo(() => milestoneItemIds(goals ?? []), [goals]);
  const { todayStr } = useToday();

  return {
    capsule: (item: Item) => (
      <MemberCapsule item={item} todayState={todayState(item.id)} todayStr={todayStr} milestoneIds={milestoneIds} />
    ),
    menu: (item: Item) => (
      <MemberMenu
        item={item}
        ownerName={ownerName}
        onRemove={(removable?.(item) ?? true) ? onRemove : undefined}
        todayState={todayState(item.id)}
        todayStr={todayStr}
        weekStartDay={weekStartDay}
        milestoneIds={milestoneIds}
      />
    ),
  };
}

/* ── what a row may do ──────────────────────────────────────────────────── */

interface Verbs {
  tick?: { label: string; run: () => void };
  skip?: () => void;
  pause?: () => void;
  resume?: () => void;
  nextDay?: { label: string; detail: string; run: () => void };
  reschedule?: (dateStr: string) => void;
  braindump?: () => void;
  remove: () => void;
  del: () => void;
}

function useVerbs(
  item: Item,
  todayState: OccurrenceState | undefined,
  todayStr: string,
  milestoneIds: ReadonlySet<string>,
  onRemove?: (id: string) => void,
): Verbs {
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
  const toggleHabitStatus = usePlannerStore((s) => s.toggleHabitStatus);
  const setItemSkipped = usePlannerStore((s) => s.setItemSkipped);
  const setItemPaused = usePlannerStore((s) => s.setItemPaused);
  const moveTaskToDate = usePlannerStore((s) => s.moveTaskToDate);
  const unscheduleTask = usePlannerStore((s) => s.unscheduleTask);
  const deleteTask = usePlannerStore((s) => s.deleteTask);
  const deleteHabit = usePlannerStore((s) => s.deleteHabit);
  const confirm = useUIStore((s) => s.confirm);

  const isHabit = item.type === 'habit';
  const itemType = isHabit ? 'habit' : 'task';
  const recurring = isRecurring(item as { repeatFrequency?: string });
  const config = getItemTypeConfig(itemTypeName(item));
  const status = (item as { status?: string }).status;
  const startDate = (item as { startDate?: string }).startDate;
  // Built at CLICK time, not render time: a console left open past midnight
  // must write to the day it now is. The store resolves the instant in the
  // user's zone; the string is resolved the same way here.
  const tz = usePlannerStore.getState().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = () => {
    const date = new Date();
    return { date, dateStr: toDateStr(date, tz) };
  };
  const actions = { toggleTaskStatus, toggleHabitStatus };
  // Whether a recurring row may be ticked or skipped was decided for the day
  // this rendered on. Past midnight that answer is stale (nothing re-renders
  // the console on the hour), so a per-day write waits for a fresh look rather
  // than landing on a day nobody was shown.
  const sameDay = (run: () => void) => () => {
    if (now().dateStr !== todayStr) {
      toast("It's a new day — close and reopen this list to see today's.");
      return;
    }
    run();
  };

  const verbs: Verbs = {
    remove: () => onRemove?.(item.id),
    del: () =>
      confirm({
        title: `Delete ${config.label}?`,
        description: config.form.deleteDescription(item.title),
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: () => (isHabit ? deleteHabit(item.id) : deleteTask(item.id)),
      }),
  };

  if (recurring) {
    // Only on a day it actually occurs — the week schedule's own answer.
    if (todayState !== undefined) {
      if (todayState === 'skipped') {
        // The planner row's Unskip, NOT a tick: ticking a skipped day wrote
        // skipped-AND-completed on a task and a count step on a counted habit
        // (lib/item-toggle.ts toggleRowDone refuses it for that reason).
        verbs.tick = { label: 'Unskip today', run: sameDay(() => setItemSkipped(item.id, false, now().date)) };
      } else {
        const target = isHabit ? ((item as HabitItem).timesPerDay ?? 1) : 1;
        const count = isHabit ? ((item as HabitItem).dailyCounts ?? {})[todayStr] ?? 0 : 0;
        verbs.tick = {
          // A counted habit steps one at a time, as its row's checkbox does.
          label:
            todayState === 'done'
              ? 'Undo today'
              : target > 1
                ? `Count one (${count}/${target})`
                : 'Done today',
          run: sameDay(() =>
            toggleRowDone(
              isHabit
                ? { itemType: 'habit', item: item as HabitItem }
                : { itemType: 'task', item: item as Task },
              now(),
              actions
            )
          ),
        };
      }
    }
    // The registry's own gates — the ones the store would enforce silently.
    if (todayState === 'due' && isSkippable(item)) {
      verbs.skip = sameDay(() => setItemSkipped(item.id, true, now().date));
    }
    if (isPausable(item)) {
      // A paused item drops out of the week, so its row still needs a way back.
      if (isPausedOn(item, todayStr, tz)) verbs.resume = () => setItemPaused(item.id, false);
      else verbs.pause = () => setItemPaused(item.id, true);
    }
  } else if (status !== 'cancelled') {
    verbs.tick = {
      label: status === config.doneStatus ? 'Mark not done' : 'Mark done',
      run: () => toggleTaskDone(item as Task, now(), actions),
    };
  }

  if (!recurring && itemType === 'task') {
    const rowDate = startDate ?? todayStr;
    if (startDate && canMoveToNextDay(item, 'task', rowDate)) {
      const target = nextDayTarget(rowDate, todayStr);
      verbs.nextDay = {
        label: nextDayLabel(target, todayStr),
        detail: formatTargetDay(target),
        run: () => moveTaskToDate(item.id, target),
      };
    }
    // Rescheduling is the next-day verb's gate with the day left open.
    if (canMoveToNextDay(item, 'task', rowDate)) {
      verbs.reschedule = (dateStr) => moveTaskToDate(item.id, dateStr);
    }
    if (startDate && canSendToBraindump(item, 'task', rowDate, milestoneIds)) {
      verbs.braindump = () => unscheduleTask(item.id);
    }
  }
  return verbs;
}

/* ── desktop: the hover capsule ─────────────────────────────────────────── */

function MemberCapsule({
  item,
  todayState,
  todayStr,
  milestoneIds,
}: {
  item: Item;
  todayState: OccurrenceState | undefined;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
}) {
  const v = useVerbs(item, todayState, todayStr, milestoneIds);
  const [picking, setPicking] = useState(false);
  const any = v.tick || v.skip || v.pause || v.resume || v.nextDay || v.reschedule || v.braindump;
  if (!any) return null;
  return (
    // Over the meta column, never reserving space; shown on hover or focus
    // above md only (below it the ⋯ menu carries everything).
    <span
      className={cn(
        'pointer-events-none absolute top-1/2 right-[110px] hidden -translate-y-1/2 opacity-0 transition-opacity md:flex',
        'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        picking && 'pointer-events-auto opacity-100'
      )}
      data-testid="member-capsule"
    >
      <RowControlGroup>
        {v.tick && <RowControl icon={Check} label={v.tick.label} testId="member-tick" onClick={v.tick.run} />}
        {v.skip && <RowControl icon={SkipForward} label="Skip today" testId="member-skip" onClick={v.skip} />}
        {v.pause && <RowControl icon={Pause} label="Pause" testId="member-pause" onClick={v.pause} />}
        {v.resume && <RowControl icon={Play} label="Resume" testId="member-resume" onClick={v.resume} />}
        {v.nextDay && (
          <RowControl
            icon={Redo2}
            label={v.nextDay.label}
            detail={v.nextDay.detail}
            testId="member-next-day"
            onClick={v.nextDay.run}
          />
        )}
        {v.reschedule && (
          <ReschedulePopover
            open={picking}
            onOpenChange={setPicking}
            value={(item as { startDate?: string }).startDate}
            onPick={v.reschedule}
          >
            <button
              type="button"
              aria-label="Reschedule"
              data-testid="member-reschedule"
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-5 w-5 items-center justify-center rounded-[4px]"
            >
              <CalendarDays className="h-3 w-3" strokeWidth={2.25} />
            </button>
          </ReschedulePopover>
        )}
        {v.braindump && (
          <>
            <RowControlDivider />
            <RowControl icon={ArrowLeftToLine} label="Move to Braindump" testId="member-braindump" onClick={v.braindump} />
          </>
        )}
      </RowControlGroup>
    </span>
  );
}

function ReschedulePopover({
  open,
  onOpenChange,
  value,
  onPick,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: string;
  onPick: (dateStr: string) => void;
  children: ReactNode;
}) {
  const { todayStr } = useToday();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end" data-testid="member-reschedule-popover">
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

/* ── everywhere: the ⋯ menu ─────────────────────────────────────────────── */

function MemberMenu({
  item,
  ownerName,
  onRemove,
  todayState,
  todayStr,
  weekStartDay,
  milestoneIds,
}: {
  item: Item;
  ownerName: string;
  onRemove?: (id: string) => void;
  todayState: OccurrenceState | undefined;
  todayStr: string;
  weekStartDay: 'sunday' | 'monday' | 'saturday';
  milestoneIds: ReadonlySet<string>;
}) {
  const v = useVerbs(item, todayState, todayStr, milestoneIds, onRemove);
  const nextWeek = addDaysStr(weekStartOf(todayStr, weekStartDay), 7);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${item.title}`}
          data-testid="member-menu"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-6 w-6 items-center justify-center rounded-[4px]"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" data-testid="member-menu-content">
        {v.tick && (
          <DropdownMenuItem onSelect={v.tick.run} data-testid="member-menu-tick">
            <Check className="size-3.5" />
            {v.tick.label}
          </DropdownMenuItem>
        )}
        {v.skip && (
          <DropdownMenuItem onSelect={v.skip} data-testid="member-menu-skip">
            <SkipForward className="size-3.5" />
            Skip today
          </DropdownMenuItem>
        )}
        {v.reschedule && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="member-menu-reschedule">
              <CalendarDays className="size-3.5" />
              {(item as { startDate?: string }).startDate ? 'Reschedule' : 'Schedule'}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="p-0">
              <div className="p-1">
                <DropdownMenuItem onSelect={() => v.reschedule!(todayStr)}>Today</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => v.reschedule!(addDaysStr(todayStr, 1))}>Tomorrow</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => v.reschedule!(nextWeek)}>Next week</DropdownMenuItem>
              </div>
              <DropdownMenuSeparator className="my-0" />
              {/* The menu claims ArrowLeft (closes the submenu) and Tab (cancelled)
                  anywhere inside it, which would make the grid unusable from the
                  keyboard. Keep those keys for the calendar; Escape still closes. */}
              <div
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') e.stopPropagation();
                }}
              >
              <Calendar
                mode="single"
                selected={parseDay((item as { startDate?: string }).startDate)}
                defaultMonth={parseDay((item as { startDate?: string }).startDate) ?? parseDay(todayStr)}
                onSelect={(date) => {
                  if (!date) return;
                  const y = date.getFullYear();
                  const m = String(date.getMonth() + 1).padStart(2, '0');
                  const d = String(date.getDate()).padStart(2, '0');
                  v.reschedule!(`${y}-${m}-${d}`);
                  setOpen(false);
                }}
              />
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {v.nextDay && (
          <DropdownMenuItem onSelect={v.nextDay.run} data-testid="member-menu-next-day">
            <Redo2 className="size-3.5" />
            {v.nextDay.label}
            <span className="text-muted-foreground ml-auto text-xs">{v.nextDay.detail}</span>
          </DropdownMenuItem>
        )}
        {v.braindump && (
          <DropdownMenuItem onSelect={v.braindump} data-testid="member-menu-braindump">
            <ArrowLeftToLine className="size-3.5" />
            Move to Braindump
          </DropdownMenuItem>
        )}
        {v.pause && (
          <DropdownMenuItem onSelect={v.pause} data-testid="member-menu-pause">
            <Pause className="size-3.5" />
            Pause
          </DropdownMenuItem>
        )}
        {v.resume && (
          <DropdownMenuItem onSelect={v.resume} data-testid="member-menu-resume">
            <Play className="size-3.5" />
            Resume
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* LEAVES the console: the item panel cannot sit over it. onNavigate,
              not onClick, so a ⌘-click to a new tab keeps this one open. */}
          <Link
            href={`/item/${item.id}`}
            onNavigate={() => useUIStore.getState().closeDialog()}
            data-testid="member-menu-open"
          >
            <Maximize2 className="size-3.5" />
            Open item
          </Link>
        </DropdownMenuItem>
        {onRemove && (
          <DropdownMenuItem onSelect={v.remove} data-testid="member-menu-remove">
            <Unlink className="size-3.5" />
            Remove from {ownerName}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={v.del} variant="destructive" data-testid="member-menu-delete">
          <Trash2 className="size-3.5" />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

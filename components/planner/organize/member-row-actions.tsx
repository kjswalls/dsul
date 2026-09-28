'use client';

import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
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
import { milestoneItemIds } from '@/lib/goals';
import { toDateStr } from '@/lib/recurrence';
import { ITEM_VERBS, type VerbContext, type VerbId } from '@/lib/item-verbs';
import { addDaysStr, weekStartOf, type OccurrenceState } from '@/lib/container-schedule';
import { ItemContextMenu, ItemMenuRow } from '@/components/planner/item-context-menu';
import { cn } from '@/lib/utils';
import type { Item } from '@/lib/planner-types';

/**
 * CONTROLS ON A CONSOLE MEMBER ROW (Kirby, 2026-09-26; design boards 4A + 4B).
 *
 * This REVERSES a recorded decision — memory/plans/organize-console.md said
 * "Member rows are addresses, not editors" — at Kirby's request; the plan now
 * records it. What survives of the old rule: nothing here opens the item panel
 * over the console (a second role="dialog" cannot coexist with it), so "Open
 * item" LEAVES for /item/[id] and closes the console on the way.
 *
 * Nothing here decides anything new. Every verb is a shared declaration from
 * lib/item-verbs.ts — the planner row's own store action behind the planner
 * row's own gate:
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
    // The right-click menu, acting on TODAY as the rest of the row does, with
    // the week schedule's answer for whether the item falls on it. "Open item"
    // leaves for the page: the item panel cannot sit over the console.
    contextMenu: (item: Item, row: ReactElement) => {
      const canRemove = removable?.(item) ?? true;
      return (
        <ItemContextMenu
          item={item}
          date="today"
          occurrence={todayState(item.id) ?? 'absent'}
          openHref
          extra={
            canRemove ? (
              <ItemMenuRow
                icon={<Unlink className="size-3.5" />}
                label={`Remove from ${ownerName}`}
                testId="item-menu-remove"
                onSelect={() => onRemove(item.id)}
              />
            ) : undefined
          }
        >
          {row}
        </ItemContextMenu>
      );
    },
  };
}

/* ── what a row may do ──────────────────────────────────────────────────── */

export interface Verbs {
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

/**
 * The row's verbs, from the shared declarations (lib/item-verbs.ts) acting on
 * TODAY. Exported for the routine's Today checklist
 * (components/planner/routine-today.tsx), which ticks and skips the same
 * members for the same day and must not grow a second copy of these gates.
 */
export function useVerbs(
  item: Item,
  todayState: OccurrenceState | undefined,
  todayStr: string,
  milestoneIds: ReadonlySet<string>,
  onRemove?: (id: string) => void,
): Verbs {
  // Selected so a change of zone re-renders; read again at click time below.
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // `todayState` comes from the row's week schedule, which knows whether the
  // item falls on today at all; undefined there means it does not.
  const occurrence = todayState ?? 'absent';
  const ctx: VerbContext = { dateStr: todayStr, date: new Date(), todayStr, tz, milestoneIds, occurrence };
  // Built at CLICK time, not render time: a console left open past midnight
  // must write to the day it now is. The store resolves the instant in the
  // user's zone; the string is resolved the same way here.
  const now = (): VerbContext => {
    const zone = usePlannerStore.getState().userTimezone ?? tz;
    const date = new Date();
    return { ...ctx, date, tz: zone, dateStr: toDateStr(date, zone) };
  };
  // Whether a per-day verb may run was decided for the day this rendered on.
  // Past midnight that answer is stale (nothing re-renders the console on the
  // hour), so a per-day write waits for a fresh look rather than landing on a
  // day nobody was shown.
  const sameDay = (run: () => void) => () => {
    if (now().dateStr !== todayStr) {
      toast("It's a new day — close and reopen this list to see today's.");
      return;
    }
    run();
  };
  const can = (id: VerbId) => ITEM_VERBS[id].eligible(item, ctx);
  const perDay = (id: VerbId) => sameDay(() => ITEM_VERBS[id].run(item, now()));
  const anyDay = (id: VerbId) => () => ITEM_VERBS[id].run(item, ctx);

  const verbs: Verbs = { remove: () => onRemove?.(item.id), del: anyDay('delete') };
  // One checkbox, three meanings: a skipped day's box undoes the skip.
  if (can('unskip')) verbs.tick = { label: ITEM_VERBS.unskip.label(item, ctx), run: perDay('unskip') };
  else if (can('tick')) verbs.tick = { label: ITEM_VERBS.tick.label(item, ctx), run: perDay('tick') };
  if (can('skip')) verbs.skip = perDay('skip');
  // A paused item drops out of the week, so its row still needs a way back.
  if (can('resume')) verbs.resume = anyDay('resume');
  else if (can('pause')) verbs.pause = anyDay('pause');
  if (can('nextDay')) {
    verbs.nextDay = {
      label: ITEM_VERBS.nextDay.label(item, ctx),
      detail: ITEM_VERBS.nextDay.detail!(item, ctx)!,
      run: anyDay('nextDay'),
    };
  }
  if (can('reschedule')) verbs.reschedule = (dateStr) => ITEM_VERBS.reschedule.run(item, ctx, dateStr);
  if (can('braindump')) verbs.braindump = anyDay('braindump');
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

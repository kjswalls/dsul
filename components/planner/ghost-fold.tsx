'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftToLine, CalendarDays, ChevronDown, MoreHorizontal, Plus, Redo2, X } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { useMorningStore } from '@/lib/morning-store';
import { useOverdueInputs } from '@/hooks/use-overdue-today';
import { useIsMobile } from '@/hooks/use-mobile';
import { addDaysToDateStr, milestoneItemIds } from '@/lib/goals';
import { ghostFoldStartsCollapsed, ghostWeekday, selectGhostRows } from '@/lib/ghost-rows';
import { toDateOnly } from '@/lib/overdue';
import { canMoveToNextDay, canReschedule, canSendToBraindump, formatTargetDay } from '@/lib/row-moves';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { openEditFor } from '@/lib/ui-store';
import { parseDay } from '@/lib/collections';
import { RowControl, RowControlGroup } from '@/components/primitives/row-control';
import { RescheduleControl } from '@/components/primitives/reschedule-control';
import { MetaText, PriorityGlyph, TagDot, formatDuration } from '@/components/primitives/pills';
import { BUCKET_LABEL_INK } from '@/components/primitives/bucket-card';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Drawer, DrawerClose, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import type { Task, TaskItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Ghost rows: what was left undone on an earlier day, folded at the very top of
 * today until the person says what happens to each one
 * (memory/plans/ghost-rows.md).
 *
 * A VIEW, never a write. The rows are `selectGhostRows` (lib/ghost-rows.ts, over
 * the one past-due predicate) recomputed from the store on every render, and
 * nothing is written until a verb is picked. Every verb is an existing store
 * action, so each one lands in the undo history and raises the undo strip
 * (hooks/use-undo-toast.ts matches their labels: "Move task to", "Move all
 * tasks", "Unschedule task:", "Let go:").
 *
 * Drawn with TaskRow's own geometry and rails (16px box column, title, the
 * start-time slot, tag / priority / duration), so the only new thing on screen
 * is the caption. The motion (arrive, breathe) and the dashed box are in
 * app/globals.css beside the row rules.
 *
 * Shown only on today, in the Day views, while the account's leftovers switch is
 * on (`morning_check_enabled`, relabelled "Leftovers on Today"), and only once
 * the planner has loaded: a pile counted from the preview's cached rows, or a
 * failed load's empty store, is not the pile.
 */
export function GhostFold({ dateStr }: { dateStr: string }) {
  const enabled = useMorningStore((s) => s.morningCheckEnabled);
  const loaded = usePlannerLoaded();
  const goals = usePlannerStore((s) => s.goals);
  const { items, todayStr, inactiveIds } = useOverdueInputs();

  // Asked only when the fold can show: every day view mounts this, and the
  // predicate walks every item.
  const shown = enabled && loaded && dateStr === todayStr;
  const ghosts = useMemo(
    () => (shown ? selectGhostRows(items, todayStr, inactiveIds, milestoneItemIds(goals ?? [])) : []),
    [shown, items, todayStr, inactiveIds, goals]
  );

  if (!shown) return null;
  return <GhostFoldBody ghosts={ghosts} todayStr={todayStr} />;
}

/** How long "All sorted, you got this" stays after the last ghost is handled. */
export const GHOST_DONE_MS = 4000;

/** May this ghost be let go? The store's own test (letGoItems), asked first so the control never no-ops. */
function canLetGo(item: TaskItem): boolean {
  return getItemTypeConfig(itemTypeName(item)).allowedStatuses.includes('cancelled');
}

/**
 * The ghost's own day, as YYYY-MM-DD. Normalised here, once, because the
 * selector admits legacy full-ISO startDates (`items.start_date` is text, and
 * lib/overdue.ts toDateOnly tolerates them), and formatTargetDay, the calendar
 * and the row-move gates all read a bare date: an ISO string there throws
 * (Intl formats an Invalid Date as a RangeError) and takes the Day view down.
 */
const ghostDay = (item: TaskItem) => toDateOnly(item.startDate ?? '');

/** May this ghost be put on today? Reschedule's gate, as the braindump's "Move to today" asks. */
const canKeep = (item: TaskItem) => canReschedule(item, 'task', ghostDay(item));

function GhostFoldBody({ ghosts, todayStr }: { ghosts: TaskItem[]; todayStr: string }) {
  const moveTaskToDate = usePlannerStore((s) => s.moveTaskToDate);
  const moveTasksToDate = usePlannerStore((s) => s.moveTasksToDate);
  const unscheduleTask = usePlannerStore((s) => s.unscheduleTask);
  const unscheduleTasks = usePlannerStore((s) => s.unscheduleTasks);
  const letGoItems = usePlannerStore((s) => s.letGoItems);
  const goals = usePlannerStore((s) => s.goals);
  const isMobile = useIsMobile();

  const count = ghosts.length;
  const tomorrow = addDaysToDateStr(todayStr, 1);
  const milestones = useMemo(() => milestoneItemIds(goals ?? []), [goals]);

  // Collapsed past the pile threshold, decided by the count at FIRST SIGHT: a
  // fold that opened itself when the pile shrank to five would move the day
  // under the pointer. The person's chevron overrides it from then on.
  const [firstCount, setFirstCount] = useState<number | null>(count > 0 ? count : null);
  if (firstCount === null && count > 0) setFirstCount(count);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !ghostFoldStartsCollapsed(firstCount ?? count);

  const [picking, setPicking] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const sheetItem = sheetFor ? (ghosts.find((g) => g.id === sheetFor) ?? null) : null;

  // "All sorted, you got this" for a few seconds once the person handles the
  // last ghost, then nothing. Only a verb run from THIS fold counts: `acted` is
  // set by each one and consumed by the next change of count, so a pile
  // emptied by anything else (the auto-age sweep at landing, another device's
  // edit through catch-up, a paused project, an away period) goes quietly. A
  // day that never had a ghost says nothing at all, and an undo that brings a
  // ghost back takes the line down with it.
  //
  // The same moment is what recipes and mods hear as `review.saved`, the end of
  // day review's event, since the review retired (ghost rows phase 2): once a
  // day, through lib/morning-store.ts noteLeftoversCleared, and only for the
  // person's own verbs, never for a pile something else emptied.
  const [done, setDone] = useState(false);
  // A ghost back (an undo inside the window) ends the line at once.
  if (done && count > 0) setDone(false);
  const prevCount = useRef(count);
  const acted = useRef(false);
  // Read by the effect below without being one of its inputs: a day turning
  // over inside the line's few seconds must not restart (or strand) its timer.
  const today = useRef(todayStr);
  useEffect(() => {
    today.current = todayStr;
  }, [todayStr]);
  const act = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    acted.current = true;
    fn(...args);
  };
  useEffect(() => {
    const was = prevCount.current;
    if (was === count) return;
    prevCount.current = count;
    const byUs = acted.current;
    acted.current = false;
    if (!(was > 0 && count === 0 && byUs)) return;
    useMorningStore.getState().noteLeftoversCleared(usePlannerStore.getState().userId, today.current);
    setDone(true);
    const t = window.setTimeout(() => setDone(false), GHOST_DONE_MS);
    return () => window.clearTimeout(t);
  }, [count]);

  if (count === 0) {
    if (!done) return null;
    return (
      <section data-testid="ghost-fold" data-ghost-fold="done" aria-label="Left over from earlier">
        <p
          role="status"
          data-testid="ghost-fold-done"
          className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
        >
          {/* The one lime mark, at full strength: nothing above it fades. */}
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
          All sorted, you got this
        </p>
      </section>
    );
  }

  const keep = act((t: TaskItem) => moveTaskToDate(t.id, todayStr));
  const toTomorrow = act((t: TaskItem) => moveTaskToDate(t.id, tomorrow));
  const moveTo = act((t: TaskItem, day: string) => moveTaskToDate(t.id, day));
  const toSidebar = act((t: TaskItem) => unscheduleTask(t.id));
  const letGo = act((t: TaskItem) => letGoItems([t.id]));

  // One gesture, one history entry, one undo. moveTasksToDate keeps each item's
  // own bucket and drops stale clock times (its contract); it already refuses
  // milestones and recurring items never ghost. unscheduleTasks is the batched
  // unscheduleTask, under the same "Unschedule task:" label.
  const keepable = ghosts.filter(canKeep);
  const sendable = ghosts.filter((t) => canSendToBraindump(t, 'task', ghostDay(t), milestones));
  const keepAll = act(() => {
    if (keepable.length > 0) moveTasksToDate(keepable.map((t) => t.id), todayStr);
  });
  const sendAll = act(() => {
    if (sendable.length > 0) unscheduleTasks(sendable.map((t) => t.id));
  });

  return (
    <section
      data-testid="ghost-fold"
      data-ghost-fold={open ? 'open' : 'closed'}
      aria-label="Left over from earlier"
      className="mb-5"
    >
      <div className="group/fold flex items-center rounded-[5px] pr-2 hover:bg-accent">
        {/* GroupSection's canvas heading: the same size, ink and chevron. */}
        <button
          type="button"
          onClick={() => setUserOpen(!open)}
          aria-expanded={open}
          data-testid="ghost-fold-toggle"
          className={cn('flex flex-1 items-center gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium', BUCKET_LABEL_INK)}
        >
          <span>From earlier</span>
          <span data-testid="ghost-fold-count" className="tabular-nums text-muted-foreground/70">
            {count}
          </span>
          <ChevronDown className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        </button>
        <span
          className={cn(
            'flex items-center gap-3 text-xs text-muted-foreground transition-opacity',
            // A folded fold keeps them on screen: they are the way through it
            // without opening it. Keyed to `open` itself, not to today's count,
            // so a pile that started folded and shrank to five still shows
            // them. Otherwise caption hover or focus. On touch there is no
            // hover, so they stay.
            !open || isMobile
              ? 'opacity-100'
              : 'opacity-0 group-hover/fold:opacity-100 group-has-[:focus-visible]/fold:opacity-100'
          )}
        >
          {keepable.length > 0 && (
            <button type="button" data-testid="ghost-keep-all" className="hover:text-foreground" onClick={keepAll}>
              Keep all
            </button>
          )}
          {sendable.length > 0 && (
            <button type="button" data-testid="ghost-send-all" className="hover:text-foreground" onClick={sendAll}>
              Send all to sidebar
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="space-y-0">
          {ghosts.map((t, gi) => (
            <GhostRow
              key={t.id}
              item={t}
              index={gi}
              todayStr={todayStr}
              tomorrow={tomorrow}
              milestones={milestones}
              isMobile={isMobile}
              picking={picking === t.id}
              onPickingChange={(o) => setPicking(o ? t.id : null)}
              onKeep={() => keep(t)}
              onTomorrow={() => toTomorrow(t)}
              onMoveTo={(d) => {
                setPicking(null);
                moveTo(t, d);
              }}
              onSidebar={() => toSidebar(t)}
              onLetGo={() => letGo(t)}
              onOpenSheet={() => setSheetFor(t.id)}
            />
          ))}
        </div>
      )}

      {isMobile && (
        <GhostSheet
          item={sheetItem}
          todayStr={todayStr}
          tomorrow={tomorrow}
          milestones={milestones}
          onClose={() => setSheetFor(null)}
          onKeep={keep}
          onTomorrow={toTomorrow}
          onMoveTo={moveTo}
          onSidebar={toSidebar}
          onLetGo={letGo}
        />
      )}
    </section>
  );
}

interface GhostRowProps {
  item: TaskItem;
  index: number;
  todayStr: string;
  tomorrow: string;
  milestones: ReadonlySet<string>;
  isMobile: boolean;
  picking: boolean;
  onPickingChange: (open: boolean) => void;
  onKeep: () => void;
  onTomorrow: () => void;
  onMoveTo: (day: string) => void;
  onSidebar: () => void;
  onLetGo: () => void;
  onOpenSheet: () => void;
}

function GhostRow({
  item: t,
  index,
  todayStr,
  tomorrow,
  milestones,
  isMobile,
  picking,
  onPickingChange,
  onKeep,
  onTomorrow,
  onMoveTo,
  onSidebar,
  onLetGo,
  onOpenSheet,
}: GhostRowProps) {
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const day = ghostDay(t);
  const keepOk = canKeep(t);
  const tomorrowOk = canMoveToNextDay(t, 'task', day);
  const rescheduleOk = canReschedule(t, 'task', day);
  const sidebarOk = canSendToBraindump(t, 'task', day, milestones);
  const letGoOk = canLetGo(t);
  const type = getItemTypeConfig(itemTypeName(t));

  return (
    <div
      data-testid="ghost-row"
      data-ghost-row
      data-item-id={t.id}
      // The stagger for arrive and breathe (app/globals.css); capped so a long
      // pile's last rows do not wait seconds to appear.
      style={{ ['--ghost-i' as string]: Math.min(index, 8) }}
      data-ghost-arrive
      className="group relative flex w-full cursor-default items-center gap-3 rounded-[5px] px-2 py-1.5 hover:bg-accent"
    >
      {/* The box is the keep: a dashed outline, no fill, that closes into a
          solid box with a Plus on hover. Same 16px column as TaskRow's tick. */}
      <button
        type="button"
        aria-label="Keep for today"
        data-testid="ghost-box"
        disabled={!keepOk}
        onClick={onKeep}
        className="ghost-box relative z-10 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] text-muted-foreground"
      >
        {/* No Plus on a box that cannot keep: it would promise a no-op. */}
        {keepOk && (
          <Plus className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.5} />
        )}
      </button>

      {/* Opens the item, as a real row's click does. */}
      <button
        type="button"
        data-testid="ghost-title"
        data-row-title="muted"
        onClick={() => openEditFor(t as unknown as Task, 'task')}
        className="min-w-0 flex-1 cursor-pointer text-left font-content text-content text-muted-foreground transition-colors line-clamp-1 group-hover:text-foreground/80 focus-visible:outline-none"
      >
        {t.title}
      </button>

      <div className="relative flex flex-shrink-0 items-center gap-3">
        {!isMobile && (
          <span
            className={cn(
              'pointer-events-none absolute inset-y-0 right-full mr-2 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100',
              picking && 'pointer-events-auto opacity-100'
            )}
          >
            <RowControlGroup>
              {keepOk && <RowControl icon={Plus} label="Keep for today" testId="ghost-keep" onClick={onKeep} />}
              {tomorrowOk && (
                <RowControl
                  icon={Redo2}
                  label="Move to tomorrow"
                  detail={formatTargetDay(tomorrow)}
                  testId="ghost-tomorrow"
                  onClick={onTomorrow}
                />
              )}
              {rescheduleOk && (
                <RescheduleControl
                  open={picking}
                  onOpenChange={onPickingChange}
                  todayStr={todayStr}
                  value={day}
                  label="Reschedule"
                  onPick={onMoveTo}
                  testId="ghost-reschedule"
                  popoverTestId="ghost-reschedule-popover"
                />
              )}
              {sidebarOk && (
                <RowControl icon={ArrowLeftToLine} label="Send to sidebar" testId="ghost-sidebar" onClick={onSidebar} />
              )}
              {letGoOk && (
                <RowControl icon={X} label="Let it go" detail="Kept in history" testId="ghost-let-go" onClick={onLetGo} />
              )}
            </RowControlGroup>
          </span>
        )}

        {/* Where the start time sits on a real row: the day it was for. */}
        <MetaText
          testId="ghost-day"
          className="hidden w-[44px] text-right text-muted-foreground/70 md:inline"
          tooltip={{ label: 'Planned for', detail: formatTargetDay(day) }}
        >
          {ghostWeekday(day)}
        </MetaText>
        {/* The day-dots column, reserved where TaskRow reserves it. */}
        <span aria-hidden className="hidden w-[59px] flex-shrink-0 lg:@min-[640px]/canvas:block" />
        {t.project ? (
          <TagDot
            name={t.project}
            color={getProjectColor(t.project)}
            label={type.form.containerLabel}
            className="w-1.5 opacity-60 lg:@min-[540px]/canvas:w-24"
            nameClassName="hidden lg:@min-[540px]/canvas:block"
          />
        ) : (
          <span aria-hidden className="w-1.5 flex-shrink-0 lg:@min-[540px]/canvas:w-24" />
        )}
        {/* Muted bars, never faded through opacity: a low priority's bars are
            lime (--priority-low), and the accent is never dimmed by a parent.
            So no lime is drawn in a ghost row at all, and arrive has none to
            composite. */}
        <span className="flex w-9 flex-shrink-0 items-center">
          {t.priority && <PriorityGlyph priority={t.priority} muted />}
        </span>
        <MetaText className="w-12 flex-shrink-0 text-right opacity-60">
          {t.duration ? formatDuration(t.duration) : ''}
        </MetaText>

        {/* Touch: no hover, so the same trailing ellipsis a real row shows. */}
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Actions"
            data-testid="ghost-actions-button"
            onClick={onOpenSheet}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The phone's way to a ghost's verbs: the five as large rows, Keep the ink primary. */
function GhostSheet({
  item,
  todayStr,
  tomorrow,
  milestones,
  onClose,
  onKeep,
  onTomorrow,
  onMoveTo,
  onSidebar,
  onLetGo,
}: {
  item: TaskItem | null;
  todayStr: string;
  tomorrow: string;
  milestones: ReadonlySet<string>;
  onClose: () => void;
  onKeep: (t: TaskItem) => void;
  onTomorrow: (t: TaskItem) => void;
  onMoveTo: (t: TaskItem, day: string) => void;
  onSidebar: (t: TaskItem) => void;
  onLetGo: (t: TaskItem) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  // The last item shown, so the sheet keeps its words while it slides away.
  const [shown, setShown] = useState<TaskItem | null>(item);
  if (item && item !== shown) setShown(item);
  const t = item ?? shown;
  const day = t ? ghostDay(t) : '';

  const run = (fn: (t: TaskItem) => void) => () => {
    if (!t) return;
    fn(t);
    setChoosing(false);
    onClose();
  };

  return (
    <Drawer
      open={!!item}
      onOpenChange={(o) => {
        if (!o) {
          setChoosing(false);
          onClose();
        }
      }}
    >
      <DrawerContent data-testid="ghost-sheet">
        <DrawerHeader>
          <DrawerTitle className="truncate text-left">{t?.title}</DrawerTitle>
          {t && <p className="text-left text-xs text-muted-foreground">Planned for {formatTargetDay(day)}</p>}
        </DrawerHeader>
        {t && choosing ? (
          <div className="flex justify-center px-4">
            <Calendar
              mode="single"
              selected={parseDay(day)}
              defaultMonth={parseDay(todayStr)}
              onSelect={(date) => {
                if (!date) return;
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, '0');
                const d = String(date.getDate()).padStart(2, '0');
                run((x) => onMoveTo(x, `${y}-${m}-${d}`))();
              }}
              initialFocus
            />
          </div>
        ) : (
          t && (
            <DrawerFooter>
              {canKeep(t) && (
                <Button className="h-12 justify-start text-sm" data-testid="ghost-sheet-keep" onClick={run(onKeep)}>
                  <Plus className="mr-2 h-4 w-4" /> Keep for today
                </Button>
              )}
              {canMoveToNextDay(t, 'task', day) && (
                <Button
                  variant="ghost"
                  className="h-12 justify-start text-sm"
                  data-testid="ghost-sheet-tomorrow"
                  onClick={run(onTomorrow)}
                >
                  <Redo2 className="mr-2 h-4 w-4" /> Move to tomorrow
                  <span className="ml-auto text-xs text-muted-foreground">{formatTargetDay(tomorrow)}</span>
                </Button>
              )}
              {canReschedule(t, 'task', day) && (
                <Button
                  variant="ghost"
                  className="h-12 justify-start text-sm"
                  data-testid="ghost-sheet-reschedule"
                  onClick={() => setChoosing(true)}
                >
                  <CalendarDays className="mr-2 h-4 w-4" /> Reschedule
                </Button>
              )}
              {canSendToBraindump(t, 'task', day, milestones) && (
                <Button
                  variant="ghost"
                  className="h-12 justify-start text-sm"
                  data-testid="ghost-sheet-sidebar"
                  onClick={run(onSidebar)}
                >
                  <ArrowLeftToLine className="mr-2 h-4 w-4" /> Send to sidebar
                </Button>
              )}
              {canLetGo(t) && (
                <Button
                  variant="ghost"
                  className="h-12 justify-start text-sm"
                  data-testid="ghost-sheet-let-go"
                  onClick={run(onLetGo)}
                >
                  <X className="mr-2 h-4 w-4" /> Let it go
                  <span className="ml-auto text-xs text-muted-foreground">Kept in history</span>
                </Button>
              )}
              <DrawerClose asChild>
                <Button variant="outline">Cancel</Button>
              </DrawerClose>
            </DrawerFooter>
          )
        )}
      </DrawerContent>
    </Drawer>
  );
}

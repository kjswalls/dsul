'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftToLine, CalendarDays, Check, ChevronDown, MoreHorizontal, Plus, Redo2, X } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { useMorningStore } from '@/lib/morning-store';
import { useOverdueInputs } from '@/hooks/use-overdue-today';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBraindumpArrows } from '@/hooks/use-braindump-arrows';
import { addDaysToDateStr, milestoneItemIds } from '@/lib/goals';
import { ghostFoldStartsCollapsed, ghostWeekday, selectGhostRows } from '@/lib/ghost-rows';
import { toDateOnly } from '@/lib/overdue';
import { canMoveToNextDay, canReschedule, canSendToBraindump, formatTargetDay } from '@/lib/row-moves';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { openEditFor } from '@/lib/ui-store';
import { parseDay } from '@/lib/collections';
import { ItemContextMenu, ItemMenuRow } from '@/components/planner/item-context-menu';
import { RowControl, RowControlGroup } from '@/components/primitives/row-control';
import { RowTitleText } from '@/components/primitives/row-title-text';
import { RescheduleControl } from '@/components/primitives/reschedule-control';
import { MetaText, PriorityGlyph, TagDot, formatDuration } from '@/components/primitives/pills';
import { BUCKET_LABEL_INK } from '@/components/primitives/bucket-card';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Drawer, DrawerClose, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import type { VerbId } from '@/lib/item-verbs';
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
 * is the caption. The motion (arrive) and the dashed box are in
 * app/globals.css beside the row rules; the settle as the pile shrinks is
 * GhostFoldSettle, below.
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

  // The fold stays mounted, empty, while its space closes after the person
  // (or anything else) settles the last ghost; `leaving` is that run. Set in
  // render, off the count's change, so the box is still in the DOM on the
  // commit where the pile hits zero.
  const count = ghosts.length;
  const [prevCount, setPrevCount] = useState(count);
  const [leaving, setLeaving] = useState(false);
  if (prevCount !== count) {
    setPrevCount(count);
    setLeaving(shown && count === 0 && prevCount > 0);
  }

  if (!shown || (count === 0 && !leaving)) return null;
  return (
    <GhostFoldSettle count={count} onGone={() => setLeaving(false)}>
      <GhostFoldBody ghosts={ghosts} todayStr={todayStr} />
    </GhostFoldSettle>
  );
}

/** How long the space a settled ghost (or the whole fold) leaves takes to close. */
export const GHOST_SETTLE_MS = 240;
const SETTLE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Closes the space a settled ghost leaves, so the planner below slides back up
 * rather than jumping. Each time the pile SHRINKS (a verb, catch-up, another
 * device), the box's height is held at what it was and eased to what it is
 * now. The last one going takes the whole fold down to nothing, its heading
 * and the spacing after it included (the box's own margin eases to cancel the
 * view's gap, so nothing jumps when the empty box finally unmounts). Growth
 * (the fold arriving, the chevron opening, an undo bringing a ghost back) is
 * never animated: a fold that crept open would move the day under the pointer,
 * and the rows' own arrive is the motion there.
 *
 * Height on one box, not a FLIP of every row below: everything under the fold
 * moves as one block, so one box carries all of it, and the day's rows, the
 * schedule's hours and Anytime take no part. `overflow: hidden` only while it
 * runs, so a focus ring or a row's hover capsule is never clipped at rest. Off
 * under reduced motion. The box carries the fold's bottom margin (mb-5, which
 * the views' space-y defers to, as it did on the fold itself).
 */
function GhostFoldSettle({ count, children, onGone }: { count: number; children: ReactNode; onGone: () => void }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // The content's height as last laid out, kept by a ResizeObserver (the
  // chevron and the row controls change it without this component rendering).
  const lastHeight = useRef(0);
  const lastCount = useRef(count);
  // Ends the run in flight; `gone` true lets an emptied fold unmount.
  const running = useRef<((gone: boolean) => void) | null>(null);
  const goneRef = useRef(onGone);
  useLayoutEffect(() => {
    goneRef.current = onGone;
  });

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    lastHeight.current = el.offsetHeight;
    // Mounted empty (nothing to close): let it go at once.
    if (count === 0) goneRef.current();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!running.current) lastHeight.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Mount only: count is read once, for the empty-mount backstop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Before paint, after the shrunk rows are in the DOM: the ResizeObserver
  // has not yet heard of the change, so lastHeight is still the old height.
  useLayoutEffect(() => {
    const was = lastCount.current;
    lastCount.current = count;
    const box = outer.current;
    const el = inner.current;
    if (!box || !el || count === was) return;
    if (count > was) {
      // A ghost back mid-run: show it at once.
      running.current?.(false);
      return;
    }
    const to = el.offsetHeight;
    // Mid-run (two verbs in a row), start from where the box is now.
    const from = running.current ? box.getBoundingClientRect().height : lastHeight.current;
    const margin = parseFloat(getComputedStyle(box).marginBottom) || 0;
    running.current?.(false);
    const emptied = count === 0;
    if (from <= to || prefersReducedMotion()) {
      lastHeight.current = to;
      if (emptied) goneRef.current();
      return;
    }
    box.style.overflow = 'hidden';
    box.style.transition = 'none';
    box.style.height = `${from}px`;
    box.style.marginBottom = `${margin}px`;
    // The space between this box and the next one, the view's gap or space-y
    // and this box's margin together: what an emptied fold must also close.
    const next = box.nextElementSibling;
    const space = emptied && next ? next.getBoundingClientRect().top - box.getBoundingClientRect().bottom : 0;
    void box.offsetHeight; // commit the start before easing from it
    box.style.transition = `height ${GHOST_SETTLE_MS}ms ${SETTLE_EASE}, margin-bottom ${GHOST_SETTLE_MS}ms ${SETTLE_EASE}`;
    box.style.height = `${to}px`;
    if (emptied) box.style.marginBottom = `${margin - Math.max(0, space)}px`;
    let timer = 0;
    const finish = (gone: boolean) => {
      window.clearTimeout(timer);
      box.removeEventListener('transitionend', onEnd);
      running.current = null;
      // An emptied fold unmounts as it is, closed, so no frame shows it open.
      if (gone) return goneRef.current();
      box.style.height = '';
      box.style.marginBottom = '';
      box.style.overflow = '';
      box.style.transition = '';
      lastHeight.current = el.offsetHeight;
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === box && e.propertyName === 'height') finish(emptied);
    };
    box.addEventListener('transitionend', onEnd);
    // A backstop for a transitionend that never comes (a hidden tab).
    timer = window.setTimeout(() => finish(emptied), GHOST_SETTLE_MS + 100);
    running.current = finish;
  }, [count]);

  // An unmount mid-run (the day changes) drops the timer and listener.
  useEffect(() => () => running.current?.(false), []);

  return (
    <div ref={outer} data-testid="ghost-fold-settle" className="mb-5">
      {/* flow-root, so nothing inside collapses a margin through the box. */}
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
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

  // Once the person handles the last ghost, the fold goes (and
  // GhostFoldSettle slides the day back up into its space); there is no line
  // after it. Only a verb run from THIS fold counts as the person clearing it:
  // `acted` is set by each one and consumed by the next change of count, so a
  // pile emptied by anything else (the auto-age sweep at landing, another
  // device's edit through catch-up, a paused project, an away period) is not.
  //
  // That moment is what recipes and mods hear as `review.saved`, the end of
  // day review's event, since the review retired (ghost rows phase 2): once a
  // day, through lib/morning-store.ts noteLeftoversCleared, and only for the
  // person's own verbs, never for a pile something else emptied.
  const prevCount = useRef(count);
  const acted = useRef(false);
  // Read by the effect below without being one of its inputs.
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
  }, [count]);

  if (count === 0) return null;

  const keep = act((t: TaskItem) => moveTaskToDate(t.id, todayStr));
  const toTomorrow = act((t: TaskItem) => moveTaskToDate(t.id, tomorrow));
  const moveTo = act((t: TaskItem, day: string) => moveTaskToDate(t.id, day));
  const toSidebar = act((t: TaskItem) => unscheduleTask(t.id));
  const letGo = act((t: TaskItem) => letGoItems([t.id]));
  // A ghost never repeats (selectOverdue), so its done is the scalar status, as
  // a one-off row's tick is: no date, the usual undo, and the confetti.
  const markDone = act((t: TaskItem) => toggleTaskStatus(t.id, 'completed'));
  // The right-click menu's own rows (Mark done, Reschedule) run the shared
  // verbs, which this fold cannot wrap; opening the menu counts as acting here.
  const noteActing = () => {
    acted.current = true;
  };

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
    >
      <div className="flex items-center rounded-[5px] pr-2 hover:bg-accent">
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
        {/* Always on screen, open or folded, on every pointer: they are the
            way through a folded pile without opening it, and an open one
            should not hide the verbs that settle all of it behind a hover.
            Quiet words with a dot between (Kirby, 2026-11-06: option E; the
            keys of #663 were too heavy for a heading). */}
        <span data-testid="ghost-bulk" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {keepable.length > 0 && (
            <button type="button" data-testid="ghost-keep-all" className={BULK_VERB} onClick={keepAll}>
              Keep all
            </button>
          )}
          {keepable.length > 0 && sendable.length > 0 && (
            <span aria-hidden data-testid="ghost-bulk-dot" className="text-muted-foreground/50">
              ·
            </span>
          )}
          {sendable.length > 0 && (
            <button type="button" data-testid="ghost-send-all" className={BULK_VERB} onClick={sendAll}>
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
              onDone={() => markDone(t)}
              onMenu={noteActing}
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

// A bulk verb in the fold's heading: muted words that ink and underline on
// hover or keyboard focus.
const BULK_VERB =
  'rounded-[3px] decoration-foreground/35 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline';

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
  onDone: () => void;
  onMenu: () => void;
  onTomorrow: () => void;
  onMoveTo: (day: string) => void;
  onSidebar: () => void;
  onLetGo: () => void;
  onOpenSheet: () => void;
}

/** The shared menu verbs a ghost's own lead rows already say, in its own words. */
const GHOST_MENU_OMIT: readonly VerbId[] = ['nextDay', 'braindump'];

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
  onDone,
  onMenu,
  onTomorrow,
  onMoveTo,
  onSidebar,
  onLetGo,
  onOpenSheet,
}: GhostRowProps) {
  const { toBraindump: ToBraindump } = useBraindumpArrows();
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const day = ghostDay(t);
  const keepOk = canKeep(t);
  const tomorrowOk = canMoveToNextDay(t, 'task', day);
  const rescheduleOk = canReschedule(t, 'task', day);
  const sidebarOk = canSendToBraindump(t, 'task', day, milestones);
  const letGoOk = canLetGo(t);
  const type = getItemTypeConfig(itemTypeName(t));

  // Right-click: the menu every row has, drawn on the ghost's own day, with the
  // fold's verbs first in the fold's words. Its Move to next day and Move to
  // braindump would say the same as Keep for today and Send to sidebar in
  // other words, so they are left out (GHOST_MENU_OMIT).
  const lead = (
    <>
      {keepOk && <ItemMenuRow icon={<Plus className="size-3.5" />} label="Keep for today" testId="ghost-menu-keep" onSelect={onKeep} />}
      {tomorrowOk && (
        <ItemMenuRow
          icon={<Redo2 className="size-3.5" />}
          label="Move to tomorrow"
          detail={formatTargetDay(tomorrow)}
          testId="ghost-menu-tomorrow"
          onSelect={onTomorrow}
        />
      )}
      {sidebarOk && (
        <ItemMenuRow icon={<ToBraindump className="size-3.5" />} label="Send to sidebar" testId="ghost-menu-sidebar" onSelect={onSidebar} />
      )}
      {letGoOk && (
        <ItemMenuRow icon={<X className="size-3.5" />} label="Let it go" detail="Kept in history" testId="ghost-menu-let-go" onSelect={onLetGo} />
      )}
    </>
  );

  return (
    <ItemContextMenu item={t} date={parseDay(day)} lead={lead} omit={GHOST_MENU_OMIT}>
      <div
        onContextMenu={onMenu}
        data-testid="ghost-row"
        data-ghost-row
        data-item-id={t.id}
        // The stagger for arrive's light (app/globals.css); capped so a long
        // pile's last rows do not wait seconds to rise.
        style={{ ['--ghost-i' as string]: Math.min(index, 8) }}
        data-ghost-arrive
        className="group relative flex w-full cursor-default items-center gap-3 rounded-[5px] px-2 py-1.5 hover:bg-accent"
      >
        {/* The box is a checkbox, as on every row: a dashed outline, no fill,
            that closes into a solid box with a muted check on hover, and a click
            marks the item done. Plenty of leftovers were done and never ticked.
            Keep for today is the capsule's first verb. Same 16px column as
            TaskRow's tick, and no lime: nothing in a ghost row is lime. */}
        <button
          type="button"
          aria-label="Mark done"
          data-testid="ghost-box"
          onClick={onDone}
          className="ghost-box relative z-10 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] text-muted-foreground"
        >
          <Check className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.5} />
        </button>

        {/* Opens the item, as a real row's click does. */}
        <button
          type="button"
          data-testid="ghost-title"
          data-row-title="muted"
          onClick={() => openEditFor(t as unknown as Task, 'task')}
          className="min-w-0 flex-1 cursor-pointer text-left font-content text-content text-muted-foreground transition-colors line-clamp-1 group-hover:text-foreground/80 focus-visible:outline-none"
        >
          <RowTitleText text={t.title} />
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
                  <RowControl icon={ToBraindump} label="Send to sidebar" testId="ghost-sidebar" onClick={onSidebar} />
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
    </ItemContextMenu>
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
                <Button variant="words">Cancel</Button>
              </DrawerClose>
            </DrawerFooter>
          )
        )}
      </DrawerContent>
    </Drawer>
  );
}

'use client';

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, useMemo } from 'react';
import { Check, Trash2, Minus, Plus, SkipForward, ArrowLeftToLine, Redo2, Undo2, MoreHorizontal,
  Flag,
  Repeat,
} from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { usePlannerStore } from '@/lib/planner-store';
import { goalRolesByItem, milestoneItemIds } from '@/lib/goals';
import { canMoveToNextDay, canSendToBraindump, formatTargetDay, nextDayLabel, nextDayTarget } from '@/lib/row-moves';
import { RowControl, RowControlDivider, RowControlGroup } from '@/components/primitives/row-control';
import { useGoalsForDisplay, useStreaksEnabled } from '@/lib/extension-gates';
import { getItemTypeConfig } from '@/lib/item-registry';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { useSelectionStore, rangeIds } from '@/lib/selection-store';
import { useScheduleSheet } from '@/lib/schedule-sheet-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { SwipeRow } from '@/components/mobile/swipe-row';
import { isRecurring, isCompletedOnDate, isSkippedOnDate, toDateStr } from '@/lib/recurrence';
import { suppressionLabel, suppressionReason } from '@/lib/active';
import { setHoveredItemRef } from '@/lib/hovered-item';
// One definition of what a tick means, shared with the Zen room — see lib/item-toggle.ts.
import { toggleHabitDone, toggleTaskDone } from '@/lib/item-toggle';
import {
  AgentPill,
  PriorityGlyph,
  RailTooltip,
  StreakFlame,
  MetaText,
  TagDot,
  DayDots,
  formatDuration,
  formatDurationLong,
} from '@/components/primitives/pills';
import type { Task, HabitItem, HabitStatus, Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Canonical item row (components/primitives): checkbox + Inter Medium title +
 * trailing pills + hover controls. Contexts:
 *   braindump — minimal metadata, tasks draggable
 *   bucket    — full pills + unschedule/skip controls, date-aware completion
 * Draggable id = item id per lib/dnd/CONTRACT.md; habits are not drag
 * sources (parity with the old timeline).
 *
 * TODO(debt): components/ai/morning-triage-list.tsx ships a THIRD row shape.
 * It couldn't reuse this one — it needs a date/age column this rail doesn't
 * have, a fixed 30px height (this row's py-1.5 + line-clamp-2 is taller, and
 * height is the entire point of that feature), no useDraggable (it renders in a
 * portal), and title-only click-to-edit (whole-row click competes with the
 * triage gesture). The convergence is a `context: 'triage'` variant here:
 * optional age column, single-line title, drag opt-out, click target on the
 * title. Owed, not done.
 */

// `HabitItem`, not the legacy `Habit`: the store holds items, and since 039 the
// two shapes disagree about the container field (`project` vs `group`).
export type RowItem = { itemType: 'task'; item: Task } | { itemType: 'habit'; item: HabitItem };

interface TaskRowProps {
  row: RowItem;
  context?: 'braindump' | 'bucket';
  density?: 'default' | 'compact';
  /** The day this row is rendered for (week columns); defaults to the selected day. */
  date?: Date;
}

export function TaskRow({ row, context = 'bucket', density = 'default', date }: TaskRowProps) {
  const {
    toggleTaskStatus,
    toggleHabitStatus,
    setItemSkipped,
    deleteTask,
    deleteHabit,
    unscheduleTask,
    moveTaskToDate,
    getProjectColor,
    selectedDate,
    userTimezone,
    routines,
    programs,
    goals,
  } = usePlannerStore();
  const confirm = useUIStore((s) => s.confirm);
  const isMobile = useIsMobile();
  const { item, itemType } = row;
  const isTask = itemType === 'task';
  const task = isTask ? (item as Task) : null;
  const habit = !isTask ? (item as HabitItem) : null;
  const inBraindump = context === 'braindump';
  const compact = density === 'compact';

  // Selected == in the multi-select set. A plain click both opens the row in the
  // editor AND selects it (see handleRowClick), so the persistent highlight this
  // drives is also the "current / open row" indicator — it replaces the old
  // editor-open pulse dot. Boolean selector so only the toggled row re-renders.
  // (The pulse dot is deliberately gone for now; it will return as the signal
  // that OpenClaw/Beacon is working an item.)
  const isMultiSelected = useSelectionStore((s) => s.selectedIds.has(item.id));

  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rowDate = date ?? selectedDate;
  const dateStr = toDateStr(rowDate, timezone);

  /**
   * The date this row's SUPPRESSION is resolved at — not always `dateStr`.
   *
   * A grid column asks about its own day. The braindump asks about today and
   * nothing else: it carries no date of its own (locked decision 3 — every
   * non-date-scoped surface resolves at today, never at the navigable
   * selectedDate), and its own two passes already do exactly that.
   *
   * `date` is optional and every braindump call site omits it, so without this
   * the row fell through to `selectedDate` and disagreed with the section it was
   * sitting in: walk the canvas to a September the user is merely browsing and a
   * live task in the working list greys itself and claims "Hidden with your
   * Summer program", while a genuinely paused row under the Paused heading
   * brightens because its resume date has passed on the day being looked at.
   * Neither has anything to do with what the user did.
   */
  const suppressionDate = inBraindump ? toDateStr(new Date(), timezone) : dateStr;

  /**
   * Is this row's work set aside on the day it is rendered for?
   *
   * Asked per row rather than threaded down from a caller, because a week column
   * and the braindump ask different questions and only the row knows which one
   * it is. Cheap enough to ask per row: `isItemActiveOn` walks this item's
   * paths, not the whole store, and there are a handful of containers.
   *
   * The open-loop variant is deliberately NOT used: a habit ticked before its
   * routine was paused still renders (the history rule), and it is still set
   * aside. Greying it says so; hiding it would rewrite the past.
   *
   * Greyed and NOT struck through, which is the distinction the manager's member
   * list already draws: struck through means done, and this is not done, it is
   * put down.
   *
   * `suppressionReason` rather than `isItemActiveOn`: it returns null on exactly
   * the same condition, and the non-null answer is the tooltip.
   */
  const suppression = suppressionReason(item as Item, suppressionDate, {
    userTimezone: timezone,
    routines,
    programs,
  });
  const suppressed = !!suppression;

  // The registry name + config for this item's type, resolved once. The
  // projected Task/Habit doesn't type its own discriminator — the store's
  // projections are filters, not maps, so `type`/`customType` survive at
  // runtime — hence the cast. This drives the delete-confirm copy, the
  // data-item-type attribute and the identity column's tooltip, all of which
  // used to resolve it separately.
  const projected = item as { type?: string; customType?: string };
  const typeName = projected.type === 'custom' ? projected.customType! : itemType;
  const typeConfig = getItemTypeConfig(typeName);

  // The goal roles this item holds, in LIVE goals only — an achieved goal's
  // milestone is history, and a row should not still wear a flag for work that
  // is finished. Built per row rather than threaded down: the index is O(goals)
  // over a handful of containers, and threading it would mean touching every
  // one of this row's callers for a glyph.
  //
  // Handed the goals the DISPLAY may read, which is an empty list while the
  // Goals extension is off — so the glyph disappears and the row itself is
  // untouched. That asymmetry is the aspire contract: a goal may add a mark to
  // a row and may never take the row away (lib/container-registry.ts).
  const displayGoals = useGoalsForDisplay(goals);
  const streaksOn = useStreaksEnabled();
  const roles = useMemo(
    () => goalRolesByItem(displayGoals).get(item.id)?.filter((r) => r.role !== 'member') ?? [],
    [displayGoals, item.id],
  );

  // Effective per-date status
  const taskRecurring = task ? isRecurring(task) : false;
  const taskDone = task ? (taskRecurring ? isCompletedOnDate(task, dateStr) : task.status === 'completed') : false;
  const habitDoneOnDate = habit ? habit.completedDates.includes(dateStr) : false;
  const habitSkipped = habit ? (habit.skippedDates ?? []).includes(dateStr) : false;
  const habitCount = habit ? ((habit.dailyCounts ?? {})[dateStr] ?? 0) : 0;
  const habitStatus: HabitStatus = habitSkipped ? 'skipped' : habitDoneOnDate ? 'done' : 'pending';
  const habitEffectiveCount = habitDoneOnDate ? habitCount || habit?.timesPerDay || 1 : habitCount;
  const completed = isTask ? taskDone : habitStatus === 'done';
  // Recurrence, not type — a recurring TASK reaches the braindump the same
  // way a recurring HABIT would (registry: habit.braindumpEligible is
  // false, so habits don't reach this list today, but tasks can and do
  // recur). `completed` above is already correctly per-date (completedDates,
  // never scalar status — see the CLAUDE.md note on recurring items), so
  // this isn't a data bug; it's that the braindump has no date column of its
  // own, so a recurring item's title going gray-and-struck-through there
  // reads as "permanently done" instead of "done today" (issue #181). The
  // grid views (context 'bucket') render each row under an explicit date,
  // where that same signal is unambiguous, so the suppression is scoped to
  // the sidebar only.
  const itemRecurring = isTask ? taskRecurring : habit ? isRecurring(habit) : false;
  const suppressCompletedLook = inBraindump && itemRecurring;

  // Skipping is a registry capability on a recurring occurrence, not a habit
  // privilege (#194). Habits satisfy both halves by construction, so this is
  // exactly the old `habit && skipped` test widened to recurring tasks and to
  // recurring custom types — no new branch, one predicate.
  const skippable = typeConfig.skippable && itemRecurring;
  const skipped = skippable && isSkippedOnDate(item, dateStr);
  /**
   * The date a skip is written against is the date the ROW is drawn for, not
   * the globally selected day. In a week column those differ, and using the
   * selected day there wrote the skip onto a day the user was not looking at —
   * so the row it was aimed at never minimized.
   *
   * Every per-date write in this row now uses `rowDate` for the same reason —
   * see handleTaskToggle / handleHabitToggle below.
   */
  const setSkipped = (next: boolean) => setItemSkipped(item.id, next, rowDate);

  // Put-it-off verbs (lib/row-moves.ts). Milestones from the RAW goals, not the
  // display list: that one is empty while the Goals extension is off, and this
  // is a write gate, not a mark.
  const todayStr = toDateStr(new Date(), timezone);
  const milestoneIds = useMemo(() => milestoneItemIds(goals ?? []), [goals]);
  const nextDay = nextDayTarget(dateStr, todayStr);
  const canNextDay = !inBraindump && canMoveToNextDay(item, itemType, dateStr);
  const canBraindump = !inBraindump && canSendToBraindump(item, itemType, dateStr, milestoneIds);

  // Multi-count habits (timesPerDay > 1). Progress reads as a fill rising
  // inside the 16px checkbox; the -/+ stepper lives in the trailing rail. The
  // leading slot therefore holds one 16px checkbox on EVERY row in EVERY state,
  // so hovering a habit never re-measures the row and the title never shifts.
  const multiTarget = habit?.timesPerDay && habit.timesPerDay > 1 ? habit.timesPerDay : 0;
  const multiPartial = multiTarget > 0 && habitEffectiveCount > 0 && !completed;
  const multiPct = multiTarget > 0 ? Math.min(100, Math.round((habitEffectiveCount / multiTarget) * 100)) : 0;

  // The CLASSIFY axis — one identity per item, whatever its type (039),
  // rendered as a color dot + name in the trailing rail.
  const tagName = item.project;
  const tagColor = tagName ? getProjectColor(tagName) : undefined;

  // Both tasks and habits are drag sources now (habits can be dropped onto
  // the schedule grid / buckets — see lib/dnd/CONTRACT.md).
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  // Full-row drag: after a drop, the browser fires a click on the row — swallow
  // it so a drag never opens the edit dialog. Cleared on a macrotask because a
  // drop outside the row fires no click at all (naive clear-in-onClick would
  // swallow the NEXT legitimate click).
  const wasDraggedRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDraggedRef.current = true;
      return;
    }
    if (wasDraggedRef.current) {
      const t = setTimeout(() => {
        wasDraggedRef.current = false;
      }, 0);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

  /**
   * Completion is written against `rowDate` — the day this row is DRAWN for —
   * not the store's selectedDate.
   *
   * The two are the same thing in day views (rowDate falls back to
   * selectedDate), but a week column passes its own `date`, and reading the
   * per-date state from one day while writing it to another is a straight
   * mismatch: the checkbox above already computes `taskDone` from
   * `dateStr` (= rowDate), so ticking Thursday's row used to mark Tuesday and
   * leave Thursday's box empty. Same rule the skip write follows (#194) and the
   * schedule block / project block already follow.
   *
   * `undefined` for a NON-recurring task is deliberate and unchanged: a one-off
   * task has no per-date dimension at all — it carries a scalar status — so the
   * store must not be handed a date it would resolve and ignore.
   */
  const handleTaskToggle = () =>
    task && toggleTaskDone(task, { date: rowDate, dateStr }, { toggleTaskStatus, toggleHabitStatus });

  /** One step up; landing on the target marks the habit done. */
  const handleHabitIncrement = () => {
    if (!habit || multiTarget === 0) return;
    const next = habitEffectiveCount + 1;
    if (next >= multiTarget) toggleHabitStatus(habit.id, 'done', multiTarget, rowDate);
    else toggleHabitStatus(habit.id, 'pending', next, rowDate);
  };

  /**
   * Checkbox semantics, which are binary: checked or not. Below target a click
   * counts up, but AT target a click clears the day entirely rather than
   * stepping down to target-1 — unchecking a box should mean "I didn't do this",
   * and landing on 2/3 means neither done nor undone. Stepping down by one is
   * what the trailing `−` control is for; the two affordances stay distinct.
   * The store logs this as "Reset habit", and it's undoable.
   */
  const handleHabitToggle = () => {
    if (!habit) return;
    toggleHabitDone(habit, { date: rowDate, dateStr }, { toggleTaskStatus, toggleHabitStatus });
  };

  const handleDelete = () => {
    // Registry copy so custom-type rows say "Delete Goal?", not "Delete Task?".
    confirm({
      title: `Delete ${typeConfig.label}?`,
      description: typeConfig.form.deleteDescription(item.title),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => (isTask ? deleteTask(item.id) : deleteHabit(item.id)),
    });
  };

  // A plain click both SELECTS this row (replacing the selection) and opens it
  // in the editor — the persistent highlight is the "current row" indicator.
  // Cmd/Ctrl adds/removes a row from a multi-selection WITHOUT opening it, and
  // Shift extends a range from the anchor (DOM order == visual order, no
  // virtualization). The wasDragged guard keeps a drop from firing a click.
  const handleRowClick = (e: ReactMouseEvent) => {
    if (wasDraggedRef.current) return;
    const selection = useSelectionStore.getState();
    if (e.metaKey || e.ctrlKey) {
      selection.toggle(item.id);
      return;
    }
    if (e.shiftKey) {
      selection.selectRange(rangeIds(selection.anchorId, item.id));
      return;
    }
    selection.replace([item.id]);
    openEditFor(item, itemType);
  };

  // A skipped occurrence — of ANY skippable recurring type — collapses to a
  // slim strip with undo. This is the whole visual payload of #194/#195: the
  // treatment is keyed off the capability, so a recurring task and a recurring
  // custom type get it for free, on desktop and on mobile alike (the strip is
  // returned above the SwipeRow wrapper, so its Unskip button is the touch
  // affordance — there is no hover to hide behind).
  if (skipped && !inBraindump) {

    return (
      <div
        data-testid="item-card"
        data-item-id={item.id}
        data-item-kind={itemType}
        data-item-type={typeName}
        // A skipped row is a COMPLETELY different DOM shape under the same
        // testid — no complete button, no rail. Tests must be able to tell the
        // two apart, or a drill to item-complete-button times out mysteriously.
        data-row-variant="skipped"
        // Selected == in the multi-select set; drives the persistent highlight.
        data-selected={isMultiSelected ? 'true' : 'false'}
        onClick={handleRowClick}
        className={cn(
          'group relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5',
          // Selected keeps a latched wash, a notch above hover (its own indicator).
          isMultiSelected ? 'bg-[var(--row-selected)]' : 'bg-surface-3/60 hover-wash'
        )}
      >
        <SkipForward className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
        <span className="flex-1 truncate text-sm text-muted-foreground/70">{item.title}</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="item-unskip-button"
          className={cn(
            'px-2 text-xs text-muted-foreground hover:text-foreground',
            // The only control on the strip, and on touch it sits inside a row
            // whose own tap opens the edit dialog — 24px is too fine a target
            // to aim at with a thumb.
            isMobile ? 'h-8 px-3' : 'h-6'
          )}
          onClick={(e) => {
            e.stopPropagation();
            setSkipped(false);
          }}
        >
          <Undo2 className="mr-1 h-3 w-3" />
          Unskip
        </Button>
      </div>
    );
  }

  const handleHabitDecrement = () => {
    if (!habit || habitEffectiveCount <= 0) return;
    toggleHabitStatus(habit.id, 'pending', habitEffectiveCount - 1, rowDate);
  };

  const rowContent = (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      suppressHydrationWarning
      // One testid for both kinds — the Phase 6 selector policy. Disambiguate
      // with data-item-kind / data-item-type rather than a second testid, so a
      // single helper can drive completion for any type.
      data-testid="item-card"
      // Identity, so assertions are id-based instead of hasText-based: a title
      // filter breaks on truncation and cannot tell apart the same item
      // rendered twice (a project-block task also renders in its bucket).
      data-item-id={item.id}
      data-item-kind={itemType}
      // Registry type name ('task' | 'habit' | custom slug) — the Phase 6
      // selector policy.
      data-item-type={typeName}
      data-row-variant="default"
      // Selected == in the multi-select set; drives the persistent highlight and
      // marks the current / open row.
      data-selected={isMultiSelected ? 'true' : 'false'}
      // Completion is otherwise observable only as Tailwind classes on the
      // title and the checkbox, which is exactly the coupling a restyle breaks.
      data-completed={completed ? 'true' : 'false'}
      // Same reasoning for "set aside": the treatment is a muted title, and a
      // spec that asserts a Tailwind class is asserting the wrong thing.
      data-suppressed={suppressed ? 'true' : 'false'}
      // A row's resolved slot. The visible start time is `hidden md:inline`, so
      // without these a drop's inferred time is unassertable on narrow/mobile
      // viewports — and these are what distinguish an untimed bucket drop from
      // a timed one.
      data-bucket={item.timeBucket ?? ''}
      data-start-time={item.startTime ?? ''}
      className={cn(
        // No transition on the hover bg — highlights land instantly, like the
        // omnibar's CommandItem. touch-manipulation (not touch-none) keeps
        // touch scrolling alive; TouchSensor's 250ms hold handles drags — which
        // is only true since the shell stopped letting PointerSensor claim touch
        // first (lib/dnd/sensors.ts). `touch-none` here would hand dnd-kit the
        // whole gesture again and take the scroll back off the user.
        // Hover cover: flat wash, Linear-style — no edge, no shadow. --accent is
        // the token defined for exactly this (a light gray in light mode, a
        // white 6% overlay in dark) so the highlight lifts off the card in dark
        // mode instead of darkening it, which bg-muted/60 did.
        'group relative flex w-full cursor-pointer touch-manipulation items-center gap-3 rounded-[5px] px-2',
        // Selected keeps a latched wash — the hover wash, one notch stronger
        // (--row-selected) so a selection reads a touch above a passing hover. It
        // marks the current / open row and every row in a multi-selection. A
        // background wash (not opacity) keeps the lime rule: nothing here dims
        // the lime completion mark through a parent's opacity.
        isMultiSelected ? 'bg-[var(--row-selected)]' : 'hover:bg-accent',
        compact ? 'py-1' : 'py-1.5',
        isDragging && 'z-50 opacity-50'
        // The completed fade is NOT applied here. Opacity on the row composites
        // the checkbox too, and lime at 60% over the dark ramp turns olive — the
        // one mark that has to stay bright, since it's the confirmation the
        // click landed. The fade rides the title and the rail instead (below);
        // opacity only ever goes down a tree, so a child can't opt back out.
      )}
      onClick={handleRowClick}
      onMouseEnter={() => setHoveredItemRef(item.id, itemType)}
      onMouseLeave={() => setHoveredItemRef(null, null)}
    >

      {/* Checkbox — 16px on EVERY row of both types in every state, so the
          leading edge is one straight column and nothing downstream of it can
          move. A multi-count habit shows its progress as a fill rising inside
          the box (clipped to the rounded corners by overflow-hidden) rather
          than by swapping in a wider stepper; the stepper itself lives in the
          trailing rail, where revealing it costs no width. Clicking still
          increments — handleHabitToggle counts up and lands on done at target. */}
      <button
        data-testid="item-complete-button"
        onClick={(e) => {
          e.stopPropagation();
          if (isTask) handleTaskToggle();
          else handleHabitToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={
          multiTarget > 0
            ? // At target a click clears the day; below it a click counts up.
              `${completed ? 'Reset' : 'Increment'} — ${habitEffectiveCount} of ${multiTarget} complete`
            : completed
              ? 'Mark incomplete'
              : 'Mark complete'
        }
        className={cn(
          'relative z-10 flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden rounded-[5px] border transition-colors',
          completed
            ? 'border-primary bg-primary'
            : multiPartial
              ? 'border-primary/60 bg-surface-3 hover:border-primary'
              : 'border-muted-foreground/45 bg-surface-3 hover:border-primary'
        )}
      >
        {multiPartial && (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 bg-primary/70 transition-[height] duration-150"
            style={{ height: `${multiPct}%` }}
          />
        )}
        {completed && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
      </button>

      {/* Title */}
      <p
        className={cn(
          // Content typeface via tokens: sans = Inter Regular 11.5,
          // serif = Source Serif SemiBold 15. Flipped by data-type-mode.
          'min-w-0 flex-1 font-content text-foreground',
          // Both densities take text-content: the week views render compact
          // rows and the day view default ones, and a title that changed size
          // between the two would break the token's whole purpose.
          compact ? 'line-clamp-1 text-content' : 'line-clamp-2 text-content',
          suppressed && 'text-muted-foreground',
          completed && !suppressCompletedLook && 'text-muted-foreground line-through opacity-60'
        )}
        title={suppression ? suppressionLabel(suppression, { long: true }) : undefined}
      >
        {item.title}
      </p>

      {/* The goal role — a sibling of the title, NOT inside it and NOT a rail
          column.

          Not inside: the title is `line-clamp`ed, which is `overflow: hidden`,
          so any title that filled its clamp hid the glyph entirely — and the
          week columns render compact one-line rows in narrow columns, which is
          exactly where titles overflow and where a week of checkpoints is most
          worth scanning. It also sat under the paragraph's `title` attribute on
          suppressed rows, firing a native tooltip on top of the Radix one that
          RailTooltip exists to replace.

          Not a rail column: the rail's five columns each reserve width on every
          row of both types, so a sixth would cost 20px on every row in the app
          to say something true of a handful of them.

          Muted ink, never honey — being a milestone is an identity, not a
          warning, and this is the row of a checkpoint that may well be late. On
          touch the tooltip never fires, so the glyphs are ones a reader can
          place unaided and the full attribution is one tap away in the edit
          sheet's Goal chip. The sr-only text is for the reader the tooltip
          never reaches at all. */}
      {roles.length > 0 && (
        <RailTooltip
          label={roles[0].role === 'milestone' ? 'Milestone' : 'Check-in'}
          detail={
            roles.length === 1 ? roles[0].goalName : `${roles[0].goalName} +${roles.length - 1}`
          }
        >
          <span
            className="text-muted-foreground/70 -ml-0.5 flex flex-shrink-0 items-center"
            data-testid="item-goal-role"
            data-goal-role={roles[0].role}
          >
            {roles[0].role === 'milestone' ? (
              <Flag className="size-3" aria-hidden />
            ) : (
              <Repeat className="size-3" aria-hidden />
            )}
            <span className="sr-only">
              {roles[0].role === 'milestone' ? 'Milestone of ' : 'Check-in for '}
              {roles[0].goalName}
            </span>
          </span>
        </RailTooltip>
      )}

      {/* What the agent is doing with this, and for how long — a sibling of the
          title for exactly the reasons the goal role above it is one, and
          registry-gated so a type that cannot be delegated never reserves the
          space. The pill returns null on its own for an unassigned or finished
          item, so most rows render nothing and start no timer. */}
      {task && typeConfig.agentAssignable && <AgentPill item={task} className="-ml-0.5" />}

      {/* Trailing metadata — the "quiet rail". Fixed order, innermost to the
          right edge: [occasional] → [days] → [identity] → [glyph] → [quantity].
          The last FOUR reserve width, and they do so on EVERY row of BOTH types,
          so a mixed task+habit list forms four straight vertical rails plus the
          row's own right edge:

            days     59px   weekday dots — empty slot when the item doesn't repeat
            identity 96px   tag dot + truncating name (6px, dot only, below lg)
            glyph    36px   priority bars / streak flame + count
            quantity 48px   duration, right-aligned tabular figures, both types

          Every one of these columns is a de-chromed glyph or a bare numeral, and
          none of them carries a label — which is what buys the alignment and what
          costs the reader any way of knowing what they are looking at. Each one
          therefore answers on hover, through RailTooltip (pills.tsx): an eyebrow
          naming the column over the value in words. The native `title` attributes
          these used to carry are gone; they fired a second, unstyleable tooltip
          in a system font at the OS's own delay.

          Reserving the first two is a change of mind, and the reason is that the
          old rule ("only fixed-size things reserve") produced rails only at the
          two outermost columns — the tag sized to its name, so its dot landed at
          a different x on every row and the column read as debris rather than as
          a column. Reserving costs a void on rows that lack the datum; a straight
          edge down a dense list is worth more than those pixels. It stays cheap
          because the two new slots only exist at lg and above, where the day view
          has the room; below that the day dots unmount and the tag collapses to
          its 6px dot.

          Genuinely occasional metadata (start time, habit progress) is still NOT
          reserved and now sits INBOARD of the day dots. Because the rail is
          right-anchored, a variable item only moves what is to its left — so
          parking them innermost lets the title's elastic gap absorb them while
          every column outboard of them stays nailed down.

          Action controls stay absolutely pinned to the left of the rail and only
          fade in on hover/focus, so they reserve no space and shift nothing. */}
      {/* gap-3 (12px), not gap-2: several rail items are bare text with no
          container, and the day-letter run has its own 4px internal gap — at 8px
          between items the run ran straight into its neighbour. 12px is wide
          enough that the between-item gap clearly outranks the within-item one. */}
      <div
        className={cn(
          'relative z-10 flex flex-shrink-0 items-center gap-3',
          completed && !suppressCompletedLook && 'opacity-60'
        )}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Action controls — one boxed cluster, absolutely positioned to the left
            of the columns so it reserves no space. pointer-events gate off until
            reveal so the invisible buttons aren't clickable while idle. */}
        {!inBraindump && !isMobile && (
          <span className="pointer-events-none absolute inset-y-0 right-full mr-2 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
            <RowControlGroup>
              {/* Multi-count stepper — leads the capsule, so the destructive
                  delete stays at the far end away from the one control here that
                  gets clicked repeatedly. A hairline separates the value editor
                  from the actions. The count it edits reads live as `n/target`
                  in the rail to the right. */}
              {multiTarget > 0 && (
                <>
                  <RowControl
                    icon={Minus}
                    label="Decrease count"
                    testId="item-stepper-dec"
                    disabled={habitEffectiveCount <= 0}
                    onClick={handleHabitDecrement}
                  />
                  <RowControl
                    icon={Plus}
                    label="Increase count"
                    testId="item-stepper-inc"
                    disabled={habitEffectiveCount >= multiTarget}
                    onClick={handleHabitIncrement}
                  />
                  <RowControlDivider />
                </>
              )}
              {/* Put it off: the next day, or back to the braindump. Never on a
                  recurring row (Skip today is its answer), and gated in one
                  place — lib/row-moves.ts — so the blocks and the sheet agree. */}
              {canNextDay && (
                <RowControl
                  icon={Redo2}
                  label={nextDayLabel(nextDay, todayStr)}
                  detail={formatTargetDay(nextDay)}
                  testId="item-tomorrow-button"
                  onClick={() => moveTaskToDate(item.id, nextDay)}
                />
              )}
              {canBraindump && (
                <RowControl
                  icon={ArrowLeftToLine}
                  label="Move to Braindump"
                  testId="item-unschedule-button"
                  onClick={() => unscheduleTask(item.id)}
                />
              )}
              {skippable && !completed && (
                <RowControl
                  icon={SkipForward}
                  label="Skip today"
                  testId="item-skip-button"
                  onClick={() => setSkipped(true)}
                />
              )}
              <RowControl icon={Trash2} label="Delete" testId="item-delete-button" destructive onClick={handleDelete} />
            </RowControlGroup>
          </span>
        )}

        {/* Mobile: no hover, so the stepper can't hide behind one — it renders
            inline and always-on for multi-count habits (the leading checkbox
            still increments; this is the only way back DOWN). Always present,
            so it shifts nothing either. 28px to match the ellipsis beside it,
            since 20px is too small a touch target; no tooltips on touch. */}
        {!inBraindump && isMobile && multiTarget > 0 && (
          <RowControlGroup>
            <RowControl
              icon={Minus}
              label="Decrease count"
              testId="item-stepper-dec"
              disabled={habitEffectiveCount <= 0}
              onClick={handleHabitDecrement}
              className="h-7 w-7"
              iconClassName="h-3.5 w-3.5"
              tooltip={false}
            />
            <RowControl
              icon={Plus}
              label="Increase count"
              testId="item-stepper-inc"
              disabled={habitEffectiveCount >= multiTarget}
              onClick={handleHabitIncrement}
              className="h-7 w-7"
              iconClassName="h-3.5 w-3.5"
              tooltip={false}
            />
          </RowControlGroup>
        )}

        {/* Mobile: always-visible ellipsis → schedule/action sheet (touch has
            no hover, so the desktop control cluster above is hidden on mobile). */}
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Actions"
            data-testid="item-actions-button"
            onClick={() => useScheduleSheet.getState().open(row, inBraindump ? null : dateStr)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}

        {/* Braindump (sidebar) delete — inline, since braindump rows carry no
            tag or pills to sit beside.
            -my-1.5 is a height neutralizer, not spacing: this 24px button was
            the tallest thing in a braindump row (the rail it would otherwise
            sit beside is gated off here), so it set the line box and made every
            sidebar row 36px against the body's 29px — the same list at a looser
            pitch. Flexbox sizes the line from items' OUTER hypothetical heights,
            so cancelling the row's own py-1.5 drops this to 12px and the 17px
            title takes the measurement back, exactly as it does in the body.
            The button still draws at its full 24px and overhangs the padding.
            Coupled to the row's py-1.5 above, like DAY_DOTS_HIT in pills.tsx. */}
        {inBraindump && !isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="-my-1.5 h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            onClick={handleDelete}
            aria-label="Delete"
            data-testid="item-delete-button"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}

        {!compact && !inBraindump && (
          <>
            {/* OCCASIONAL — unreserved and variable, so it sits innermost where
                the title's elastic gap absorbs it and no rail outboard moves. */}
            {item.startTime && (
              <MetaText
                testId="item-start-time"
                className="hidden md:inline"
                // Label only: the value is already the reading, so a body line
                // would just print the same figure twice.
                tooltip={{ label: 'Start time' }}
              >
                {item.startTime}
              </MetaText>
            )}
            {habit && habit.timesPerDay && habit.timesPerDay > 1 && (
              <MetaText
                testId="item-count"
                tooltip={{
                  label: 'Times per day',
                  detail: `${habitEffectiveCount || 0} of ${habit.timesPerDay} done today`,
                }}
              >
                {habitEffectiveCount || 0}/{habit.timesPerDay}
              </MetaText>
            )}

            {/* DAYS — 59px on every row. Habits and recurring tasks plot their
                weekdays; one-off tasks render the empty slot, which is what
                holds the tag column to a straight edge in a mixed list. Hidden
                below lg, where the rail can't afford it. */}
            <DayDots
              frequency={item.repeatFrequency}
              repeatDays={item.repeatDays}
              highlightDay={rowDate.getDay()}
              className="hidden lg:flex"
            />

            {/* IDENTITY — 96px at lg (dot + truncating name), 6px below it where
                only the dot survives as a presence indicator, name on hover. */}
            {tagName ? (
              <TagDot
                name={tagName}
                color={tagColor}
                // 'Project' or 'Group' from the registry — below lg the name is
                // hidden and this is the column's only reading.
                label={typeConfig.form.containerLabel}
                className="w-1.5 lg:w-24"
                nameClassName="hidden lg:block"
              />
            ) : (
              <span aria-hidden className="w-1.5 flex-shrink-0 lg:w-24" />
            )}

            {/* GLYPH — 36px, reserved on every row of both types. Priority bars
                for tasks, flame + streak count for habits: the first shared
                rail. It was 16px while the streak count lived outboard in the
                quantity slot; the extra 20px is that count's room. Both types
                start their ink on the slot's left edge — the priority bars
                occupy exactly the first 16px, as before — so nothing that was
                already here moved and the column is still one straight rail. */}
            <span className="flex w-9 flex-shrink-0 items-center">
              {isTask
                ? task?.priority && <PriorityGlyph priority={task.priority} />
                : streaksOn && <StreakFlame streak={habit?.streak ?? 0} />}
            </span>

            {/* QUANTITY — 48px, right-aligned tabular figures: how long the item
                takes, on EVERY type. This used to be duration for tasks and the
                streak count for habits, which meant the app's most scannable
                column held minutes on one row and days on the next — you could
                read it as neither. Habits carry a real duration now (see
                memory/plans/unified-items.md), so the column has one unit, and
                the streak moved in beside its own flame. */}
            <MetaText
              testId="item-duration"
              className="w-12 flex-shrink-0 text-right"
              tooltip={
                item.duration
                  ? { label: 'Duration', detail: formatDurationLong(item.duration) }
                  : undefined
              }
            >
              {item.duration ? formatDuration(item.duration) : ''}
            </MetaText>
          </>
        )}
      </div>
    </div>
  );

  // Mobile: reveal Schedule / Complete / Delete on swipe-left. Desktop returns
  // the row unchanged (hover controls + the ellipsis handle these actions).
  if (isMobile) {
    return (
      <SwipeRow
        onComplete={isTask ? handleTaskToggle : handleHabitToggle}
        onSchedule={() => useScheduleSheet.getState().open(row, inBraindump ? null : dateStr)}
        onDelete={handleDelete}
      >
        {rowContent}
      </SwipeRow>
    );
  }
  return rowContent;
}

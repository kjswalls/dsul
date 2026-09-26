'use client';

import { useState, useMemo, useEffect } from 'react';

import { Moon, CheckCircle2, Circle, ArrowRight, Check, X, SkipForward } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { milestoneItemIds } from '@/lib/goals';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { useEODStore } from '@/lib/eod-store';
import { anchoredSeriesOn, shouldShowOnDate, isCompletedOnDate, isSkippedOnDate, isRecurring } from '@/lib/recurrence';
import { ITEM_TYPES, isSkippable } from '@/lib/item-registry';
import { isOpenLoopSuppressedOn } from '@/lib/active';
import type { Item, Task, TimeBucket } from '@/lib/planner-types';

/**
 * The store's `tasks` projection is a filter, not a map, so every row still
 * carries its runtime discriminator (`type`, and `customType` for custom
 * types) — the same cast lib/search.ts and lib/commands/entities.ts make.
 * Needed because the registry predicates take an `Item`.
 */
const asItem = (task: Task): Item => task as unknown as Item;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(tz?: string | null) {
  const resolvedTz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date().toLocaleDateString('en-CA', { timeZone: resolvedTz });
}

function tomorrowStr(tz?: string | null) {
  const resolvedTz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Parse today's date parts and add 1 day in UTC to avoid browser-TZ drift
  const [y, m, d] = todayStr(resolvedTz).split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Build a Date at UTC noon for the given YYYY-MM-DD string — safe for Calendar fromDate. */
function dateFromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Format a Date as YYYY-MM-DD in the given timezone (avoids browser-TZ drift in Calendar onSelect). */
function formatDateInTz(date: Date, tz?: string | null): string {
  const resolvedTz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return date.toLocaleDateString('en-CA', { timeZone: resolvedTz });
}

function actionLabel(action: TaskAction, userTimezone: string | null | undefined): string {
  if (!action) return '';
  if (action.type === 'dismissed') return 'Moved to sidebar';
  // Nothing happened to the item, and the receipt says so without dressing it up
  // as an achievement or a failure: it stayed where it was and it comes back on
  // its own schedule. See the `left` branch of handleDismiss.
  if (action.type === 'left') return 'Left for next time';
  // The same neutral word the palette's `items.skip` command and the habit
  // section below already use: a skipped day is a decision, not a failure.
  if (action.type === 'skipped') return 'Skipped today';
  if (action.type === 'moved') {
    const tomorrow = tomorrowStr(userTimezone);
    if (action.to === tomorrow) return 'Moved to tomorrow';
    const [y, m, d] = action.to.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    const resolvedTz = userTimezone ?? 'UTC';
    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: resolvedTz });
    return `Rescheduled to ${formatted}`;
  }
  return '';
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * What the user did to a row this session.
 *
 * `dismissed` and `left` are the SAME gesture (the ✕) on two different kinds of
 * item, and they are separate variants because they are separate outcomes:
 * `dismissed` unscheduled a one-off task, `left` wrote nothing at all. Merging
 * them would make the receipt lie about one of the two — and would lose the flag
 * handleUndo reads to know there is nothing to restore.
 *
 * `skipped` is the recurring row's own verb (see handleSkipToday). Like `left`
 * it has no undo-stack entry: the reversal is another intent-based store call
 * (`setItemSkipped(id, false)`), not a restore of saved fields.
 */
type TaskAction =
  | { type: 'moved'; to: string }
  | { type: 'dismissed' }
  | { type: 'left' }
  | { type: 'skipped' }
  | null;

// ── Component ─────────────────────────────────────────────────────────────────

export function EODReview() {
  const { tasks, habits, updateTask, unscheduleTask, toggleHabitStatus, toggleTaskStatus, setItemSkipped } =
    usePlannerStore();
  const { isOpen, close, saveLastReviewDate } = useEODStore();
  const userId = usePlannerStore((s) => s.userId);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const milestoneIds = useMemo(() => milestoneItemIds(goals), [goals]);
  const streaksOn = useStreaksEnabled();

  const today = todayStr(userTimezone);

  // Helper: is this task done for today (handles recurring via completedDates)
  const isTaskDoneToday = (task: (typeof tasks)[0]): boolean =>
    isRecurring(task) ? isCompletedOnDate(task, today) : task.status === 'completed';

  // Partition today's tasks — live view for pending section
  const { pendingTasks: livePendingTasks, completedTasks } = useMemo(() => {
    const resolvedTz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayTasks = tasks.filter((t) => {
      if (t.status === 'cancelled') return false;
      // Paused work is set aside, not owed — the review must not ask about it.
      // This guard sits here rather than on the two partitions below because
      // `isOpenLoopSuppressedOn` is already false for anything carrying a mark
      // or a terminal status, so `completedTasks` passes through untouched:
      // an item paused after being ticked today still shows under Done today
      // (the history rule).
      if (isOpenLoopSuppressedOn(asItem(t), today, { userTimezone: resolvedTz, routines, programs }))
        return false;
      // One-off tasks: match by startDate
      if (!isRecurring(t)) return t.startDate === today;
      // A recurring task skipped for today was already decided on — the review
      // shouldn't ask about it again, same as skipped habits (#194).
      if (isSkippedOnDate(t, today)) return false;
      // Recurring tasks: use recurrence filter (respects repeatFrequency, repeatDays, etc.)
      return t.startDate
        ? anchoredSeriesOn(t, t.startDate, today, resolvedTz)
        : shouldShowOnDate(t, today, resolvedTz);
    });
    return {
      pendingTasks: todayTasks.filter((t) => !isTaskDoneToday(t)),
      completedTasks: todayTasks.filter((t) => isTaskDoneToday(t)),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, routines, programs, today, userTimezone]);

  // Tasks marked complete during this EOD session
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(new Set());

  // Tasks uncompleted from "Done today" during this session (needed to surface them in pending list)
  const [justUncompletedIds, setJustUncompletedIds] = useState<Set<string>>(new Set());

  // Snapshot pendingTasks at dialog open time so tasks marked done during
  // the session don't disappear from the list (circle stays visible for undo).
  const [pendingTasksSnapshot, setPendingTasksSnapshot] = useState<typeof livePendingTasks>(livePendingTasks);
  useEffect(() => {
    if (isOpen) {
      setPendingTasksSnapshot(livePendingTasks);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const pendingTasks = useMemo(() => {
    if (!isOpen) return livePendingTasks;
    // Merge any tasks uncompleted from "Done today" that weren't in the original snapshot
    const snapshotIds = new Set(pendingTasksSnapshot.map((t) => t.id));
    const extras = tasks.filter(
      (t) => justUncompletedIds.has(t.id) && !isTaskDoneToday(t) && !snapshotIds.has(t.id)
    );
    return [...pendingTasksSnapshot, ...extras];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingTasksSnapshot, tasks, justUncompletedIds]);

  // Partition today's habits (scoped to habits that should show today)
  const { doneHabits, skippedHabits } = useMemo(() => {
    const resolvedTz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayHabits = habits.filter((h) => shouldShowOnDate(h, today, resolvedTz));
    return {
      doneHabits: todayHabits.filter((h) => h.completedDates.includes(today) || h.status === 'done'),
      skippedHabits: todayHabits.filter(
        (h) =>
          h.skippedDates.includes(today) ||
          (h.status === 'skipped' && !h.completedDates.includes(today))
      ),
    };
  }, [habits, today, userTimezone]);

  // Tasks already done when modal opened — excludes in-session completions shown in pending section
  const preExistingCompletedTasks = useMemo(
    () => completedTasks.filter((t) => !justCompletedIds.has(t.id)),
    [completedTasks, justCompletedIds]
  );

  // Per-task pill actions (replaces selectedIds)
  const [taskActions, setTaskActions] = useState<Map<string, TaskAction>>(new Map());

  // Undo stack: stores previous state before an action was taken
  type UndoEntry = { startDate: string | null | undefined; isScheduled?: boolean; timeBucket?: string; startTime?: string | null };
  const [undoStack, setUndoStack] = useState<Map<string, UndoEntry>>(new Map());

  // Which task's date picker popover is open (desktop only)
  const [datePickerOpenId, setDatePickerOpenId] = useState<string | null>(null);

  // Reset session state when modal closes so stale data doesn't persist into next open
  useEffect(() => {
    if (!isOpen) {
      setJustCompletedIds(new Set());
      setJustUncompletedIds(new Set());
      setTaskActions(new Map());
      setUndoStack(new Map());
      setDatePickerOpenId(null);
    }
  }, [isOpen]);

  const handleMarkDone = (id: string) => {
    // Done supersedes skipped, and the two are mutually exclusive per date
    // (setItemSkipped clears a completion the same way in the other
    // direction). Without this, ticking a row you had just skipped this
    // session would leave the day BOTH skipped and completed, and every
    // surface renders the skipped strip first — so the completion would be
    // written and then be invisible.
    if (taskActions.get(id)?.type === 'skipped') {
      setItemSkipped(id, false, new Date());
      setTaskActions((prev) => { const next = new Map(prev); next.delete(id); return next; });
    }
    toggleTaskStatus(id, 'completed', new Date());
    setJustCompletedIds((prev) => new Set(prev).add(id));
    setJustUncompletedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const handleUnmarkDone = (id: string) => {
    toggleTaskStatus(id, 'pending', new Date());
    setJustCompletedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    // Track tasks uncompleted from "Done today" that weren't in the original snapshot
    if (!pendingTasksSnapshot.some((t) => t.id === id)) {
      setJustUncompletedIds((prev) => new Set(prev).add(id));
    }
  };

  const handleToggleHabit = (id: string, targetStatus: 'done' | 'pending' | 'skipped') => {
    toggleHabitStatus(id, targetStatus, undefined, new Date());
  };

  /**
   * "Tomorrow" / the date picker. ONE-OFF tasks only — the controls are not
   * rendered for a recurring row, and this is the belt to that suspenders.
   *
   * A recurring item's `startDate` is its recurrence ANCHOR, so writing a new
   * one here does not move tonight's occurrence to Friday; it rewrites every
   * future occurrence of the series (a Tuesday task anchored forward to Friday
   * repeats on Fridays). There is no per-occurrence date override in the data
   * model, so "move this one occurrence" is not expressible at all — the
   * recurring row is offered "Skip today" instead. Same shape as the ✕ fix for
   * issue #187 above: branch on isRecurring(), which is a runtime property of
   * the item, not on its registry type.
   */
  const handleMoveTo = (id: string, date: string) => {
    const task = pendingTasks.find((t) => t.id === id);
    if (task && isRecurring(task)) return;
    setUndoStack((prev) => {
      const next = new Map(prev);
      if (!next.has(id)) next.set(id, { startDate: task?.startDate ?? null, startTime: task?.startTime ?? null });
      return next;
    });
    setTaskActions((prev) => { const next = new Map(prev); next.set(id, { type: 'moved', to: date }); return next; });
    updateTask(id, { startDate: date });
  };

  /**
   * What a recurring row gets instead of the date controls: today's occurrence
   * is marked "not this one" and the series is untouched.
   *
   * The write goes through setItemSkipped (#194), which is the only thing that
   * may touch `skippedDates` — it is intent-based, gated on isSkippable()
   * (capability AND recurrence), and for types whose vocabulary carries a skip
   * value it routes through the status toggle so streaks stay server-owned.
   * Writing the date array here by hand, or setting a scalar status, would
   * both break that and (for tasks) push a value the OpenClaw plugin throws on.
   *
   * `new Date()` — not the store's selectedDate — because this review is about
   * TODAY, the same day every other handler in this component acts on.
   */
  const handleSkipToday = (id: string) => {
    const task = pendingTasks.find((t) => t.id === id);
    if (!task || !isSkippable(asItem(task))) return;
    setTaskActions((prev) => { const next = new Map(prev); next.set(id, { type: 'skipped' }); return next; });
    setItemSkipped(id, true, new Date());
  };

  /**
   * The ✕. One-off tasks go back to the Braindump; recurring ones are LEFT ALONE.
   *
   * A recurring item's startDate is its recurrence anchor, not the date of the
   * occurrence you are looking at — so unscheduleTask (which clears startDate,
   * timeBucket, startTime and isScheduled) doesn't dismiss tonight's instance,
   * it deletes the whole series off the calendar and drops it in the sidebar.
   * Issue #187: a task that repeats every Tuesday and gets dismissed on Tuesday
   * night must still be there next Tuesday.
   *
   * So the recurring branch writes NOTHING. Not the scalar status either —
   * recurring completion is per-date (`completedDates`), and a scalar
   * 'completed'/'cancelled' here would both lie about the occurrence and
   * silently retire every future one. The item stays incomplete on its date,
   * exactly as the issue asks, and the receipt is purely session UI so the row
   * stops asking to be triaged again in this sitting.
   *
   * Branching on isRecurring(), not on the item's TYPE: a recurring task and a
   * one-off task are the same registry type, so this is a runtime property of
   * the item and there is no capability question to ask instead.
   */
  const handleDismiss = (id: string) => {
    const task = pendingTasks.find((t) => t.id === id);
    if (task && isRecurring(task)) {
      setTaskActions((prev) => { const next = new Map(prev); next.set(id, { type: 'left' }); return next; });
      return;
    }
    setUndoStack((prev) => {
      const next = new Map(prev);
      if (!next.has(id)) next.set(id, { startDate: task?.startDate ?? null, isScheduled: task?.isScheduled, timeBucket: task?.timeBucket, startTime: task?.startTime ?? null });
      return next;
    });
    setTaskActions((prev) => { const next = new Map(prev); next.set(id, { type: 'dismissed' }); return next; });
    unscheduleTask(id);
  };

  const handleUndo = (id: string) => {
    // A `left` receipt has no undo stack entry because it had nothing to stack:
    // the dismissal wrote no fields. Clearing the receipt IS the whole reversal,
    // and routing it through updateTask instead would push a history entry (and
    // a db write) for a change that never happened.
    if (taskActions.get(id)?.type === 'left') {
      setTaskActions((s) => { const next = new Map(s); next.delete(id); return next; });
      return;
    }
    // A skip is reversed by the same intent-based verb that made it, not by
    // replaying saved fields: setItemSkipped owns skippedDates (and, for
    // habits, the status/streak interaction that goes with it).
    if (taskActions.get(id)?.type === 'skipped') {
      setItemSkipped(id, false, new Date());
      setTaskActions((s) => { const next = new Map(s); next.delete(id); return next; });
      return;
    }
    const prev = undoStack.get(id);
    if (!prev) return;
    if (prev.isScheduled !== undefined) {
      updateTask(id, { startDate: prev.startDate ?? undefined, isScheduled: prev.isScheduled, timeBucket: prev.timeBucket as TimeBucket, startTime: prev.startTime ?? undefined });
    } else {
      updateTask(id, { startDate: prev.startDate ?? undefined, startTime: prev.startTime ?? undefined });
    }
    setTaskActions((s) => { const next = new Map(s); next.delete(id); return next; });
    setUndoStack((s) => { const next = new Map(s); next.delete(id); return next; });
  };

  /**
   * The bulk carry. Recurring rows are excluded outright — not moved, and NOT
   * given a receipt either.
   *
   * planner-store's own bulk verb says it in as many words ("Callers are
   * responsible for excluding recurring items"), and this component is a
   * caller. A recurring row left alone here keeps its Skip today / ✕ controls
   * and stays in the unactioned count, which is the honest outcome: pretending
   * it was "Moved to tomorrow" would be a receipt for a write that must never
   * happen, and marking it actioned any other way would quietly retire a
   * decision the user never made.
   */
  /**
   * May this row be swept up by "Move all to tomorrow"?
   *
   * Recurring rows are excluded because moving one rewrites the whole series'
   * anchor. MILESTONES are excluded for a different reason and the same
   * consequence: a milestone's `startDate` is not a scheduling intention, it is
   * the goal's target date — the record of when the checkpoint was meant to
   * happen — so one habitual evening tap would walk a three-year goal's
   * deadline forward a day, every night, invisibly. Moving one deliberately is
   * still offered on the row itself; it is only the sweeping verb that refuses.
   *
   * Shared with `movableCount` rather than restated, so the footer button can
   * never offer a verb that is about to be a no-op.
   */
  const isCarryable = (t: Task) =>
    !justCompletedIds.has(t.id) &&
    !taskActions.has(t.id) &&
    !isRecurring(t) &&
    !milestoneIds.has(t.id);

  const handleMoveAllToTomorrow = () => {
    const tomorrow = tomorrowStr(userTimezone);
    pendingTasks.filter(isCarryable).forEach((t) => handleMoveTo(t.id, tomorrow));
  };

  const handleDone = async () => {
    await saveLastReviewDate(userId, today);
  };

  // How many rows the bulk verb would actually carry — the same predicate
  // handleMoveAllToTomorrow uses, recurring exclusion included. It gates the
  // footer button, so counting rows the verb refuses to touch would offer
  // "Move all to tomorrow" on an evening where it is a no-op.
  const movableCount = pendingTasks.filter(isCarryable).length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg border-border max-h-[85vh] overflow-hidden flex flex-col gap-0">
        {/* Header */}
        <DialogHeader className="pb-4">
          <DialogTitle className="text-foreground flex items-center gap-2 text-base">
            <Moon className="h-5 w-5 text-evening" />
            End of day
          </DialogTitle>
          <DialogDescription className="sr-only">
            End-of-day review: celebrate wins and carry forward what&apos;s unfinished.
          </DialogDescription>
        </DialogHeader>

        {/* Beacon greeting */}
        <div className="mb-5 rounded-xl bg-evening/10 border border-evening/20 px-4 py-3">
          <p className="text-sm text-foreground leading-relaxed">
            Hey! It&apos;s end of day — let&apos;s take a quick look at how today went 🌙
          </p>
        </div>

        <div className="flex-1 overflow-y-auto space-y-5 pr-1">

          {/* ── Done today (completed tasks + done habits) ────── */}
          {(preExistingCompletedTasks.length > 0 || doneHabits.length > 0) && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Done today
                </h3>
              </div>
              <ul className="space-y-1.5">
                {preExistingCompletedTasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 py-0.5">
                    <button
                      onClick={() => handleUnmarkDone(task.id)}
                      className="shrink-0 h-5 w-5 rounded-full border-2 border-success bg-success text-success-foreground flex items-center justify-center hover:bg-success/90 transition-colors"
                      title="Undo"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <span className="flex-1 text-sm text-muted-foreground line-through min-w-0 truncate">
                      {task.title}
                    </span>
                  </li>
                ))}
                {doneHabits.map((habit) => (
                  <li key={habit.id} className="flex items-center gap-2 py-0.5">
                    <button
                      onClick={() => handleToggleHabit(habit.id, 'pending')}
                      className="shrink-0 h-5 w-5 rounded-full border-2 border-success bg-success text-success-foreground flex items-center justify-center hover:bg-success/90 transition-colors"
                      title="Undo"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <span className="flex-1 text-sm text-muted-foreground line-through min-w-0 truncate">
                      {habit.title}
                    </span>
                    {streaksOn && ITEM_TYPES.habit.counters.streak && habit.streak > 1 && (
                      <span className="text-xs text-ai">🔥 {habit.streak}</span>
                    )}
                    <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">{ITEM_TYPES.habit.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Pending tasks (carry forward) ─────────────────── */}
          {pendingTasks.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Still on your list
                </h3>
              </div>
              <ul className="space-y-1">
                {pendingTasks.map((task) => {
                  const isDone = justCompletedIds.has(task.id);
                  const action = taskActions.get(task.id);
                  const hasAction = action !== undefined;
                  // A recurring row is offered a different verb, because the
                  // date controls have nothing to write on it: startDate is the
                  // series anchor, and there is no per-occurrence override to
                  // move instead. See handleMoveTo / handleSkipToday.
                  const recurring = isRecurring(task);
                  const canSkip = recurring && isSkippable(asItem(task));

                  return (
                    <li
                      key={task.id}
                      data-testid={`eod-task-row-${task.id}`}
                      className="flex items-center gap-2 py-1"
                    >
                      {/* Done toggle — click filled circle to undo */}
                      <button
                        onClick={() => isDone ? handleUnmarkDone(task.id) : handleMarkDone(task.id)}
                        className={cn(
                          'shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors',
                          isDone
                            ? 'border-success bg-success text-success-foreground hover:bg-success/90'
                            : 'border-border hover:border-success/60 hover:bg-success/10'
                        )}
                        title={isDone ? 'Undo' : 'Mark as done'}
                      >
                        {isDone && <Check className="h-3 w-3" />}
                      </button>

                      {/* Task title */}
                      <span className={cn(
                        'flex-1 text-sm leading-snug min-w-0 truncate',
                        isDone ? 'line-through text-muted-foreground' : 'text-foreground'
                      )}>
                        {task.title}
                      </span>

                      {/* Action pills — hidden once task is marked done */}
                      {!isDone && (
                        hasAction ? (
                          /* After action: show action label + Undo link */
                          <button
                            data-testid={`eod-undo-btn-${task.id}`}
                            onClick={() => handleUndo(task.id)}
                            className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {actionLabel(action, userTimezone)} · <span className="underline">Undo</span>
                          </button>
                        ) : (
                          /* Unactioned: show pill buttons */
                          <div className="flex items-center gap-1 shrink-0">
                            {recurring ? (
                              /* Skip today — the recurring row's stand-in for the
                                 date controls. Rendered only when the type can
                                 actually take a skip, so a hypothetical
                                 non-skippable recurring type keeps the ✕ alone
                                 rather than a button that would no-op. */
                              canSkip && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs gap-1 px-2"
                                  data-testid={`eod-skip-btn-${task.id}`}
                                  onClick={() => handleSkipToday(task.id)}
                                >
                                  <SkipForward className="h-3 w-3" />
                                  Skip today
                                </Button>
                              )
                            ) : (
                              <>
                                {/* Tomorrow → */}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs gap-1 px-2"
                                  data-testid={`eod-tomorrow-btn-${task.id}`}
                                  onClick={() => handleMoveTo(task.id, tomorrowStr(userTimezone))}
                                >
                                  Tomorrow
                                  <ArrowRight className="h-3 w-3" />
                                </Button>

                                {/* 📅 Date picker — native input on mobile, Popover on desktop */}
                                {/* Desktop: shadcn Popover + Calendar */}
                                <Popover
                                  open={datePickerOpenId === task.id}
                                  onOpenChange={(open) => setDatePickerOpenId(open ? task.id : null)}
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="hidden sm:inline-flex h-7 text-xs px-2"
                                      data-testid={`eod-datepicker-btn-${task.id}`}
                                    >
                                      📅
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-auto p-0" align="end">
                                    <Calendar
                                      mode="single"
                                      fromDate={dateFromYmd(tomorrowStr(userTimezone))}
                                      onSelect={(date) => {
                                        if (date) {
                                          handleMoveTo(task.id, formatDateInTz(date, userTimezone));
                                          setDatePickerOpenId(null);
                                        }
                                      }}
                                    />
                                  </PopoverContent>
                                </Popover>
                                {/* Mobile: label wrapping sr-only input — avoids onChange firing on scroll */}
                                <label
                                  htmlFor={`date-input-${task.id}`}
                                  className="sm:hidden inline-flex items-center justify-center h-7 w-7 rounded-md border border-input bg-background cursor-pointer text-sm"
                                >
                                  📅
                                  <input
                                    id={`date-input-${task.id}`}
                                    type="date"
                                    min={tomorrowStr(userTimezone)}
                                    className="sr-only"
                                    onBlur={(e) => { if (e.target.value) handleMoveTo(task.id, e.target.value); }}
                                    aria-label="Move task to date"
                                  />
                                </label>
                              </>
                            )}

                            {/* ✕ Dismiss */}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs px-2"
                              data-testid={`eod-dismiss-btn-${task.id}`}
                              onClick={() => handleDismiss(task.id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* ── Skipped habits ────────────────────────────────── */}
          {skippedHabits.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Circle className="h-4 w-4 text-muted-foreground/50" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Skipped today
                </h3>
              </div>
              <ul className="space-y-1.5">
                {skippedHabits.map((habit) => (
                  <li key={habit.id} className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-muted-foreground min-w-0 truncate">{habit.title}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-xs px-2 shrink-0"
                      onClick={() => handleToggleHabit(habit.id, 'done')}
                    >
                      Mark done
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Empty state */}
          {preExistingCompletedTasks.length === 0 &&
            pendingTasks.length === 0 &&
            doneHabits.length === 0 &&
            skippedHabits.length === 0 && (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">
                  Nothing scheduled today — you kept the day open. That&apos;s valid.
                </p>
              </div>
            )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 mt-2 border-t border-border shrink-0">
          {/* Move all to tomorrow — visible whenever ≥1 row it would move */}
          {movableCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              data-testid="eod-move-all-btn"
              onClick={handleMoveAllToTomorrow}
            >
              <ArrowRight className="h-3 w-3" />
              Move all to tomorrow
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={handleDone}>
            Done for today
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

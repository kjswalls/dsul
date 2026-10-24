'use client';

import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  ArrowLeftToLine,
  ArrowRight,
  CalendarDays,
  ChevronsRight,
  type LucideIcon,
} from 'lucide-react';

import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePlannerStore } from '@/lib/planner-store';
import { milestoneItemIds } from '@/lib/goals';
import { useMorningStore } from '@/lib/morning-store';
import { OVERDUE_COHORT_LABELS, splitOverdueCohorts, toDateOnly } from '@/lib/overdue';
import { itemTypeName } from '@/lib/item-registry';
import { isRecurring } from '@/lib/recurrence';
import { openEditFor } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { ItemTick, animateItemCheck } from '@/components/primitives/item-check';
import type { Item, Task, TaskItem } from '@/lib/planner-types';

/**
 * The past-due triage list — the body shared by the desktop tray (a portaled
 * Popover under the 50px bar) and the mobile bottom Drawer. One component, so
 * the two platforms can never drift on what an exit does or what a receipt says.
 *
 * The list NEVER renders in flow on the canvas. That is the whole feature: the
 * bar above it is 50px at every task count, and lib/use-fit-hour-px.ts derives
 * the schedule's hour height from the space below the bar. A list that grew in
 * flow drove hourPx to its MIN_HOUR_PX floor and destroyed the fit-to-height
 * contract at ~18 overdue items.
 *
 * Deliberately NOT components/primitives/task-row.tsx: that row has no date
 * column (the age stamp is the point here), its py-1.5 + line-clamp-2 body is
 * taller than 30px so reusing it would worsen the exact problem this fixes, its
 * useDraggable is meaningless inside a portal, and its whole-row click-to-edit
 * competes with the triage gesture (in a triage list the primary click must be
 * triage, so only the TITLE opens the editor here).
 */

/**
 * NOTHING IN THIS LIST ESCALATES WITH AGE. There was an ANCIENT_DAYS = 30
 * threshold here that promoted the date stamp to --warning-text, a token that
 * flips BRIGHT in dark mode — so the oldest rows were the loudest thing on the
 * surface and the list read as a severity ranking. Age is orientation, not a
 * grade: every stamp is muted, every row is the same weight, and the only thing
 * that ever changes a row's appearance is something the USER did to it (a
 * receipt) or something that happened to the item (a stale marker). See the copy
 * contract on BarCopy in components/ai/morning-check.tsx.
 */

/**
 * Group headers only earn their 24px when the list is long enough to need
 * navigating AND both cohorts actually exist — two headers over a five-row list
 * is chrome, not structure.
 */
const GROUP_HEADER_MIN_ROWS = 8;

/**
 * The one class string every exit on this surface shares.
 *
 * Before this there were three different buttons in a 112px column — a shadcn
 * ghost `Button` with an icon and a word at h-6, and two icon-only ghost h-6 w-6
 * squares — plus two more shapes in the footer, one of them a filled lime
 * primary. Five treatments for five sibling actions, none of them the language
 * the rest of the app had moved to.
 *
 * They are now one boxed hairline control: the day list's own row-action box
 * (RowControl in components/primitives/task-row.tsx — same rounded-[5px], same
 * border-border / bg-surface-3 / hover-wash token set, so a triage row's cluster
 * and a day row's cluster are the same object) at the compact proportions of the
 * item dialog's chips (components/primitives/property-chip.tsx).
 *
 * hover-wash, not hover:bg-accent, for RowControl's reason: these sit ON the
 * well (bg-surface-3), and swapping the background would make the button LIGHTEN
 * on hover while the row behind it darkens.
 *
 * A function rather than only a component, because two exits can't route through
 * TriageAction below: the sheet's picker has to BE a <label> wrapping an sr-only
 * <input type="date">, and the desktop picker has to be the element
 * PopoverTrigger clones. They wear the string directly. One string, so the
 * cluster cannot drift back into five boxes.
 *
 * @param labeled a control that shows its word; icon-only ones stay square so
 *                the cluster reads as one group rather than three loose glyphs.
 */
function actionClass(isSheet: boolean, labeled = false): string {
  return cn(
    'inline-flex flex-shrink-0 items-center justify-center rounded-[5px] border border-border bg-surface-3',
    'text-muted-foreground transition-colors hover-wash hover:border-muted-foreground hover:text-foreground',
    // No ring-offset — --tw-ring-offset-color defaults to #fff and would paint a
    // white hairline over the lime ring in dark mode. Same as PropertyChip.
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
    isSheet ? 'h-7' : 'h-[22px]',
    // text-xs on BOTH surfaces, not the text-2xs the date stamp uses: 10px is
    // the register for metadata you read only if you want it, and these are the
    // things the surface exists to let you press.
    labeled ? 'gap-1 px-1.5 font-medium text-xs' : isSheet ? 'w-7' : 'w-[22px]'
  );
}

/**
 * One exit, in the shared box.
 *
 * `label` is always the accessible name. `text` renders it visibly for the exits
 * that earn a word; the rest get a real Tooltip, which exists precisely BECAUSE
 * the name is missing from the box — so a control never carries both.
 */
function TriageAction({
  icon: Icon,
  label,
  text,
  isSheet,
  onClick,
  testId,
  className,
}: {
  icon?: LucideIcon;
  label: string;
  text?: string;
  isSheet: boolean;
  onClick: () => void;
  testId?: string;
  className?: string;
}) {
  const button = (
    <button
      type="button"
      aria-label={text ? undefined : label}
      data-testid={testId}
      onClick={onClick}
      className={cn(actionClass(isSheet, !!text), className)}
    >
      {/* 14px on every variant — RowControl's proportion inside a 22px box, and
          the standard pairing with text-xs elsewhere in the app. */}
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {text && <span className="truncate">{text}</span>}
    </button>
  );

  if (text) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export type TriageVariant = 'tray' | 'sheet';

/**
 * What the user did to a row during this session. Rows do NOT vanish when
 * actioned (see the snapshot note below) — they swap their control cluster for
 * a receipt, exactly like components/ai/eod-review.tsx:349-357.
 */
type RowAction =
  | { kind: 'done' }
  | { kind: 'today' }
  | { kind: 'date'; to: string }
  | { kind: 'braindump' };

/**
 * Why a snapshot row can no longer be triaged. The list is frozen but the WORLD
 * is not: the row title opens the modal edit dialog ON TOP of the tray (Radix
 * disables outside pointer events for the layer below, so the tray survives and
 * no pointerDownOutside fires), and the tray is deliberately non-modal, so the
 * day underneath stays live the whole time it is open.
 *
 * Both store verbs behind the exits fail CLOSED on an id they can't resolve
 * (planner-store.ts:703 and :725 return early), which is correct — but it left
 * the receipt to be stamped unconditionally afterwards, i.e. the tray telling
 * the user it had carried an item it had in fact not touched.
 */
type StaleReason = 'deleted' | 'completed' | 'recurring';

/**
 * @param live the item as the store has it RIGHT NOW; `undefined` = gone.
 *
 * One rule, two call sites (the render pass reads a map, the click handlers
 * re-read the store), so they can never drift on what "still actionable" means.
 * A habit under a snapshot id counts as gone for the same reason findTaskLike
 * refuses one (planner-store.ts:324): the task pipeline would no-op on it, so
 * every exit here would too.
 */
function staleReasonFor(live: Item | undefined): StaleReason | null {
  if (!live || live.type === 'habit') return 'deleted';
  // Turned recurring under the tray — the row's own title button opens the edit
  // dialog on top of this list, so it is a two-click trip from here.
  //
  // lib/overdue.ts refuses recurring items on the way IN (their misses are
  // per-date state, never a property of the item), and this is the same rule on
  // the way OUT: every exit in this list writes startDate, which for a recurring
  // item is the recurrence ANCHOR rather than the date of the row you are
  // looking at. "Move to Braindump" in particular would clear it and take the
  // whole series off the calendar — issue #187, the EOD ✕'s bug. So the row
  // stops offering exits rather than quietly mangling the series; the item is
  // now something the past-due pile has no opinion about.
  if (isRecurring(live)) return 'recurring';
  // 'pending' is the only status lib/overdue.ts:109 accepts, so anything else —
  // completed in the day list behind the tray, or 'cancelled' via the agent API
  // — means the item has left the pile for real and must not be carried.
  return live.status === 'pending' ? null : 'completed';
}

interface MorningTriageListProps {
  /** Live overdue list, in display order. Frozen at mount — see below. */
  items: TaskItem[];
  /** yyyy-MM-dd for "today", local — the same string the bar counts against. */
  todayStr: string;
  variant: TriageVariant;
  /**
   * Dismiss for the day. Owned by the parent rather than pulled from the store
   * here: dismissal unmounts this whole surface mid-click, so the keyboard has
   * to be moved somewhere deliberate first (morning-check.tsx useDismissWithFocus).
   */
  onDismiss: () => void;
}

export function MorningTriageList({
  items,
  todayStr,
  variant,
  onDismiss,
}: MorningTriageListProps) {
  const isSheet = variant === 'sheet';

  const liveItems = usePlannerStore((s) => s.items);
  const goals = usePlannerStore((s) => s.goals);
  const milestoneIds = useMemo(() => milestoneItemIds(goals), [goals]);
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
  const moveTaskToDate = usePlannerStore((s) => s.moveTaskToDate);
  const moveTasksToDate = usePlannerStore((s) => s.moveTasksToDate);
  const unscheduleTask = usePlannerStore((s) => s.unscheduleTask);
  const updateTask = usePlannerStore((s) => s.updateTask);
  const closeTray = useMorningStore((s) => s.close);

  /**
   * SNAPSHOT FROZEN AT OPEN. Both surfaces unmount their content when closed
   * (Radix Popover / vaul Drawer), so mounting IS opening and this lazy
   * initializer runs exactly once per open.
   *
   * Eighteen rows disappearing one at a time under a stationary cursor slides
   * the next row under the pointer — a misclick machine, and the reason EOD
   * snapshots too (eod-review.tsx:106-124). The BAR's count stays live; only
   * the list is frozen.
   *
   * It also removes the need for an undo stack: every row's pre-action field
   * values are still right here in the snapshot, so `restoreFrom` can read them
   * directly no matter how many times a row is actioned and undone.
   *
   * FROZEN IS NOT AUTHORITATIVE. A snapshot row is a record of what an item
   * looked like when the tray opened, and nothing more — `liveById` below is
   * what says whether it still describes anything. Freezing buys a stable
   * layout; it must never buy the tray permission to act on a stale record.
   */
  const [snapshot] = useState<TaskItem[]>(() => items);

  const [actions, setActions] = useState<Map<string, RowAction>>(new Map());
  /** Which row's date-picker popover is open (desktop only). */
  const [datePickerOpenId, setDatePickerOpenId] = useState<string | null>(null);

  const { recent, long } = useMemo(
    () => splitOverdueCohorts(snapshot, todayStr),
    [snapshot, todayStr]
  );

  const showGroupHeaders =
    recent.length > 0 && long.length > 0 && snapshot.length > GROUP_HEADER_MIN_ROWS;

  /**
   * The snapshot's rows, re-read against the LIVE store. This is the one place
   * the frozen list is allowed to notice the world moved: rows still never
   * disappear or reorder (that is the whole point of freezing them), they just
   * stop pretending to be actionable once they aren't. See StaleReason above.
   */
  const liveById = useMemo(() => {
    const ids = new Set(snapshot.map((t) => t.id));
    const map = new Map<string, Item>();
    for (const i of liveItems) if (ids.has(i.id)) map.set(i.id, i);
    return map;
  }, [liveItems, snapshot]);

  /**
   * Re-check at CLICK time, off the store rather than the render's map: the
   * receipt is a claim about what just happened, so it has to be gated on the
   * state the verb is about to see, not on the state the last paint saw.
   */
  const staleNow = (id: string): StaleReason | null =>
    staleReasonFor(usePlannerStore.getState().items.find((i) => i.id === id));

  /** Untouched this session AND still real — the only rows "Move all" may act on. */
  // Milestones are excluded here, at the same seam that already drops stale and
  // already-actioned rows — NOT left to moveTasksToDate to refuse. The verb does
  // refuse them (a milestone's startDate is the goal's target date, not a
  // scheduling intention), but this list also drives the button's count AND the
  // per-row `{kind:'today'}` receipts below. Left in, a refused milestone would
  // wear "Moved to today · Undo" for a write that never happened — the exact
  // hazard handleMoveAll's own comment names three lines down.
  const carryable = snapshot.filter(
    (t) =>
      !actions.has(t.id) &&
      staleReasonFor(liveById.get(t.id)) === null &&
      !milestoneIds.has(t.id)
  );

  const setAction = (id: string, action: RowAction) =>
    setActions((prev) => new Map(prev).set(id, action));

  const clearAction = (id: string) =>
    setActions((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  /*
   * Every exit below is guarded by staleNow() and stamps its receipt ONLY on the
   * far side of that guard. A receipt is a statement of fact ("this item is on
   * today now, here is the undo"), and the store verbs decline ids they cannot
   * resolve, so an unguarded setAction is the tray inventing an outcome. The
   * guard is also what keeps the receipt's Undo honest: restoreFrom reads the
   * snapshot's pre-action fields, which only mean anything if a write happened.
   */

  const handleDone = (item: TaskItem) => {
    if (staleNow(item.id)) return;
    toggleTaskStatus(item.id, 'completed', new Date());
    setAction(item.id, { kind: 'done' });
  };

  const handleMoveTo = (item: TaskItem, dateStr: string) => {
    if (staleNow(item.id)) return;
    moveTaskToDate(item.id, dateStr);
    setAction(item.id, dateStr === todayStr ? { kind: 'today' } : { kind: 'date', to: dateStr });
  };

  const handleBraindump = (item: TaskItem) => {
    if (staleNow(item.id)) return;
    // unscheduleTask, NOT a hand-rolled updateTask of the same four fields: only
    // 'Unschedule task:' is in SIGNIFICANT_ACTIONS (hooks/use-undo-toast.ts), so
    // the hand-rolled version ("Edit task:") was silently excluded from the undo
    // toast. That was the verified bug here.
    unscheduleTask(item.id);
    setAction(item.id, { kind: 'braindump' });
  };

  const handleMoveAll = () => {
    // Re-filtered off the store at click time for the same reason the single-row
    // verbs re-check: `carryable` is a render-time list, and the row that got
    // deleted or ticked off between paint and click is exactly the one this bug
    // was about. moveTasksToDate drops unresolvable ids on its own, so passing
    // them would ALSO mislabel the history entry — it counts what it kept, while
    // the receipts were stamped on what we sent.
    const targets = carryable.filter((t) => !staleNow(t.id));
    if (targets.length === 0) return;
    // ONE store verb => one history entry => one Cmd+Z. The old loop pushed N
    // snapshots, evicted the user's earlier history at MAX_HISTORY_SIZE=50, and
    // needed N presses to reverse one gesture.
    moveTasksToDate(
      targets.map((t) => t.id),
      todayStr
    );
    setActions((prev) => {
      const next = new Map(prev);
      // Only rows the user hasn't already handled — today's "Move all" re-stamps
      // rows you just triaged, which is how a triage pass undoes itself.
      targets.forEach((t) => next.set(t.id, { kind: 'today' }));
      return next;
    });
  };

  const handleUndo = (item: TaskItem, action: RowAction) => {
    // Only 'deleted' blocks a reversal, not the whole staleness test: a row
    // actioned 'done' is SUPPOSED to read as completed right now — that is our
    // own write — and testing for stale-in-general here would refuse to undo it.
    // A restore onto an id the store has dropped, though, writes nothing, and
    // clearing the receipt afterwards would claim it had.
    if (staleNow(item.id) === 'deleted') return;
    if (action.kind === 'done') {
      toggleTaskStatus(item.id, 'pending', new Date());
    } else {
      // All four scheduling fields, read off the frozen snapshot. Restoring all
      // four (rather than just the ones a given verb wrote) is what makes one
      // undo path correct for moveTaskToDate, the bulk moveTasksToDate — which
      // additionally clears startTime/isScheduled — and unscheduleTask alike.
      const restore: Partial<Task> = {
        startDate: item.startDate,
        timeBucket: item.timeBucket,
        startTime: item.startTime,
        isScheduled: item.isScheduled,
      };
      updateTask(item.id, restore);
    }
    clearAction(item.id);
  };

  const handleOpenEditor = (item: TaskItem) => {
    // The mobile sheet closes first: stacking the edit dialog on top of a vaul
    // drawer leaves two dismissable layers fighting over the back gesture.
    if (isSheet) closeTray();
    openEditFor(item, 'task');
  };

  const surfaceBg = isSheet ? 'bg-modal' : 'bg-popover';

  const renderRows = (rows: TaskItem[]) =>
    rows.map((item) => {
      const action = actions.get(item.id);
      const reason = staleReasonFor(liveById.get(item.id));
      // A completion WE performed is the receipt, not staleness — otherwise
      // ticking a row's checkbox would immediately overwrite its own "Done ·
      // Undo" with "Completed elsewhere".
      const stale = reason === 'completed' && action?.kind === 'done' ? null : reason;

      return (
      <TriageRow
        key={item.id}
        item={item}
        todayStr={todayStr}
        variant={variant}
        action={action}
        stale={stale}
        datePickerOpen={datePickerOpenId === item.id}
        onDatePickerOpenChange={(open) => setDatePickerOpenId(open ? item.id : null)}
        onDone={handleDone}
        onMoveTo={handleMoveTo}
        onBraindump={handleBraindump}
        onUndo={handleUndo}
        onOpenEditor={handleOpenEditor}
      />
      );
    });

  return (
    <>
      {/*
        PLAIN overflow, never a nested <ScrollArea>. components/ui/scroll-area.tsx
        puts the caller's className on the Radix ROOT while the Viewport is
        hardcoded `size-full`, so a max-h on it caps nothing — and worse,
        lib/use-fit-hour-px.ts:35 resolves ITS viewport by walking up to the
        nearest [data-slot="scroll-area-viewport"], so a second one in the
        document is an actively bad idea. Every capped floating list in this repo
        (omnibar, filter-popover, command, eod-review) uses plain overflow.

        overscroll-contain is mandatory: without it a wheel past the end of this
        list scroll-chains into the live schedule grid behind the tray.

        Padding note: px-1/pb-1 rather than a flat p-1 so the sticky group
        headers can sit flush against the top edge — a 4px pad above them would
        let rows scroll through the gap.
      */}
      <div
        className={cn(
          'overflow-y-auto overscroll-contain px-1 pb-1',
          !showGroupHeaders && 'pt-1',
          isSheet
            ? 'min-h-0 flex-1'
            : // 320px ≈ 10 rows + an 8px sliver of the 11th; the half-cut row IS
              // the scroll affordance. The dvh term keeps the tray off the
              // bottom of a short window.
              'max-h-[min(320px,calc(100dvh-340px))]'
        )}
      >
        {showGroupHeaders ? (
          <>
            <GroupHeader label={OVERDUE_COHORT_LABELS.recent} surfaceBg={surfaceBg} />
            {renderRows(recent)}
            <GroupHeader label={OVERDUE_COHORT_LABELS.long} surfaceBg={surfaceBg} />
            {renderRows(long)}
          </>
        ) : (
          renderRows(snapshot)
        )}
      </div>

      {/*
        Footer: two peers, and deliberately no primary.

        The dismissal used to be a filled lime `Button` — the loudest element on
        the surface, and the app's affirmative accent — sitting under a list of
        things you hadn't done. That composition has a reading whether or not
        anyone intended it: getting to zero is the goal, and the button is the
        reward for it. It isn't. Looking at the list IS the whole obligation, so
        both controls are the same quiet box (see actionClass) and the user can
        leave from either one without having cleared anything.

        "Hide until tomorrow", not "Done for today": it is the honest description
        of what dismiss() does (lib/morning-store.ts writes today's date and the
        bar returns in the morning), it matches the bar ✕'s aria-label word for
        word, and it doesn't tell someone they are finished with work they can
        see they haven't finished.
      */}
      <div
        className={cn(
          'flex shrink-0 items-center justify-between border-t border-border px-2.5',
          isSheet ? 'h-14 pb-2' : 'h-9'
        )}
      >
        {/* Gated on `carryable`, not on "rows without a receipt": a tray whose
            only remaining rows were deleted or completed elsewhere has nothing
            left to carry, and offering the button there is offering a no-op. */}
        {carryable.length > 0 ? (
          <TriageAction
            icon={ChevronsRight}
            label="Move all to today"
            text="Move all to today"
            isSheet={isSheet}
            testId="morning-move-all-btn"
            onClick={handleMoveAll}
          />
        ) : (
          <span />
        )}
        <TriageAction
          label="Hide until tomorrow"
          text="Hide until tomorrow"
          isSheet={isSheet}
          testId="morning-dismiss-btn"
          onClick={onDismiss}
        />
      </div>
    </>
  );
}

/**
 * Cohort heading. SENTENCE case with mono letterspacing — a deliberate
 * divergence from EOD's uppercase section headings (eod-review.tsx:264): those
 * label whole sections of a modal, these are quiet dividers inside one scroller
 * and uppercase at 10px reads as a second competing bar.
 */
function GroupHeader({ label, surfaceBg }: { label: string; surfaceBg: string }) {
  return (
    <div
      className={cn(
        // -mx-1 cancels the scroller's px-1 so the sticky band spans the full
        // tray width; px-3.5 puts the text back on the rows' text edge.
        'sticky top-0 z-10 -mx-1 flex h-6 items-center px-3.5 font-num text-2xs tracking-[0.04em] text-muted-foreground',
        surfaceBg
      )}
    >
      {label}
    </div>
  );
}

interface TriageRowProps {
  item: TaskItem;
  todayStr: string;
  variant: TriageVariant;
  action: RowAction | undefined;
  /** Set once the underlying item stopped matching the snapshot — see StaleReason. */
  stale: StaleReason | null;
  datePickerOpen: boolean;
  onDatePickerOpenChange: (open: boolean) => void;
  onDone: (item: TaskItem) => void;
  onMoveTo: (item: TaskItem, dateStr: string) => void;
  onBraindump: (item: TaskItem) => void;
  onUndo: (item: TaskItem, action: RowAction) => void;
  onOpenEditor: (item: TaskItem) => void;
}

/**
 * One triage row — 30px fixed on desktop, 38px on touch.
 *
 *   [☐ 16px] [title flex-1 truncate] [date 52px] [cluster 124px / 136px]
 *
 * BOTH trailing columns reserve their width and the cluster fades IN FLOW rather
 * than being absolutely positioned (which is what the dense day row does). A
 * ~1030px tray row has slack a day list doesn't, and reserving those 176px buys
 * a straight right edge down 60 rows with zero hover shift.
 *
 * EVERY ROW LOOKS THE SAME. Not "similar" — the same: same title weight, same
 * muted stamp, same three exits, whether the date on it is yesterday's or from
 * three months ago. The only two things that may ever change a row's appearance
 * are a receipt (the user acted on it) and a stale marker (the item changed under
 * the tray). Age is not one of them.
 */
function TriageRow({
  item,
  todayStr,
  variant,
  action,
  stale,
  datePickerOpen,
  onDatePickerOpenChange,
  onDone,
  onMoveTo,
  onBraindump,
  onUndo,
  onOpenEditor,
}: TriageRowProps) {
  const isSheet = variant === 'sheet';
  const startDate = item.startDate ? parseISO(toDateOnly(item.startDate)) : null;
  const dateLabel = startDate ? format(startDate, 'MMM d') : '';
  /**
   * Hover gives the FULL date, not "18 days ago".
   *
   * A day count is the aggregate the bar just stopped printing, restated one row
   * at a time — and it was strictly less useful than what it displaced: "May 2"
   * doesn't tell you which weekday that was or which year it belongs to, and a
   * stamp from last year is otherwise indistinguishable from one from this May.
   */
  const dateTitle = startDate ? format(startDate, 'EEEE, MMMM d, yyyy') : undefined;
  // A stale row shows the world's truth, never ours: the item is finished or
  // gone, so it renders complete-looking and offers nothing but the report.
  // The row keeps its slot — the snapshot never re-flows, that is the point —
  // it just stops claiming to be triageable.
  const isDone = stale === 'completed' || (stale === null && action?.kind === 'done');
  // Muted + struck through covers 'deleted' too: the title is the last trace of
  // something that no longer exists, and it must not read as live text.
  const isSpent = isDone || stale === 'deleted';
  // A row that has already exited via a non-completion verb keeps its checkbox
  // column (the leading edge must stay a straight line) but stops accepting
  // clicks: its receipt's Undo is the single reversal path. Stale rows have no
  // reversal path at all — there is nothing left to toggle.
  const checkboxInert = stale !== null || (action !== undefined && !isDone);

  return (
    <div
      data-testid={`morning-row-${item.id}`}
      // Registry type name ('task' | custom slug) — the Phase 6 selector policy.
      data-item-type={itemTypeName(item)}
      className={cn(
        'group flex items-center gap-2.5 rounded-[5px] px-2.5 hover:bg-accent',
        isSheet ? 'h-[38px]' : 'h-[30px]'
      )}
    >
      {/* Checkbox — the most important addition. Half of a three-month graveyard
          is already done in real life, and before this the only row exits were
          "carry it again" or "unschedule it", both of which GROW the pile.
          Treatment copied verbatim from components/primitives/task-row.tsx so
          the lime mark reads identically here and in the day list. */}
      <button
        type="button"
        disabled={checkboxInert}
        // Keyed off the ACTION, not off `isDone`: a row that reads as done
        // because it was completed somewhere else has no action to reverse, and
        // the old `action!` assertion would have handed undefined to onUndo.
        onClick={(e) => {
          if (action?.kind === 'done') onUndo(item, action);
          else {
            animateItemCheck(e.currentTarget);
            onDone(item);
          }
        }}
        aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
        className={cn(
          'relative flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden rounded-[5px] inset-ring transition-[background-color,box-shadow]',
          isDone
            ? 'inset-ring-check-fill bg-check-fill'
            : 'inset-ring-muted-foreground/45 bg-surface-3 hover:inset-ring-muted-foreground',
          checkboxInert && 'pointer-events-none opacity-40'
        )}
      >
        {isDone && <ItemTick />}
      </button>

      {/* Title — ONLY the title opens the editor, not the whole row. font-content
          + text-content always travel together in this codebase.

          Disabled once the item is gone: this button is how the item got
          deleted in the first place (title → edit dialog → delete), and
          re-opening the editor on an id the store no longer has is the one
          click that leads nowhere. */}
      <button
        type="button"
        disabled={stale === 'deleted'}
        onClick={() => onOpenEditor(item)}
        className={cn(
          'min-w-0 flex-1 truncate text-left font-content text-content',
          isSpent ? 'text-muted-foreground line-through' : 'text-foreground'
        )}
      >
        {item.title}
      </button>

      {/* Date stamp. Muted at every age, forever — this is the row's orientation
          ("which day was this line about?"), not its severity. It used to promote
          to --warning-text past 30 days, which in dark mode is a BRIGHT honey:
          the rows you'd been avoiding longest were the ones that glowed. */}
      <span
        title={dateTitle}
        className="w-[52px] flex-shrink-0 text-right font-num text-2xs text-muted-foreground"
      >
        {dateLabel}
      </span>

      {/* Trailing cluster: the controls, the receipt once the row is actioned,
          or — when the item stopped existing under us — what became of it.
          NO BARE ✕ HERE. Today's unlabeled ✕ meant *unschedule* while the
          footer's "Dismiss for today" meant *hide the UI* — two
          destructive-feeling affordances with different semantics, and that
          collision is part of how 18 became 18. ✕ now means exactly one thing
          (dismiss the bar until tomorrow) and lives only on the bar. */}
      <div
        className={cn(
          // gap-1, not gap-0.5: the exits carry hairline borders now (see
          // actionClass), and at a 2px gap three adjacent 1px edges read as one
          // segmented control rather than three separate targets.
          'flex flex-shrink-0 items-center justify-end gap-1',
          // Touch has no hover, so the sheet shows the cluster unconditionally —
          // and its 28px targets need 12px more reserved width than the desktop
          // 22px ones. Both numbers are FIXED, which is the part that matters:
          // reserving the column is what keeps the right edge straight down 60
          // rows with zero hover shift, and it is also what makes the receipt and
          // the controls occupy exactly the same slot.
          //
          // Both carry ~8px of slack over the measured content (≈116px / ≈128px:
          // a ~64px "Today" chip, two 22/28px squares, two 4px gaps). That slack
          // is a guard, not padding — this box has no overflow rule and it is
          // justify-end, so a cluster wider than its reservation spills LEFT, over
          // the date stamp. Text metrics move with the font; leave the margin in.
          isSheet ? 'w-[136px] opacity-100' : 'w-[124px]',
          // The stale marker is the one thing in this column that is not an
          // affordance, so it does NOT hide behind hover the way the controls
          // and the receipt do — a row silently refusing to be carried has to
          // say why while the eye is still on the list.
          !isSheet &&
            (stale
              ? 'opacity-100'
              : 'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100')
        )}
      >
        {stale ? (
          // "Repeats", not "Skipped" or anything with a verdict in it: it names
          // what the item BECAME, which is also the whole reason the exits went
          // away. Same muted register as the other two markers.
          <span className="w-full truncate text-right text-2xs text-muted-foreground">
            {stale === 'deleted' ? 'Deleted' : stale === 'recurring' ? 'Repeats' : 'Completed'}
          </span>
        ) : action ? (
          <button
            type="button"
            data-testid={`morning-undo-btn-${item.id}`}
            onClick={() => onUndo(item, action)}
            className="w-full truncate text-right text-2xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {receiptLabel(action)} · <span className="underline">Undo</span>
          </button>
        ) : (
          <>
            {/* "Today" is the only exit that keeps its word: it is the one people
                reach for without reading, and an unlabelled → is the least
                legible glyph in the set. The other two are the same box with the
                name in a tooltip. */}
            <TriageAction
              icon={ArrowRight}
              label="Move to today"
              text="Today"
              isSheet={isSheet}
              testId={`morning-today-btn-${item.id}`}
              onClick={() => onMoveTo(item, todayStr)}
            />

            {/* Pick a date. Desktop gets Calendar in a nested Popover; touch gets
                the sr-only native input pattern from eod-review.tsx:404-417 —
                copied exactly, because that shape exists so the picker's
                onChange doesn't fire while the wheel is being scrolled.

                Both wear actionClass() directly rather than going through
                TriageAction: this one has to be a <label> so the sr-only input
                stays clickable, and the desktop one has to be the element
                PopoverTrigger clones. They are the two reasons the shared style
                is a function and not just a component. */}
            {isSheet ? (
              <label
                htmlFor={`morning-date-input-${item.id}`}
                data-testid={`morning-date-btn-${item.id}`}
                aria-label="Pick a date"
                className={cn(actionClass(true), 'cursor-pointer')}
              >
                <CalendarDays className="h-3.5 w-3.5" />
                <input
                  id={`morning-date-input-${item.id}`}
                  type="date"
                  min={todayStr}
                  className="sr-only"
                  onBlur={(e) => {
                    if (e.target.value) onMoveTo(item, e.target.value);
                  }}
                  aria-label="Move to date"
                />
              </label>
            ) : (
              <Popover open={datePickerOpen} onOpenChange={onDatePickerOpenChange}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Pick a date"
                        data-testid={`morning-date-btn-${item.id}`}
                        className={actionClass(false)}
                      >
                        <CalendarDays className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Pick a date</TooltipContent>
                </Tooltip>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    fromDate={parseISO(todayStr)}
                    onSelect={(date) => {
                      if (!date) return;
                      onMoveTo(item, format(date, 'yyyy-MM-dd'));
                      onDatePickerOpenChange(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
            )}

            <TriageAction
              icon={ArrowLeftToLine}
              label="Move to Braindump"
              isSheet={isSheet}
              testId={`morning-backlog-btn-${item.id}`}
              onClick={() => onBraindump(item)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function receiptLabel(action: RowAction): string {
  switch (action.kind) {
    case 'done':
      return 'Done';
    case 'today':
      return 'Today';
    case 'braindump':
      return 'Braindump';
    case 'date':
      return format(parseISO(action.to), 'MMM d');
  }
}

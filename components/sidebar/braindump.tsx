'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { FolderOpen, Moon, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { GroupSection } from '@/components/primitives/group-section';
import { AddIconButton } from '@/components/primitives/add-icon-button';
import { RelayField } from '@/components/primitives/relay-field';
import { SurfaceHeader } from '@/components/primitives/surface-header';
import { NoticeSlot } from '@/components/notices/notice-slot';
import { DisplayMenu, type DisplayMenuHandle } from '@/components/primitives/display-menu';
import { DisplayShelf } from '@/components/primitives/display-shelf';
import { RailTooltip } from '@/components/primitives/pills';
import { KeyCap } from '@/components/planner/organize/primitives';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { formatKeys } from '@/lib/commands/keys';
import { usePlannerStore } from '@/lib/planner-store';
import { PlannerSkeleton } from '@/components/primitives/planner-skeleton';
import {
  isPlannerLoaded,
  selectPlannerSettled,
  usePlannerPreviewing,
  usePlannerVisible,
} from '@/lib/planner-ready';
import { captureTask, useHeldCount } from '@/lib/held-captures';
import { useUIStore, openAddDialog, openBulkAdd } from '@/lib/ui-store';
import { isBulkPaste } from '@/lib/bulk-add';
import { useViewStore } from '@/lib/view-store';
import { SIDEBAR_MIN_WIDTH } from '@/lib/sidebar-store';
import { narrowingClauseCount, passesFilters } from '@/lib/filters';
import {
  useBraindumpGroupBy,
  useDoStuffEnabled,
  useGoalFilterIds,
  useOrganizeEnabled,
} from '@/lib/extension-gates';
import { DoStuffList, DoStuffRow, SizeControl, wantsDoStuffRow } from '@/components/sidebar/do-stuff';
import { useDoStuffStore } from '@/lib/do-stuff';
import { groupRows, type RowGroup } from '@/lib/grouping';
import { isRowCompletedOn, orderRows } from '@/lib/sort-rows';
import { useSinkHold } from '@/hooks/use-sink-hold';
import { RELAY } from '@/lib/relay-config';
import { inactiveItemIdsOn, suppressionReason, suppressionLabel } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { useDragStore } from '@/lib/drag-store';
import { useSelectionStore } from '@/lib/selection-store';
import { placementOf } from '@/lib/dnd/handle-drag-end';
import { sidebarDropPlan } from '@/lib/dnd/sidebar-drop';
import { milestoneItemIds } from '@/lib/goals';
import { braindumpMembers } from '@/lib/braindump-members';
import type { Task, HabitItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The Braindump: every item that has no assigned day — unscheduled tasks
 * (no bucket) and habits with no bucket and no recurrence. Remains the DnD
 * source/target for scheduling ('sidebar' droppable = unschedule, see
 * lib/dnd/CONTRACT.md).
 */

/**
 * Persistent capture card at the foot of the sidebar — a boxed-plus and a
 * borderless field inside a pill that rhymes with the Braindump header. Enter
 * commits the title as a new unscheduled task (lands right here in the
 * braindump), clears, and holds focus — type, Enter, type, Enter. The plus
 * commits the same way, or focuses the field when it's empty.
 *
 * While the planner's load is in flight (a cold load, the look-only preview)
 * Enter still clears: the capture is HELD (lib/held-captures.ts) and lands when
 * the load finishes, and the row says so until it has. Over a failed load it is
 * added at once, and the row keeps saying so until a landing confirms it.
 */
function QuickAddRow({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const heldCount = useHeldCount();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);

  const commit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    const result = captureTask(trimmed);
    setTitle('');
    // Focus survives the re-render (same DOM node), but re-assert it so the
    // plus-button path lands the caret back in the field too.
    inputRef.current?.focus();
    // A held capture has no row yet, and lands mid-settle: never scroll for it.
    if (result !== 'added') return;
    // Keep the just-added item in view: once it mounts (two frames — one for
    // React's commit, one for layout) drop the scroll to the bottom so the new
    // row lands just above this card. A no-op when the list doesn't overflow,
    // so short lists never jump.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      })
    );
  };

  // The plus hands off to the full add dialog instead of quick-committing,
  // seeding it with whatever's typed so far. Enter stays the fast inline path.
  const openFull = () => {
    const trimmed = title.trim();
    // Not loaded, the dialog would be deferred (or dropped by a failed load)
    // with the text already cleared out of here. Keep the text where it is;
    // Enter can hold it.
    if (trimmed && !isPlannerLoaded()) {
      inputRef.current?.focus();
      return;
    }
    openAddDialog('task', undefined, undefined, trimmed || undefined);
    setTitle('');
    inputRef.current?.blur();
  };

  return (
    // Reads as one more task row at the foot of the list — same shape, spacing,
    // and hover wash as a braindump TaskRow, but with a boxed-plus where the
    // checkbox would be. It sits OUTSIDE the scroll area as a section child; the
    // list shrinks (flex) to make room, so this rides just under a short list and
    // pins above the omnibar when the list runs long. shrink-0 keeps it from
    // compressing. mx-[14px] mirrors the scroll list's inner px-[14px] and px-2
    // its rows' own padding, so the plus lands in the same column as the
    // checkboxes above it.
    //
    // -mt-2 cancels the section's gap-2 (both 8px), halving the space to the last
    // item (the list's own pb-2 still holds ~8px) without going flush. It eats
    // only the empty flex gap between siblings, landing exactly at the scroll
    // port's edge — never over a row when a long list is scrolled.
    <div
      data-testid="braindump-quick-add"
      data-focused={focused ? 'true' : 'false'}
      // A settle frame (lib/settle.ts), for the same reason as the paused strip:
      // it sits at the foot of a list that can change length on landing.
      data-settle-key="braindump:quickadd"
      data-settle-role="frame"
      className={cn(
        '-mt-2 mx-[14px] flex shrink-0 items-center gap-3 rounded-[5px] px-2 py-1.5',
        // Match the row hover: a flat --accent wash, landed instantly (no
        // transition), so hovering the foot of the list feels like hovering a row.
        'hover:bg-accent'
      )}
    >
      <AddIconButton
        size="md"
        onClick={openFull}
        aria-label="Open the full add dialog"
        // Brightens from its resting 80% to full foreground on focus, in step
        // with the placeholder — the whole row lights up as one.
        className={cn(focused && 'text-foreground')}
      />
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setTitle('');
            inputRef.current?.blur();
          }
        }}
        // A multi-line paste is a list, and a single-line input would silently
        // fold it into one garbled title. Hand it to the bulk-add dialog, which
        // shows the split before anything is created. The typed draft stays put
        // in this field — the paste, not the draft, is what's being promoted.
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text/plain');
          if (isBulkPaste(pasted)) {
            e.preventDefault();
            openBulkAdd({ text: pasted });
          }
        }}
        placeholder="Add item"
        aria-label="Add item"
        data-testid="braindump-quick-add-input"
        className={cn(
          '-mx-1 min-w-0 flex-1 bg-transparent px-1 font-content text-content text-foreground focus:outline-none',
          // "Add item" sits grayed like a ghost row until you focus it, then
          // brightens to a real title's foreground — an invitation to type.
          focused ? 'placeholder:text-foreground' : 'placeholder:text-muted-foreground'
        )}
      />
      {/* The field cleared, but nothing has landed yet: say where it went. */}
      {heldCount > 0 && (
        <span role="status" data-testid="quick-add-held" className="font-num text-2xs text-muted-foreground">
          Adds once synced
        </span>
      )}
      {/* Enter affordance — the row commits on Enter, so surface a ↵ keycap
          while it's focused to make that discoverable. Kept mounted (opacity,
          not conditional render) so the field width doesn't jump on focus. */}
      <kbd
        aria-hidden
        className={cn(
          'pointer-events-none flex-shrink-0 rounded-xs border border-border px-1 font-mono text-[10px] text-muted-foreground transition-opacity',
          focused ? 'opacity-100' : 'opacity-0'
        )}
      >
        ↵
      </kbd>
    </div>
  );
}

/**
 * The foot-of-the-sidebar home for everything currently paused.
 *
 * It sits OUTSIDE the scroll port, as a peer of the quick-add card, for two
 * reasons. It stays reachable without scrolling past the working list, which is
 * what makes it a recovery surface rather than another place to lose things.
 * And QuickAddRow parks a freshly captured row by scrolling the port to its
 * bottom — with this block inside, every capture would scroll past the new row
 * to land on a heading, which would break the type-Enter-type-Enter rhythm the
 * capture row exists for.
 *
 * Collapsed by default, and quiet: paused is not an error state, so no badge,
 * no warning colour, no dotted border — a muted heading and a count. The count
 * is the whole affordance; it answers "did I leave anything set aside?" without
 * making the answer feel like a debt.
 */
/**
 * `base` is MEMBERSHIP — what belongs in the braindump at all — and `rows` is
 * base narrowed by the Display menu. They are split so the header can say
 * "8 of 23": both numbers come from one predicate, rather than the header
 * re-deriving what the list already decided.
 *
 * A function rather than inline in the memo because the drop preview runs it a
 * second time, over the tasks as a drop would leave them: one predicate for
 * "what is here" and "where would this land" means the two cannot disagree.
 *
 * Membership itself lives in lib/braindump-members.ts, which the iPhone's port
 * is checked against; only the Display narrowing is this file's own.
 */
function braindumpRows(
  tasks: readonly Task[],
  habits: readonly HabitItem[],
  suppressedIds: ReadonlySet<string>,
  braindumpFilters: ReturnType<typeof useViewStore.getState>['braindumpFilters'],
  goalMemberIds: ReturnType<typeof useGoalFilterIds>
): { base: RowItem[]; rows: RowItem[] } {
  const base: RowItem[] = braindumpMembers(tasks, habits, suppressedIds);

  const rows = base.filter((row) => {
    // "Hide finished" asks the same dateless predicate that sinks, strikes and
    // counts the rows, so a recurring row (finished on no day the braindump can
    // name, issue #215) is never hidden while it draws as open.
    if (braindumpFilters.hideFinished && isRowCompletedOn(row, null)) return false;
    if (row.itemType === 'task') {
      return passesFilters(row.item, braindumpFilters, undefined, goalMemberIds);
    }
    return passesFilters(row.item, braindumpFilters, 'habit', goalMemberIds);
  });

  return { base, rows };
}

/**
 * Where a dragged item will land, drawn in the slot it will take. Not a TaskRow:
 * the real row is still mounted wherever the drag started, and a second TaskRow
 * would register the same draggable id twice.
 */
function LandingRow({ title, reveal }: { title: string; reveal: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);
  return (
    <div
      ref={ref}
      data-testid="braindump-landing"
      aria-hidden
      className="drop-line flex w-full items-center gap-2 px-2 pb-1.5 pt-2"
    >
      <span className="drop-ghost h-3.5 w-3.5 flex-shrink-0 rounded-[4px] border border-muted-foreground" />
      <span className="drop-ghost flex-1 truncate text-sm">{title}</span>
    </div>
  );
}

type PausedGroup = { key: string; label: string; rows: RowItem[] };

/**
 * `landing` is the habits a drop on the sidebar would pause. While there are
 * any, the section shows (even when nothing is paused yet) and opens, with a
 * landing line for each at its top, so the drag says where the habit will go.
 */
function PausedSection({
  groups,
  count,
  landing,
}: {
  groups: PausedGroup[];
  count: number;
  landing: readonly HabitItem[];
}) {
  const [open, setOpen] = useState(false);
  if (count === 0 && landing.length === 0) return null;
  const shown = open || landing.length > 0;

  return (
    <div
      data-testid="braindump-paused-section"
      // A settle frame (lib/settle.ts): the strip moves when the list above it
      // grows or shrinks on the preview → fresh swap.
      data-settle-key="braindump:paused"
      data-settle-role="frame"
      className="mx-[10px] mb-2 shrink-0 rounded-[10px] bg-surface-2"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={shown}
        data-testid="braindump-paused-toggle"
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover-wash"
      >
        <Moon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-content text-content text-muted-foreground">Paused</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count > 0 && count}</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            shown && 'rotate-90'
          )}
        />
      </button>
      {/* Plain overflow-y-auto, never <ScrollArea> — the Radix wrapper silently
          drops max-h and the list would grow without bound. */}
      {shown && (
        <div className="max-h-[40vh] overflow-y-auto px-[6px] pb-2">
          {landing.map((h, i) => (
            <LandingRow key={h.id} title={h.title} reveal={i === 0} />
          ))}
          {groups.map((group) => (
            <div key={group.key}>
              {/* Suppressed only when there is nothing to disambiguate — one
                  cause needs no heading, and a lone label would read as a
                  category rather than an explanation. */}
              {groups.length > 1 && (
                <p
                  className="text-muted-foreground px-2 pt-2 pb-0.5 text-[10.5px] font-medium tracking-wider uppercase"
                  data-testid="braindump-paused-group"
                >
                  {group.label}
                </p>
              )}
              {group.rows.map((row) => (
                <TaskRow key={row.item.id} row={row} context="braindump" />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ORGANIZE_OFF = 'Organize is off. Switch it on in Settings → Extensions';
const ORGANIZE_OFF_SHORT = 'Off. Switch it on in Settings → Extensions';

/**
 * The header controls' tooltip: the rail tooltip's shape (muted eyebrow over
 * the value), dropped below the row. `off` on the phone, where a tap would pop
 * one over the thumb that made it and there is no hover to earn it.
 */
function HeaderTip({
  off,
  label,
  detail,
  children,
}: {
  off?: boolean;
  label: string;
  detail?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (off) return <>{children}</>;
  return (
    <RailTooltip side="bottom" label={label} detail={detail}>
      {children}
    </RailTooltip>
  );
}

interface BraindumpProps {
  /**
   * 'mobile' is the phone's Braindump TAB. It differs from the sidebar only at
   * the top, where this header is the tab's whole chrome: the capsule, and the
   * notice slot under it, are inset off the screen edge so they line up with
   * the dated tabs' header card and with the dock; and every control in the
   * header — the Display shelf's text and ✕s included — reaches 28px for a
   * thumb (a setting's ✕ 25 × 28px, or 25 × 23 right above another ✕, which
   * takes the gap). Everything below that already sits on the paper backdrop
   * on both shells.
   */
  variant?: 'sidebar' | 'mobile';
  /**
   * Trailing content for the header row-pill. This capsule is the ONLY header
   * the phone's Braindump tab gets, so the shell hangs the user menu here
   * (design/mobile-redesign/BraindumpTab.dc.html); the sidebar has the canvas
   * header for that and passes nothing.
   */
  headerAccessory?: React.ReactNode;
}

export function Braindump({ variant = 'sidebar', headerAccessory }: BraindumpProps = {}) {
  const { tasks, habits, items, routines, seasons, goals, userTimezone } = usePlannerStore();
  // Action selector, not a whole-store destructure: actions are stable, and a
  // bare useUIStore() here re-rendered this whole column on every dialog open.
  const openDialog = useUIStore((s) => s.openDialog);
  const { braindumpFilters, braindumpSortBy } = useViewStore();
  // Resolved against what is switched on: 'goal' falls back to 'none' while
  // the Goals extension is off, rather than sectioning the whole list under
  // one "No goal" heading. See lib/extension-gates.ts.
  const braindumpGroupBy = useBraindumpGroupBy();
  const organizeOn = useOrganizeEnabled();
  /**
   * Do stuff (lib/do-stuff.ts). Switched off, the braindump is exactly the old
   * list: no row, no size control, and a walk in progress ends.
   */
  const doStuffOn = useDoStuffEnabled();
  const doingStuff = useDoStuffStore((s) => s.on) && doStuffOn;
  useEffect(() => {
    if (!doStuffOn && useDoStuffStore.getState().on) useDoStuffStore.getState().stop();
  }, [doStuffOn]);
  const isMobile = variant === 'mobile';
  // The scroll port — QuickAddRow drops it to the bottom after each add so the
  // new row stays visible above the sticky capture row.
  const listRef = useRef<HTMLDivElement>(null);
  // The Display menu's handle, shared with the shelf under the header: the
  // shelf's text opens the menu through it, and its ✕s park focus on the
  // trigger before the last setting, or a reset, takes the shelf away. A ref
  // rather than open state held here, so opening and closing the menu
  // re-render the menu alone and not every row of this list.
  const displayRef = useRef<DisplayMenuHandle>(null);

  const { isOver, setNodeRef } = useDroppable({ id: 'sidebar' });

  /**
   * Suppressed ids, resolved at TODAY.
   *
   * Today, not `selectedDate`: the braindump carries no date of its own, so a
   * paused row must not appear and vanish as the user walks the week (plan
   * decision 3). The set feeds two places — it is subtracted from the live list
   * below, and it builds the Paused section — because an item may satisfy both
   * predicates and rendering it twice makes the second copy a ghost that
   * shift-range and ⌘A silently skip.
   */
  const suppressedIds = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return inactiveItemIdsOn(items, toDateStr(new Date(), tz), {
      userTimezone: tz,
      routines,
      seasons,
    });
  }, [items, routines, seasons, userTimezone]);

  /**
   * The goal clause, resolved to item ids.
   *
   * Membership lives in `goal_items`, so the pure predicate cannot ask an item
   * row for it — the surface resolves it once and hands it down, the same
   * bargain `inactiveItemIdsOn` above makes. `null` is INERT, not empty: a
   * selection that names no live goal narrows nothing rather than emptying the
   * list (see lib/goals.ts) — and the same is true with the Goals extension
   * switched off, which is what makes that switch safe here (lib/extension-gates.ts).
   */
  const goalMemberIds = useGoalFilterIds(goals, braindumpFilters.goals);

  // Membership and the Display-narrowed list; see braindumpRows.
  const { base, rows } = useMemo(
    () => braindumpRows(tasks, habits, suppressedIds, braindumpFilters, goalMemberIds),
    [tasks, habits, braindumpFilters, suppressedIds, goalMemberIds]
  );

  /**
   * What a drop here would bring in, while a drag is over the list: the ids that
   * `unscheduleTask(s)` would actually move. Empty when the drop is a no-op (a
   * braindump row dragged over its own list, a habit from the canvas), and then
   * nothing lights.
   *
   * Read from the drag and selection stores at render time rather than
   * subscribed: this component already re-renders when `isOver` flips, which is
   * exactly when the answer can change, and a subscription would re-render the
   * whole list at every drag start as well. So the work here is once on enter
   * and once on leave, never per pointer move, and there are no per-row
   * droppables for collision to test against on every move either.
   */
  const landingIds = useMemo(() => {
    const none = new Set<string>();
    if (!isOver) return none;
    const activeId = useDragStore.getState().activeId;
    if (!activeId) return none;
    const moves = (id: string) => {
      if (suppressedIds.has(id)) return false;
      const task = tasks.find((t) => t.id === id);
      return !!task && placementOf(task).placed;
    };
    // The group branch in app-shell.tsx's handleDragEnd: the whole selection,
    // minus milestones (unscheduleTasks refuses them) — and when nothing in it
    // is writable, the drop falls through to the dragged row alone.
    const { selectedIds } = useSelectionStore.getState();
    if (selectedIds.has(activeId) && selectedIds.size >= 2) {
      const milestones = milestoneItemIds(goals);
      const group = [...selectedIds].filter((id) => !milestones.has(id) && moves(id));
      if (group.length) return new Set(group);
    }
    return moves(activeId) ? new Set([activeId]) : none;
  }, [isOver, tasks, goals, suppressedIds]);

  /**
   * The habits a drop here would PAUSE (see sidebarDropPlan): drawn as landing
   * rows at the top of the Paused section, which is where they will show.
   * Same read-at-render bargain as landingIds above.
   */
  const pausingRows = useMemo(() => {
    if (!isOver) return [];
    const activeId = useDragStore.getState().activeId;
    if (!activeId) return [];
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    const { selectedIds } = useSelectionStore.getState();
    const group = selectedIds.has(activeId) && selectedIds.size >= 2;
    // The shell drops a group whole; when nothing in it writes, it falls
    // through to the dragged row alone, whose plan is a subset of the group's.
    const ids = group ? [...selectedIds] : [activeId];
    const { pause } = sidebarDropPlan(ids, tasks, habits, milestoneItemIds(goals), todayStr, tz);
    return habits.filter((h) => pause.includes(h.id));
  }, [isOver, tasks, habits, goals, userTimezone]);

  /**
   * The list as it will read after the drop: the same membership and filters,
   * run over the tasks as `unscheduleTask` will leave them. Grouping and sorting
   * below then put each incoming item exactly where it will appear, and that
   * slot is what lights — there is no reorder in dsul (dnd-no-reorder.test.ts),
   * so where the row lands is decided by the list, not by the pointer.
   */
  const shownRows = useMemo(() => {
    if (landingIds.size === 0) return rows;
    const landed = tasks.map((t) =>
      landingIds.has(t.id)
        ? { ...t, isScheduled: false, timeBucket: undefined, startTime: undefined, startDate: undefined }
        : t
    );
    return braindumpRows(landed, habits, suppressedIds, braindumpFilters, goalMemberIds).rows;
  }, [landingIds, rows, tasks, habits, suppressedIds, braindumpFilters, goalMemberIds]);
  const landingShown = landingIds.size > 0 && shownRows.some((r) => landingIds.has(r.item.id));

  /**
   * The header's count: OPEN items, "23 undated", or "8 of 23" while a filter
   * narrows the list. Open, because the number is what is still waiting on a
   * day — finished rows sink to the foot of the list and are struck through,
   * and counting them would make ticking one off change nothing. Built on
   * `isRowCompletedOn` with no date, the same predicate that sinks and strikes
   * those rows, so a recurring row counts as open exactly as it draws.
   *
   * Hidden until the planner has loaded: the store starts empty, and "0
   * undated" over a list that is about to fill is a small lie on every launch.
   * `!isLoading` alone is not loaded (see app-shell.tsx), and a failed load
   * leaves an empty store too.
   */
  const loaded = usePlannerStore((s) => selectPlannerSettled(s) && !s.error);
  /**
   * The list body's own gate: bars until there is something to show, so a
   * cold launch never shows the empty-state poem ("A clear head") over an
   * account that is about to fill. Visible is the fresh load OR the look-only
   * preview (lib/planner-ready.ts). A FAILED load is settled, so visible, and
   * keeps the poem beside its Retry notice — which is why this is not `loaded`.
   */
  const visible = usePlannerVisible();
  /**
   * The look-only preview: the rows are this browser's cache, so the list body
   * and the paused strip refuse pointer and focus until the fresh data lands.
   * The quick-add and the sweep receipt stay live — a capture is held until
   * then (lib/held-captures.ts), and a receipt's actions say "Syncing…".
   */
  const previewing = usePlannerPreviewing();
  const openTotal = useMemo(() => base.filter((r) => !isRowCompletedOn(r, null)).length, [base]);
  const openShown = useMemo(() => rows.filter((r) => !isRowCompletedOn(r, null)).length, [rows]);
  const narrowed = narrowingClauseCount(braindumpFilters, goalMemberIds) > 0;
  // "0 undated" beside the empty state's own line reads flat, so an empty,
  // unfiltered list keeps the word. A filter that leaves nothing still counts
  // ("0 of 23"): that zero is news.
  const countLabel = !loaded ? null : narrowed ? (
    <>
      <span className="font-num">{openShown}</span>
      <span className="font-normal text-muted-foreground"> of </span>
      <span className="font-num">{openTotal}</span>
    </>
  ) : openTotal > 0 ? (
    <>
      <span className="font-num">{openTotal}</span>
      <span className="font-normal text-muted-foreground"> undated</span>
    </>
  ) : null;

  // The live binding, never a printed "N": new_task is rebindable, and a hint
  // that doesn't follow the rebinding starts lying the moment it moves. isMac
  // is read at render: the Braindump never server-renders (AppShell holds a
  // skeleton until mount), so there is no server pass for it to disagree with.
  const newTaskKeys = useShortcutKeys('new_task');
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const addKeys =
    newTaskKeys.length > 0 ? (
      <span className="flex items-center">
        Shortcut
        {formatKeys(newTaskKeys, isMac).map((k) => (
          <KeyCap key={k}>{k}</KeyCap>
        ))}
      </span>
    ) : undefined;

  /**
   * Everything currently set aside — the home paused work would otherwise not
   * have.
   *
   * Without this, "hidden entirely" means an indefinitely-paused item is absent
   * from the grid, the review, the past-due bar AND this list, and the only way
   * back is remembering it exists and searching its name. That is data loss
   * wearing a feature's clothes.
   *
   * Reads `items` rather than the projections on purpose: the section spans
   * dated and scheduled work that the braindump's own membership predicate
   * would never admit. That means re-applying the projection's subtask rule by
   * hand — a subtask has no standalone row anywhere else, and one surfacing
   * here as a free-floating item is exactly what that filter exists to prevent.
   *
   * Deliberately ignores braindumpFilters and braindumpGroupBy: those shape the
   * working list, and filtering the recovery surface would reintroduce the very
   * problem this section solves.
   */
  const pausedGroups: PausedGroup[] = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    // Grouped BY CAUSE rather than listed flat. With three layers able to hide
    // an item, a flat list of twelve rows can't tell you whether to resume an
    // item, a routine or a season — and the heading is the only place to say
    // so, because the row's trailing rail is width-budgeted down to the pixel
    // and has no slot to spend (see task-row.tsx's "quiet rail" note).
    const groups = new Map<string, PausedGroup>();
    for (const item of items) {
      if (!suppressedIds.has(item.id)) continue;
      if ('parentItemId' in item && item.parentItemId) continue;
      const reason = suppressionReason(item, todayStr, { userTimezone: tz, routines, seasons });
      // Self-paused items key on their RESUME DATE as well as the cause. The
      // heading is taken from whichever row lands in the bucket first, and
      // store order is sort_order/created_at — nothing to do with pause dates —
      // so a single 'paused' bucket puts "Paused until Sep 1" over an item that
      // has no scheduled return at all, or the bare "Paused" over one that does.
      // Container causes need no such split: every member of a routine shares
      // its one resume date by construction.
      const key = !reason
        ? 'paused'
        : reason.kind === 'routine'
          ? `routine:${reason.routine.id}`
          : reason.kind === 'season'
            ? `season:${reason.season.id}`
            : `paused:${reason.until ?? ''}`;
      const row: RowItem =
        item.type === 'habit'
          ? { itemType: 'habit' as const, item: item as unknown as HabitItem }
          : { itemType: 'task' as const, item: item as unknown as Task };
      const group = groups.get(key);
      if (group) group.rows.push(row);
      // A null reason can't normally reach here (suppressedIds and
      // suppressionReason agree), but falling back to the bare "Paused"
      // heading keeps a row visible rather than dropping it on the floor.
      else groups.set(key, { key, label: reason ? suppressionLabel(reason) : 'Paused', rows: [row] });
    }
    return [...groups.values()];
  }, [items, suppressedIds, routines, seasons, userTimezone]);

  const pausedCount = pausedGroups.reduce((n, g) => n + g.rows.length, 0);

  /**
   * Grouped first, then sorted WITHIN each group — the order Day × List uses,
   * and the rule the plan states: grouping owns the outer order.
   *
   * Sorting `rows` before this ran instead made the SECTIONS move. The map is
   * filled by walking the row list, so its insertion order — which is what
   * `[...groups.entries()]` returns — became "whichever group owns the first
   * row under the current ordering". Grouping by Project with Ordering off
   * rendered [Work, Home]; switching to Title A–Z rendered [Home, Work]. The
   * rows inside were right either way, which is why it reads as a jump rather
   * than as a bug.
   *
   * `orderRows` also sinks finished rows to the foot of each group. The date is
   * NULL, not today: the braindump carries no date of its own (locked decision
   * 3), and TaskRow already refuses to draw a recurring row as completed here
   * for that reason (`suppressCompletedLook`, issue #181). A recurring row that
   * shows no completion mark must not move as though it had one, so only
   * one-shot rows — which are what this list is almost entirely made of — sink.
   */
  const { completedAs, rootRef: sinkRootRef } = useSinkHold<HTMLElement>(setNodeRef);
  const grouped: RowGroup<RowItem>[] = useMemo(() => {
    // 'type' is the braindump's own value and has no canvas counterpart — the
    // canvas answers "what is in here" with the Type FILTER instead. Everything
    // else routes through the shared core, so 'project' resolves the container
    // axis through the registry here exactly as it does on the canvas.
    const groups: RowGroup<RowItem>[] =
      braindumpGroupBy === 'type'
        ? [
            { key: 'Tasks', label: 'Tasks', rows: shownRows.filter((r) => r.itemType === 'task') },
            { key: 'Habits', label: 'Habits', rows: shownRows.filter((r) => r.itemType === 'habit') },
          ].filter((g) => g.rows.length > 0)
        : // routines/seasons feed the gate values ('routine', 'season') and
          // goals the aspire one; each is inert for the values it does not
          // answer, so passing all three always is harmless.
          groupRows(shownRows, braindumpGroupBy, { routines, seasons, goals });
    return groups.map((g) => ({ ...g, rows: orderRows(g.rows, braindumpSortBy, null, completedAs) }));
  }, [shownRows, braindumpGroupBy, braindumpSortBy, routines, seasons, goals, completedAs]);

  // The first incoming row scrolls itself into view, so a slot below the fold
  // still shows. Only one: several revealing at once would fight.
  const firstLanding = grouped.flatMap((g) => g.rows).find((r) => landingIds.has(r.item.id))?.item.id;
  const sizeControl = (row: RowItem) =>
    doStuffOn && row.itemType === 'task' ? <SizeControl item={row.item} /> : undefined;
  const renderRow = (row: RowItem) =>
    landingIds.has(row.item.id) ? (
      <LandingRow key={row.item.id} title={row.item.title} reveal={row.item.id === firstLanding} />
    ) : (
      <TaskRow key={row.item.id} row={row} context="braindump" trailing={sizeControl(row)} />
    );

  /**
   * The list Do stuff sorts: what the braindump shows, in its order, with the
   * Display grouping set aside (sizes are the grouping while it runs). Built
   * from `rows`, not `shownRows`: a drag's landing preview is not something to
   * walk to.
   */
  const doStuffRows = useMemo(
    () => (doingStuff ? orderRows(rows, braindumpSortBy, null, completedAs) : rows),
    [doingStuff, rows, braindumpSortBy, completedAs]
  );
  const showDoStuffRow = doStuffOn && visible && (doingStuff || wantsDoStuffRow(rows));

  const organizeButton = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'h-6 w-6 text-muted-foreground hover:text-foreground',
        isMobile && 'size-7'
      )}
      onClick={() => openDialog({ type: 'organize', section: 'projects' })}
      // INERT, not absent, while the Organize console is off. A door that
      // vanishes teaches nothing; a door that is visibly shut and says why
      // is the "extension store" posture (lib/extension-gates.ts). The
      // console's own gate is the guard of last resort — this one is here so
      // the click never opens an empty room in the first place.
      disabled={!organizeOn}
      // Why it is shut: the tooltip says it on a pointer, this says it to a
      // screen reader, and the phone — which gets no tooltips — keeps the
      // native title it has always had.
      aria-description={organizeOn ? undefined : ORGANIZE_OFF}
      title={isMobile && !organizeOn ? ORGANIZE_OFF : undefined}
      aria-label="Organize projects & groups"
    >
      <FolderOpen className="h-4 w-4" />
    </Button>
  );

  return (
    <section
      ref={sinkRootRef}
      data-dnd-id="sidebar"
      data-dnd-over={isOver ? 'true' : 'false'}
      data-dnd-acts={landingIds.size > 0 || pausingRows.length > 0 ? 'true' : 'false'}
      // Separates the CONTENT scope from the DnD hook: data-dnd-id="sidebar"
      // currently does double duty as both, so a spec scoping assertions to the
      // braindump is really asserting against a drop target.
      data-testid="braindump"
      // The settle scope is the whole SECTION, not the scroller: the paused
      // strip and the quick-add are its flex siblings, and they move when a
      // short list grows (the scroller is flex-1 only when empty).
      data-settle-scope="braindump"
      // The look-only state, as view-root marks it: the waiting shimmer's
      // scope (app/globals.css). Not inert here: the section's scroller, notice
      // slot and quick-add stay live, and the rows below carry their own.
      data-preview={previewing ? 'true' : undefined}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      {/* Header — the shared double-card capsule (SurfaceHeader). The phone
          shell insets it off the screen edge; the sidebar column has no gutter
          of its own, so it stays flush there. */}
      {/* The title is a live count now, not the word. The list under it
          already says what it is; the header says how much of it is waiting.
          The name stays in the heading as screen-reader text, so the region is
          still called "Braindump" to anything that reads it rather than sees
          it — and the word itself comes back until there is a number worth
          showing (before the planner loads, and on an empty list). The lines
          glyph that used to lead the row went with it: it was decoration that
          drew exactly like a menu button and did nothing when clicked. */}
      <SurfaceHeader
        title={
          countLabel ? (
            <>
              <span className="sr-only">Braindump, </span>
              <span data-testid="braindump-count">{countLabel}</span>
            </>
          ) : (
            'Braindump'
          )
        }
        className={cn(isMobile && 'mx-[10px]')}
        // The Display shelf: what the menu has set, in words, under the pill —
        // and when a filter matches nothing, the only thing on screen that says
        // why the list below is showing its empty-state poem. It sits in flow,
        // and this header stands over a scrolling list, which only starts
        // scrolling a line sooner. (The canvas capsule's twin stands over the
        // hour grid, which pays for the line in hour height instead — see
        // header-capsule.tsx.) And the shelf is there only while something is
        // set, so a braindump with nothing set keeps the bare capsule.
        //
        // The sidebar's shelf keeps the layout of the narrowest column it can
        // have. Collapse and hover-peek animate the column between w-0 and its
        // width over 300ms with the braindump still mounted, so without a floor
        // the paragraph would re-wrap on every frame of the fold, growing taller
        // and pushing the list down as the column closed, and the collapsed
        // shelf would sit one value to a line, which every expand then unfolds
        // from. At rest the floor never binds — the column is never narrower
        // than SIDEBAR_MIN_WIDTH, less the capsule's 10px sides — and while it
        // folds, the column's own overflow clips the rest. The phone tab has no
        // collapsing column to ride out, so it takes no floor.
        below={
          <DisplayShelf
            surface="braindump"
            menu={displayRef}
            touch={isMobile}
            floor={isMobile ? undefined : SIDEBAR_MIN_WIDTH - 20}
          />
        }
      >
        {/* On the phone this row is the Braindump tab's ONLY header, so these
            controls are the whole surface's chrome and they were still wearing
            sidebar density — a 24px menu, a 24px organize button and a 16px
            add, which is that tab's primary action being aimed at with a thumb.
            The mobile mount grows all three to the 28px slot the artboard draws
            (BraindumpTab.dc.html), glyphs unchanged; the sidebar's 280px width
            budget is untouched. Same idiom as mobile-header.tsx's wrapper
            around this component's canvas twin.

            The menu itself is portalled, so the sidebar's 280px minimum never
            constrains its 240px panel. The shelf under the pill is the one
            part of the Display surface that spends the column's width, and it
            wraps rather than overflow. */}
        <span className={cn('flex', isMobile && '[&>button]:size-7')}>
          <DisplayMenu ref={displayRef} surface="braindump" trigger="icon" align="start" />
        </span>
        {/* A disabled button takes no pointer events (disabled:pointer-events-none
            in ui/button), so while Organize is off the tooltip hangs on a span
            around it — hover-only, not a tab stop, since the button it wraps is
            not one either. */}
        <HeaderTip
          off={isMobile}
          label="Organize"
          detail={organizeOn ? 'Projects & item types' : ORGANIZE_OFF_SHORT}
        >
          {organizeOn ? organizeButton : <span className="flex">{organizeButton}</span>}
        </HeaderTip>
        {/* No routines button here on purpose. This row is width-critical at
            the 280px minimum — the collapse control moved off it to buy the
            title ~30px, and a fifth control spends exactly that back. The
            manager is reached from the palette and from the item dialog's
            Routine chip instead. */}
        {/* Collapse used to sit here, as a fifth control. It moved onto the
            resize sash (components/sidebar/sidebar.tsx) so all the chrome
            that acts on the COLUMN — its width and whether it's there at all
            — lives on the column's own edge, and this row is left holding
            only things that act on the LIST. It also buys the title back
            ~30px, which is the difference between fitting and truncating at
            the 280px minimum width. ⌘[ is unchanged. */}
        {/* The box is the mark here, not a hit area — a 28px bordered square
            would read as a fourth well in the row — so the phone gets the
            reach through a pseudo-element instead: 16px drawn, 28px tappable,
            which lands inside the 8px gap without covering its neighbour. */}
        <HeaderTip off={isMobile} label="Add task" detail={addKeys}>
          <AddIconButton
            size="md"
            onClick={() => openAddDialog('task')}
            aria-label="Add task"
            className={cn(
              isMobile && "relative before:absolute before:-inset-[6px] before:content-['']"
            )}
          />
        </HeaderTip>
        {headerAccessory}
      </SurfaceHeader>

      {/* The sweep receipt, standing on the list it added to.
          "12 items put aside this morning" needs no words to say WHICH items —
          they are the rows immediately below it, and "Put back" is next to the
          things that would move. Outside the scroller on purpose: a receipt you
          have to scroll to find is a receipt you never see, and this is the
          surface the sweep's own consequence lives on.

          It renders nothing when there is no receipt, and it registers the
          `braindump` anchor only while it is mounted — so on the phone, where
          this component lives on one tab, a receipt raised while you are on Today
          falls back to the dock's line by itself. */}
      <NoticeSlot anchor="braindump" className={cn(isMobile ? 'mx-[10px]' : 'px-[6px]')} />

      {/* Do stuff's row: below the header, above the list (design board C). */}
      {showDoStuffRow && <DoStuffRow rows={doStuffRows} />}

      {/* List — sits directly on the paper backdrop, no card. A plain
          overflow-y-auto container, NOT Radix <ScrollArea>: it shrinks (flex) so
          the quick-add card below can pin to the section foot, and its ref drives
          scroll-to-bottom after each add. It fills the column only when empty, so
          the empty-state poem stays vertically centered.

          overflow-x is pinned hidden, not left alone: CSS promotes an untouched
          `visible` to `auto` the moment the other axis scrolls, so overflow-y
          here quietly made the port horizontally scrollable too — and the empty
          state's relay field, which overhangs its box by design, then poked far
          enough past the padding to raise a horizontal scrollbar under an empty
          braindump. It clips a couple of px the field's mask has already faded
          to nothing. */}
      <div
        ref={listRef}
        className={cn(
          'min-h-0 overflow-y-auto overflow-x-hidden rounded-card transition-colors',
          // Fill the column only when there is genuinely nothing here — a
          // paused-only sidebar still wants the poem's space collapsed so the
          // Paused strip sits under the header rather than adrift at the foot.
          // Not while the bars are up: the skeleton sits where rows will, so the
          // quick-add card sits under it as it sits under real rows, rather
          // than jumping from the foot when the load lands.
          visible && shownRows.length === 0 && pausedCount === 0 && 'flex-1',
          // The whole list lights only when what is landing will be hidden by
          // the Display filters, so there is no row slot to show instead.
          landingIds.size > 0 && !landingShown && 'drop-armed'
        )}
      >
        <div className="px-[14px] py-2" inert={previewing}>
          {!visible ? (
            <PlannerSkeleton variant="braindump" />
          ) : doingStuff ? (
            <DoStuffList rows={doStuffRows} />
          ) : (
            grouped.map((g) =>
              g.label ? (
                <GroupSection
                  key={g.key}
                  groupKey={g.key}
                  label={g.label}
                  gate={g.gate}
                  className="pt-5 first:pt-1"
                  forceOpen={landingIds.size > 0 && g.rows.some((r) => landingIds.has(r.item.id))}
                >
                  {g.rows.map(renderRow)}
                </GroupSection>
              ) : (
                <div key="all" className="space-y-0">
                  {g.rows.map(renderRow)}
                </div>
              )
            )
          )}

          {visible && shownRows.length === 0 && pausedCount === 0 && (
            <div className="relative flex min-h-[220px] flex-col items-center justify-center gap-2 py-12 text-center">
              {RELAY.emptyState && (
                // pitch matches the dock capsule (20) — tile size derives from it.
                // The field overhangs the box horizontally and its mask reaches
                // full transparency inside its own bounds (closest-side), so the
                // grid dissolves at every edge instead of being clipped mid-tile.
                <RelayField
                  className="absolute -inset-x-4 inset-y-0 z-0"
                  focalY={0.45}
                  pitch={20}
                  period={4.5}
                  idleIntensity={0.35}
                  mask="radial-gradient(closest-side at 50% 45%, black 0%, black 40%, transparent 100%)"
                />
              )}
              <p className="relative z-10 font-serif text-base italic text-muted-foreground">
                A clear head. Drop stray thoughts here.
              </p>
              <button
                onClick={() => openAddDialog('task')}
                className="relative z-10 text-xs text-success-text hover:underline underline-offset-2"
              >
                + Add something
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inert with the list body while previewing. `contents`, so the wrapper
          joins no layout: the strip stays the section's own flex child, and
          its settle frame key sits on its root, which has a box. */}
      <div inert={previewing} className="contents">
        <PausedSection groups={pausedGroups} count={pausedCount} landing={pausingRows} />
      </div>

      {/* Quick-add — a floating card at the section foot, peer of the header. */}
      <QuickAddRow scrollRef={listRef} />
    </section>
  );
}

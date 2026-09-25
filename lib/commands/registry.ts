import {
  CalendarCheck,
  CalendarDays,
  CalendarMinus,
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Columns3,
  Contrast,
  Filter,
  FilterX,
  FolderOpen,
  FolderPlus,
  Inbox,
  Keyboard,
  Layers,
  Leaf,
  ListPlus,
  MessageSquare,
  Moon,
  PanelLeft,
  Palette,
  Plus,
  Redo2,
  Rows3,
  Search,
  Settings,
  SlashSquare,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Bug,
  AlarmClock,
  CheckCircle2,
  Clock,
  Flag,
  Flame,
  SkipForward,
  Trash2,
  Type,
  Undo2,
  Unlink,
  Wand2,
  Zap,
  Repeat as RepeatIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Target,
} from 'lucide-react';
import { addDays, subDays } from 'date-fns';

import { usePlannerStore } from '../planner-store';
import { useViewStore } from '../view-store';
import { EMPTY_VIEW_FILTERS, isEmptyFilters } from '../filters';
import { containerRef, namesOfKind } from '../container-registry';
import { useUIStore, openAddDialog, openBulkAdd } from '../ui-store';
import {
  goalsEnabled,
  groupByOptionsFor,
  organizeEnabled,
  resolvedCanvasGroupBy,
  streaksEnabled,
} from '../extension-gates';
import { useSidebarStore } from '../sidebar-store';
import { useSelectionStore, selectableIdsInDom } from '../selection-store';
import { useMobileNavStore } from '../mobile-nav-store';
import { useMorningStore } from '../morning-store';
import { useEODStore } from '../eod-store';
import { useChatStore } from '../chat-store';
import { useProposalStore } from '../proposal-store';
import { goToDate, stepScope } from '../nav-commands';
import { resolveCategoryIcon } from '../category-icons';
import { getItemTypeConfig, isSkippable, isPausable, itemTypeName } from '../item-registry';
import { selectOverdue } from '../overdue';
import { inactiveItemIdsOn, isPausedOn, isProgramActiveOn } from '../active';
import { programStateForSwitch } from '../scope-rail';
import { toDateStr } from '../recurrence';
import { PRIORITY_LABELS, TIME_BUCKET_RANGES } from '../planner-types';
import { isScalableLayout } from '../week-columns';
import { CANVAS_GROUP_BY_OPTIONS, LAYOUT_OPTIONS, TYPE_OPTIONS } from '../view-options';
import {
  assignBucket,
  isCancelled,
  isDoneOn,
  isHabit,
  isPausedNow,
  isSkippedOn,
  isTaskLike,
  itemCommand,
  nextDayStr,
} from './entities';
import type { Command, CommandArgOption, CommandContext, CommandProvider } from './types';
import type { TypeFilter, ViewLayout } from '../view-store';
import type { GroupBy, Priority, TimeBucket, Routine, Program, Goal } from '../planner-types';

/**
 * The command registry.
 *
 * Round 1 shipped one rule: a command was in here only if it was GLOBAL (it
 * needed no target item, because there was no selection model — see
 * lib/hovered-item.ts for why hover is not one) and VERIFIED (its hook has a
 * live consumer). The second half still holds; the first is now lifted.
 *
 * Round 2 added the missing primitive — the `entity` argument
 * (lib/commands/entities.ts), which resolves "which item did you mean" against
 * the planner store. That is what the Items group below is built on, and it is
 * why this file is no longer a flat array: `resolveCommands(ctx)` is the
 * registry as the palette sees it, and it is the static list PLUS whatever the
 * providers derive from live data (today, one "Add ‹type›" per hydrated custom
 * item type). STATIC_COMMANDS remains the only thing that may own a keyboard
 * shortcut, because bindings are persisted by id and a command that can vanish
 * cannot own one.
 *
 * Still parked, and not for want of machinery: renaming a project or group.
 * Items reference their container BY NAME, so a rename orphans every child —
 * that is a data-model fix (stable container ids) before it is a command.
 *
 * Several app settings are deliberately absent rather than dead: compact mode,
 * chill mode, the current-time indicator, default view, morning-check time,
 * assistant name and the custom system prompt all persist correctly but are
 * read by nothing on screen today. Their setters are untouched — adding a
 * command is one entry here the day a view consumes them again.
 *
 * Declaration order is the palette's within-group order, and the matcher's
 * final tie-break. Put the thing you reach for most first.
 */

/* ── helpers ───────────────────────────────────────────────────────────── */

const planner = () => usePlannerStore.getState();
const view = () => useViewStore.getState();

/**
 * Said once, on all three column-width bindings. Their `availableWhen` is the
 * enforcement (`scope === 'week' && isScalableLayout(layout)`); this is the
 * same fact in words, for the shortcuts table — see CommandShortcutSpec.context.
 */
const WEEK_COLUMNS_CONTEXT = 'Only in a week view with columns.';

/**
 * "Set priority" and "Move to bucket" want TWO values — an item and a level.
 * The argument model holds one, and rather than grow a multi-chip flow for two
 * commands, each value gets its own command: "Set priority: High" then pick the
 * item. Same trade the flattened enums make (types.ts, `flatten`) — a known
 * value costs one keystroke instead of a second browse — and the same reason
 * these are generated rather than typed out seven times: the levels are data
 * the app already owns.
 */
function priorityCommands(): Command[] {
  return (Object.keys(PRIORITY_LABELS) as Priority[]).map((priority) =>
    itemCommand({
      id: `items.priority.${priority}`,
      label: `Set priority: ${PRIORITY_LABELS[priority]}`,
      icon: Flag,
      keywords: `priority ${priority} importance urgent level set`,
      aliases: [priority],
      placeholder: 'Which task?',
      emptyLabel: `Nothing left to set to ${PRIORITY_LABELS[priority].toLowerCase()}`,
      // Habits carry no priority field.
      eligible: (item) => isTaskLike(item) && item.priority !== priority && !isCancelled(item),
      detail: (item) =>
        isTaskLike(item) && item.priority ? PRIORITY_LABELS[item.priority] : undefined,
      run: (item) => planner().updateTask(item.id, { priority }),
    })
  );
}

function bucketCommands(): Command[] {
  return (Object.keys(TIME_BUCKET_RANGES) as TimeBucket[]).map((bucket) =>
    itemCommand({
      id: `items.bucket.${bucket}`,
      label: `Move to ${TIME_BUCKET_RANGES[bucket].label}`,
      icon: BUCKET_ICONS[bucket],
      keywords: `move bucket ${bucket} time when reschedule`,
      aliases: [bucket],
      emptyLabel: `Nothing left to move to ${TIME_BUCKET_RANGES[bucket].label.toLowerCase()}`,
      eligible: (item, dateStr) =>
        item.timeBucket !== bucket && !isDoneOn(item, dateStr) && !isCancelled(item),
      detail: (item) =>
        item.timeBucket ? TIME_BUCKET_RANGES[item.timeBucket].label : undefined,
      run: (item) => assignBucket(item, bucket),
    })
  );
}

const BUCKET_ICONS: Record<TimeBucket, Command['icon']> = {
  anytime: Clock,
  morning: Sunrise,
  afternoon: Sun,
  evening: Sunset,
};

function optionsFrom<T extends string>(
  list: { value: T; label: string; icon: CommandArgOption['icon'] }[],
  current: T
): CommandArgOption[] {
  return list.map((o) => ({
    value: o.value,
    label: o.label,
    icon: o.icon,
    active: o.value === current,
  }));
}

/* ── the static registry ───────────────────────────────────────────────── */

export const STATIC_COMMANDS: Command[] = [
  /* ── Create ─────────────────────────────────────────────────────────── */
  {
    id: 'create.task',
    label: 'Add task',
    group: 'create',
    icon: Plus,
    keywords: 'new create todo',
    aliases: ['task'],
    shortcut: { id: 'new_task', keys: ['n'] },
    run: () => openAddDialog('task'),
  },
  {
    id: 'create.habit',
    label: 'Add habit',
    group: 'create',
    icon: Plus,
    keywords: 'new create routine streak',
    aliases: ['habit'],
    run: () => openAddDialog('habit'),
  },
  {
    id: 'create.bulk',
    label: 'Add many items…',
    description: 'Paste a list or import a file — one item per line',
    group: 'create',
    icon: ListPlus,
    keywords: 'bulk multiple paste import csv list batch many',
    aliases: ['bulk', 'import'],
    run: () => openBulkAdd(),
  },
  {
    id: 'create.project',
    label: 'Add project',
    description: 'Create a project you can file tasks under',
    group: 'create',
    icon: FolderPlus,
    keywords: 'new folder category group',
    aliases: ['project'],
    argument: {
      kind: 'text',
      placeholder: 'Project name',
      validate: (value) => {
        const name = value.trim();
        if (!name) return 'Enter a project name';
        // addProject no-ops silently on an exact duplicate, so without this the
        // palette would report success and do nothing.
        const clash = planner().projects.find(
          (p) => p.name.toLowerCase() === name.toLowerCase()
        );
        return clash ? `“${clash.name}” already exists` : null;
      },
    },
    // Empty glyph on purpose: resolveCategoryIcon then derives the icon from
    // the name ("Gym" → dumbbell). Passing a hardcoded token would give every
    // palette-created project the same wrong icon.
    run: (_ctx, arg) => planner().addProject((arg ?? '').trim(), ''),
  },

  /* ── Items ──────────────────────────────────────────────────────────────
     Everything here takes an entity argument: you pick the command, then the
     item. Eligibility is declared once per command and drives both the picker
     and the greyed-out state — see lib/commands/entities.ts. */
  itemCommand({
    id: 'items.complete',
    label: 'Complete',
    description: 'Tick off a task or habit on the day you are looking at',
    icon: CheckCircle2,
    keywords: 'complete done finish tick check off mark',
    aliases: ['complete', 'done'],
    emptyLabel: 'Nothing left to complete',
    eligible: (item, dateStr) => !isDoneOn(item, dateStr) && !isCancelled(item),
    run: (item) =>
      isHabit(item)
        ? planner().toggleHabitStatus(item.id, 'done')
        : planner().toggleTaskStatus(item.id, 'completed'),
    // A batch loops the single verbs rather than calling setItemsCompleted:
    // they keep per-date completion for recurring items, the +1 streak per
    // habit and the live Beeminder post. Quiet so the loop celebrates once and
    // raises one offer per goal, not one per item.
    quietBatch: true,
    batchLabel: (n) => `Complete items (${n})`,
  }),
  itemCommand({
    id: 'items.delete',
    label: 'Delete',
    icon: Trash2,
    keywords: 'delete remove destroy trash',
    aliases: ['delete'],
    emptyLabel: 'Nothing to delete',
    // The one command here with no eligibility rule beyond existing: you can
    // always delete anything, including something already completed.
    eligible: () => true,
    run: (item) => {
      const config = getItemTypeConfig(itemTypeName(item));
      // Confirmed, not immediate. Every other item command is a single undo
      // away; this one destroys a habit's whole history with it, so it goes
      // through the same prompt the item dialog uses, with that type's copy.
      useUIStore.getState().confirm({
        title: `Delete ${config.label.toLowerCase()}?`,
        description: config.form.deleteDescription(item.title),
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: () =>
          isHabit(item) ? planner().deleteHabit(item.id) : planner().deleteTask(item.id),
      });
    },
    // Not the default loop: `confirm` is a single slot, so N prompts would
    // leave only the last standing and delete one item. One prompt, then one
    // deleteItems — a single entry that raises the undo strip, which is why
    // this copy says undo where the bulk bar's still says it cannot be undone.
    runMany: (items) => {
      const habits = items.filter(isHabit).length;
      useUIStore.getState().confirm({
        title: `Delete ${items.length} items?`,
        description:
          'They’ll be removed along with any subtasks.' +
          (habits
            ? ` ${habits === 1 ? 'One is a habit' : `${habits} are habits`} — ${
                habits === 1 ? 'its' : 'their'
              } completion history goes too.`
            : '') +
          ' You can undo this right after.',
        confirmLabel: `Delete ${items.length}`,
        destructive: true,
        onConfirm: () => {
          // Re-read at confirm time: the prompt can sit open across a sync.
          const live = new Set(planner().items.map((i) => i.id));
          planner().deleteItems(items.map((i) => i.id).filter((id) => live.has(id)));
        },
      });
    },
  }),
  itemCommand({
    id: 'items.snooze',
    label: 'Snooze to tomorrow',
    description: 'Push an item forward one day',
    icon: AlarmClock,
    keywords: 'snooze postpone defer later push tomorrow delay',
    aliases: ['snooze'],
    emptyLabel: 'Nothing to snooze',
    // Habits are date-blind by construction (dateAnchored: false) — there is
    // no date on them to move.
    eligible: (item, dateStr) => isTaskLike(item) && !isDoneOn(item, dateStr) && !isCancelled(item),
    run: (item, dateStr) => planner().updateTask(item.id, { startDate: nextDayStr(item, dateStr) }),
  }),
  itemCommand({
    id: 'items.skip',
    label: 'Skip today',
    description: "Marks the day skipped — for a habit, without breaking the streak",
    icon: SkipForward,
    keywords: 'skip habit rest day pass miss recurring',
    aliases: ['skip'],
    placeholder: 'Which item?',
    emptyLabel: 'Nothing left to skip today',
    // Registry capability, not "is it a habit": any recurring occurrence of a
    // skippable type can be skipped (#194). One-shot items are excluded by
    // isSkippable — they get completed or cancelled, never skipped.
    eligible: (item, dateStr) =>
      isSkippable(item) && !isDoneOn(item, dateStr) && !isSkippedOn(item, dateStr),
    // No date argument, exactly as before: the store resolves the selected day,
    // which is the same day `dateStr` was derived from.
    run: (item) => planner().setItemSkipped(item.id, true),
  }),
  itemCommand({
    id: 'items.resetStreak',
    label: 'Reset streak',
    description: 'Zeroes the counter; completion history is kept',
    icon: Flame,
    keywords: 'reset streak counter zero habit start over',
    aliases: ['streak'],
    placeholder: 'Which habit?',
    emptyLabel: 'No habit has a streak to reset',
    eligible: (item) => isHabit(item) && item.streak > 0 && streaksEnabled(),
    detail: (item) => (isHabit(item) && streaksEnabled() ? `🔥 ${item.streak}` : undefined),
    run: (item) => planner().resetHabitStreak(item.id),
  }),
  itemCommand({
    id: 'items.leaveProjectBlock',
    label: 'Move out of project block',
    description: 'Returns the task to the time it had before the block claimed it',
    icon: Unlink,
    keywords: 'project block remove out release detach unblock',
    aliases: ['unblock'],
    placeholder: 'Which task?',
    emptyLabel: 'No task is in a project block',
    // Task-like, matching the verb: moveTaskOutOfProjectBlock resolves against
    // findTaskLike now, so a custom item that got into a block can get out of
    // one. It used to resolve 'task' exactly, which is why this was narrower.
    eligible: (item) => item.type !== 'habit' && !!item.inProjectBlock,
    run: (item) => planner().moveTaskOutOfProjectBlock(item.id),
  }),
  // Pause / Resume deliberately ignore the dateStr these predicates are handed:
  // that is the SELECTED day, and pausing is dateless (plan decision 3). Keying
  // on it would make the two commands trade places as the user walks the week
  // past a resume boundary, and the picker's contents change with them.
  //
  // "Pause until…" is absent on purpose — itemCommand supports exactly one
  // argument and it is the entity, so a date belongs to the dialog's overflow
  // menu and the mobile sheet, which can host a picker.
  itemCommand({
    id: 'items.pause',
    label: 'Pause',
    description: 'Sets it aside — hidden until you resume, streak untouched',
    icon: PauseIcon,
    keywords: 'pause hold suspend set aside break vacation hide later',
    aliases: ['pause'],
    emptyLabel: 'Nothing to pause',
    eligible: (item) => isPausable(item) && !isPausedNow(item),
    run: (item) => planner().setItemPaused(item.id, true),
  }),
  itemCommand({
    id: 'items.resume',
    label: 'Resume',
    description: 'Brings it back where you left it',
    icon: PlayIcon,
    keywords: 'resume unpause restart continue bring back restore',
    aliases: ['resume'],
    placeholder: 'Which paused item?',
    emptyLabel: 'Nothing is paused',
    eligible: (item) => isPausedNow(item),
    run: (item) => planner().setItemPaused(item.id, false),
  }),
  ...priorityCommands(),
  ...bucketCommands(),

  /* ── Go to ──────────────────────────────────────────────────────────── */
  {
    id: 'goto.today',
    label: 'Go to today',
    group: 'goto',
    icon: CalendarCheck,
    keywords: 'now jump date current',
    aliases: ['today'],
    run: () => goToDate(new Date()),
  },
  {
    id: 'goto.tomorrow',
    label: 'Go to tomorrow',
    group: 'goto',
    icon: CalendarPlus,
    keywords: 'next jump date',
    aliases: ['tomorrow'],
    run: () => goToDate(addDays(new Date(), 1), 'left'),
  },
  {
    id: 'goto.yesterday',
    label: 'Go to yesterday',
    description: 'Check off anything you missed',
    group: 'goto',
    icon: CalendarMinus,
    keywords: 'back previous jump date missed',
    aliases: ['yesterday'],
    run: () => goToDate(subDays(new Date(), 1), 'right'),
  },
  {
    id: 'goto.next',
    label: 'Next day or week',
    dynamicLabel: () => (view().scope === 'week' ? 'Next week' : 'Next day'),
    group: 'goto',
    icon: ChevronRight,
    keywords: 'forward advance',
    aliases: ['next'],
    run: () => stepScope(1),
  },
  {
    id: 'goto.previous',
    label: 'Previous day or week',
    dynamicLabel: () => (view().scope === 'week' ? 'Previous week' : 'Previous day'),
    group: 'goto',
    icon: ChevronLeft,
    keywords: 'back last',
    aliases: ['prev', 'previous'],
    run: () => stepScope(-1),
  },
  {
    id: 'goto.braindump',
    label: 'Open braindump',
    description: 'Your unscheduled backlog',
    group: 'goto',
    icon: Inbox,
    keywords: 'inbox backlog unscheduled capture notes',
    aliases: ['braindump', 'inbox'],
    run: (ctx) => {
      if (ctx.isMobile) useMobileNavStore.getState().setActiveTab('braindump');
      else useSidebarStore.getState().setLeftSidebarOpen(true);
    },
  },
  {
    id: 'goto.todayTab',
    label: 'Go to Today tab',
    group: 'goto',
    icon: Rows3,
    keywords: 'plan canvas schedule',
    // Mobile's primary navigation; on desktop the canvas is always on screen.
    hidden: (ctx) => !ctx.isMobile,
    run: () => useMobileNavStore.getState().setActiveTab('today'),
  },
  {
    id: 'goto.overdue',
    label: 'Show items waiting',
    description: 'Opens the tray listing anything still waiting from an earlier day',
    group: 'goto',
    // Sunrise, not AlertTriangle. The surface this opens is deliberately not an
    // alert (see the copy contract on BarCopy in components/ai/morning-check.tsx)
    // and a warning triangle in the palette undoes that before the tray even
    // opens. Same glyph as settings.morningCheck below, so the two rows that
    // touch this feature look related. Every old search term is kept in
    // `keywords` — the vocabulary changed, the ways in didn't.
    icon: Sunrise,
    keywords: 'overdue past due late missed behind morning check waiting carried',
    aliases: ['overdue'],
    // The past-due surface ships on BOTH platforms now, so there is no platform
    // gate. It starts collapsed and can be dismissed for the day, neither of
    // which reverses on its own — which is what makes this worth a row.
    //
    // Greyed rather than a no-op: the surface also self-hides when nothing is
    // overdue, so without this the command would silently do nothing on a day
    // you happen to be caught up. Dismissal state deliberately does NOT gate
    // availability — run() resets the dismissal AND opens the tray, so the
    // command does something real in both states (before, when nothing was
    // dismissed, resetDismissal() alone was the very no-op this guard exists to
    // prevent). Predicate is the shared one (lib/overdue.ts): this copy had no
    // recurrence guard, so it lit up for daily chores that are `pending`
    // forever by design.
    availableWhen: () => {
      if (!useMorningStore.getState().morningCheckEnabled) return false;
      // items, not the `tasks` projection: the selector resolves each item's
      // registry config, and custom types are carry-forward eligible too.
      //
      // "Today" comes from the user's SAVED timezone (the app-wide `toDateStr`
      // convention), matching the bar in components/ai/morning-check.tsx and
      // the sweep in hooks/use-overdue-sweep.ts. Bare `format(new Date(), …)`
      // would read the machine tz and could grey this row out on a day the bar
      // is visibly showing overdue items.
      const { items, routines, programs, userTimezone } = planner();
      const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const todayStr = toDateStr(new Date(), tz);
      // Dateless surface: resolve suppression at TODAY, never at the store's
      // navigable selectedDate (plan decision 3).
      const inactive = inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, programs });
      return selectOverdue(items, todayStr, inactive).length > 0;
    },
    // Reveal the surface BEFORE poking its state — the same guard openChat,
    // Open braindump and focusOmnibar already use. The rule outlived the
    // reason: this used to switch mobile to Today, because the past-due pill
    // was mounted on that tab alone. The surface is a line in the dock now
    // (components/sidebar/dock-notices.tsx), which mobile mounts on every tab,
    // so the tab switch became a navigation the user did not ask for — and
    // desktop inherited the exact bug it was written to prevent, because the
    // dock's rows do not render while the sidebar column is collapsed. Flipping
    // isOpen there looks broken in precisely the same way.
    run: (ctx) => {
      if (!ctx.isMobile) useSidebarStore.getState().setLeftSidebarOpen(true);
      const store = useMorningStore.getState();
      store.resetDismissal();
      store.open();
    },
  },

  /* ── View ───────────────────────────────────────────────────────────── */
  {
    id: 'view.layout',
    label: 'Change layout',
    group: 'view',
    icon: Rows3,
    keywords: 'buckets schedule list timeline view',
    aliases: ['layout'],
    argument: {
      kind: 'enum',
      placeholder: 'Layout',
      flatten: true,
      options: () => optionsFrom(LAYOUT_OPTIONS, view().layout),
    },
    run: (_ctx, arg) => view().setLayout(arg as ViewLayout),
  },
  {
    id: 'view.typeFilter',
    label: 'Show',
    description: 'Tasks, habits, or both',
    group: 'view',
    icon: Filter,
    keywords: 'tasks habits both type filter only',
    aliases: ['show'],
    argument: {
      kind: 'enum',
      placeholder: 'Show',
      flatten: true,
      options: () => optionsFrom(TYPE_OPTIONS, view().typeFilter),
    },
    run: (_ctx, arg) => view().setTypeFilter(arg as TypeFilter),
  },
  {
    id: 'view.groupBy',
    label: 'Group by',
    description: 'Sections every layout — Buckets groups its untimed rows, Schedule its Anytime strip',
    group: 'view',
    icon: Layers,
    keywords: 'group sort organise organize project priority bucket',
    aliases: ['group'],
    argument: {
      kind: 'enum',
      placeholder: 'Group by',
      flatten: true,
      // Both halves resolved against what is switched on, not read raw. A
      // gated value is not offered, and a STORED gated value does not draw a
      // checkmark — every surface and the Display menu report 'none' for it, and
      // the palette is the one place that used to say otherwise.
      options: () =>
        optionsFrom(groupByOptionsFor(CANVAS_GROUP_BY_OPTIONS), resolvedCanvasGroupBy()),
    },
    run: (_ctx, arg) => view().setCanvasGroupBy(arg as GroupBy),
  },
  {
    id: 'view.filterProject',
    label: 'Filter by project',
    description: 'Narrow the canvas to one project — habits stay, filed by their group',
    group: 'view',
    icon: Filter,
    keywords: 'filter project only narrow',
    aliases: ['filter'],
    availableWhen: () => planner().projects.length > 0,
    argument: {
      kind: 'enum',
      placeholder: 'Project',
      // Never flattened: names are free text, so flattening lets a project
      // called "Today" or "List" outrank the built-in command of that name.
      options: () => {
        const active = namesOfKind(view().canvasFilters.containers, 'project');
        return planner().projects.map((p) => ({
          value: p.name,
          label: p.name,
          icon: resolveCategoryIcon(p.emoji, p.name),
          active: active.includes(p.name),
        }));
      },
    },
    run: (_ctx, arg) => {
      if (!arg) return;
      const store = view();
      const current = store.canvasFilters;
      const ref = containerRef('project', arg);
      store.setCanvasFilters({
        ...current,
        containers: current.containers.includes(ref)
          ? current.containers.filter((c) => c !== ref)
          : [...current.containers, ref],
      });
    },
  },
  {
    id: 'view.clearFilters',
    label: 'Clear canvas filters',
    group: 'view',
    icon: FilterX,
    keywords: 'clear reset filters show all',
    aliases: ['clear'],
    availableWhen: () => {
      const f = view().canvasFilters;
      return !isEmptyFilters(f);
    },
    run: () => view().setCanvasFilters(EMPTY_VIEW_FILTERS),
  },
  {
    id: 'view.scopeDay',
    label: 'Switch to Day view',
    description: 'Also becomes the view dsul opens on',
    group: 'view',
    icon: Sun,
    keywords: 'day scope today single',
    aliases: ['day'],
    // Mobile is day-only by construction — MobileViewRouter never reads scope —
    // so on a phone this row would do nothing visible while still writing
    // default_view to the server.
    hidden: (ctx) => ctx.isMobile,
    run: () => view().setScope('day'),
  },
  {
    id: 'view.scopeWeek',
    label: 'Switch to Week view',
    description: 'Also becomes the view dsul opens on',
    group: 'view',
    icon: CalendarDays,
    keywords: 'week scope seven days',
    aliases: ['week'],
    hidden: (ctx) => ctx.isMobile,
    run: () => view().setScope('week'),
  },
  {
    id: 'view.toggleScope',
    label: 'Toggle Day/Week view',
    dynamicLabel: () => (view().scope === 'week' ? 'Switch to Day view' : 'Switch to Week view'),
    description: 'Flips between the two, same as picking one directly',
    group: 'view',
    icon: CalendarRange,
    keywords: 'day week scope toggle switch flip view',
    aliases: ['toggle'],
    shortcut: { id: 'toggle_view_scope', keys: ['v'], context: 'Desktop only — mobile is day-only.' },
    // Same reason as the two commands above: mobile is day-only by
    // construction, so this would silently write default_view with no
    // visible effect.
    hidden: (ctx) => ctx.isMobile,
    run: () => view().setScope(view().scope === 'week' ? 'day' : 'week'),
  },
  {
    id: 'view.zen',
    // Neutral, like every other toggle in here, and NOT 'Enter Zen': the
    // shortcuts table renders the STATIC label — DEFAULT_SHORTCUTS is built at
    // module scope and has no ctx to run `dynamicLabel` against — so a
    // state-named label would have the ⌘/ overlay offering to "Enter Zen" while
    // you are sitting in it. The palette still says the state-accurate thing.
    label: 'Toggle Zen',
    dynamicLabel: () => (view().zenOpen ? 'Leave Zen' : 'Enter Zen'),
    description: 'The day, one thing at a time, on a quiet screen',
    group: 'view',
    icon: Leaf,
    keywords: 'zen focus distraction free quiet calm room now one thing full screen',
    aliases: ['zen'],
    /*
     * Bare `z`, in the house style of `n` for new and `v` for view — and NOT
     * ⌘⇧Z, which reads as the obvious choice and is unavailable: normalizeBinding
     * folds `ctrl` and `meta` into one MOD token, so ⌘⇧Z and the redo binding
     * ⌃⇧Z are the same combination to every lookup, and the collision test in
     * tests/unit/commands.test.ts fails on it.
     */
    shortcut: {
      id: 'toggle_zen',
      keys: ['z'],
      context: 'Desktop only — the phone opens on its own Today tab.',
    },
    /*
     * availableWhen, not just `hidden`. The two are independent: `hidden` keeps
     * a row out of the palette, while the keyboard dispatcher gates on
     * `isAvailable` alone (hooks/use-command-shortcuts.ts) — so without this a
     * hardware keyboard paired to a phone could still fire `z` and set a flag
     * nothing in the mobile tree renders, stranding the user in a shell that
     * looks unchanged but is one reload from a room they cannot leave.
     */
    availableWhen: (ctx) => !ctx.isMobile,
    hidden: (ctx) => ctx.isMobile,
    run: () => view().toggleZen(),
  },
  /*
   * Week column scale. ⌘+ / ⌘− / ⌘0 are the browser's page-zoom keys, and the
   * dispatcher only preventDefaults a command it is actually going to RUN — so
   * `availableWhen` is what hands them back to the browser everywhere except the
   * two week views that have day columns to scale. Repeatable, because holding
   * the key to sweep the ladder is the whole gesture.
   */
  {
    id: 'view.weekColumnsWider',
    label: 'Widen day columns',
    description: 'Fewer, wider day columns in the week views',
    group: 'view',
    icon: ChevronsLeftRight,
    keywords: 'week column width wider zoom in bigger scale days',
    shortcut: {
      id: 'week_columns_wider',
      keys: ['meta', '='],
      repeatable: true,
      context: WEEK_COLUMNS_CONTEXT,
    },
    availableWhen: () => view().scope === 'week' && isScalableLayout(view().layout),
    hidden: (ctx) => ctx.isMobile,
    run: () => view().stepWeekDaysVisible(1),
  },
  {
    id: 'view.weekColumnsNarrower',
    label: 'Narrow day columns',
    description: 'More, narrower day columns in the week views',
    group: 'view',
    icon: ChevronsRightLeft,
    keywords: 'week column width narrower zoom out smaller scale days',
    shortcut: {
      id: 'week_columns_narrower',
      keys: ['meta', '-'],
      repeatable: true,
      context: WEEK_COLUMNS_CONTEXT,
    },
    availableWhen: () => view().scope === 'week' && isScalableLayout(view().layout),
    hidden: (ctx) => ctx.isMobile,
    run: () => view().stepWeekDaysVisible(-1),
  },
  {
    id: 'view.weekColumnsReset',
    label: 'Reset day column width',
    description: 'Back to whatever fits the canvas best',
    group: 'view',
    icon: Columns3,
    keywords: 'week column width reset default automatic fit canvas',
    shortcut: { id: 'week_columns_reset', keys: ['meta', '0'], context: WEEK_COLUMNS_CONTEXT },
    // Clears the choice rather than writing a fixed count, so the view goes back
    // to picking the stop nearest TARGET_COL_PX — and keeps re-picking it as the
    // canvas changes, exactly as it did before the control was ever touched.
    availableWhen: () =>
      view().scope === 'week' && isScalableLayout(view().layout) && view().weekDaysVisible !== null,
    hidden: (ctx) => ctx.isMobile,
    run: () => view().setWeekDaysVisible(null),
  },

  /* ── Rituals & Beacon ───────────────────────────────────────────────── */
  {
    id: 'rituals.chat',
    label: 'Ask Beacon',
    group: 'rituals',
    icon: Sparkles,
    keywords: 'chat ai assistant beacon ask question',
    aliases: ['chat', 'beacon'],
    run: (ctx) => ctx.openChat(),
  },
  {
    id: 'rituals.catchUp',
    label: 'Pick things back up',
    group: 'rituals',
    icon: Wand2,
    keywords: 'catch up overdue behind reschedule plan proposal beacon',
    aliases: ['catchup'],
    // Computed locally (lib/proposal.ts), so this works with no AI configured
    // at all — the feature that matters most on the worst day must not depend
    // on a provider being reachable.
    run: (ctx) => {
      ctx.openChat();
      useProposalStore.getState().request('catch-up');
    },
  },
  {
    id: 'rituals.planDay',
    label: 'Plan my day',
    description: 'Asks Beacon to build a plan from today’s tasks',
    group: 'rituals',
    icon: Wand2,
    keywords: 'plan day schedule ai beacon organise organize',
    aliases: ['plan'],
    // send() no-ops while a response is streaming.
    availableWhen: () => !useChatStore.getState().isLoading,
    run: (ctx) => {
      ctx.openChat();
      const chat = useChatStore.getState();
      // ChatConversation is what normally hydrates the store, and it has not
      // mounted yet at this point. Sending first would append to an empty
      // message list and immediately persist it over the saved transcript.
      chat.hydrate();
      void chat.send('Plan my day');
    },
  },
  {
    id: 'rituals.eod',
    label: 'Start end-of-day review',
    group: 'rituals',
    icon: Moon,
    keywords: 'eod evening review reflect wrap up night',
    aliases: ['eod', 'review'],
    run: () => useEODStore.getState().open(),
  },

  /* ── Workspace ──────────────────────────────────────────────────────── */
  {
    id: 'workspace.toggleChat',
    label: 'Toggle chat panel',
    group: 'workspace',
    icon: MessageSquare,
    keywords: 'chat panel sidebar beacon hide show',
    shortcut: {
      id: 'toggle_right_sidebar',
      keys: ['meta', ']'],
      allowInInput: true,
      context: 'Desktop only — nothing on mobile reads the sidebar.',
    },
    // Nothing in the mobile tree consumes sidebar-store.
    hidden: (ctx) => ctx.isMobile,
    run: () => {
      const sidebar = useSidebarStore.getState();
      // Opening chat while the sidebar is collapsed would expand a panel
      // inside a w-0 overflow-hidden column: nothing appears, and the state
      // silently desyncs from what the user last saw.
      if (!sidebar.chatExpanded) sidebar.setLeftSidebarOpen(true);
      sidebar.toggleChat();
    },
  },
  {
    id: 'workspace.toggleSidebar',
    label: 'Toggle sidebar',
    group: 'workspace',
    icon: PanelLeft,
    keywords: 'sidebar collapse expand hide show braindump',
    shortcut: {
      id: 'toggle_left_sidebar',
      keys: ['meta', '['],
      allowInInput: true,
      context: 'Desktop only — nothing on mobile reads the sidebar.',
    },
    // Deliberately never a palette row: the omnibar lives INSIDE the sidebar,
    // so running this from the palette makes the palette disappear — and
    // ⌘K then focuses a zero-width, clipped input that looks broken. The
    // binding is the point; the row would be a trapdoor.
    hidden: true,
    run: () => useSidebarStore.getState().toggleLeftSidebar(),
  },
  {
    id: 'workspace.focusItemPanel',
    label: 'Focus item panel',
    description: 'Move focus into the open item panel',
    group: 'workspace',
    icon: PanelLeft,
    keywords: 'item panel inspector focus edit details',
    shortcut: {
      id: 'focus_item_panel',
      keys: ['meta', '\\'],
      allowInInput: true,
      context: 'Only while an item panel is open.',
    },
    // Hidden for the same reason toggleSidebar is: with no panel open the row
    // would be a trapdoor that appears to do nothing. The binding is the point,
    // and it still shows up in the shortcuts modal.
    hidden: true,
    run: () => useUIStore.getState().focusItemPanel(),
  },
  {
    id: 'workspace.focusOmnibar',
    label: 'Search',
    description: 'Open the command launcher',
    group: 'workspace',
    icon: Search,
    keywords: 'search find omnibar command palette launcher',
    shortcut: { id: 'system_search', keys: ['meta', 'k'], allowInInput: true },
    // Running it from inside the launcher is a no-op; it exists so the binding
    // is rebindable and shows up in the shortcuts modal.
    hidden: true,
    // Desktop: ⌘K opens the summoned launcher modal (command + search). It is
    // independent of the sidebar, so no reveal step is needed.
    //
    // Mobile has no launcher (no keyboard): keep the old behaviour of focusing
    // the docked omnibar, switching off the Chat tab first since the mobile
    // dock unmounts the omnibar there — focusing a zero-width clipped input
    // otherwise takes n / e / Backspace / ⌘Z down with it until you blur.
    run: (ctx) => {
      if (ctx.isMobile) {
        const nav = useMobileNavStore.getState();
        if (nav.activeTab === 'chat') nav.setActiveTab('today');
        useUIStore.getState().focusOmnibar();
        return;
      }
      useUIStore.getState().openDialog({ type: 'launcher' });
    },
  },
  {
    id: 'workspace.openCommandLauncher',
    label: 'Commands',
    description: 'Open the command launcher in command mode',
    group: 'workspace',
    icon: SlashSquare,
    keywords: 'command palette slash run launcher',
    // Bare '/', suppressed while typing (allowInInput omitted) so the key stays
    // typeable in every text field; it only fires from a non-input surface.
    shortcut: { id: 'system_command', keys: ['/'] },
    hidden: true,
    // Desktop: '/' opens the launcher already in command mode (the '/' seeds the
    // input). Mobile has no launcher — focus the docked omnibar, where typing
    // '/' reaches the same palette.
    run: (ctx) => {
      if (ctx.isMobile) {
        const nav = useMobileNavStore.getState();
        if (nav.activeTab === 'chat') nav.setActiveTab('today');
        useUIStore.getState().focusOmnibar();
        return;
      }
      useUIStore.getState().openDialog({ type: 'launcher', query: '/' });
    },
  },
  {
    id: 'workspace.focusCapture',
    label: 'Quick add',
    description: 'Focus the sidebar capture bar',
    group: 'workspace',
    icon: Plus,
    keywords: 'quick add capture omnibar sidebar new task',
    shortcut: { id: 'system_capture', keys: ['meta', 'i'], allowInInput: true },
    hidden: true,
    // The reveal+focus path ⌘K used before the launcher took ⌘K over. Reveal the
    // sidebar BEFORE focusing: focusing a clipped zero-width input in a collapsed
    // sidebar swallows every binding without allowInInput (n / e / Backspace / ⌘Z)
    // until you blur. Mobile switches off the Chat tab, which unmounts the omnibar.
    run: (ctx) => {
      if (ctx.isMobile) {
        const nav = useMobileNavStore.getState();
        if (nav.activeTab === 'chat') nav.setActiveTab('today');
      } else {
        useSidebarStore.getState().setLeftSidebarOpen(true);
      }
      useUIStore.getState().focusOmnibar();
    },
  },
  {
    id: 'workspace.selectAll',
    label: 'Select all items',
    description: 'Select every item currently on screen',
    group: 'workspace',
    icon: Rows3,
    keywords: 'select all everything highlight multi',
    // No palette row: "select all" from a palette that then closes reads as a
    // no-op, and the binding is the point. It still lists in the shortcuts modal.
    // No allowInInput, so ⌘A inside a text field stays the browser's select-all.
    shortcut: { id: 'select_all', keys: ['meta', 'a'] },
    hidden: true,
    // DOM order == visual order (no virtualization); dedupes ids across surfaces.
    run: () => useSelectionStore.getState().replace(selectableIdsInDom()),
  },

  /* ── Settings ───────────────────────────────────────────────────────── */
  {
    id: 'settings.darkMode',
    label: 'Toggle dark mode',
    group: 'settings',
    icon: Contrast,
    keywords: 'dark light theme appearance night mode',
    // resolved, not value: inverting 'system' needs to know what is on screen.
    run: (ctx) => ctx.theme.set(ctx.theme.resolved === 'dark' ? 'light' : 'dark'),
  },
  {
    id: 'settings.theme',
    label: 'Set theme',
    group: 'settings',
    icon: Palette,
    keywords: 'theme appearance light dark system auto',
    aliases: ['theme'],
    argument: {
      kind: 'enum',
      placeholder: 'Theme',
      // Flattened so "/dark" is one keystroke and one Enter, not a two-step
      // browse. Flattened options only surface once you have typed, so the
      // resting list is unaffected by the extra three rows.
      flatten: true,
      options: (ctx) =>
        [
          { value: 'light', label: 'Light', icon: Sun, aliases: ['light'] },
          { value: 'dark', label: 'Dark', icon: Moon, aliases: ['dark'] },
          { value: 'system', label: 'System', icon: Contrast, aliases: ['system', 'auto'] },
        ].map((o) => ({ ...o, active: o.value === (ctx.theme.value ?? 'system') })),
    },
    run: (ctx, arg) => ctx.theme.set((arg as 'light' | 'dark' | 'system') ?? 'system'),
  },
  {
    id: 'settings.showCompleted',
    label: 'Toggle completed tasks',
    dynamicLabel: () =>
      planner().showCompletedTasks ? 'Hide completed tasks' : 'Show completed tasks',
    group: 'settings',
    icon: CheckCircle2,
    keywords: 'completed done hide show finished',
    aliases: ['completed'],
    run: () => planner().setShowCompletedTasks(!planner().showCompletedTasks),
  },
  {
    id: 'settings.showPaused',
    label: 'Toggle paused items on the grid',
    dynamicLabel: () =>
      planner().showPausedOnGrid ? 'Hide paused items on the grid' : 'Show paused items on the grid',
    description: 'Greyed, in place, where they would have been',
    group: 'settings',
    icon: Moon,
    keywords: 'paused hidden set aside routine program show grid ghost',
    aliases: ['paused'],
    // Ungated, deliberately. It first carried `routines.length > 0 ||
    // programs.length > 0` on the theory that the preference is unobservable
    // without a container — which is false: `inactiveItemIdsOn`'s own
    // `!isPausedOn(item, …)` arm needs no container at all, so Phase 1's
    // item-level pause is governed by this flag from a standing start. Worse,
    // the flag is persisted, so gating it made the control unreachable in a
    // state it could itself produce: turn it on, then delete your last
    // container, and every self-paused item renders greyed forever behind a
    // palette row that is greyed out and refuses to run.
    run: () => planner().setShowPausedOnGrid(!planner().showPausedOnGrid),
  },
  {
    id: 'settings.timeFormat',
    label: 'Toggle 12/24-hour time',
    dynamicLabel: () =>
      planner().timeFormat === '24h' ? 'Use 12-hour time' : 'Use 24-hour time',
    group: 'settings',
    icon: Clock,
    keywords: 'time format 12 24 hour clock am pm military',
    // Neutral token, not '12h'/'24h': this is a toggle, so an alias naming a
    // specific format would flip you to the other one half the time.
    aliases: ['time'],
    run: () => planner().setTimeFormat(planner().timeFormat === '24h' ? '12h' : '24h'),
  },
  {
    id: 'settings.typeface',
    label: 'Toggle typeface',
    dynamicLabel: () => (view().typeMode === 'serif' ? 'Use sans typeface' : 'Use serif typeface'),
    group: 'settings',
    icon: Type,
    keywords: 'font typeface serif sans type appearance',
    aliases: ['font'],
    run: () => view().setTypeMode(view().typeMode === 'serif' ? 'sans' : 'serif'),
  },
  {
    id: 'settings.animations',
    label: 'Toggle animations',
    dynamicLabel: () => (planner().animationsEnabled ? 'Reduce motion' : 'Enable animations'),
    group: 'settings',
    icon: Zap,
    keywords: 'animation motion reduce accessibility transitions',
    aliases: ['motion'],
    run: () => planner().setAnimationsEnabled(!planner().animationsEnabled),
  },
  {
    id: 'settings.morningCheck',
    label: 'Toggle morning task check',
    dynamicLabel: () =>
      useMorningStore.getState().morningCheckEnabled
        ? 'Turn off morning task check'
        : 'Turn on morning task check',
    group: 'settings',
    icon: Sunrise,
    keywords: 'morning check overdue banner ritual',
    run: () => {
      const store = useMorningStore.getState();
      store.setMorningCheckEnabled(!store.morningCheckEnabled);
    },
  },
  {
    id: 'settings.eodReview',
    label: 'Toggle end-of-day review',
    dynamicLabel: () =>
      useEODStore.getState().eodReviewEnabled
        ? 'Turn off end-of-day review'
        : 'Turn on end-of-day review',
    group: 'settings',
    icon: Sunset,
    keywords: 'eod evening review nightly ritual reminder',
    run: () => {
      const store = useEODStore.getState();
      store.setEodReviewEnabled(!store.eodReviewEnabled);
    },
  },

  /* ── History ────────────────────────────────────────────────────────── */
  {
    id: 'history.undo',
    label: 'Undo',
    group: 'history',
    icon: Undo2,
    keywords: 'undo revert back mistake',
    shortcut: { id: 'undo', keys: ['ctrl', 'z'], repeatable: true },
    availableWhen: () => planner().canUndo,
    run: () => planner().undo(),
  },
  {
    id: 'history.redo',
    label: 'Redo',
    group: 'history',
    icon: Redo2,
    keywords: 'redo forward again',
    shortcut: { id: 'redo', keys: ['ctrl', 'shift', 'z'], repeatable: true },
    availableWhen: () => planner().canRedo,
    run: () => planner().redo(),
  },

  /* ── App ────────────────────────────────────────────────────────────── */
  {
    id: 'app.settings',
    label: 'Settings',
    group: 'app',
    icon: Settings,
    keywords: 'settings preferences options account api key',
    // The shortcut id stays 'system_settings' byte-for-byte even though the
    // command now opens a route: keyboard-shortcuts-store persists user
    // rebindings BY ID, and commands.test.ts asserts the id list exhaustively.
    shortcut: { id: 'system_settings', keys: ['meta', ','], allowInInput: true },
    run: (ctx) => {
      // navigate is optional on CommandContext (see types.ts), so this falls
      // back to a full load rather than doing nothing when it's absent.
      // The canonical pane URL, not bare /settings: the bare path costs a
      // second navigation (the page replace()s itself to /settings/day).
      if (ctx.navigate) ctx.navigate('/settings/day');
      else if (typeof window !== 'undefined') window.location.assign('/settings/day');
    },
  },
  {
    // The id and the aliases are FROZEN even though the surface was renamed:
    // ids are the stable handle the e2e suite and command-usage ranking key on,
    // and an alias is muscle memory. Only the label follows the rename.
    id: 'app.categories',
    // 'groups' stays in the aliases and keywords though the surface is gone
    // (039): the id and the aliases are frozen, and a habit group IS a project
    // now, so the alias still lands where the user meant.
    label: 'Organize projects & item types',
    group: 'app',
    icon: FolderOpen,
    keywords: 'projects groups categories manage organize folders edit labels',
    aliases: ['projects', 'groups'],
    // GREYED, NOT GONE, while the Organize console is off. `availableWhen`
    // renders the row and blocks the run, which is exactly the "inert but still
    // findable" posture the extension surface is built on — and it is the same
    // grammar the display menu uses for a value the current view cannot honour.
    // A row that vanished would read as a broken palette; this one reads as a
    // feature you have not switched on.
    availableWhen: () => organizeEnabled(),
    run: () => useUIStore.getState().openDialog({ type: 'organize', section: 'projects' }),
  },
  {
    id: 'app.collections',
    label: 'Organize routines & programs',
    group: 'app',
    icon: RepeatIcon,
    keywords: 'routines programs collections manage organize group pause',
    aliases: ['routines'],
    // Not gated on collectionsAvailable: the console explains the situation
    // better than a missing row does, and a row that silently disappears reads
    // as a broken palette rather than an unavailable feature. The EXTENSION is
    // a different question — with the console switched off there is no console
    // to do the explaining, so the row greys out instead. See app.categories.
    availableWhen: () => organizeEnabled(),
    run: () => useUIStore.getState().openDialog({ type: 'organize', section: 'routines' }),
  },
  {
    id: 'app.goals',
    label: 'Organize goals',
    group: 'app',
    icon: Target,
    keywords: 'goals milestones check-ins ambitions long term targets progress',
    aliases: ['goals'],
    // Ungated, like app.collections and for the same reason: the console
    // explains an unavailable feature better than a vanished palette row does.
    //
    // Gated on GOALS rather than on the console, matching the section it opens
    // (console-rail.tsx): the Goals section rides EXT_GOALS, so this row works
    // with the rest of the console switched off and greys out when the idea
    // itself is off, whatever the console is doing.
    availableWhen: () => goalsEnabled(),
    run: () => useUIStore.getState().openDialog({ type: 'organize', section: 'goals' }),
  },
  {
    id: 'app.shortcuts',
    label: 'Keyboard shortcuts',
    group: 'app',
    icon: Keyboard,
    keywords: 'keyboard shortcuts keys bindings help',
    aliases: ['keys'],
    shortcut: { id: 'system_shortcuts', keys: ['meta', '/'], allowInInput: true },
    run: () => useUIStore.getState().openDialog({ type: 'keyboard-shortcuts' }),
  },
  {
    id: 'app.feedback',
    label: 'Share feedback',
    group: 'app',
    icon: Bug,
    keywords: 'bug report feedback issue feature request',
    aliases: ['bug', 'feedback'],
    shortcut: { id: 'report_bug', keys: ['?'] },
    run: () => useUIStore.getState().openDialog({ type: 'bug-report' }),
  },
];

/**
 * Commands whose shortcut is dispatched by the shell rather than run through
 * the registry, because they need the shell's React state (the hovered item
 * read at keypress time). They carry no palette row — acting on "the item under
 * the mouse" is meaningless once the omnibar has focus — but they own their
 * binding here so the shortcuts table lists them and rebinding works.
 *
 * Both are the plainest case for `context` (see CommandShortcutSpec): they are
 * the only two bindings that need something under the pointer, and a flat table
 * would otherwise advertise ⌫ as a way to delete whatever you last thought
 * about.
 */
const HOVER_CONTEXT = 'Only while the pointer is over an item.';

export const SHELL_SHORTCUTS = [
  {
    id: 'edit_hovered',
    label: 'Edit hovered item',
    description: 'Open the edit dialog for the task currently under the mouse',
    keys: ['e'],
    context: HOVER_CONTEXT,
  },
  {
    id: 'delete_hovered',
    label: 'Delete hovered item',
    description: 'Delete the task currently under the mouse (shows confirmation)',
    keys: ['backspace'],
    context: HOVER_CONTEXT,
  },
] as const;

/* ── dynamic commands ──────────────────────────────────────────────────── */

/**
 * One "Add ‹type›" per hydrated custom item type, so a type you created ten
 * seconds ago is a first-class palette row rather than a tab you have to go
 * find inside the add dialog.
 *
 * Memoised on the identity of the type list: this runs on every keystroke, and
 * a fresh Command object each time would hand the omnibar a new `activeCommand`
 * identity mid-argument.
 */
let cachedTypeDefs: unknown = null;
let cachedTypeCommands: Command[] = [];

const customTypeCommands: CommandProvider = () => {
  // The store's copy, not the item-registry module's, because this must track
  // creates and deletes; hydration into the registry happens on load and CRUD.
  const defs = planner().itemTypes;
  if (defs === cachedTypeDefs) return cachedTypeCommands;

  // Aliases already claimed by a hand-authored command, or by another type.
  const taken = new Set(STATIC_COMMANDS.flatMap((c) => c.aliases ?? []));

  cachedTypeDefs = defs;
  cachedTypeCommands = defs.map((def) => {
    const config = getItemTypeConfig(def.name);
    const noun = config.label.toLowerCase();
    // An alias is a promise that typing it lands in exactly one place, and
    // type names are user input — a type called "review" must not quietly
    // steal /review from the end-of-day ritual.
    const alias = taken.has(def.name) ? undefined : def.name;
    if (alias) taken.add(alias);

    return {
      id: `create.type.${def.name}`,
      label: `Add ${noun}`,
      group: 'create',
      icon: resolveCategoryIcon(def.icon, def.label),
      keywords: `new create ${def.name} ${config.labelPlural.toLowerCase()}`,
      aliases: alias ? [alias] : undefined,
      run: () => openAddDialog(def.name),
    } satisfies Command;
  });
  return cachedTypeCommands;
};

/**
 * Sources of commands that are not known until runtime. Order matters only for
 * ties — provider output is appended after the static list, so a generated row
 * never outranks a hand-authored one at the same score.
 */
let cachedRoutines: readonly Routine[] | null = null;
let cachedRoutineCommands: Command[] = [];

/**
 * "Pause Morning" / "Resume Exercise", one pair per routine.
 *
 * The customTypeCommands pattern: memoized on the routine array's identity
 * (rebuilt on every mutation), so a palette-wide pass costs nothing per
 * keystroke. Deliberately different from it in two ways, both because these
 * are STATE commands rather than create commands:
 *
 * - No aliases. A routine is user-named, and an alias is a promise that typing
 *   it lands in exactly one place; a routine called "settings" must not steal
 *   /settings. customTypeCommands can afford a collision check because a type
 *   name is a slug — routine names are free text and far likelier to collide.
 * - Only ONE of the pair renders, chosen by the routine's state resolved at
 *   TODAY. Offering both would make the palette lie about which is a no-op,
 *   and resolving at the selected date would make them trade places as the
 *   user walks the week past a resume boundary (the bug items.pause/resume
 *   had to be written around in Phase 1).
 */
const routineCommands: CommandProvider = () => {
  const { routines, collectionsAvailable } = planner();
  if (!collectionsAvailable) return [];
  if (routines === cachedRoutines) return cachedRoutineCommands;

  cachedRoutines = routines;
  cachedRoutineCommands = routines.map((routine) => {
    // Resolved per BUILD rather than per render, which is safe precisely
    // because the memo key is the routine array — and a pause writes to it.
    const tz = planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const paused = isPausedOn(routine, toDateStr(new Date(), tz), tz);
    return {
      id: `routine.${paused ? 'resume' : 'pause'}.${routine.id}`,
      label: `${paused ? 'Resume' : 'Pause'} ${routine.name}`,
      group: 'items',
      icon: paused ? PlayIcon : PauseIcon,
      keywords: `routine ${routine.name} ${paused ? 'resume unpause start' : 'pause hide stop'}`,
      run: () => planner().setRoutinePaused(routine.id, !paused),
    } satisfies Command;
  });
  return cachedRoutineCommands;
};

let cachedPrograms: readonly Program[] | null = null;
let cachedProgramDay: string | null = null;
let cachedProgramCommands: Command[] = [];

/**
 * Two commands per program, and both can render at once — unlike the routine
 * pair, where exactly one is a no-op.
 *
 * - "Turn on/off X" is the direct flip, and only the one that would CHANGE
 *   something appears, same reasoning as routines.
 * - "Switch to X" is the swap: it turns X on and everything else off. It only
 *   appears when there is something to turn off, because with nothing else on
 *   it would be the first command wearing a second name.
 *
 * No aliases, for the reason spelled out above routineCommands: program names
 * are free text and a program called "settings" must not steal /settings.
 */
const programCommands: CommandProvider = () => {
  const { programs, collectionsAvailable } = planner();
  if (!collectionsAvailable) return [];
  const tz = planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  // The day is part of the key, not just the array. An `auto` program flips
  // liveness at midnight with NO store write, so array identity alone cannot
  // express the passage of time — a tab left open overnight would keep serving
  // yesterday's "Turn on Summer" for a program the calendar already turned on.
  // Same reasoning as the entity-eligibility memo, which had to learn this too.
  if (programs === cachedPrograms && todayStr === cachedProgramDay) return cachedProgramCommands;

  cachedPrograms = programs;
  cachedProgramDay = todayStr;
  const liveCount = programs.filter((p) => isProgramActiveOn(p, todayStr)).length;

  cachedProgramCommands = programs.flatMap((program) => {
    const live = isProgramActiveOn(program, todayStr);
    const commands: Command[] = [
      {
        id: `program.${live ? 'pause' : 'activate'}.${program.id}`,
        label: `Turn ${live ? 'off' : 'on'} ${program.name}`,
        group: 'items',
        icon: live ? PauseIcon : PlayIcon,
        keywords: `program ${program.name} ${live ? 'off pause stop hide' : 'on activate start show'}`,
        // Re-resolved at RUN time, and belt-and-braces even with the day in the
        // key above. The label promises an OUTCOME ("on"), not a transition, so
        // if the world already reached it there is nothing to do.
        //
        // The state itself comes from `programStateForSwitch`, the same rule the
        // scope rail uses. Writing 'active'/'paused' straight was only ever half
        // right: the FIRST flip of an `auto` program agrees either way, but the
        // return flip does not, and this control could never hand a program back
        // to `auto`. Turn Summer off here and on again and its Aug 31 end is
        // gone — the exact loss two controls for one switch must not disagree
        // about.
        run: () => {
          const desiredOn = !live;
          const current = planner().programs.find((p) => p.id === program.id);
          if (!current) return;
          const today = toDateStr(new Date(), tz);
          if (isProgramActiveOn(current, today) === desiredOn) return;
          planner().setProgramState(program.id, programStateForSwitch(current, desiredOn, today));
        },
      },
    ];
    if (!live && liveCount > 0) {
      commands.push({
        id: `program.swap.${program.id}`,
        label: `Switch to ${program.name}`,
        group: 'items',
        icon: CalendarRange,
        keywords: `program ${program.name} switch swap change season only`,
        run: () => planner().swapToProgram(program.id),
      });
    }
    return commands;
  });
  return cachedProgramCommands;
};

let cachedGoals: readonly Goal[] | null = null;
let cachedGoalCommands: Command[] = [];

/**
 * "Open Learn Chinese", one per ACTIVE goal.
 *
 * One command rather than a pair, because unlike a routine or a program a goal
 * has no daily switch — its states are a lifecycle decision (achieved, set
 * aside) that belongs where the milestone list is visible, not on a row you
 * hit by typing three letters. So the palette's job here is navigation: it is
 * the fastest route to the goal page, which is the surface a long goal is
 * actually visited on.
 *
 * Memoized on the goal array's identity, and ONLY the array — a goal's
 * liveness never changes with the calendar the way an `auto` program's does,
 * so there is no day to key on.
 *
 * Ended goals are omitted. They are a record rather than live work, and a
 * palette that offers three finished goals ahead of the one you are running
 * has stopped being a shortcut. They stay reachable through the console.
 *
 * No aliases, for the reason spelled out above routineCommands: goal names are
 * free text and a goal called "settings" must not steal /settings.
 */
const goalCommands: CommandProvider = () => {
  const { goals, goalsAvailable } = planner();
  // DATA rows, not catalogue rows — so these go away entirely rather than grey
  // out. "Open Learn Chinese" is one of the user's goals, and a palette full of
  // greyed goal names would be worse than the static row above, which is the one
  // that stays findable and says the feature exists. The page they open is inert
  // while Goals is off anyway (app/goal/[id]/page.tsx).
  if (!goalsEnabled()) return [];
  if (!goalsAvailable) return [];
  if (goals === cachedGoals) return cachedGoalCommands;

  cachedGoals = goals;
  cachedGoalCommands = goals
    .filter((goal) => goal.state === 'active')
    .map(
      (goal) =>
        ({
          id: `goal.open.${goal.id}`,
          label: `Open ${goal.name}`,
          group: 'items',
          icon: Target,
          keywords: `goal ${goal.name} milestone progress open`,
          // Client navigation, with the same fallback app.settings uses. A
          // hard load would tear down the hydrated store and re-run every
          // fetch, discarding the undo stack and any in-flight write — for a
          // move between two sibling client routes.
          run: (ctx) => {
            const href = `/goal/${goal.id}`;
            if (ctx.navigate) ctx.navigate(href);
            else if (typeof window !== 'undefined') window.location.assign(href);
          },
        }) satisfies Command,
    );
  return cachedGoalCommands;
};

const PROVIDERS: CommandProvider[] = [
  customTypeCommands,
  routineCommands,
  programCommands,
  goalCommands,
];

/**
 * The registry as every palette surface sees it. Call this rather than reading
 * STATIC_COMMANDS: the static list is the subset that may own a keyboard
 * shortcut, not the set of commands that exist.
 */
export function resolveCommands(ctx: CommandContext): Command[] {
  const dynamic = PROVIDERS.flatMap((provider) => provider(ctx));
  return dynamic.length === 0 ? STATIC_COMMANDS : [...STATIC_COMMANDS, ...dynamic];
}

export function findCommand(id: string, ctx: CommandContext): Command | undefined {
  return resolveCommands(ctx).find((command) => command.id === id);
}

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
  ListChecks,
  ListPlus,
  MessageSquare,
  MessageSquarePlus,
  History as HistoryIcon,
  Moon,
  PanelLeft,
  Palette,
  PowerOff,
  Plus,
  Redo2,
  Rows3,
  Search,
  Settings,
  Store,
  SlashSquare,
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
  Workflow,
  Puzzle,
} from 'lucide-react';
import { addDays, subDays } from 'date-fns';

import { AskMarkIcon, AskMarkUnlitIcon } from '@/components/ai/ask-mark';
import { usePlannerStore } from '../planner-store';
import { useViewStore } from '../view-store';
import { EMPTY_VIEW_FILTERS, isEmptyFilters } from '../filters';
import { containerRef, namesOfKind } from '../container-registry';
import { useUIStore, closeItemPanel, openAddDialog, openBulkAdd, openNewContainer } from '../ui-store';
import {
  goalsEnabled,
  groupByOptionsFor,
  organizeEnabled,
  resolvedCanvasGroupBy,
  streaksEnabled,
} from '../extension-gates';
import { useSidebarStore } from '../sidebar-store';
import { revealDock } from '../look-store';
import { useSelectionStore, selectableIdsInDom } from '../selection-store';
import { setupPageShown, useMobileNavStore } from '../mobile-nav-store';
import { useMorningStore } from '../morning-store';
import { useEODStore } from '../eod-store';
import { useProposalStore } from '../proposal-store';
import { getAICapabilities } from '../ai-connection-store';
import { askNew, newChat, openHistory, openSetup, revealChat, toggleRail } from '../open-chat';
import { useConversationsStore } from '../conversations-store';
import { useModsStore } from '../mods-store';
import { modDisplayLabel, modLabel, parseModManifest, type UserMod } from '../mods/schema';
import { modSurfaceLabel } from '../mods/labels';
import { parseRecipe } from '../recipes/validate';
import { runRecipeCommand } from '../recipes/command-run';
import { runModCommand } from '../mods/command-run';
import { openablePanelsOf } from '../mods/ui/card';
import { openModPanel } from '../mods/ui/open-panel';
import { railModeNow, useRailStore } from '../rail-store';
import { useUndoStripStore } from '../undo-strip-store';
import { goToDate, stepScope } from '../nav-commands';
import { openHoveredSlot } from '../slot-add';
import { resolveCategoryIcon } from '../category-icons';
import { getCustomTypeDefs, getItemTypeConfig } from '../item-registry';
import { selectOverdue } from '../overdue';
import { inactiveItemIdsOn, isPausedOn, isSeasonActiveOn } from '../active';
import { seasonStateForSwitch } from '../scope-rail';
import { toDateStr } from '../recurrence';
import { PRIORITY_LABELS, TIME_BUCKET_RANGES } from '../planner-types';
import { isScalableLayout } from '../week-columns';
import { CANVAS_GROUP_BY_OPTIONS, LAYOUT_OPTIONS, TYPE_OPTIONS } from '../view-options';
import {
  assignBucket,
  isCancelled,
  isDoneOn,
  isHabit,
  isTaskLike,
  fromVerb,
  itemCommand,
} from './entities';
import type { Command, CommandArgOption, CommandContext, CommandProvider } from './types';
import type { TypeFilter, ViewLayout } from '../view-store';
import type { GroupBy, Priority, TimeBucket, Routine, Season, Goal } from '../planner-types';

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
 * The phone's palette and capture keys focus the dock's omnibar, which Ask's
 * composer replaces on the `chat` tab, so they move to Today first. Not from
 * the setup page or the fix home (lib/mobile-nav-store.ts setupPageShown):
 * that page keeps the omnibar, and moving would only take the person off the
 * page they were on.
 */
function leaveAskForOmnibar(): void {
  const nav = useMobileNavStore.getState();
  if (nav.activeTab === 'chat' && !setupPageShown(getAICapabilities())) nav.setActiveTab('today');
}

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
    // Over a grid slot or an add row, the key adds right there.
    runFromShortcut: () => {
      if (!openHoveredSlot()) openAddDialog('task');
    },
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
    description: 'Paste a list or import a file, one item per line',
    group: 'create',
    icon: ListPlus,
    keywords: 'bulk multiple paste import csv list batch many',
    aliases: ['bulk', 'import'],
    run: () => openBulkAdd(),
  },
  /* The three organizers the "new" dialog makes (2026-09-25). Palette rows
     only: shortcut ids are frozen and cost a settings id each, and `n` already
     reaches the same dialog, whose type menu lists them. No aliases either —
     a custom type named "goal" was promised the `goal` token first, and
     customTypeCommands yields to the static list, so claiming it here would
     silently take it from that type's row. `create.project` keeps its inline
     text argument: a project is often just a name.

     `availableWhen` is the extension, like the console doors below it: greyed,
     not gone. Table availability is the dialog's to explain — it disables its
     own submit with a sentence rather than the palette hiding the row. */
  {
    id: 'create.goal',
    label: 'New goal',
    description: 'Set a long-term goal',
    group: 'create',
    icon: Target,
    keywords: 'add create goal aim ambition target long term why',
    availableWhen: () => goalsEnabled(),
    run: () => openNewContainer('goal'),
  },
  {
    id: 'create.routine',
    label: 'New routine',
    description: 'Things you do regularly, in order',
    group: 'create',
    icon: RepeatIcon,
    keywords: 'add create routine stack habits together regular order morning checklist pause',
    availableWhen: () => organizeEnabled(),
    run: () => openNewContainer('routine'),
  },
  {
    id: 'create.season',
    label: 'New season',
    description: 'Plan a season',
    group: 'create',
    icon: CalendarRange,
    keywords: 'add create season program period term block dates',
    availableWhen: () => organizeEnabled(),
    run: () => openNewContainer('season'),
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
    ...fromVerb('complete'),
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
    // Always eligible, and confirmed with the type's own copy — lib/item-verbs.ts.
    ...fromVerb('delete'),
    // Not the default loop: `confirm` is a single slot, so N prompts would
    // leave only the last standing and delete one item. One prompt, then one
    // deleteItems — a single entry that raises the undo strip, which is why
    // this copy offers undo where the bulk bar's names only the Trash.
    runMany: (items) => {
      const habits = items.filter(isHabit).length;
      useUIStore.getState().confirm({
        title: `Delete ${items.length} items?`,
        description:
          'They’ll be removed along with any subtasks.' +
          (habits
            ? ` ${habits === 1 ? 'One is a habit' : `${habits} are habits`}, so ${
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
    // The rows' carry (lib/row-moves.ts via the shared verb): a dated one-off
    // only. It used to take any open task-like item and write startDate + 1,
    // which on a recurring task rewrote the series anchor, dropped an overdue
    // item one day later but still in the past, and stranded a task inside a
    // project block. Habits are date-blind — there is no date on them to move.
    ...fromVerb('nextDay'),
  }),
  itemCommand({
    id: 'items.skip',
    label: 'Skip today',
    description: 'Marks the day skipped. A habit keeps its streak',
    icon: SkipForward,
    keywords: 'skip habit rest day pass miss recurring',
    aliases: ['skip'],
    placeholder: 'Which item?',
    emptyLabel: 'Nothing left to skip today',
    // Registry capability, not "is it a habit": any recurring occurrence of a
    // skippable type can be skipped (#194). One-shot items are excluded by
    // isSkippable — they get completed or cancelled, never skipped.
    ...fromVerb('skip'),
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
    ...fromVerb('resetStreak'),
    detail: (item) => (isHabit(item) && streaksEnabled() ? `🔥 ${item.streak}` : undefined),
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
    ...fromVerb('leaveProjectBlock'),
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
    description: 'Sets it aside. Hidden until you resume, streak untouched',
    icon: PauseIcon,
    keywords: 'pause hold suspend set aside break vacation hide later',
    aliases: ['pause'],
    emptyLabel: 'Nothing to pause',
    ...fromVerb('pause'),
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
    ...fromVerb('resume'),
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
      const { items, routines, seasons, userTimezone } = planner();
      const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const todayStr = toDateStr(new Date(), tz);
      // Dateless surface: resolve suppression at TODAY, never at the store's
      // navigable selectedDate (plan decision 3).
      const inactive = inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons });
      return selectOverdue(items, todayStr, inactive).length > 0;
    },
    // Reveal the surface BEFORE poking its state — the same guard Open
    // braindump and focusOmnibar already use. The rule outlived the
    // reason: this used to switch mobile to Today, because the past-due pill
    // was mounted on that tab alone. The surface is a line in the dock now
    // (components/sidebar/dock-notices.tsx), which mobile mounts on every tab,
    // so the tab switch became a navigation the user did not ask for — and
    // desktop inherited the exact bug it was written to prevent, because the
    // dock's rows do not render while the sidebar column is collapsed. Flipping
    // isOpen there looks broken in precisely the same way.
    run: (ctx) => {
      if (!ctx.isMobile) revealDock();
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
    description: 'Sections every layout: Buckets groups its untimed rows, Schedule its Anytime strip',
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
    description: 'Narrow the canvas to one project. Habits stay, filed by their group',
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
    shortcut: { id: 'toggle_view_scope', keys: ['v'], context: 'Desktop only. Mobile is day-only.' },
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
      context: 'Desktop only. The phone opens on its own Today tab.',
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
   * Week column scale. ⌘+ / ⌘− / ⌘0 are the browser's page-zoom keys. The
   * dispatcher (hooks/use-command-shortcuts.ts) hands an unavailable binding
   * back to the browser, unless it is chrome-level (`allowInInput`): those stay
   * consumed even while unavailable. So these carry no `allowInInput`, and
   * `availableWhen` is what hands them back everywhere except the two week
   * views that have day columns to scale. Repeatable, because holding the key
   * to sweep the ladder is the whole gesture.
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

  /* ── Rituals ────────────────────────────────────────────────────────── */
  {
    id: 'rituals.chat',
    label: 'Ask AI',
    group: 'rituals',
    icon: AskMarkIcon,
    keywords: 'chat ai assistant ask question',
    // 'beacon' stays as an alias: it is how the row was reached before the AI
    // lost its name, and only the first alias (`/chat`) is ever shown.
    aliases: ['chat', 'beacon'],
    // The AI gate (lib/ai-registry.ts), read off the store rather than ctx so
    // CommandContext stays the shape every caller already builds. A row that
    // opens a chat nothing will answer is the thing the gate exists to stop.
    hidden: () => !getAICapabilities().canChat,
    availableWhen: () => getAICapabilities().canChat,
    run: (ctx) => ctx.openChat(),
  },
  // Ask AI's place while nothing answers (the AI setup spec's "Doors"): "Set
  // up AI" while the gate invites, "Fix AI" while a saved key needs
  // attention. Palette only (no shortcut id: the frozen list in
  // commands.test.ts stays as it is, and Ctrl+J already opens the same
  // column). Hidden as well as unavailable outside its own state, so No AI,
  // an unknown gate and a working connection never see a greyed row. Open
  // only, never a toggle (lib/open-chat.ts openSetup): on desktop the setup
  // column, on the phone the Ask tab, which holds the setup page then. The
  // launcher draws whichever is offered inline, first in Actions
  // (components/sidebar/omnibar.tsx), so these two are only ever reached as
  // ordinary rows in the dock and in `/`.
  {
    id: 'ai.setup',
    label: 'Set up AI',
    group: 'rituals',
    icon: AskMarkUnlitIcon,
    keywords: 'ai ask chat assistant connect key gemini openrouter model',
    aliases: ['setup', 'connect'],
    verb: 'open',
    hidden: () => !getAICapabilities().askInvite,
    availableWhen: () => getAICapabilities().askInvite,
    run: (ctx) => {
      openSetup(ctx.isMobile);
    },
  },
  {
    id: 'ai.fix',
    label: 'Fix AI',
    group: 'rituals',
    icon: AskMarkUnlitIcon,
    keywords: 'ai ask chat assistant key repair reconnect gemini model',
    verb: 'open',
    hidden: () => !getAICapabilities().askFix,
    availableWhen: () => getAICapabilities().askFix,
    run: (ctx) => {
      openSetup(ctx.isMobile);
    },
  },
  {
    id: 'rituals.catchUp',
    label: 'Pick things back up',
    group: 'rituals',
    icon: Wand2,
    keywords: 'catch up overdue behind reschedule plan proposal',
    aliases: ['catchup'],
    // Computed locally (lib/proposal.ts), so this works with no AI configured
    // at all — the feature that matters most on the worst day must not depend
    // on a provider being reachable. So it is never gated: with no chat to open,
    // the card renders in the dock's catch-up host instead (SidebarDock on
    // desktop, hence revealing it; the phone's dock is always on screen).
    //
    // With chat, the card's one home is Ask home (lib/open-chat.ts
    // useChatCardHomeShown), so the item on top is closed and the stack popped
    // to home first, and the card lands where it is seen. The close goes
    // through the one flushing close BEFORE the request, because `request`
    // builds the catch-up proposal at once from the planner store, and a title
    // typed a moment ago must already be in it.
    //
    // On the phone it asks for no box: the card is Apply and Not now, things
    // to tap, and the box's keyboard would come up over it (the reason Ask
    // home asks for none on arrival). The omnibar the command was typed
    // into unmounts with Today's dock, so the keyboard goes down.
    run: (ctx) => {
      if (getAICapabilities().canChat) closeItemPanel();
      if (revealChat(ctx.isMobile, { boxOnPhone: false })) {
        useRailStore.getState().popToHome(ctx.isMobile ? 'phone' : 'desktop');
      } else if (!ctx.isMobile) {
        revealDock();
      }
      useProposalStore.getState().request('catch-up');
    },
  },
  {
    id: 'rituals.planDay',
    label: 'Plan my day',
    description: 'Asks your AI to build a plan from today’s tasks',
    group: 'rituals',
    icon: Wand2,
    keywords: 'plan day schedule ai organise organize',
    aliases: ['plan'],
    hidden: () => !getAICapabilities().canChat,
    availableWhen: () => getAICapabilities().canChat,
    // Always a fresh conversation, titled after the ritual, so a reply still
    // streaming somewhere else is never in the way.
    run: (ctx) => askNew('Plan my day', { title: 'Plan my day', isMobile: ctx.isMobile }),
  },
  // Ask's own two doors, palette only (no shortcut id: the frozen list in
  // commands.test.ts stays as it is).
  {
    id: 'ask.newChat',
    label: 'New chat',
    group: 'rituals',
    icon: MessageSquarePlus,
    keywords: 'ask ai chat conversation new start fresh',
    hidden: () => !getAICapabilities().canChat,
    availableWhen: () => getAICapabilities().canChat,
    run: (ctx) => void newChat(ctx.isMobile, { reveal: true }),
  },
  {
    id: 'ask.history',
    label: 'Conversation history',
    group: 'rituals',
    icon: HistoryIcon,
    keywords: 'ask ai chat conversations history past saved search',
    // With saving off (the migration missing) there is nothing to list.
    hidden: () => !getAICapabilities().canChat || useConversationsStore.getState().saving === 'off',
    availableWhen: () => getAICapabilities().canChat && useConversationsStore.getState().saving !== 'off',
    run: (ctx) => openHistory(ctx.isMobile, { reveal: true, focusSearch: true }),
  },
  // ⌘K hands off to Make (memory/plans/mods.md, "AI writes it"): Write with
  // AI lives in Settings → Make, gated on canMake (a connected model, never
  // OpenClaw alone). This only opens it with the Recipe box focused; nothing
  // is sent until Write is pressed there. Palette only, so no shortcut id.
  {
    id: 'make.write',
    label: 'Write a recipe with AI',
    group: 'mods',
    icon: AskMarkIcon,
    keywords: 'ai make recipe theme look write automate when',
    hidden: () => !getAICapabilities().canMake,
    availableWhen: () => getAICapabilities().canMake,
    run: (ctx) => {
      if (ctx.navigate) ctx.navigate('/settings/make?write=recipe');
      else if (typeof window !== 'undefined') window.location.assign('/settings/make?write=recipe');
    },
  },
  // The same door with the Mod box (build order 10). It shares make.write's
  // gate and sends nothing either; Make boots the sandbox when the kind is a
  // mod, since a draft is checked there before its card shows.
  {
    id: 'make.write-mod',
    label: 'Write a mod with AI',
    group: 'mods',
    icon: AskMarkIcon,
    keywords: 'ai make mod panel card command counter write code',
    hidden: () => !getAICapabilities().canMake,
    availableWhen: () => getAICapabilities().canMake,
    run: (ctx) => {
      if (ctx.navigate) ctx.navigate('/settings/make?write=mod');
      else if (typeof window !== 'undefined') window.location.assign('/settings/make?write=mod');
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
    label: 'Open or close Ask',
    group: 'workspace',
    icon: MessageSquare,
    keywords: 'chat panel sidebar hide show ask rail right panel history',
    // The shortcut id is FROZEN (commands.test.ts): it is the key a rebinding
    // is stored under, so it keeps its pre-rail name. Only the default moved,
    // from ⌘] (Forward in every Mac browser) to Ctrl+J, ⌘J on a Mac ('meta'
    // folds to the platform's primary modifier, lib/commands/keys.ts).
    shortcut: {
      id: 'toggle_right_sidebar',
      keys: ['meta', 'j'],
      allowInInput: true,
      context: 'Desktop only. On the phone, Ask is a tab.',
    },
    // The phone's Ask is a tab, not the rail. With nothing to answer but the
    // gate offering setup or a fix, the chord opens the setup column, as the
    // unlit key does (lib/open-chat.ts toggleRail); the palette row stays
    // hidden then, since "Open or close Ask" is not what it opens. With
    // nothing offered (AI hidden, the gate unknown) the rail is only the
    // item's panel, and the chord stays consumed and inert (`availableWhen`;
    // hooks/use-command-shortcuts.ts), so the browser's own Ctrl+J never opens
    // either.
    // The setup column is the desktop rail's, so on the phone shell the chord
    // offers it nothing: there it would only arm a summon nothing draws, to
    // spring the column open unasked once the window widens (toggle_zen's
    // reason, above).
    hidden: (ctx) => ctx.isMobile || !getAICapabilities().canChat,
    availableWhen: (ctx) => {
      const ai = getAICapabilities();
      return ai.canChat || (!ctx.isMobile && (ai.askInvite || ai.askFix));
    },
    run: () => toggleRail(),
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
      context: 'Desktop only. Nothing on mobile reads the sidebar.',
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
    label: 'Focus right panel',
    description: "Move focus into the open item, or into Ask's box",
    group: 'workspace',
    icon: PanelLeft,
    keywords: 'item panel inspector focus edit details ask rail right',
    shortcut: {
      id: 'focus_item_panel',
      keys: ['meta', '\\'],
      allowInInput: true,
      context: 'While an item panel is open, or Ask is showing.',
    },
    // Hidden for the same reason toggleSidebar is: with nothing open on the
    // right the row would be a trapdoor that appears to do nothing. The binding
    // is the point, and it still shows up in the shortcuts modal.
    hidden: true,
    run: () => {
      const ui = useUIStore.getState();
      if (ui.activeDialog?.type === 'edit-item') ui.focusItemPanel();
      else if (railModeNow() === 'ask') useRailStore.getState().focusDesktopField();
    },
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
    // dock unmounts the omnibar under Ask: focusing a zero-width clipped input
    // otherwise takes n / e / Backspace / ⌘Z down with it until you blur. The
    // setup page keeps the omnibar, so there it stays (leaveAskForOmnibar).
    run: (ctx) => {
      if (ctx.isMobile) {
        leaveAskForOmnibar();
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
        leaveAskForOmnibar();
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
    // until you blur. Mobile switches off the Chat tab where Ask unmounts the
    // omnibar, and stays on the setup page, which keeps it (leaveAskForOmnibar).
    run: (ctx) => {
      if (ctx.isMobile) {
        leaveAskForOmnibar();
      } else {
        revealDock();
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
    keywords: 'paused hidden set aside routine season show grid ghost',
    aliases: ['paused'],
    // Ungated, deliberately. It first carried `routines.length > 0 ||
    // seasons.length > 0` on the theory that the preference is unobservable
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
  {
    // mods.md, "Faults": the off switch for everything a person made that runs.
    // Same write as Settings → Make's make.allOff. No shortcut: ids are frozen.
    id: 'settings.modsOff',
    label: 'Turn all mods off',
    description: 'Switches off every recipe and mod you made.',
    group: 'settings',
    icon: PowerOff,
    keywords: 'mods recipes make disable off safe',
    availableWhen: () => useModsStore.getState().available,
    run: (ctx) => {
      if (ctx.userId) void useModsStore.getState().turnAllOff(ctx.userId);
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
    // The strip's row and Ctrl+Z are one offer. A row with its own take-back
    // ("AI is off" · Undo, lib/no-ai.ts) is what Ctrl+Z takes back while it
    // shows, never the planner's last action from before it.
    availableWhen: () => planner().canUndo || !!useUndoStripStore.getState().entry?.onUndo,
    run: () => {
      const strip = useUndoStripStore.getState();
      const own = strip.entry;
      if (own?.onUndo) {
        strip.dismiss(own.id);
        own.onUndo();
        return;
      }
      planner().undo();
    },
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
    id: 'app.extensions',
    label: 'Extensions store',
    group: 'app',
    icon: Store,
    keywords: 'extensions store plugins add-ons browse heatmap confetti beeminder',
    // No shortcut on purpose: a binding would join the frozen id list in
    // commands.test.ts for a page most people open a handful of times.
    run: (ctx) => {
      // The store is the body of Settings → Extensions.
      if (ctx.navigate) ctx.navigate('/settings/extensions');
      else if (typeof window !== 'undefined') window.location.assign('/settings/extensions');
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
    label: 'Organize routines & seasons',
    group: 'app',
    icon: RepeatIcon,
    keywords: 'routines seasons collections manage organize group pause',
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
  const switches = routines.map((routine) => {
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
  // "Run Morning" — to the routine's page, which leads with today's members in
  // the routine's order (components/planner/routine-today.tsx). Listed in the
  // order the day runs them: by usual time, untimed routines last. Navigation,
  // not a write, so unlike the switch above it has no state to resolve, and a
  // paused routine keeps its row — its page says why nothing is on today.
  const runs = [...routines]
    .sort((a, b) => (a.usualTime ?? '99:99').localeCompare(b.usualTime ?? '99:99'))
    .map(
      (routine) =>
        ({
          id: `routine.run.${routine.id}`,
          label: `Run ${routine.name}`,
          group: 'items',
          icon: ListChecks,
          keywords: `routine ${routine.name} run start do checklist today order`,
          // Client navigation, as goal.open does: a hard load would tear down
          // the hydrated store and the undo stack.
          run: (ctx) => {
            const href = `/routine/${routine.id}`;
            if (ctx.navigate) ctx.navigate(href);
            else if (typeof window !== 'undefined') window.location.assign(href);
          },
        }) satisfies Command,
    );
  cachedRoutineCommands = [...runs, ...switches];
  return cachedRoutineCommands;
};

let cachedSeasons: readonly Season[] | null = null;
let cachedSeasonDay: string | null = null;
let cachedSeasonCommands: Command[] = [];

/**
 * Two commands per season, and both can render at once — unlike the routine
 * pair, where exactly one is a no-op.
 *
 * - "Turn on/off X" is the direct flip, and only the one that would CHANGE
 *   something appears, same reasoning as routines.
 * - "Switch to X" is the swap: it turns X on and everything else off. It only
 *   appears when there is something to turn off, because with nothing else on
 *   it would be the first command wearing a second name.
 *
 * No aliases, for the reason spelled out above routineCommands: season names
 * are free text and a season called "settings" must not steal /settings.
 */
const seasonCommands: CommandProvider = () => {
  const { seasons, collectionsAvailable } = planner();
  if (!collectionsAvailable) return [];
  const tz = planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  // The day is part of the key, not just the array. An `auto` season flips
  // liveness at midnight with NO store write, so array identity alone cannot
  // express the passage of time — a tab left open overnight would keep serving
  // yesterday's "Turn on Summer" for a season the calendar already turned on.
  // Same reasoning as the entity-eligibility memo, which had to learn this too.
  if (seasons === cachedSeasons && todayStr === cachedSeasonDay) return cachedSeasonCommands;

  cachedSeasons = seasons;
  cachedSeasonDay = todayStr;
  const liveCount = seasons.filter((p) => isSeasonActiveOn(p, todayStr)).length;

  cachedSeasonCommands = seasons.flatMap((season) => {
    const live = isSeasonActiveOn(season, todayStr);
    const commands: Command[] = [
      {
        id: `season.${live ? 'pause' : 'activate'}.${season.id}`,
        label: `Turn ${live ? 'off' : 'on'} ${season.name}`,
        group: 'items',
        icon: live ? PauseIcon : PlayIcon,
        keywords: `season ${season.name} ${live ? 'off pause stop hide' : 'on activate start show'}`,
        // Re-resolved at RUN time, and belt-and-braces even with the day in the
        // key above. The label promises an OUTCOME ("on"), not a transition, so
        // if the world already reached it there is nothing to do.
        //
        // The state itself comes from `seasonStateForSwitch`, the same rule the
        // scope rail uses. Writing 'active'/'paused' straight was only ever half
        // right: the FIRST flip of an `auto` season agrees either way, but the
        // return flip does not, and this control could never hand a season back
        // to `auto`. Turn Summer off here and on again and its Aug 31 end is
        // gone — the exact loss two controls for one switch must not disagree
        // about.
        run: () => {
          const desiredOn = !live;
          const current = planner().seasons.find((p) => p.id === season.id);
          if (!current) return;
          const today = toDateStr(new Date(), tz);
          if (isSeasonActiveOn(current, today) === desiredOn) return;
          planner().setSeasonState(season.id, seasonStateForSwitch(current, desiredOn, today));
        },
      },
    ];
    if (!live && liveCount > 0) {
      commands.push({
        id: `season.swap.${season.id}`,
        label: `Switch to ${season.name}`,
        group: 'items',
        icon: CalendarRange,
        keywords: `season program ${season.name} switch swap change only`,
        run: () => planner().swapToSeason(season.id),
      });
    }
    return commands;
  });
  return cachedSeasonCommands;
};

let cachedGoals: readonly Goal[] | null = null;
let cachedGoalCommands: Command[] = [];

/**
 * "Open Learn Chinese", one per ACTIVE goal.
 *
 * One command rather than a pair, because unlike a routine or a season a goal
 * has no daily switch — its states are a lifecycle decision (achieved, set
 * aside) that belongs where the milestone list is visible, not on a row you
 * hit by typing three letters. So the palette's job here is navigation: it is
 * the fastest route to the goal page, which is the surface a long goal is
 * actually visited on.
 *
 * Memoized on the goal array's identity, and ONLY the array — a goal's
 * liveness never changes with the calendar the way an `auto` season's does,
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

let cachedRecipeRows: readonly UserMod[] | null = null;
let cachedRecipeTypes: readonly unknown[] | null = null;
let cachedRecipeCommands: Command[] = [];

/**
 * "Run recipe: Morning reset", one per switched-on recipe whose trigger is
 * ⌘K (memory/plans/mods.md, "Commands"). Ids `mod.<slug>.run`; the slug is
 * unique across every kind a person makes (lib/mods-store.ts createRecipe), and
 * a duplicate is dropped anyway, first one wins.
 *
 * No shortcut (only STATIC_COMMANDS may own a binding) and no alias: a recipe's
 * name is free text, for the reason spelled out above routineCommands. The
 * label always starts "Run recipe:", host chrome the name cannot remove.
 *
 * Memoised on the rows array's identity, which every write replaces, and on
 * the hydrated custom types', which parseRecipe asks (a recipe that adds an
 * Errand is invalid until the Errand type has loaded).
 */
const recipeCommands: CommandProvider = () => {
  const { rows, available, safeMode } = useModsStore.getState();
  if (!available || safeMode) return [];
  const types = getCustomTypeDefs();
  if (rows === cachedRecipeRows && types === cachedRecipeTypes) return cachedRecipeCommands;

  cachedRecipeRows = rows;
  cachedRecipeTypes = types;
  const seen = new Set<string>();
  cachedRecipeCommands = [];
  for (const row of rows) {
    if (row.kind !== 'recipe' || !row.enabled) continue;
    if (parseRecipe(row)?.trigger.on !== 'command') continue;
    const id = `mod.${row.slug}.run`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = modLabel(row);
    cachedRecipeCommands.push({
      id,
      label: `Run recipe: ${label}`,
      group: 'mods',
      icon: Workflow,
      keywords: `recipe ${label} run`,
      availableWhen: () =>
        useModsStore.getState().rows.some((r) => r.id === row.id && r.enabled),
      run: () => runRecipeCommand(row.id),
    });
  }
  return cachedRecipeCommands;
};

let cachedModRows: readonly UserMod[] | null = null;
let cachedModCommands: Command[] = [];

/**
 * "Your mod · Water: Add a glass", one per command a switched-on mod's STORED
 * manifest declares (memory/plans/mods.md, "Commands"; build order 8). Ids
 * `mod.<slug>.<id>`: slugs are unique across every kind (createMod checks
 * every row) and `run` is a reserved command id, so a mod's command never
 * takes a recipe's `mod.<slug>.run`. A duplicate is dropped anyway, first one
 * wins.
 *
 * The stored manifest is Zod-checked here and again at every load, and the
 * runtime refuses one that no longer matches the code, so ⌘K never offers a
 * command the mod does not have. The prefix and the name (modDisplayLabel, so
 * a name only the database accepted shows as the slug) are host chrome the
 * mod cannot remove.
 *
 * No shortcut and no alias, for recipeCommands' reasons. No loaded runtime
 * needed: runModCommand goes through ModHost's slot, which loads the mod
 * lazily; an empty slot (a lean route) does nothing.
 *
 * Build order 9 adds "Your mod · Water: Open Water", one per panel, with ids
 * `mod.<slug>.open.<panelId>`: a mod's command id has no `.`, so none can
 * collide, and their name is modSurfaceLabel, the panel chrome's. They open
 * through the one router (lib/mods/ui/open-panel.ts), the rail on the desktop
 * and the sheet on the phone. And `mod.close-panel`, while
 * a panel shows in the rail: the keyboard's way out with no AI, where Ctrl+J
 * is consumed before it reaches the toggle.
 */
const modCommands: CommandProvider = () => {
  const { rows, available, safeMode } = useModsStore.getState();
  if (!available || safeMode) return [];
  if (rows === cachedModRows) return cachedModCommands;

  cachedModRows = rows;
  const seen = new Set<string>();
  cachedModCommands = [];
  for (const row of rows) {
    if (row.kind !== 'mod' || !row.enabled) continue;
    const manifest = parseModManifest(row);
    if (!manifest) continue;
    const name = modDisplayLabel(row);
    for (const c of manifest.commands) {
      const id = `mod.${row.slug}.${c.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cachedModCommands.push({
        id,
        label: `Your mod · ${name}: ${c.label}`,
        description: 'Your mod',
        group: 'mods',
        icon: Puzzle,
        keywords: c.keywords?.join(' '),
        availableWhen: () =>
          useModsStore.getState().rows.some((r) => r.id === row.id && r.enabled),
        run: () => runModCommand(row.id, c.id),
      });
    }
  }
  for (const p of openablePanelsOf(rows)) {
    const id = `mod.${p.row.slug}.open.${p.panelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = modSurfaceLabel(p.row);
    cachedModCommands.push({
      id,
      label: `Your mod · ${name}: Open ${p.panel.label}`,
      description: 'Your mod',
      group: 'mods',
      icon: Puzzle,
      keywords: 'panel open',
      availableWhen: () => useModsStore.getState().rows.some((r) => r.id === p.modId && r.enabled),
      run: () => openModPanel({ modId: p.modId, panelId: p.panelId }),
    });
  }
  // Offered with any mod at all (shown only while a panel is in the rail): a
  // panel stays open, saying it is off, after its mod is switched off.
  if (rows.some((r) => r.kind === 'mod')) cachedModCommands.push(CLOSE_MOD_PANEL);
  return cachedModCommands;
};

/** "Close your mod's panel", while one shows in the rail (modCommands). */
const CLOSE_MOD_PANEL: Command = {
  id: 'mod.close-panel',
  label: "Close your mod's panel",
  group: 'mods',
  icon: Puzzle,
  keywords: 'mod panel close hide',
  hidden: () => railModeNow() !== 'mod',
  availableWhen: () => railModeNow() === 'mod',
  run: () => useRailStore.getState().closeModPanel(),
};

const PROVIDERS: CommandProvider[] = [
  customTypeCommands,
  routineCommands,
  seasonCommands,
  goalCommands,
  recipeCommands,
  modCommands,
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

import {
  CheckCheck,
  ListTodo,
  Repeat,
  Rows3,
  Clock,
  List,
  Sun,
  CalendarDays,
  Layers,
  Folder,
  Flag,
  Hourglass,
  Shapes,
  ArrowDownAZ,
  CalendarRange,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { GroupBy } from './planner-types';
import type { SortBy } from './sort-rows';
import type { BraindumpGroupBy, TypeFilter, ViewLayout, ViewScope } from './view-store';

/**
 * The canonical option lists for the canvas view controls, shared by the
 * header capsule's dropdowns and the command registry so a layout is labelled
 * and iconed identically wherever you change it from.
 */

export interface ViewOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

export const TYPE_OPTIONS: ViewOption<TypeFilter>[] = [
  { value: 'all', label: 'All', icon: CheckCheck },
  { value: 'tasks', label: 'Tasks', icon: ListTodo },
  { value: 'habits', label: 'Habits', icon: Repeat },
];

export const LAYOUT_OPTIONS: ViewOption<ViewLayout>[] = [
  { value: 'buckets', label: 'Buckets', icon: Rows3 },
  { value: 'schedule', label: 'Schedule', icon: Clock },
  { value: 'list', label: 'List', icon: List },
];

export const SCOPE_OPTIONS: ViewOption<ViewScope>[] = [
  { value: 'day', label: 'Day', icon: Sun },
  { value: 'week', label: 'Week', icon: CalendarDays },
];

/**
 * The canvas grouping vocabulary — every member of `GroupBy`, since Phase 5a
 * deleted the one ('status') that had no branch behind it.
 */
export const CANVAS_GROUP_BY_OPTIONS: ViewOption<GroupBy>[] = [
  { value: 'none', label: 'None', icon: Layers },
  { value: 'project', label: 'Project', icon: Folder },
  { value: 'priority', label: 'Priority', icon: Flag },
  { value: 'bucket', label: 'Time bucket', icon: Hourglass },
  { value: 'routine', label: 'Routine', icon: Repeat },
  { value: 'program', label: 'Program', icon: CalendarRange },
  // Target, matching the Goal chip in the item dialog and the console rail —
  // one glyph for the container wherever it is named.
  { value: 'goal', label: 'Goal', icon: Target },
];

/**
 * How much of the CURRENT view a group-by value actually reaches.
 *
 * Three states, not two, because Phase 5a made "partly" the common case:
 *   honoured + no note   — the whole surface sections by it (both List views,
 *                          and Week × Buckets, whose cells have no spine)
 *   honoured + a note    — some of the surface does, and the note says which
 *                          part. The row stays ENABLED: picking it does
 *                          something, and a disabled row would say it doesn't.
 *   not honoured + note  — inert here. Disabled, reason on the rail.
 *
 * Unhonoured values stay VISIBLE rather than vanishing: a menu whose sections
 * appear and disappear as you switch layouts is harder to learn than one whose
 * rows explain themselves — and a hidden row cannot account for the clause the
 * trigger's count is still adding up, since neither setScope nor setLayout
 * clears canvasGroupBy.
 *
 * Only one combination is genuinely inert now, and it is inert because the view
 * already answers the question.
 */
export interface GroupSupport {
  /** Does picking this change anything on this surface? */
  honoured: boolean;
  /** Short rail text: which part it reaches, or why it reaches none. */
  note: string | null;
}

const FULL: GroupSupport = { honoured: true, note: null };

export function groupBySupport(
  scope: ViewScope,
  layout: ViewLayout,
  value: GroupBy
): GroupSupport {
  if (value === 'none') return FULL;

  if (layout === 'buckets') {
    // The view IS the partition. Four cards of one bucket each, sectioned by
    // bucket, is four cards holding one section apiece.
    if (value === 'bucket') return { honoured: false, note: 'Already by bucket' };
    // Day × Buckets groups its UNTIMED rows only. The timed spine below them
    // carries `scheduled:{bucket}:before|after:{type}:{id}` drop zones, and
    // `inferDropTime` resolves those as ±30 min from that row's own time — so
    // reordering the spine makes "drop above this row" assign a time that
    // contradicts where the row visibly landed.
    if (scope === 'day') return { honoured: true, note: 'Untimed rows only' };
    // A week cell has no per-row droppable (the whole cell is
    // `week:{date}:{bucket}`) and is not in one time order to begin with — it
    // renders habits then tasks — so there is no spine to protect.
    return FULL;
  }

  if (layout === 'schedule') {
    // Time-of-day does not become lanes: y already IS it, so four bucket-lanes
    // would be a diagonal staircase with three quarters of the field dead. The
    // Anytime strip still sections by it, which is the honest half.
    if (value === 'bucket') return { honoured: true, note: 'Anytime only' };
    // Phase 5b: the grid partitions on x. Day divides into lanes where the field
    // can afford them and falls back to focus where it cannot; Week is always
    // focus. Both are the grouping, honoured — which of the two you get is
    // arithmetic the menu cannot state in a rail (it depends on the measured
    // field and the group count), and the cap row above the grid shows it.
    return FULL;
  }

  return FULL;
}

export const SORT_BY_OPTIONS: ViewOption<SortBy>[] = [
  { value: 'default', label: 'Default', icon: List },
  { value: 'priority', label: 'Priority', icon: Flag },
  { value: 'title', label: 'Title A–Z', icon: ArrowDownAZ },
];

/**
 * Why the current LAYOUT cannot honour an ordering, or null when it can.
 *
 * Only List. `inferDropTime` resolves a drop as ±30 min from its neighbour's
 * time, so a Buckets card's timed spine has to stay in `startTime` order or
 * "drop after this row" assigns a time contradicting where the row landed.
 * Schedule is the same argument taken to its limit: there, y position IS time.
 *
 * Scope does NOT block it — Week × List honours ordering exactly as Day × List
 * does, since each day section is its own list.
 */
export function sortByBlockedBy(layout: ViewLayout, value: SortBy): string | null {
  if (value === 'default') return null;
  return layout === 'list' ? null : 'List only';
}

/**
 * The braindump's own group-by vocabulary — a different union: it has `type`,
 * which the canvas answers with the Type filter instead, and lacks `bucket`,
 * since nothing in the braindump carries a time of day.
 */
export const BRAINDUMP_GROUP_BY_OPTIONS: ViewOption<BraindumpGroupBy>[] = [
  { value: 'none', label: 'None', icon: Layers },
  { value: 'type', label: 'Type', icon: Shapes },
  { value: 'project', label: 'Project', icon: Folder },
  { value: 'priority', label: 'Priority', icon: Flag },
  { value: 'routine', label: 'Routine', icon: Repeat },
  { value: 'program', label: 'Program', icon: CalendarRange },
  { value: 'goal', label: 'Goal', icon: Target },
];

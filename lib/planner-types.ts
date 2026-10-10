/**
 * planner-types.ts
 *
 * Core entity types (Task, Habit, Project) are the source of
 * truth in @dsul/types and re-exported from there.
 *
 * This file adds dsul app-specific types and constants that don't need to
 * be shared externally (ViewMode, FilterState, UI helpers, etc.).
 */

// ── Re-export shared types from @dsul/types ─────────────────────────────
export type {
  Priority,
  TimeBucket,
  TaskStatus,
  HabitStatus,
  RepeatFrequency,
  Task,
  Habit,
  Item,
  ItemType,
  KnownItemType,
  TaskItem,
  HabitItem,
  CustomItem,
  ItemTypeDef,
  Project,
  HabitGroupType,
  Routine,
  Season,
  SeasonState,
  Goal,
  GoalState,
  GoalRole,
  Proposal,
  ProposalDraft,
  ProposalOperation,
  ProposalCreateOp,
  ProposalUpdateOp,
  ProposalVerbOp,
  ProposalContainerOp,
  ProposalMembershipOp,
  ProposalContainer,
  ProposalVerb,
} from '@dsul/types'

// ── App-only types ────────────────────────────────────────────────────────────

export type ViewMode = 'day' | 'week';
/**
 * 'status' is gone. It was a legal member with no branch anywhere — picking it
 * rendered identically to 'none' — and it can never gain one: the task and habit
 * status vocabularies (`pending|completed|cancelled` / `pending|done|skipped`)
 * are frozen external contracts that the OpenClaw plugin `safeParse`s, so a
 * section heading would have to either merge them or show two ladders for one
 * axis. It survives only as a stale persisted string; see `isGroupBy`.
 */
export type GroupBy =
  | 'none'
  | 'project'
  | 'priority'
  | 'bucket'
  | 'routine'
  | 'season'
  | 'goal';

export const GROUP_BY_VALUES: readonly GroupBy[] = [
  'none',
  'project',
  'priority',
  'bucket',
  'routine',
  'season',
  'goal',
];

/**
 * Coerce whatever a persisted payload holds.
 *
 * Two live sources can carry `'status'`: `dsul-view`'s own `canvasGroupBy`,
 * and `planner-storage`'s `groupBy`, which `adoptLegacyViewPrefs` copies across
 * on first mount. Unrecognised values reach `groupRows`, whose container branch
 * is the fallthrough — so an unknown string would silently group by project.
 */
export const isGroupBy = (v: unknown): v is GroupBy =>
  typeof v === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(v);
export type FilterType = 'project' | 'priority' | 'startDate' | 'repeat' | 'status';

export interface FilterState {
  project?: string;
  priority?: Priority;
  startDate?: 'today' | 'week' | 'overdue' | 'none';
  repeat?: boolean;
  status?: TaskStatus;
}

export interface PlannerState {
  tasks: Task[];
  habits: Habit[];
  selectedDate: Date;
  viewMode: ViewMode;
  groupBy: GroupBy;
  filters: FilterState;
  projects: Project[];
}

// ── UI helpers ────────────────────────────────────────────────────────────────

import type { Priority, TimeBucket, RepeatFrequency, TaskStatus, Task, Habit, Project } from '@dsul/types'

export const TIME_BUCKET_RANGES: Record<TimeBucket, { start: number; end: number; label: string }> = {
  anytime:   { start: 0,  end: 24, label: 'Anytime'   },
  morning:   { start: 0,  end: 12, label: 'Morning'   },
  afternoon: { start: 12, end: 17, label: 'Afternoon' },
  evening:   { start: 17, end: 24, label: 'Evening'   },
};

export function formatBucketHour(hour: number, use24h = false): string {
  const h = hour % 24;
  if (use24h) return `${String(h).padStart(2, '0')}:00`;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function formatBucketRange(range: { start: number; end: number }, use24h = false): string {
  return `${formatBucketHour(range.start, use24h)} - ${formatBucketHour(range.end, use24h)}`;
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low', medium: 'Medium', high: 'High',
};

/**
 * The starter set a brand-new account is given (organize-console decision 2).
 *
 * NO `id`, and the type says so. These are TEMPLATES: an id baked into a module
 * constant would be the same uuid in every account, which the `(user_id, id)`
 * composite key would tolerate and every other assumption in the app would not.
 * The seeding action mints one per row. (This is also why the constants had six
 * of the branch's tsc errors — they were typed as finished `Project` /
 * `HabitGroupType` values, which have required ids since 027.)
 *
 * `icon:PascalName` tokens, not bare emoji. The emoji here predate the token
 * system by a year and were never migrated, because nothing ever imported these
 * — they would have rendered as a literal "💼" in a row that draws Lucide glyphs
 * everywhere else.
 *
 * ONE LIST since migration 039, and the six names are the two old lists
 * unchanged. They were deliberately made disjoint when projects and habit groups
 * were separate namespaces (a chip reading "Work" could not say which it meant),
 * which is exactly what makes concatenating them safe now that there is only one
 * namespace — there is no pair to collide. The WHERE names (Work / Home /
 * Health) come first and the WHEN names (Morning / Movement / Wind-down) after,
 * because that is the order the console lists them in and habits are gardened by
 * time of day.
 */
export interface ContainerSeed {
  name: string;
  emoji: string;
}

export const DEFAULT_PROJECTS: ContainerSeed[] = [
  { name: 'Work',      emoji: 'icon:Briefcase' },
  { name: 'Home',      emoji: 'icon:House' },
  { name: 'Health',    emoji: 'icon:HeartPulse' },
  { name: 'Morning',   emoji: 'icon:Sunrise' },
  { name: 'Movement',  emoji: 'icon:Footprints' },
  { name: 'Wind-down', emoji: 'icon:Moon' },
];

export const REPEAT_FREQUENCY_LABELS: Record<RepeatFrequency, string> = {
  none:     'No repeat',
  daily:    'Daily',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  monthly:  'Monthly',
  custom:   'Custom days',
};

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

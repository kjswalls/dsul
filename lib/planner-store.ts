'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
// The store's one UI import, and it earns it: a swallowed write failure is the
// exact bug undoFailedCreate exists to fix, so the net has to be able to speak.
// planner-store is 'use client' and no server route imports it, and <Toaster>
// is mounted in the root layout.
import { toast } from 'sonner';
import type {
  Task,
  Item,
  TaskItem,
  HabitItem,
  ItemType,
  ViewMode,
  GroupBy,
  FilterState,
  TimeBucket,
  TaskStatus,
  HabitStatus,
  Priority,
  Project,
  ItemTypeDef,
  Routine,
  Program,
  Goal,
  GoalRole,
  Proposal,
} from './planner-types';
import { PRIORITY_LABELS, TIME_BUCKET_RANGES } from './planner-types';
import { validateProposalOperations } from './proposal';
import {
  addDaysToDateStr,
  goalItemIds,
  goalProgress,
  milestoneItemIds,
  resolveGoalStateWrite,
  roleStillValid,
} from './goals';
import {
  fetchItems,
  fetchProjects,
  fetchItemTypes,
  createItemType as dbCreateItemType,
  updateItemType as dbUpdateItemType,
  deleteItemType as dbDeleteItemType,
  createItem as dbCreateItem,
  createItems as dbCreateItems,
  updateItem as dbUpdateItem,
  deleteItem as dbDeleteItem,
  changeItemType as dbChangeItemType,
  restoreItem as dbRestoreItem,
  setItemCompletion as dbSetItemCompletion,
  setItemSkip as dbSetItemSkip,
  createProject as dbCreateProject,
  updateProject as dbUpdateProject,
  deleteProject as dbDeleteProject,
  restoreProject as dbRestoreProject,
  renameContainerMembers as dbRenameContainerMembers,
  fetchRoutines,
  createRoutine as dbCreateRoutine,
  updateRoutine as dbUpdateRoutine,
  deleteRoutine as dbDeleteRoutine,
  restoreRoutine as dbRestoreRoutine,
  fetchPrograms,
  fetchGoals,
  createGoal as dbCreateGoal,
  updateGoal as dbUpdateGoal,
  deleteGoal as dbDeleteGoal,
  recordCheckin as dbRecordCheckin,
  restoreGoal as dbRestoreGoal,
  createProgram as dbCreateProgram,
  updateProgram as dbUpdateProgram,
  deleteProgram as dbDeleteProgram,
  restoreProgram as dbRestoreProgram,
  itemDbType,
  adoptContainerMembers,
  type TrashEntry,
} from './db';
import { celebrateCompletion } from './completion-confetti';
import type { CommitResult, SeedPlan } from './seed-containers';
import { ITEM_TYPES, getItemTypeConfig, itemTypeName, isSkippable, isPausable, isCollectible, hydrateCustomTypes } from './item-registry';
import {
  isPausedOn,
  isProgramActiveOn,
  inactiveItemIdsOn,
  resolvePauseWrite,
  suppressionReason,
  suppressionLabel,
} from './active';
import { programStateForSwitch } from './scope-rail';
import { conversionBlock, convertItem, type ConvertRepeat } from './item-convert';
import { recordReleased } from './sweep-grace';
// Type-only, so it is erased at compile time and lib/local-state.ts importing
// this store back does not make a runtime cycle.
import type { ClearScope } from './local-state';
import {
  PROJECT_FIELDS,
  ROUTINE_FIELDS,
  PROGRAM_FIELDS,
  GOAL_FIELDS,
} from '@dsul/types';
import { saveSettings } from './settings-service';
import { isRecurring, isCompletedOnDate, toDateStr } from './recurrence';
import { accentColorForName } from './accent-colors';
import { CONTAINER_KINDS, foldContainerName, sameContainerName } from './container-registry';
import {
  canBulkClearProject,
  canBulkCollect,
  canBulkSetPriority,
  canBulkSetProject,
  canBulkSetReminder,
  itemCount,
} from './bulk-edit';

interface PlannerStore {
  /**
   * Source of truth: every task and habit as a unified Item. `tasks` and
   * `habits` are projections kept in sync on every mutation so existing
   * consumers keep working unchanged; new code should prefer `items`.
   */
  items: Item[];
  tasks: Task[];
  /**
   * `HabitItem[]`, not `Habit[]`, since 039.
   *
   * The two shapes were interchangeable until the CLASSIFY collapse; now the
   * item answers with `project` and the LEGACY `Habit` answers with `group`.
   * The store is app-side, so it holds the item shape and every UI consumer
   * reads `habit.project` like it reads `task.project`. `toLegacyHabit` in
   * lib/db.ts is the only place the other spelling exists.
   *
   * `tasks` stays `Task[]` because that projection did not move: a `TaskItem`
   * minus its discriminant IS a `Task`.
   */
  habits: HabitItem[];
  selectedDate: Date;
  viewMode: ViewMode;
  groupBy: GroupBy;
  filters: FilterState;
  projects: Project[];
  timelineItemFilter: 'all' | 'tasks' | 'habits';
  compactMode: boolean;
  setCompactMode: (compact: boolean) => void;
  navDirection: 'left' | 'right' | null;
  setNavDirection: (direction: 'left' | 'right' | null) => void;
  chillMode: boolean;
  setChillMode: (chill: boolean) => void;
  showCurrentTimeIndicator: boolean;
  setShowCurrentTimeIndicator: (show: boolean) => void;
  showCompletedTasks: boolean;
  setShowCompletedTasks: (show: boolean) => void;
  /**
   * Render suppressed work in place, greyed, instead of hiding it (Phase 5).
   *
   * Deliberately grid-only. The braindump already has a better answer — the
   * Paused section groups by CAUSE, which a greyed row inline cannot — and the
   * question this setting answers is a canvas question: "what would today look
   * like with Summer back on?"
   */
  showPausedOnGrid: boolean;
  setShowPausedOnGrid: (show: boolean) => void;
  defaultView: 'day' | 'week';
  setDefaultView: (view: 'day' | 'week') => void;
  defaultTimeBucket: TimeBucket;
  setDefaultTimeBucket: (bucket: TimeBucket) => void;
  animationsEnabled: boolean;
  setAnimationsEnabled: (enabled: boolean) => void;
  weekStartDay: 'sunday' | 'monday' | 'saturday';
  setWeekStartDay: (day: 'sunday' | 'monday' | 'saturday') => void;
  timeFormat: '12h' | '24h';
  setTimeFormat: (format: '12h' | '24h') => void;
  /** IANA zone from user_settings (hydrated on login); use with chat timestamps, EOD, etc. */
  userTimezone: string | null;
  /** ID of the task/habit card currently under the mouse cursor — used by keyboard shortcuts */
  hoveredItemId: string | null;
  hoveredItemType: 'task' | 'habit' | null;
  setHoveredItem: (id: string | null, type: 'task' | 'habit' | null) => void;

  // Supabase state
  userId: string | null;
  isLoading: boolean;
  error: string | null;
  /**
   * The account whose most recent load FAILED, or null.
   *
   * A failed load leaves `userId` stamped and `isLoading` false, which is
   * exactly what a finished load looks like, so `initializeStore`'s opening
   * guard used to read a failed account as loaded and refuse every retry: the
   * notice's Retry and the provider's next SIGNED_IN both did nothing, and only
   * a page reload, or signing out and back in, recovered. The guard reads this
   * field now, and so does the notice, so the row offers a Retry exactly when
   * a retry will load.
   *
   * Both read this and not `error`, which is a message slot. Keyed on `error`,
   * a later writer of it for some other failure would have the notice offer a
   * Retry, and the guard grant it, that resets a planner that loaded fine. (The
   * provider's unlatch, the sweep's gate and the braindump's count still read
   * `error` as "the load failed", which holds while the load is its only
   * writer.)
   *
   * The first-run seed reads it too: after a failed load the store's empty
   * arrays mean "the fetch broke", not "a brand-new account".
   */
  loadFailedUserId: string | null;

  // Store lifecycle
  /**
   * Say WHO is signed in, without fetching anything.
   *
   * `userId` used to have exactly one writer — `initializeStore` — which made
   * it mean two things at once: "this account is signed in" AND "the
   * seven-table item fetch has begun". Every surface that only needed the
   * first had to pay for the second. `/settings` is the clearest case: its
   * hydration gate (lib/settings/hydration.ts) reads `userId` and no item on
   * this store, and #243 already took the item load off that gate's critical
   * path — but the load still had to be STARTED for the page to know who it
   * was rendering for.
   *
   * Splitting the two is what lets a route that shows no items skip the fetch
   * without the pages that only wanted the identity going dark.
   *
   * `isLoading: true` rides along and is not incidental: every `!isLoading`
   * gate in the app (the overdue sweep, the auto-age sweep, AppShell's
   * readiness check, /item and /goal's not-found guards) reads it as "the
   * items are settled". They are not — they have not been asked for. Leaving
   * it false would hand every one of those an EMPTY store that claims to be
   * complete, which is how a sweep unschedules a year of work in one silent
   * batch. It also keeps `initializeStore`'s own early-return open: that guard
   * skips a re-entry only when the account is stamped, not loading, and its
   * last load did not fail, so the stamp must not look like a finished load.
   */
  identifyUser: (userId: string) => void;
  initializeStore: (userId: string) => Promise<void>;
  clearStore: () => void;
  /**
   * Drop the persisted PREFERENCES slice — see lib/local-state.ts.
   *
   * Its sibling `clearStore` above drops the DATA (items, containers, goals,
   * history) and is called on sign-out. It has never touched the thirteen
   * fields `planner-storage` writes to localStorage, and three of them —
   * `groupBy`, `timelineItemFilter`, `showPausedOnGrid` — have no
   * `user_settings` column, so `hydrateSettings` never overwrites them either.
   * Those three survived every sign-out and every account switch this app has
   * ever done.
   *
   * Every one of the thirteen is INERT in lib/local-state.ts' sense — density,
   * which slice of time is on screen, the grouping axis, four visibility
   * toggles, which day a week starts on, 12h/24h. Booleans and closed enums
   * throughout; no free text, nothing derived from the account's own rows. So
   * they say what the screen looks like and nothing about who was sitting at
   * it, and this only fires under scope 'all' — a known change of user, not the
   * unstamped browser every existing install presents on its first load.
   */
  clearUserScopedState: (scope: ClearScope) => void;

  // Task actions ('task' actions operate on any task-LIKE item — custom types
  // are task-shaped and ride this pipeline; only habits are excluded)
  /** Create an item of a user-defined type (task-shaped). */
  addItem: (
    customType: string,
    item: Omit<Task, 'id' | 'order' | 'status' | 'isScheduled'>,
    memberships?: Memberships,
  ) => void;
  addTask: (
    task: Omit<Task, 'id' | 'order' | 'status' | 'isScheduled'>,
    memberships?: Memberships,
  ) => void;
  /**
   * Bulk create — the paste-a-list path (bulk-add dialog). One set(), one
   * history entry, one undo, then one DB write per row, per the bulk-verb
   * contract above. `type` is 'task' or a hydrated custom slug and applies to
   * every row; habits are excluded (their config doesn't fit one-per-line).
   * A single-element array delegates to addTask/addItem so its history label
   * stays the natural "Add task: …" form.
   */
  addTasksBulk: (
    type: string,
    items: Array<Omit<Task, 'id' | 'order' | 'status' | 'isScheduled'>>,
  ) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  /**
   * Switch an item to another type (lib/item-convert.ts). A no-op when the
   * switch is refused — callers show the reason from `conversionBlock`.
   * `repeat` is the repeat a one-off takes on becoming a repeat-only type.
   */
  changeItemType: (id: string, toType: string, opts?: { repeat?: ConvertRepeat }) => void;
  deleteTask: (id: string) => void;
  toggleTaskStatus: (id: string, status?: TaskStatus, date?: Date) => void;
  scheduleTask: (id: string, bucket: TimeBucket, time?: string, date?: string) => void;
  assignTaskToBucket: (id: string, bucket: TimeBucket) => void;
  unscheduleTask: (id: string) => void;
  /**
   * Carry ONE task-like item to `dateStr` (yyyy-MM-dd), guaranteeing it stays
   * visible on that day (see the timeBucket note at the implementation).
   * Preserves startTime.
   */
  moveTaskToDate: (id: string, dateStr: string) => void;
  /**
   * Bulk carry: one set(), one history entry, one undo. Same visibility
   * guarantee as moveTaskToDate, but deliberately drops startTime/isScheduled.
   * `bucket` overrides each item's own bucket (a week-grid group drop targets a
   * specific bucket); omitted, each item keeps its current bucket.
   */
  moveTasksToDate: (ids: string[], dateStr: string, bucket?: TimeBucket) => void;
  /**
   * Batched unscheduleTask — one set(), one history entry, one undo.
   *
   * `opts.label` overrides the history entry's text, which is also what decides
   * whether the undo toast fires (hooks/use-undo-toast.ts matches on prefix).
   * Only the auto-age sweep passes it, and only to stand the toast down; see
   * the note at the implementation.
   */
  unscheduleTasks: (ids: string[], opts?: { label?: string }) => void;
  /**
   * Put scheduling fields back on specific rows — the forward-facing inverse of
   * `unscheduleTasks`, addressed at ids rather than at the top of the history
   * stack.
   *
   * This exists because "undo" and "put those back" stop being the same thing
   * within seconds. An undo toast can pop the stack safely because it lives for
   * five seconds and nothing else has happened yet. A receipt that persists —
   * the dock's line for the overnight sweep — cannot: by the time it is read,
   * the sweep is buried under everything the user has done since, and a pop
   * would reverse the wrong action entirely. Restoring recorded field values is
   * the same outcome, still one set() and so still itself undoable, but correct
   * no matter how long the offer sat there.
   */
  restoreScheduling: (
    entries: readonly {
      id: string;
      isScheduled: boolean;
      startDate?: string;
      timeBucket?: string;
      startTime?: string;
    }[]
  ) => void;
  reorderTasks: (taskIds: string[]) => void;
  /**
   * Apply an accepted AI proposal. Operations are re-validated against the type
   * registry here (never trust the model), then applied in ONE set() so the
   * whole plan is a single Cmd+Z. Returns the number of operations applied.
   */
  applyProposal: (proposal: Proposal) => number;

  // Multi-select bulk actions (any kind). Each does exactly ONE set() so the
  // whole gesture is a single undo, then fans out one DB write per item with
  // that item's own slug — see moveTasksToDate for the pattern.
  /** Bulk delete a mixed selection, cascading task-like subtasks. */
  deleteItems: (ids: string[]) => void;
  /**
   * Bulk completion for `date`, routed per kind: per-date completedDates for
   * habits and recurring task-likes, scalar status for one-off task-likes.
   * Items already in the target state are skipped (no double-counted streaks).
   */
  setItemsCompleted: (ids: string[], completed: boolean, date?: Date) => void;
  /** Bulk assign a mixed selection to a time bucket, untimed (group drag). */
  assignItemsToBucket: (ids: string[], bucket: TimeBucket) => void;
  /**
   * Add or remove a whole selection's membership of one routine or program, in
   * one set() ⇒ one undo. The registry gates eligibility (subtasks are not
   * collectible), so a mixed selection collects its eligible subset rather than
   * refusing wholesale — same posture as the other bulk verbs.
   */
  setItemsCollected: (
    ids: string[],
    kind: 'routine' | 'program',
    containerId: string,
    member: boolean,
  ) => void;
  /**
   * Bulk property edits — the multiselect bar's Edit menu. Each asks
   * lib/bulk-edit.ts for its eligible subset, drops the items already in the
   * requested state, and writes the rest in one set() ⇒ one undo. A request
   * nothing would change writes nothing and logs nothing.
   */
  /** `undefined` clears. Habits (no priority field) and cancelled items are skipped. */
  setItemsPriority: (ids: string[], priority: Priority | undefined) => void;
  /**
   * Re-file under a project by name (`undefined` unfiles). The id is resolved
   * once, case-folded. Unfiling skips types whose container is required.
   */
  setItemsProject: (ids: string[], name: string | undefined) => void;
  /**
   * Set every eligible item's cue to `time` (HH:mm), keeping each one's own
   * anchor phrase; `undefined` clears both halves.
   */
  setItemsReminder: (ids: string[], time: string | undefined) => void;
  /**
   * Add a selection to a goal as plain members, or strip it from the goal in
   * whatever role each item held. setItemsCollected's shape, for the third
   * container role.
   */
  setItemsGoal: (ids: string[], goalId: string, member: boolean) => void;
  /**
   * Bulk schedule a mixed selection AT a clock time (group drag onto a timed
   * grid slot) so they land as visible blocks, not untimed rows. Task-likes take
   * the date; habits are date-blind and just take the bucket + time. One undo.
   */
  scheduleItemsAt: (ids: string[], bucket: TimeBucket, time: string, dateStr?: string) => void;
  /**
   * Declare whether ONE recurring occurrence is skipped (intent-based, so a
   * repeat is a no-op). Type-agnostic: the registry decides whether the type
   * can be skipped at all and whether a skip is also denormalized into scalar
   * `status` — it is for habits, never for tasks (see ItemTypeConfig.skipStatus).
   */
  setItemSkipped: (id: string, skipped: boolean, date?: Date) => void;
  /** Pause/resume an item. `until` is an exclusive resume date (yyyy-MM-dd). */
  setItemPaused: (id: string, paused: boolean, until?: string) => void;

  // Habit actions
  addHabit: (habit: Omit<HabitItem, 'id' | 'type' | 'streak' | 'status' | 'completedDates' | 'skippedDates' | 'dailyCounts' | 'currentDayCount'>, memberships?: Memberships) => void;
  updateHabit: (id: string, updates: Partial<HabitItem>) => void;
  deleteHabit: (id: string) => void;
  toggleHabitStatus: (id: string, status: HabitStatus, count?: number, date?: Date) => void;
  scheduleHabit: (id: string, bucket: TimeBucket, time?: string) => void;
  assignHabitToBucket: (id: string, bucket: TimeBucket) => void;
  resetHabitStreak: (id: string) => void;

  // View actions
  setSelectedDate: (date: Date) => void;
  setViewMode: (mode: ViewMode) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setFilters: (filters: FilterState) => void;
  clearFilters: () => void;
  setTimelineItemFilter: (filter: 'all' | 'tasks' | 'habits') => void;

  // Project actions
  /**
   * Returns the new project's id, or null when the name is already taken
   * (case-folded) and nothing was created. `extra` rides the same set() and the
   * same insert — a colour picked in the "new" dialog is part of the arrival,
   * not a second write the undo stack would split off.
   */
  addProject: (
    name: string,
    emoji: string,
    extra?: Partial<Omit<Project, 'id' | 'name' | 'emoji'>>
  ) => string | null;
  /** First-run starter containers. See seedStarterContainers for the guards. */
  seedStarterContainers: (plan: SeedPlan, forUserId: string) => CommitResult;
  updateProject: (id: string, updates: Partial<Project>) => void;
  removeProject: (id: string) => void;
  getProjectEmoji: (name: string) => string;
  getProjectColor: (name: string) => string;
  getProject: (name: string) => Project | undefined;
  moveTaskToProjectBlock: (taskId: string) => void;
  moveTasksToProjectBlock: (taskIds: string[]) => void;
  moveTaskOutOfProjectBlock: (taskId: string) => void;

  // Item type definitions (user-defined types, Phase 6). Hydrated into the
  // capability registry on load; NOT part of undo/redo history.
  itemTypes: ItemTypeDef[];
  /** False when the item_types table is unreachable (migration 021 not yet
   *  applied) — creation UI must gate on this or writes vanish on reload. */
  itemTypesAvailable: boolean;
  addItemType: (def: Omit<ItemTypeDef, 'id'>) => void;
  updateItemType: (id: string, updates: Partial<Omit<ItemTypeDef, 'id' | 'name'>>) => void;
  removeItemType: (id: string) => void;

  // Routines (migration 024). A routine scopes its members: while it is paused,
  // its items are suppressed even though nothing on the items changed. Part of
  // undo/redo history, unlike itemTypes — membership is user data.
  routines: Routine[];
  /** False when migration 024's tables are unreachable. Every routine UI gates
   *  on this, or writes look like they landed and vanish on reload. */
  collectionsAvailable: boolean;
  addRoutine: (routine: Omit<Routine, 'id'> & { id?: string }) => string;
  updateRoutine: (id: string, updates: Partial<Omit<Routine, 'id'>>) => void;
  removeRoutine: (id: string) => void;
  /**
   * Pause/resume a routine. Same today-resolved, dateless semantics as items.
   *
   * `until` distinguishes three things and the difference is load-bearing:
   * `undefined` is "not specified" (what the bare toggles pass, and what keeps
   * them idempotent), `null` is "clear the resume date", and a string is "come
   * back on this day". Resolved through active.ts's resolvePauseWrite.
   */
  setRoutinePaused: (id: string, paused: boolean, until?: string | null) => void;

  // Programs (migration 024). A period of life — summer, a school year — holding
  // items and/or whole routines. Same undo/redo treatment as routines, and
  // gated by the same `collectionsAvailable` flag.
  programs: Program[];
  addProgram: (program: Omit<Program, 'id'> & { id?: string }) => string;
  updateProgram: (id: string, updates: Partial<Omit<Program, 'id'>>) => void;
  removeProgram: (id: string) => void;
  /**
   * Set a program's tri-state. Separate from `updateProgram` for the same reason
   * `setRoutinePaused` is: it stamps its own action-log label, and the history
   * subscriber fires synchronously inside set().
   */
  setProgramState: (id: string, state: Program['state']) => void;
  /**
   * Activate one program and pause every other one that is currently on, in a
   * SINGLE set() — decision 3's "swap programs is just pause A + activate B",
   * made one gesture so it is also one ⌘Z.
   */
  swapToProgram: (id: string) => void;

  // Goals (migration 036). The third container role: a goal says WHY work
  // matters and suppresses nothing, so unlike routines and programs it never
  // reaches lib/active.ts. Its members carry a ROLE — plain member, milestone
  // (a one-shot checkpoint whose startDate is its target date) or check-in (a
  // recurring review) — and the role belongs to the membership, not the item.
  goals: Goal[];
  /** False when migration 036's tables are unreachable. Same contract as
   *  `collectionsAvailable`: every goal surface gates on it, or a write looks
   *  like it landed and vanishes on reload. */
  goalsAvailable: boolean;
  addGoal: (goal: Omit<Goal, 'id'> & { id?: string }) => string;
  updateGoal: (id: string, updates: Partial<Omit<Goal, 'id'>>) => void;
  removeGoal: (id: string) => void;
  /**
   * Move a goal between active / achieved / abandoned.
   *
   * Separate from `updateGoal` for the reason `setProgramState` is — it stamps
   * its own action-log label — and because the `achievedAt` rule belongs in one
   * place: resolveGoalStateWrite (lib/goals.ts) decides what a state change
   * actually writes, so a same-state write never restamps an achievement date
   * and a return to 'active' clears it.
   */
  setGoalState: (id: string, state: Goal['state']) => void;


  /**
   * Put one row of the Trash back (Organize console, Phase 4).
   *
   * One action for all five kinds rather than five, because the hard parts are
   * identical and are all about HISTORY: decision 3 says a restore is a normal
   * entry and ⌘Z re-deletes it, and that only holds if the label is armed
   * before the single set() that carries every slice being touched. See the
   * implementation for the two traps.
   *
   * Takes the whole TrashEntry, not an id: the bin lives in a local hook and
   * never enters the store, so this is the only way the entity reaches it.
   */
  restoreFromTrash: (entry: TrashEntry) => void;

  // Cleanup orphaned references
  cleanupOrphanedReferences: () => void;

  // Undo/Redo
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  // Action log for displaying undo/redo history
  actionLog: ActionLogEntry[];
  historyIndex: number;
  refreshActionLog: () => void;
}

// Projections: keep `tasks`/`habits` derived from `items` in the same set()
// so every consumer sees a consistent snapshot. TaskItem/HabitItem are
// structurally assignable to Task/Habit (the extra `type` key is inert).
//
// Phase 6b: the app-internal `tasks` projection is task-LIKE (custom-type
// items included — they're task-shaped and ride the task pipeline in every
// view). This is NOT the pinned external projection: db.ts fetchTasks and the
// context response keep type === 'task' exactly. Runtime objects retain their
// type/customType keys (projections filter, never map).
const projectItems = (items: Item[]) => ({
  items,
  // Subtasks (parentItemId set) live inside their parent's detail surface and
  // are deliberately EXCLUDED from the tasks projection — braindump, buckets,
  // schedule, EOD/morning all read this projection, so one filter keeps a
  // subtask from showing up as a free-floating task everywhere at once.
  // items[] still carries them (the panel and the agent context read items).
  tasks: items.filter(
    (i): i is TaskItem => i.type !== 'habit' && !i.parentItemId
  ) as Task[],
  habits: items.filter((i): i is HabitItem => i.type === 'habit'),
});

/**
 * Everything on this store that BELONGED TO AN ACCOUNT, back to empty.
 *
 * Shared by the two callers that drop a previous user: `clearStore` on
 * sign-out, and `identifyUser` when the account changes under it. One list
 * rather than two, because the failure mode of the second copy is silent and
 * expensive — the `goals` note below is a bug that was found exactly that way,
 * a slice the reset had never been taught about, leaving user B holding user
 * A's rows.
 *
 * Deliberately NOT included: `userId` and `isLoading`, which say who we are and
 * where the fetch has got to. The two callers disagree about those (a sign-out
 * has no user and nothing loading; an account switch has both) so they stay at
 * the call sites, where the difference is visible.
 */
const emptyAccountData = () => ({
  ...projectItems([]),
  projects: [],
  itemTypes: [],
  routines: [],
  programs: [],
  collectionsAvailable: true,
  // Goals reset with every other slice. Missed, the previous account's goal
  // names, whys and target dates stay in memory after SIGNED_OUT — and
  // initializeStore's catch branch sets only its status flags, never the data,
  // so a FAILED next sign-in leaves user B looking at user A's goals in the
  // chip and the console, with updateGoal firing user-B writes at user-A ids.
  goals: [],
  goalsAvailable: true,
  // Its two siblings above were here and this was not — a gap inherited from
  // the old `clearStore` body, and exactly the miss the note above describes.
  // Left at `false` by an account whose item_types table was unreachable, it
  // makes `addItemType`'s opening guard silently drop the NEXT account's custom
  // types until their own fetch resolves.
  itemTypesAvailable: true,
  error: null,
  loadFailedUserId: null,
  canUndo: false,
  canRedo: false,
  actionLog: [],
  historyIndex: -1,
  userTimezone: null,
});

/**
 * A container NAME write implies an ID write (migration 027).
 *
 * Every surface that files an item still speaks in names — the item dialog's
 * chips, the agent API, the braindump — and converting those ~15 call sites is
 * explicitly out of scope. So the resolution happens once, here, at the moment
 * a name is written: the name stays authoritative for display, and the id it
 * resolves to is what survives the container being renamed.
 *
 * Returning `undefined` for an unmatched name is correct, not a fallback. Some
 * items name a container that has no row at all — 12 of them on the live
 * database name a project called "Housework" — and inventing a link for those
 * would file them under whatever container is created with that name next.
 */
/**
 * EXACT FIRST, THEN FOLDED, and both halves are load-bearing.
 *
 * The fold was the habit-group half's rule before 039 collapsed the two classify
 * kinds — `makeAddDraft` writes a lowercase 'personal' against a seeded
 * 'Personal' whenever the container list has not loaded yet, so an exact-only
 * match strands exactly those items. `CONTAINER_KINDS.project.caseFold` is now
 * true for the one kind, so the same rule applies to every container, and
 * `sameContainerName` is the single expression of it.
 *
 * The exact pass still runs first: an account legitimately holding both `Work`
 * and `work` as rows should resolve `Work` to the row actually called that,
 * rather than to whichever comes first in store order.
 */
const projectIdFor = (name: string | undefined, projects: Project[]) =>
  name
    ? (
        projects.find((p) => p.name === name) ??
        projects.find((p) => sameContainerName('project', p.name, name))
      )?.id
    : undefined;

/**
 * Where an item goes when the container it named is deleted.
 *
 * A CAPABILITY QUESTION, not a type branch, and it is the one place the two old
 * delete actions actually disagreed. `removeProject` unfiled its members;
 * `removeHabitGroup` REASSIGNED them, because a habit must answer with
 * something — its confirm copy names the destination. The registry already says
 * which is which (`containerRequired`, `orphanContainerFallback`), so the merged
 * action asks it instead of asking whether the item is a habit.
 *
 * The fallback name resolves to no id when no such row exists, which is the
 * honest answer for an account whose default containers were never persisted —
 * a text-only reference, exactly what 027 documents for most of them.
 */
const unfiled = (item: Item, projects: Project[], removedId: string): Item => {
  const config = getItemTypeConfig(itemTypeName(item));
  if (!config.containerRequired) return { ...item, project: undefined, projectId: undefined };
  const dest = projects.find((p) => p.id !== removedId);
  return {
    ...item,
    project: dest?.name || config.orphanContainerFallback || '',
    projectId: dest?.id,
  };
};

// History management for undo/redo
/**
 * Container membership handed to an add action, so the item row and its join
 * rows land in ONE set() and therefore one history entry.
 *
 * The add actions mint ids internally and return void, so "create, then apply
 * membership" has no id to apply to — and would cost a second undo step, which
 * makes one user gesture take two ⌘Z to reverse.
 */
export interface Memberships {
  routineIds?: string[];
  programIds?: string[];
  goalIds?: string[];
  /**
   * The role the new item takes in every goal named by `goalIds`.
   *
   * ONE role for the whole payload, not a per-goal map, because there are
   * exactly two flows that create a pre-linked item — the Goal chip in the add
   * dialog (plain member) and the console's "new milestone" — and neither
   * creates one item as a milestone here and a check-in there. Deliberately NOT
   * generalised into `{id, role}[]`: routineIds/programIds are flat arrays and
   * `withMembership` is generic over a single `itemIds`, so widening the shape
   * would ripple through both other chips for a case nothing asks for.
   */
  goalRole?: GoalRole;
}

/**
 * Create the item row, THEN its join rows.
 *
 * The order is load-bearing and cannot be parallelised: routine_items and
 * program_items each carry a composite FK (item_id, user_id) -> items(id,
 * user_id), so a join insert that lands before the item does fails with 23503
 * and the membership is silently lost — the store would show it, and a reload
 * would not. Chaining off the create is the whole point of this helper existing
 * rather than two call sites firing side by side.
 */
function persistNewItem(
  userId: string,
  row: Item,
  memberships: Memberships | undefined,
  get: () => PlannerStore,
) {
  const created = dbCreateItem(userId, row);
  created.catch(console.error);

  const routineIds = memberships?.routineIds ?? [];
  const programIds = memberships?.programIds ?? [];
  const goalIds = memberships?.goalIds ?? [];
  if (routineIds.length === 0 && programIds.length === 0 && goalIds.length === 0) return;

  created
    .then(() =>
      Promise.all([
        // Re-read in both loops: the optimistic set() already appended, and
        // these are the arrays the reconciler diffs against.
        ...routineIds.map((rid) => {
          const routine = get().routines.find((r) => r.id === rid);
          return routine ? dbUpdateRoutine(userId, rid, { itemIds: routine.itemIds }) : undefined;
        }),
        ...programIds.map((pid) => {
          const program = get().programs.find((p) => p.id === pid);
          return program ? dbUpdateProgram(userId, pid, { itemIds: program.itemIds }) : undefined;
        }),
        // All three role arrays, even though only one of them changed: the
        // reconcile diffs whichever roles it is given, so sending the whole
        // membership is the cheapest way to be certain the new item lands in
        // the role the payload asked for without the other two drifting.
        ...goalIds.map((gid) => {
          const goal = get().goals.find((g) => g.id === gid);
          return goal
            ? dbUpdateGoal(userId, gid, {
                memberIds: goal.memberIds,
                milestoneIds: goal.milestoneIds,
                checkinIds: goal.checkinIds,
              })
            : undefined;
        }),
      ]),
    )
    .catch(console.error);
}

/**
 * Add `itemId` to each named container. Returns the SAME array reference when
 * there is nothing to do, so the common no-membership add doesn't churn
 * identity and re-render every consumer of the list.
 */
function withMembership<T extends { id: string; itemIds: string[] }>(
  containers: T[],
  itemId: string,
  containerIds: string[] | undefined,
): T[] {
  if (!containerIds?.length) return containers;
  const want = new Set(containerIds);
  return containers.map((c) =>
    want.has(c.id) && !c.itemIds.includes(itemId) ? { ...c, itemIds: [...c.itemIds, itemId] } : c,
  );
}

/**
 * The goal-side counterpart to `withMembership`.
 *
 * Its own function rather than a generalisation, because a goal's membership is
 * three arrays and a role, not one `itemIds`. Widening the generic to carry a
 * role would touch the routine and program chips — which have no roles — for a
 * case only goals have.
 */
function withGoalMembership(
  goals: Goal[],
  itemId: string,
  goalIds: string[] | undefined,
  role: GoalRole = 'member',
): Goal[] {
  if (!goalIds?.length) return goals;
  const key = role === 'milestone' ? 'milestoneIds' : role === 'checkin' ? 'checkinIds' : 'memberIds';
  const want = new Set(goalIds);
  return goals.map((g) =>
    want.has(g.id) && !g[key].includes(itemId) ? { ...g, [key]: [...g[key], itemId] } : g,
  );
}

/**
 * Decision 11's receipt: did the thing the user just moved land somewhere it
 * will not be seen?
 *
 * The move verbs are all ALLOWED to drop work into a suppressed window —
 * blocking them would fight the boundary week, which deliberately renders live
 * and hidden columns side by side so you can plan across the handoff. What is
 * not allowed is doing it silently. A drag that ends with the block simply gone
 * is indistinguishable from a bug.
 *
 * Resolved at the TARGET date, not today: dropping a task on a column after a
 * program ends is exactly the case this exists for, and today would answer
 * about the wrong day. Suppression that is dateless (a paused item, a paused
 * routine) answers the same on every date, so it is covered by the same call.
 *
 * Lives here rather than in each caller because there are five of them — DnD,
 * EOD's move-all, two date pickers and the mobile sheet — and they all funnel
 * through these actions. One definition, per lib/overdue.ts's founding lesson.
 */
function landingReceipt(
  state: { items: Item[]; routines: Routine[]; programs: Program[]; userTimezone: string | null },
  ids: readonly string[],
  dateStr?: string,
): string | undefined {
  const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const target = dateStr ?? toDateStr(new Date(), tz);
  const ctx = { userTimezone: tz, routines: state.routines, programs: state.programs };
  const labels = ids
    .map((id) => state.items.find((i) => i.id === id))
    .filter((item): item is Item => !!item)
    .map((item) => suppressionReason(item, target, ctx))
    .filter((reason) => !!reason)
    .map((reason) => suppressionLabel(reason, { long: true }));

  if (labels.length === 0) return undefined;
  // One cause, however many items: say it. Mixed causes across a bulk move
  // can't be summarised without inventing a shared reason, so it counts instead.
  const unique = new Set(labels);
  if (unique.size === 1) return labels[0];
  return `${labels.length} of these are hidden where they landed`;
}

/**
 * The same receipt, for an item CREATED straight into a gate — the item
 * dialog's Routine and Program chips in add mode.
 *
 * setItemsCollected already says this out loud when a selection is collected
 * into a container that is currently off, and creating an item into one is the
 * same act arriving by a different door: the row is written, it is a legal
 * write, and it is not on the surface the user was looking at when they made
 * it. ADD mode is what this covers, and it is the mode that needs covering
 * most: there is no item yet and the dialog closes on save, so nothing on the
 * surface survives to say anything. EDIT mode is NOT covered and is an open
 * follow-up — its chip writes through `updateProgram` (label `Edit program:`,
 * no receipt) and the dialog's activation note resolves at today rather than at
 * the item's date, so a program whose window excludes a future-dated item is
 * silent there while it speaks here.
 *
 * Both sides are handed in PROSPECTIVELY, and that is the whole difficulty: the
 * item is not in `state.items` yet and its join rows are not written yet, so
 * asked against live state the answer is always "visible" — the one answer that
 * is never useful here. Same reasoning setItemsCollected records, one step
 * further along: there it is the containers that move, here it is both.
 *
 * Only GATE membership is consulted. Goals are an ASPIRE kind and suppress
 * nothing (lib/container-registry.ts, the three roles), so a goal-only add can
 * never hide anything and must not be charged for a lookup that says so.
 */
function newMemberReceipt(
  state: { items: Item[]; routines: Routine[]; programs: Program[]; userTimezone: string | null },
  item: Item,
  memberships: Memberships | undefined,
  dateStr?: string,
): string | undefined {
  const routineIds = memberships?.routineIds ?? [];
  const programIds = memberships?.programIds ?? [];
  if (routineIds.length === 0 && programIds.length === 0) return undefined;
  return landingReceipt(
    {
      items: [...state.items, item],
      routines: withMembership(state.routines, item.id, routineIds),
      programs: withMembership(state.programs, item.id, programIds),
      userTimezone: state.userTimezone,
    },
    [item.id],
    dateStr,
  );
}

/**
 * Suppressed open loops right now, for the release-grace diff below.
 *
 * `inactiveItemIdsOn` and not `isItemActiveOn`, deliberately: only open loops
 * can ever be swept, so anything else appearing in the diff would grant grace
 * to work that was never at risk.
 */
function suppressedNow(
  state: { items: Item[]; routines: Routine[]; programs: Program[] },
  todayStr: string,
  tz: string,
): Set<string> {
  return inactiveItemIdsOn(state.items, todayStr, {
    userTimezone: tz,
    routines: state.routines,
    programs: state.programs,
  });
}

interface HistoryState {
  items: Item[];
  projects: Project[];
  // Explicit, because the subscriber snapshots only what it is told. Omitting
  // either container would make every membership edit and every pause/state
  // change un-undoable AND would let an unrelated undo silently revert them,
  // since applyHistoryState writes the whole snapshot back.
  routines: Routine[];
  programs: Program[];
  // Goals join for the same reason, with one extra: their membership carries a
  // ROLE, so an undo that restored bare ids would flatten every milestone and
  // check-in back to a plain member — changing a goal's progress denominator
  // with no visible cause.
  goals: Goal[];
}

export type ActionLogEntry = {
  id: string;
  label: string;
  timestamp: number;
  /**
   * A second line for the undo toast, set when the action's result is not
   * visible where the user just put it (plan decision 11). Optional and
   * ignored everywhere else — the action log itself renders labels only.
   */
  receipt?: string;
  /**
   * How many items one entry covers, set only by `batchHistory`. A structured
   * flag rather than a label pattern, so the undo strip can ask "was this a
   * batch?" without a title that happens to end in "· 3 items" spoofing it.
   */
  batch?: number;
};

/**
 * Slugs `addItemType` refuses for a NEW type: the three built-ins, and since
 * 2026-09-25 the four organizer nouns the "new" dialog's type menu lists beside
 * the item types. The two halves are exported separately because the console's
 * refusal (labels.tsx `slugProblem`) says a different sentence for each — and
 * builds both from these, so the copy and this guard can't drift apart silently.
 */
export const BUILTIN_ITEM_TYPE_NAMES: readonly string[] = ['task', 'habit', 'custom'];
export const ORGANIZER_TYPE_NAMES: readonly string[] = ['goal', 'routine', 'program', 'project'];
export const RESERVED_ITEM_TYPE_NAMES: readonly string[] = [
  ...BUILTIN_ITEM_TYPE_NAMES,
  ...ORGANIZER_TYPE_NAMES,
];

const MAX_HISTORY_SIZE = 50;
let historyStack: HistoryState[] = [];
let historyIndex = -1;
let isUndoRedoAction = false;
let actionLog: ActionLogEntry[] = [];
let pendingActionLabel: string | null = null;
let pendingActionReceipt: string | undefined;
let pendingActionBatch: number | undefined;

/*
 * Batch state (see batchHistory). `batchReceipts` collects the landing receipts
 * the looped verbs write, so the one entry can carry them. While `quietDepth`
 * is above zero the completion verbs collect their celebration and offers here
 * instead of firing them per item; the outermost quiet batch flushes them once.
 */
let batchReceipts: string[] | null = null;
let quietDepth = 0;
let batchCompleted = false;
let deferredAchievementIds: string[] = [];
let deferredCheckins: { item: Item; dateStr: string }[] = [];
type BatchEffects = {
  completed: boolean;
  achievementIds: string[];
  checkins: { item: Item; dateStr: string }[];
};
// Assigned inside the store creator, where the offer helpers live.
let flushBatchEffects: (e: BatchEffects) => void = () => {};

/**
 * What a restored row is CALLED in its history entry.
 *
 * The bin is the one list in the app that mixes kinds, so "Restore: Morning" is
 * ambiguous in a way no other label is — and this string is what the user reads
 * in the history popover when deciding what ⌘Z is about to take back.
 */
const TRASH_NOUNS: Record<TrashEntry['kind'], string> = {
  item: 'item',
  project: 'project',
  routine: 'routine',
  program: 'program',
  goal: 'goal',
};

// Set the label for the next action that will be saved to history
export const setNextActionLabel = (label: string, receipt?: string) => {
  pendingActionLabel = label;
  pendingActionReceipt = receipt;
  if (batchReceipts && receipt) batchReceipts.push(receipt);
};

// Get the current action log
export const getActionLog = (): ActionLogEntry[] => {
  return [...actionLog].reverse(); // Most recent first
};

// Get the current history index for highlighting current position
export const getHistoryInfo = () => ({
  currentIndex: historyIndex,
  totalEntries: historyStack.length,
  actionLog: [...actionLog].reverse(),
});

const saveToHistory = (state: HistoryState) => {
  if (isUndoRedoAction) return;

  // If we're not at the end of history, truncate forward history
  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    actionLog = actionLog.slice(0, historyIndex + 1);
  }

  // Deep clone the state to avoid reference issues.
  //
  // Every key of HistoryState must appear here. Omitting one does not fail
  // loudly: applyHistoryState restores the missing slice as [], and
  // syncContainers reads "present in current, absent in restored" as a DELETE —
  // so one Cmd+Z silently soft-deletes every row of that container in Supabase.
  // That is exactly what shipped for `routines` and the review caught it.
  const snapshot: HistoryState = {
    items: JSON.parse(JSON.stringify(state.items)),
    projects: JSON.parse(JSON.stringify(state.projects)),
    routines: JSON.parse(JSON.stringify(state.routines)),
    programs: JSON.parse(JSON.stringify(state.programs)),
    goals: JSON.parse(JSON.stringify(state.goals)),
  };

  historyStack.push(snapshot);

  // Add action log entry
  actionLog.push({
    id: crypto.randomUUID(),
    label: pendingActionLabel || 'Unknown action',
    timestamp: Date.now(),
    receipt: pendingActionReceipt,
    batch: pendingActionBatch,
  });
  pendingActionLabel = null;
  pendingActionReceipt = undefined;
  pendingActionBatch = undefined;

  // Limit history size
  if (historyStack.length > MAX_HISTORY_SIZE) {
    historyStack.shift();
    actionLog.shift();
  } else {
    historyIndex++;
  }
};

/** The entry `saveToHistory` just wrote, so a failed write can take it back. */
const lastHistoryEntryId = (): string | null =>
  actionLog.length > 0 ? actionLog[actionLog.length - 1].id : null;

/**
 * Take an optimistic container back out when the database refused it.
 *
 * WHY THIS EXISTS AT ALL. `projects_user_id_name_key` and
 * `habit_groups_user_id_name_key` are PLAIN unique indexes over
 * `(user_id, name)` — no `WHERE deleted_at IS NULL` — so a soft-deleted
 * container reserves its name for the full 30 days while being invisible to
 * this store, whose arrays come from `deleted_at`-filtered fetches. The
 * `alreadyExists` guards above therefore cannot see the row that is about to
 * reject the insert, and the insert used to fail into a bare
 * `.catch(console.error)` AFTER the optimistic `set()` had landed.
 *
 * What that left behind is worse than a missing container. Every later edit to
 * it is an `.eq('id', …)` matching zero rows, so it accepts a glyph, a colour
 * and a whole time block and keeps none of them — and because
 * `items_project_id_fkey` is a COMPOSITE foreign key, any item filed into it
 * has its own INSERT rejected with 23503 in full. The item dialog's inline
 * "new project" is the sharp end: type the name of a project you deleted last
 * week, save, and you lose the project AND the task you were writing, with the
 * only evidence a console line nobody will read.
 *
 * Healing it HERE rather than at the call sites is the point. The console's
 * create rows consult the bin and refuse with a sentence (see
 * use-trashed-names.ts) — that is the good path, and this is the net under it,
 * covering the item dialog, the command palette, and anything added later,
 * without the async lookup a synchronous action cannot await.
 *
 * The rollback leaves no trace in history: it is not a user action, so it
 * pushes no entry of its own (a bare `set()` here would be a labelless mutation
 * landing as "Unknown action"), and the failed create's own entry is stripped
 * of the phantom and relabelled — see forgetFailedContainer.
 *
 * WHAT IT CANNOT DO. If the user's Save wins the race — the item's INSERT goes
 * out before the container's rejection comes back — that item is already lost
 * to 23503 and nothing here retrieves it. Clearing the reference stops the NEXT
 * save carrying it; the one already in flight is why the proactive refusals in
 * the console and the item dialog matter, and why this is the net rather than
 * the plan.
 */
/**
 * Container ids that were seated optimistically and then refused.
 *
 * Published because the rollback is INDISTINGUISHABLE from a delete to anything
 * watching this store: both are "a container that was in `projects` and now is
 * not". `useTrashedNames` watches exactly that, to catch the name of a container
 * binned mid-visit — and so it caught the phantom too, and spent the rest of the
 * session refusing a name that nothing anywhere holds. The user's one useful
 * response to "Nothing was saved" is to try again; that was the response it
 * locked out.
 *
 * A uuid per failed create, never cleared. Both are deliberate: ids are uuids so
 * a stale entry cannot collide with a real container even across an account
 * switch, and a session with enough refused creates for the set to matter has a
 * much larger problem than its memory.
 */
const neverCreated = new Set<string>();

/** True for a container this store seated and the database then rejected. */
export const wasNeverCreated = (id: string): boolean => neverCreated.has(id);

/**
 * Take a refused container back out of the store and out of history.
 *
 * Extracted so first-run seeding gets the SAME rollback a hand-made create gets.
 * Its inserts can be refused for a reason no fault is needed to reach: two tabs
 * opening a first run both read the seeding latch as false, both plan the same
 * names, and the second one's insert meets `projects_user_id_name_key`. Left
 * behind, that tab holds six containers that do not exist — and because
 * `items_project_id_fkey` is composite, the first item filed into one has its
 * own INSERT rejected in full.
 *
 * Everything careful here was paid for twice (see the fix-commit table in
 * memory/plans/organize-console.md); duplicating it for the seed path would have
 * been the third time.
 */
const removeRefusedContainer = (
  id: string,
  entryId: string | null,
  label: string,
) => {
  // BEFORE the setState below, not after. The history subscriber and
  // useTrashedNames' both run synchronously inside set(), so a watcher that
  // asks "was this real?" while reacting to the removal has to be able to get
  // the right answer already.
  neverCreated.add(id);

  // SAVED AND RESTORED, never a hard `false`. `isUpdatingUndoRedo` is a plain
  // boolean rather than a counter, and `initializeStore` holds it true across
  // its ENTIRE fetch while `userId` is already stamped — so a create rejecting
  // inside the load window used to hand the flag back unblocked. The republish
  // below then woke the subscriber's lazy-baseline branch mid-load, seeding a
  // second 'Session start' and leaving `historyIndex` naming a snapshot the
  // store did not hold. One ⌘Z after that soft-deleted every row the load had
  // just brought in — verified by an A/B probe whose only variable was whether
  // the create resolved.
  const wasSuppressed = isUpdatingUndoRedo;
  isUpdatingUndoRedo = true;
  try {
    usePlannerStore.setState((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      // Items filed into it in the meantime lose the reference too, or the
      // next save re-sends an id no row will ever match. One branch since 039 —
      // there is one container array and one pair of item fields.
      ...projectItems(
        state.items.map((item) =>
          item.projectId === id
            ? { ...item, project: undefined, projectId: undefined }
            : item
        )
      ),
    }));
    forgetFailedContainer(id, entryId, label);
    // The baseline has to follow the rollback, or the next real change is
    // diffed against a snapshot that still holds the phantom.
    const s = usePlannerStore.getState();
    updatePrevStateBaseline({
      items: s.items,
      projects: s.projects,
      routines: s.routines,
      programs: s.programs,
      goals: s.goals,
    });
  } finally {
    isUpdatingUndoRedo = wasSuppressed;
  }

  // Republish the action log so the relabelled entry reaches the popover. Only
  // when nothing else is mid-write: inside initializeStore's window this would
  // publish half-loaded history over the top of the load.
  //
  // BOTH THIS GUARD AND THE SAVE/RESTORE ABOVE ARE KEPT, and each alone is
  // enough to stop the load-window corruption — verified by probing them
  // separately. Neither is dead code: this one keeps the rollback from
  // publishing over a load in progress, the other keeps the suppression flag
  // honest for every other reader of it. The consequence of getting it wrong is
  // one ⌘Z soft-deleting everything the load brought in, which is worth two
  // cheap defences rather than one clever one.
  if (!wasSuppressed) {
    const info = getHistoryInfo();
    usePlannerStore.setState({
      canUndo: historyIndex > 0,
      canRedo: historyIndex < historyStack.length - 1,
      actionLog: info.actionLog,
      historyIndex: info.currentIndex,
    });
  }
};

/**
 * A seed container the database refused.
 *
 * Same rollback, and deliberately SILENT. `undoFailedCreate` says it out loud
 * because a hand-made create is something the user just did and is watching for;
 * this one is a starter set they never asked for, and "Couldn't create Work"
 * would be the first thing a brand-new account ever said to its owner. Nothing
 * is lost by the silence: the row simply is not there, which is the state the
 * account was in a second earlier.
 *
 * `null` for the entry id because the seed pushes no history entry at all —
 * there is nothing to relabel, and `forgetFailedContainer` still strips the id
 * from every snapshot, which is the half that matters.
 */
const rollbackSeedContainer = (error: unknown, id: string, name: string) => {
  console.error('seed container failed', name, error);
  removeRefusedContainer(id, null, '');
};

const undoFailedCreate = (
  error: unknown,
  entryId: string | null,
  id: string,
  name: string,
) => {
  // The noun comes from the container registry, not from a literal here — it is
  // provisional (see CONTAINER_KINDS.project.label) and this string is user-
  // facing twice over, in the history entry and in the toast below.
  const noun = CONTAINER_KINDS.project.label.toLowerCase();
  console.error(`create ${noun} failed`, error);

  removeRefusedContainer(id, entryId, `Couldn’t add ${noun}: ${name}`);

  // SAID OUT LOUD. Every other way this can go wrong is silent, which is how it
  // survived: the container looks created for the rest of the session. 23505 is
  // the only error this insert can realistically raise, and the trash is the
  // only place the name can be hiding, so the sentence can be specific.
  toast.error(
    isUniqueViolation(error)
      ? `Couldn't create “${name}” — a deleted ${noun} still has that name. Restore or empty it from Organize → Trash.`
      : `Couldn't create “${name}”. Nothing was saved.`
  );
};

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === '23505' || (error instanceof Error && error.message.includes('duplicate key value'));
};

/**
 * Erase a container the database never accepted from the whole undo history.
 *
 * REWRITES THE SNAPSHOTS; TOUCHES NO INDEX. The first version of this popped
 * the failed create's entry off the stack and decremented `historyIndex`, which
 * is only safe when that entry is still the top AND the user has not moved —
 * and the guards it needed for that handed every other case straight back to
 * the bug. Review reproduced both halves: with the user having acted during the
 * round trip (which the item dialog's own Save flow guarantees), the store lost
 * the phantom while every snapshot kept it, so ONE ⌘Z put it back and fired
 * `dbRestoreProject` against a row that never existed.
 *
 * Stripping the id from every snapshot instead has no such precondition. The
 * stack length, the log length and `historyIndex` are all untouched, so the
 * invariant that `historyIndex` names the state the store holds cannot be
 * broken by this function at all — whatever the user did meanwhile, whether two
 * creates are in flight at once, and regardless of MAX_HISTORY_SIZE having
 * shifted entries off the front.
 *
 * Members go with it. An item filed into the phantom before the rejection
 * landed still names it in older snapshots, and undoing into one of those would
 * re-file the item against a container that does not exist.
 */
const forgetFailedContainer = (
  id: string,
  entryId: string | null,
  label: string,
) => {
  for (const snapshot of historyStack) {
    snapshot.projects = snapshot.projects.filter((p) => p.id !== id);
    snapshot.items = snapshot.items.map((item) =>
      item.projectId === id
        ? { ...item, project: undefined, projectId: undefined }
        : item
    );
  }

  // The entry STAYS — removing it is what forced the index arithmetic — but it
  // stops claiming something happened. Its snapshot now matches its
  // predecessor, so undoing across it is a no-op rather than a resurrection.
  const entry = entryId ? actionLog.find((a) => a.id === entryId) : undefined;
  if (entry) entry.label = label;
};

// Get appropriate bucket for a given time
const getBucketForTime = (time: string): TimeBucket => {
  const hour = parseInt(time.split(':')[0]);
  if (hour >= TIME_BUCKET_RANGES.morning.start && hour < TIME_BUCKET_RANGES.morning.end) {
    return 'morning';
  } else if (hour >= TIME_BUCKET_RANGES.afternoon.start && hour < TIME_BUCKET_RANGES.afternoon.end) {
    return 'afternoon';
  } else if (hour >= TIME_BUCKET_RANGES.evening.start || hour < 5) {
    return 'evening';
  }
  return 'anytime';
};

// A concrete start time overrides a mismatched bucket ('anytime' is exempt).
// Single home for the auto-correct rule that used to be copied six times.
const autoCorrectBucket = (
  time: string | undefined,
  bucket: TimeBucket | undefined,
): TimeBucket | undefined =>
  time && bucket && bucket !== 'anytime' ? getBucketForTime(time) : bucket;

// Per-type diff for undo/redo db sync — fields come from the schema-derived
// registry lists, so a new schema field can never silently drop out of sync.
const diffItem = (from: Item, to: Item): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const key of getItemTypeConfig(itemTypeName(to)).fields) {
    const a = (from as Record<string, unknown>)[key];
    const b = (to as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) patch[key] = b;
  }
  return patch;
};

/**
 * The `planner-storage` slice, at its defaults — every field the persist
 * `partialize` at the bottom of this file writes to localStorage, and nothing
 * else.
 *
 * THE TWO LISTS MUST MATCH, and they are far enough apart in this file to drift
 * silently, so tests/unit/local-state.test.ts pins them: it dirties the store,
 * reads what actually reached localStorage, and fails if any persisted key is
 * missing from the clear. Add a field to `partialize` without adding it here
 * and that test goes red rather than the field quietly outliving a sign-out.
 *
 * Values are duplicated from the store body above rather than extracted from it
 * because the body deliberately keeps each field beside its own setter; a test
 * pins these against a freshly created store instead.
 */
const PERSISTED_SETTINGS_DEFAULTS = {
  compactMode: false,
  viewMode: 'day',
  chillMode: false,
  groupBy: 'none',
  showCurrentTimeIndicator: true,
  timelineItemFilter: 'all',
  showCompletedTasks: true,
  showPausedOnGrid: false,
  defaultView: 'day',
  defaultTimeBucket: 'anytime',
  animationsEnabled: true,
  weekStartDay: 'sunday',
  timeFormat: '12h',
} satisfies Partial<PlannerStore>;

export const usePlannerStore = create<PlannerStore>()(
  persist(
    (set, get) => {
      // ── Unified item engine (private) ──────────────────────────────────────
      const findItem = (id: string, type: ItemType): Item | undefined =>
        get().items.find((i) => i.id === id && i.type === type);

      /**
       * Custom types are task-shaped and ride the task action pipeline
       * (Phase 6b): "task" actions operate on any non-habit item. The
       * habit/task boundary stays hard — a task-like lookup never returns a
       * habit, so e.g. the sidebar drop calling unscheduleTask with a habit
       * id remains a complete no-op.
       */
      const findTaskLike = (id: string): Item | undefined =>
        get().items.find((i) => i.id === id && i.type !== 'habit');

      /**
       * findTaskLike's runtime filter guarantees non-habit but its declared
       * return type is the full union, so `startDate` needs the narrowing
       * spelled out. Habits genuinely have no startDate — they are date-blind
       * by design — so undefined here is the right answer, not a fallback.
       */
      const startDateOf = (item: Item | undefined): string | undefined =>
        item && item.type !== 'habit' ? item.startDate : undefined;

      /**
       * Run a container write, and record any item whose suppression it ENDED.
       *
       * The auto-age sweep reads recorded resume dates to grace work that has
       * just come back (decision 9). Deleting a container, or pulling a member
       * out of one, releases items with no such record anywhere — the container
       * or the join row it would have been read from is precisely what was
       * removed. Without this, tidying up a paused routine hands every one of
       * its dated members to the next morning's sweep, already weeks overdue.
       *
       * Diffed rather than inferred from the patch: "was hidden, is now
       * visible" is the only question that matters, and the path algebra makes
       * it genuinely hard to answer any other way (an item with a second live
       * path was never hidden; one held by two paused programs still is).
       */
      const withReleaseGrace = (mutate: () => void) => {
        const tz = get().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const todayStr = toDateStr(new Date(), tz);
        const before = suppressedNow(get(), todayStr, tz);
        mutate();
        if (before.size === 0) return;
        const after = suppressedNow(get(), todayStr, tz);
        const released = [...before].filter((id) => !after.has(id));
        if (released.length > 0) recordReleased(released, todayStr);
      };

      /** DB slug for an item ('task' | 'habit' | custom slug). */
      const dbTypeOf = (item: Item): string =>
        item.type === 'custom' ? item.customType : item.type;

      /**
       * Optimistically apply `updates` to one item and persist. The type guard
       * is load-bearing (see findTaskLike); 'task' here means "task-like".
       *
       * Deliberate change from the pre-unification store: a store miss also
       * suppresses the DB write (old code issued it blindly, which could touch
       * soft-deleted trash rows).
       */
      /**
       * Locked decision 3: an item edit that invalidates a goal role DEMOTES
       * the role, and never blocks the edit.
       *
       * The registry predicates guard the role at GRANT time, but they cannot
       * see a later edit — the item dialog and the agent PATCH route both flip
       * `repeatFrequency` freely, long after the role was given. And the
       * consequence is silent: a recurring item's scalar status is frozen by
       * design (per-date completion is the truth), so a milestone made
       * recurring can never be counted achieved and its goal reads permanently
       * behind, with nothing to click and no explanation.
       *
       * Blocking the edit was the other option and is worse: it would let a
       * goal constrain its members, which is the one thing goals must never do.
       * So the membership yields instead — one join-row write, a normal undo
       * entry, and a receipt naming the goal so the user learns what changed
       * rather than discovering it in a progress count weeks later.
       *
       * Runs on the item that is ALREADY updated, not on the patch, so it asks
       * the same question the reader will: is this role still true of this item?
       */
      const planGoalRoleDemotion = (item: Item): { goals: Goal[]; receipt: string } | null => {
        const goals = get().goals;
        if (goals.length === 0) return null;
        const demoted: { goal: Goal; from: GoalRole }[] = [];
        const next = goals.map((goal) => {
          for (const role of ['milestone', 'checkin'] as const) {
            const key = role === 'milestone' ? 'milestoneIds' : 'checkinIds';
            if (!goal[key].includes(item.id)) continue;
            if (roleStillValid(role, item)) continue;
            demoted.push({ goal, from: role });
            return {
              ...goal,
              [key]: goal[key].filter((mid) => mid !== item.id),
              memberIds: goal.memberIds.includes(item.id)
                ? goal.memberIds
                : [...goal.memberIds, item.id],
            };
          }
          return goal;
        });
        if (demoted.length === 0) return null;

        const { goal, from } = demoted[0];
        const noun = from === 'milestone' ? 'milestone' : 'check-in';
        const why =
          from === 'milestone'
            ? 'it repeats now, and a repeating item never finishes'
            : 'it no longer repeats, and a check-in is a rhythm';

        const userId = get().userId;
        if (userId) {
          for (const { goal: g } of demoted) {
            const live = next.find((n) => n.id === g.id)!;
            dbUpdateGoal(userId, g.id, {
              memberIds: live.memberIds,
              milestoneIds: live.milestoneIds,
              checkinIds: live.checkinIds,
            }).catch(console.error);
          }
        }

        return {
          goals: next,
          receipt:
            demoted.length === 1
              ? `No longer a ${noun} of your ${goal.name} goal — ${why}.`
              : `No longer a ${noun} of ${demoted.length} goals — ${why}.`,
        };
      };

      /**
       * A goal whose last open milestone just closed.
       *
       * Offers, never acts (decision 6 / Kirby's answer to open question 6):
       * achieving is a deliberate statement about a stretch of your life, and
       * an app that made it for you would be claiming to know when the thing
       * you set out to do is done.
       *
       * A TOAST rather than a dialog, and that is a constraint rather than a
       * taste: `activeDialog` is a single slot, so a dialog fired from a
       * completion inside the EOD review would destructively replace the review
       * the user is in the middle of.
       *
       * Called only from the user-facing completion verbs — never from
       * applyHistoryState (which writes through dbUpdateItem) and never from the
       * agent routes (which do not touch the store), so a redo can't re-fire it
       * and a background write can't fire it at a screen nobody is looking at.
       */
      const offerAchievementFor = (itemId: string, offered?: Set<string>) => {
        const state = get();
        // ONE zone for the whole function. The `far` comparison below already
        // asked this question of the user's setting; formatGoalDay was asking
        // it of the runtime, so a goal could be described in one zone and
        // judged near/far in another.
        const tz =
          state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        // `Aug 21`, not `2026-08-21`. Local to the store rather than imported
        // from lib/collections, which is a hooks module — a store importing
        // React hooks is a cycle waiting to happen.
        //
        // Built at UTC noon and rendered in UTC, so the day shown is the day
        // STORED, in every zone. targetOn is a calendar date — no time, no
        // zone — so converting it to one is wrong by construction, and the
        // conversion is not hypothetical: UTC noon rendered at UTC+12 or +14
        // (Auckland, Kiritimati) lands on the following day, so a goal due
        // `2026-08-21` would read "Aug 22" to those users. `tz` below is a
        // different question and still needs the user's zone — it asks what
        // TODAY is, which is genuinely zone-dependent. Note also why noon and
        // not midnight: `new Date('yyyy-mm-dd')` is UTC midnight and formats
        // as the previous day anywhere west of Greenwich.
        const formatGoalDay = (dateStr: string) => {
          const [y, m, d] = dateStr.split('-').map(Number);
          if (!y || !m || !d) return dateStr;
          return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
          });
        };
        const itemsById = new Map(state.items.map((i) => [i.id, i]));
        for (const goal of state.goals) {
          if (goal.state !== 'active') continue;
          if (!goal.milestoneIds.includes(itemId)) continue;
          // A batch passes the goals it has already offered, so three
          // milestones of one goal closed together raise one toast, not three.
          if (offered?.has(goal.id)) continue;
          const { achieved, total } = goalProgress(goal, itemsById);
          if (total === 0) continue;
          // Decision 5's word is DATED: no un-achieved *dated* milestone
          // remains. Requiring every milestone instead made the offer
          // unreachable for anyone who uses the feature as designed — inline
          // creation deliberately produces UNDATED checkpoints, so two jotted
          // ideas would permanently silence the offer for every dated
          // milestone finished afterwards. An undated checkpoint is a thought,
          // not a commitment; it should not hold the goal open.
          const openDated = goal.milestoneIds.some((mid) => {
            const m = itemsById.get(mid);
            if (!m || m.status === 'cancelled') return false;
            if (!('startDate' in m) || !m.startDate) return false;
            return m.status !== getItemTypeConfig(itemTypeName(m)).doneStatus;
          });
          if (openDated) continue;

          // The copy respects a distant target. "All 3 milestones so far" is the
          // honest reading of a three-year goal that has defined two near-term
          // checkpoints — telling that user they have finished would be the
          // progress bar's own lie, in words.
          const far = !!goal.targetOn && goal.targetOn > toDateStr(new Date(), tz);
          toast(
            far
              ? `All ${total} milestone${total === 1 ? '' : 's'} so far on ${goal.name}`
              : `Every milestone on ${goal.name} is done`,
            {
              description: far
                ? `Its target is ${formatGoalDay(goal.targetOn!)}. Worth a look — or call it achieved.`
                : 'Ready to call it achieved?',
              action: {
                label: 'Mark achieved',
                // Re-checked at CLICK time, not trusted from eight seconds ago.
                // ⌘Z during the toast's life reopens the milestone, and acting
                // on the stale snapshot would mark a goal achieved with an open
                // checkpoint under it.
                onClick: () => {
                  const now = get();
                  const live = now.goals.find((g) => g.id === goal.id);
                  if (!live || live.state !== 'active') return;
                  const byId = new Map(now.items.map((i) => [i.id, i]));
                  const p = goalProgress(live, byId);
                  if (p.total === 0 || p.achieved !== p.total) return;
                  now.setGoalState(goal.id, 'achieved');
                },
              },
              duration: 8000,
              // Second guard behind `offered`: sonner replaces a toast with the
              // same id rather than stacking another.
              id: `achieve:${goal.id}`,
            },
          );
          offered?.add(goal.id);
          // One goal per completion. An item can be a milestone of several, but
          // a stack of toasts for one checkbox is noise, and the first is the
          // one whose list the user was most likely looking at.
          return;
        }
      };

      /**
       * The check-in bridge.
       *
       * A check-in is completed where every recurring item is completed — a row
       * on the grid, a line in the EOD review — and NOT on the goal page. So
       * the note, the history and the trip back to the goal have to come to the
       * completion rather than wait at a surface the user has no reason to
       * visit. Without this, Phase 3's differentiating features were reachable
       * only by someone who happened to open the goal first, at which point the
       * check-in item added nothing over just visiting the page.
       *
       * A toast with two actions, for the same single-slot reason the
       * achievement offer is one: a dialog fired from a completion inside the
       * EOD review would replace the review the user is in the middle of.
       *
       * The note is written against the OCCURRENCE date, not the moment of
       * typing — see recordCheckin.
       */
      const offerCheckinNote = (item: Item, dateStr: string) => {
        // EVERY active goal this item checks in for, not the first one found.
        // Locked decision 2 lets an item hold a role in several goals, and
        // `heldElsewhere` only stops two roles within ONE goal — so picking the
        // first meant a shared check-in always named the same goal and wrote
        // its notes there, leaving the other goal's history permanently empty
        // no matter how many were written. The note is one reflection on one
        // sitting; the goals it serves all get it.
        const goals = get().goals.filter(
          (g) => g.state === 'active' && g.checkinIds.includes(item.id),
        );
        if (goals.length === 0) return;
        const label =
          goals.length === 1 ? goals[0].name : `${goals[0].name} +${goals.length - 1}`;
        toast(`Checked in on ${label}`, {
          description: 'Anything worth remembering about this one?',
          action: {
            label: 'Add a note',
            onClick: () => {
              // A native prompt, and the honest reason is that there is nowhere
              // else to put it yet. ui-store DOES carry a second modal slot
              // (`confirmRequest`, rendered beside ActiveDialog), so a modal
              // raised while EOD is open is a solved problem here — but that
              // slot confirms, it does not capture text. Building the surface
              // that does is the guided check-in flow, which is a recorded
              // deferral. Consequence to know: a browser that has suppressed
              // dialogs returns null silently and the note is simply not saved.
              const note = window.prompt(
                goals.length === 1 ? `How is ${goals[0].name} going?` : 'How is it going?',
              );
              if (!note?.trim()) return;
              // Re-read at CLICK time, like the achievement offer beside it —
              // eight seconds is long enough to undo the completion, delete the
              // goal, or demote the item out of the role.
              const live = get().goals.filter(
                (g) => g.state === 'active' && g.checkinIds.includes(item.id),
              );
              for (const goal of live) {
                dbRecordCheckin(item.id, dbTypeOf(item), goal.id, dateStr, note.trim());
              }
            },
          },
          // The second half of the bridge, which the plan pins by name
          // ("· Add a note · View goal"): the trip BACK to the goal is the part
          // a completion cannot otherwise offer, and the whole argument for the
          // bridge is that it comes to the completion rather than waiting. It
          // uses sonner's cancel slot as a second button — never a library
          // limit, just an omission.
          cancel: {
            label: 'View goal',
            onClick: () => {
              if (typeof window !== 'undefined') window.location.assign(`/goal/${goals[0].id}`);
            },
          },
          duration: 8000,
        });
      };

      /**
       * The check-in bridge for a batch: ONE toast for every check-in a batch
       * completed, and one note written to every (item, date) pair and every
       * goal it serves — the same one-reflection-per-sitting rule as above.
       * A single pair is not a summary, so it takes the ordinary offer.
       */
      const offerCheckinSummary = (pairs: { item: Item; dateStr: string }[]) => {
        const seen = new Set<string>();
        const unique = pairs.filter(({ item, dateStr }) => {
          const key = `${item.id}|${dateStr}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const goalsFor = (item: Item) =>
          get().goals.filter((g) => g.state === 'active' && g.checkinIds.includes(item.id));
        const relevant = unique.filter(({ item }) => goalsFor(item).length > 0);
        if (relevant.length === 0) return;
        if (relevant.length === 1) {
          offerCheckinNote(relevant[0].item, relevant[0].dateStr);
          return;
        }
        const goalIds = new Set(relevant.flatMap(({ item }) => goalsFor(item).map((g) => g.id)));
        const goals = get().goals.filter((g) => goalIds.has(g.id));
        toast(`Checked in on ${goals[0].name}${goals.length > 1 ? ` +${goals.length - 1}` : ''}`, {
          description: 'Anything worth remembering about these?',
          action: {
            label: 'Add a note',
            onClick: () => {
              const note = window.prompt('How is it going?');
              if (!note?.trim()) return;
              // Re-read at click time per item, as offerCheckinNote does.
              for (const { item, dateStr } of relevant) {
                for (const goal of goalsFor(item)) {
                  dbRecordCheckin(item.id, dbTypeOf(item), goal.id, dateStr, note.trim());
                }
              }
            },
          },
          cancel: {
            label: 'View goal',
            onClick: () => {
              if (typeof window !== 'undefined') window.location.assign(`/goal/${goals[0].id}`);
            },
          },
          duration: 8000,
        });
      };

      /*
       * The completion verbs' side effects, routed through a quiet batch when
       * one is open. Outside a batch these are exactly the per-item calls.
       */
      const celebrate = () => {
        if (quietDepth > 0) batchCompleted = true;
        else celebrateCompletion();
      };
      const offerCheckin = (item: Item, dateStr: string) => {
        if (quietDepth > 0) deferredCheckins.push({ item, dateStr });
        else offerCheckinNote(item, dateStr);
      };
      const offerAchievement = (itemId: string) => {
        if (quietDepth > 0) deferredAchievementIds.push(itemId);
        else offerAchievementFor(itemId);
      };
      flushBatchEffects = ({ completed, achievementIds, checkins }) => {
        // Fired after the batch's history entry exists, so the confetti aims at
        // the undo strip that entry raises (except when a quiet batch nests in a
        // loud one: see batchHistory).
        if (completed) celebrateCompletion();
        const offered = new Set<string>();
        for (const id of new Set(achievementIds)) offerAchievementFor(id, offered);
        if (checkins.length) offerCheckinSummary(checkins);
      };

      const updateItemAction = (id: string, type: ItemType, updates: Partial<Task> | Partial<HabitItem>) => {
        const found = type === 'habit' ? findItem(id, 'habit') : findTaskLike(id);
        if (!found) return;
        // Only recurrence can invalidate a role, so only a patch that touches it
        // pays for the scan. `in` rather than a truthiness test: clearing the
        // field (`repeatFrequency: undefined`) is exactly the edit that turns a
        // check-in back into a one-shot task.
        const demotion = 'repeatFrequency' in updates
          ? planGoalRoleDemotion({ ...found, ...updates } as Item)
          : null;

        // ONE set() for the item AND the roles it just invalidated. Two set()s
        // push two history entries, and the intermediate one is the state the
        // whole rule exists to make unreachable: a single ⌘Z would restore the
        // milestone role while the item is still recurring, and syncContainers
        // would then WRITE that recurring milestone back — a row whose scalar
        // status is frozen by design, so the goal reads permanently behind with
        // nothing to click. The file's own doctrine, twenty lines from the trash
        // restore: one set() => one history entry => one undo.
        if (demotion) {
          // Its own prefix, registered in use-undo-toast's SIGNIFICANT_ACTIONS.
          // The receipt has exactly one consumer and it only fires for a known
          // prefix, so an `Edit …` label would have written the explanation
          // into an object nothing renders — and borrowing another verb's
          // prefix would have lied in the history popover, which shows the
          // label verbatim.
          setNextActionLabel(`Role changed: ${found.title}`, demotion.receipt);
        }
        set((state) => ({
          ...projectItems(
            state.items.map((i) => (i.id === id && i.type === found.type ? { ...i, ...updates } as Item : i)),
          ),
          ...(demotion ? { goals: demotion.goals } : {}),
        }));
        dbUpdateItem(id, dbTypeOf(found), updates).catch(console.error);
      };

      const resolveDateStr = (date?: Date): string => {
        const userTimezone = get().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        return toDateStr(date ?? get().selectedDate, userTimezone);
      };

      return {
      ...projectItems([]),
      selectedDate: new Date(),
      viewMode: 'day',
      groupBy: 'none',
      filters: {},
      projects: [],
      timelineItemFilter: 'all' as const,
      actionLog: [] as ActionLogEntry[],
      historyIndex: -1,
      refreshActionLog: () => {
        const info = getHistoryInfo();
        set({ actionLog: info.actionLog, historyIndex: info.currentIndex });
      },
      compactMode: false,
      setCompactMode: (compact) => {
        set({ compactMode: compact });
        const userId = get().userId;
        if (userId) saveSettings(userId, { compact_mode: compact });
      },
      navDirection: null,
      setNavDirection: (direction) => set({ navDirection: direction }),
      chillMode: false,
      setChillMode: (chill) => {
        set({ chillMode: chill });
        const userId = get().userId;
        if (userId) saveSettings(userId, { chill_mode: chill });
      },
      showCurrentTimeIndicator: true,
      setShowCurrentTimeIndicator: (show) => {
        set({ showCurrentTimeIndicator: show });
        const userId = get().userId;
        if (userId) saveSettings(userId, { show_time_indicator: show });
      },
      showCompletedTasks: true,
      setShowCompletedTasks: (show) => {
        set({ showCompletedTasks: show });
        const userId = get().userId;
        if (userId) saveSettings(userId, { show_completed_tasks: show });
      },
      showPausedOnGrid: false,
      // Local-only, unlike its showCompletedTasks neighbour: persisting it
      // server-side would mean a user_settings column, and a migration is a
      // steep price for a preference that answers "what am I looking at on this
      // screen". It rides planner-storage's partialize, which is where the rest
      // of the view preferences already live.
      setShowPausedOnGrid: (show) => set({ showPausedOnGrid: show }),
      defaultView: 'day',
      setDefaultView: (view) => {
        set({ defaultView: view, viewMode: view });
        const userId = get().userId;
        if (userId) saveSettings(userId, { default_view: view });
      },
      defaultTimeBucket: 'anytime',
      setDefaultTimeBucket: (bucket) => {
        set({ defaultTimeBucket: bucket });
        const userId = get().userId;
        if (userId) saveSettings(userId, { default_time_bucket: bucket });
      },
      animationsEnabled: true,
      setAnimationsEnabled: (enabled) => {
        set({ animationsEnabled: enabled });
        const userId = get().userId;
        if (userId) saveSettings(userId, { animations_enabled: enabled });
      },
      weekStartDay: 'sunday',
      setWeekStartDay: (day) => {
        set({ weekStartDay: day });
        const userId = get().userId;
        if (userId) saveSettings(userId, { week_start_day: day });
      },
      timeFormat: '12h',
      setTimeFormat: (format) => {
        set({ timeFormat: format });
        const userId = get().userId;
        if (userId) saveSettings(userId, { time_format: format });
      },
      userTimezone: null,
      hoveredItemId: null,
      hoveredItemType: null,
      setHoveredItem: (id, type) => set({ hoveredItemId: id, hoveredItemType: type }),

      // Supabase state
      userId: null,
      isLoading: false,
      error: null,
      loadFailedUserId: null,

      // ── Item type definitions (Phase 6) ────────────────────────────────────
      itemTypes: [],
      itemTypesAvailable: true,
      addItemType: (def) => {
        const userId = get().userId;
        if (!get().itemTypesAvailable) return;
        const name = def.name.trim().toLowerCase();
        // The organizer nouns are reserved for NEW types (2026-09-25): the "new"
        // dialog's type menu lists Goal / Routine / Program / Project beside the
        // item types, and a same-named type would read as the organizer. Types
        // that already carry one of these names keep it; this only refuses new
        // ones. Mirrored, with a sentence, by the console's slugProblem.
        if (!name || RESERVED_ITEM_TYPE_NAMES.includes(name)) return;
        if (get().itemTypes.some((t) => t.name === name)) return;
        const full: ItemTypeDef = { ...def, name, id: crypto.randomUUID() };
        const next = [...get().itemTypes, full];
        hydrateCustomTypes(next);
        set({ itemTypes: next });
        if (userId) dbCreateItemType(userId, full).catch(console.error);
      },
      updateItemType: (id, updates) => {
        const next = get().itemTypes.map((t) => (t.id === id ? { ...t, ...updates } : t));
        hydrateCustomTypes(next);
        set({ itemTypes: next });
        dbUpdateItemType(id, updates).catch(console.error);
      },
      // Items of the type are NOT deleted — they fall back to the registry's
      // default template (capitalized-name label).
      removeItemType: (id) => {
        const next = get().itemTypes.filter((t) => t.id !== id);
        hydrateCustomTypes(next);
        set({ itemTypes: next });
        dbDeleteItemType(id).catch(console.error);
      },

      // ── Routines (Phase 2) ─────────────────────────────────────────────────
      routines: [],
      collectionsAvailable: true,
      addRoutine: (routine) => {
        const userId = get().userId;
        const full: Routine = { ...routine, id: routine.id ?? crypto.randomUUID() };
        setNextActionLabel(`Add routine: ${full.name}`);
        set({ routines: [...get().routines, full] });
        if (userId) dbCreateRoutine(userId, full).catch(console.error);
        return full.id;
      },
      updateRoutine: (id, updates) => {
        const userId = get().userId;
        const routine = get().routines.find((r) => r.id === id);
        if (!routine) return;
        setNextActionLabel(`Edit routine: ${updates.name ?? routine.name}`);
        // Only a membership change can release anything; a rename or a colour
        // cannot, and the diff costs two resolver passes.
        const run = () =>
          set({ routines: get().routines.map((r) => (r.id === id ? { ...r, ...updates } : r)) });
        if (updates.itemIds) withReleaseGrace(run);
        else run();
        if (userId) dbUpdateRoutine(userId, id, updates).catch(console.error);
      },
      removeRoutine: (id) => {
        const userId = get().userId;
        const routine = get().routines.find((r) => r.id === id);
        if (!routine) return;
        // Soft delete. The join rows survive, so a restore within the purge
        // window brings the membership back intact — which is also what makes
        // undo of a delete a real undo rather than an empty shell.
        setNextActionLabel(`Delete routine: ${routine.name}`);
        withReleaseGrace(() => set({ routines: get().routines.filter((r) => r.id !== id) }));
        if (userId) dbDeleteRoutine(userId, id).catch(console.error);
      },
      setRoutinePaused: (id, paused, until) => {
        const routine = get().routines.find((r) => r.id === id);
        if (!routine) return;
        // Resolved at TODAY from a single instant, never at selectedDate —
        // pausing is dateless (decision 3), and this is the bug Phase 1 shipped
        // and had to fix on the item side. Same reasoning, same shape.
        const tz = get().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const todayStr = toDateStr(new Date(), tz);

        // Delegated to resolvePauseWrite rather than hand-built here, which is
        // both a simplification and a BUG FIX. This action used to open with
        //
        //     if (isPausedOn(routine, todayStr, tz) === paused) return;
        //
        // — an idempotence guard that also swallowed the one request it should
        // have honoured: a new resume date on a pause that is already running.
        // Since a resume date can only be chosen while something is paused,
        // `pausedUntil` was unreachable from the UI entirely; the third
        // parameter has been on this signature, unwritable, since it landed.
        //
        // resolvePauseWrite (lib/active.ts) is the one definition of what the
        // pause VERB means in terms of columns, and already states this case:
        // "Already paused: honour a new resume date, but leave pausedAt where it
        // is" — never restamping the lower bound, which would drag it forward
        // and un-hide the days between. Every previously-supported call resolves
        // identically: a two-argument toggle still writes nothing when the
        // routine is already in the requested state, and a manual resume still
        // normalizes to `pausedUntil = todayStr` rather than clearing the pair,
        // so the interval survives on the row for the sweep's grace.
        //
        // `until` is `string | null | undefined`, and the three are distinct:
        // undefined = "not specified" (the toggles), null = "clear the date",
        // a string = "come back then".
        const write = resolvePauseWrite(
          routine,
          { paused, pausedUntil: until },
          todayStr,
          new Date().toISOString(),
          tz
        );
        // A `reason` is a request the resolver refused (a resume date already in
        // the past). The UI cannot produce one — the picker disables today and
        // everything before it — so there is nothing to report here.
        if (!('patch' in write)) return;
        const updates = write.patch as Partial<Routine>;
        if (Object.keys(updates).length === 0) return;

        // Writes directly rather than delegating to updateRoutine: that action
        // stamps its own "Edit routine" label, and the history subscriber fires
        // synchronously on its set(), so a label applied afterwards would land
        // on whatever the user does NEXT.
        //
        // A pausedUntil-only write is neither a pause nor a resume — it moves
        // the end of one already running — and gets its own label so undo can
        // name it.
        const verb = !('pausedAt' in updates) && paused ? 'Resume date' : paused ? 'Pause' : 'Resume';
        setNextActionLabel(`${verb} routine: ${routine.name}`);
        set({ routines: get().routines.map((r) => (r.id === id ? { ...r, ...updates } : r)) });
        const userId = get().userId;
        // dbUpdateRoutine keys on `'pausedUntil' in updates` (lib/db.ts:958), so
        // an explicit-undefined value still writes paused_until = null.
        if (userId) dbUpdateRoutine(userId, id, updates).catch(console.error);
      },

      // ── Programs (Phase 3) ─────────────────────────────────────────────────
      programs: [],
      addProgram: (program) => {
        const userId = get().userId;
        const full: Program = { ...program, id: program.id ?? crypto.randomUUID() };
        setNextActionLabel(`Add program: ${full.name}`);
        set({ programs: [...get().programs, full] });
        if (userId) dbCreateProgram(userId, full).catch(console.error);
        return full.id;
      },
      updateProgram: (id, updates) => {
        const userId = get().userId;
        const program = get().programs.find((p) => p.id === id);
        if (!program) return;
        setNextActionLabel(`Edit program: ${updates.name ?? program.name}`);
        const run = () =>
          set({ programs: get().programs.map((p) => (p.id === id ? { ...p, ...updates } : p)) });
        // Membership OR a date range: moving `startsOn` earlier switches the
        // program on for today just as surely as adding a member does.
        if (updates.itemIds || updates.routineIds || 'startsOn' in updates || 'endsOn' in updates) {
          withReleaseGrace(run);
        } else {
          run();
        }
        if (userId) dbUpdateProgram(userId, id, updates).catch(console.error);
      },
      removeProgram: (id) => {
        const userId = get().userId;
        const program = get().programs.find((p) => p.id === id);
        if (!program) return;
        // Soft delete, and the join rows survive it — so a restore inside the
        // 30-day purge window brings the membership back intact, and undo of a
        // delete is a real undo rather than an empty shell. Note the members
        // REAPPEAR while the program is trashed: a routine it was the only
        // holder of falls back to standalone (resolver decision 3). That is the
        // designed behaviour — a container in the trash must not keep hiding
        // work behind a control nobody can reach.
        setNextActionLabel(`Delete program: ${program.name}`);
        withReleaseGrace(() => set({ programs: get().programs.filter((p) => p.id !== id) }));
        if (userId) dbDeleteProgram(userId, id).catch(console.error);
      },
      setProgramState: (id, state) => {
        const userId = get().userId;
        const program = get().programs.find((p) => p.id === id);
        if (!program || program.state === state) return;
        const verb =
          state === 'active' ? 'Activate' : state === 'paused' ? 'Pause' : 'Auto-schedule';
        // Written directly rather than through updateProgram for the same
        // reason setRoutinePaused is: that action stamps its own "Edit program"
        // label, and the history subscriber fires synchronously inside its
        // set(), so a label applied afterwards lands on the user's NEXT action.
        setNextActionLabel(`${verb} program: ${program.name}`);
        // `updatedAt` is stamped optimistically to mirror what the DB trigger is
        // about to do. Without it the store keeps the value it loaded with, and
        // the overdue sweep's grace (c) — whose ONLY evidence that a program
        // recently stopped hiding its members is this timestamp — would not fire
        // until the next reload. Turning a program on and leaving the tab open
        // overnight is exactly the case it protects.
        const stamped = { state, updatedAt: new Date().toISOString() };
        set({ programs: get().programs.map((p) => (p.id === id ? { ...p, ...stamped } : p)) });
        if (userId) dbUpdateProgram(userId, id, { state }).catch(console.error);
      },
      swapToProgram: (id) => {
        const userId = get().userId;
        const target = get().programs.find((p) => p.id === id);
        if (!target) return;
        // Resolved at TODAY, never at selectedDate — switching programs is a
        // statement about now, not about the week being browsed.
        const tz = get().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const todayStr = toDateStr(new Date(), tz);

        const patches = new Map<string, Partial<Program>>();
        // Only write a program that is not ALREADY where the swap wants it. An
        // `auto` program inside its own date range is already carrying its
        // members, and stamping 'active' would silently convert a self-managing
        // program into one the user must remember to turn off.
        //
        // The state written comes from `programStateForSwitch` — the same rule
        // the scope rail and the palette use — rather than a literal
        // 'active'/'paused'. Writing the literal is only half right: it can
        // never hand a program back to `auto`, so swapping away from a summer
        // and back again loses the Aug 31 end it was following.
        if (!isProgramActiveOn(target, todayStr)) {
          patches.set(id, { state: programStateForSwitch(target, true, todayStr) });
        }
        for (const program of get().programs) {
          if (program.id === id) continue;
          if (isProgramActiveOn(program, todayStr)) {
            patches.set(program.id, { state: programStateForSwitch(program, false, todayStr) });
          }
        }
        if (patches.size === 0) return;

        // ONE set() for the whole swap: one history entry, one ⌘Z. A loop over
        // setProgramState would cost one undo press per program that happened
        // to be on, which for a verb the user experiences as a single switch is
        // effectively not undoable.
        setNextActionLabel(`Switch to program: ${target.name}`);
        const now = new Date().toISOString();
        set({
          programs: get().programs.map((p) => {
            const patch = patches.get(p.id);
            // Same optimistic `updatedAt` as setProgramState, and needed most
            // here: a swap is precisely the moment a dormant program's members
            // flood back in, already carrying weeks of accrued overdue age.
            return patch ? { ...p, ...patch, updatedAt: now } : p;
          }),
        });
        if (userId) {
          for (const [programId, patch] of patches) {
            dbUpdateProgram(userId, programId, patch).catch(console.error);
          }
        }
      },

      // ── Goals (036) ────────────────────────────────────────────────────────
      goals: [],
      goalsAvailable: true,
      addGoal: (goal) => {
        const userId = get().userId;
        const full: Goal = { ...goal, id: goal.id ?? crypto.randomUUID() };
        setNextActionLabel(`Add goal: ${full.name}`);
        set({ goals: [...get().goals, full] });
        if (userId) dbCreateGoal(userId, full).catch(console.error);
        return full.id;
      },
      updateGoal: (id, updates) => {
        const userId = get().userId;
        const goal = get().goals.find((g) => g.id === id);
        if (!goal) return;

        // An id in two role arrays is two contradictory instructions about one
        // join row, and the PK holds exactly one role. db.ts refuses it — but
        // it refuses INSIDE the write, which this action fires as
        // `.catch(console.error)` AFTER the optimistic set() has landed. So the
        // store would keep a state the database rejected, the item would render
        // in two lists, goalProgress would count a milestone that does not
        // exist, and every SUBSEQUENT membership edit on this goal would throw
        // on the same contradiction. Refusing here keeps the store honest.
        const roleArrays = [updates.memberIds, updates.milestoneIds, updates.checkinIds];
        const seen = new Set<string>();
        for (const ids of roleArrays) {
          if (!ids) continue;
          for (const memberId of new Set(ids)) {
            if (seen.has(memberId)) {
              console.error(
                `updateGoal: item ${memberId} was given two roles in goal ${id}; write refused.`,
              );
              return;
            }
            seen.add(memberId);
          }
        }

        setNextActionLabel(`Edit goal: ${updates.name ?? goal.name}`);
        set({ goals: get().goals.map((g) => (g.id === id ? { ...g, ...updates } : g)) });
        // No withReleaseGrace, unlike updateRoutine: a goal suppresses nothing,
        // so no membership change here can release an item back onto the canvas.
        // That grace exists for the resolver's benefit and goals never reach it.
        if (userId) dbUpdateGoal(userId, id, updates).catch(console.error);
      },
      removeGoal: (id) => {
        const userId = get().userId;
        const goal = get().goals.find((g) => g.id === id);
        if (!goal) return;
        // Soft delete, and the MEMBERS ARE UNTOUCHED: they are ordinary items
        // that exist for their own sake, and only the goal and its links go to
        // the bin. The delete confirm has to say so — "delete Learn Chinese"
        // sounds like it takes a year of work with it.
        setNextActionLabel(`Delete goal: ${goal.name}`);
        set({ goals: get().goals.filter((g) => g.id !== id) });
        if (userId) dbDeleteGoal(userId, id).catch(console.error);
      },
      setGoalState: (id, state) => {
        const userId = get().userId;
        const goal = get().goals.find((g) => g.id === id);
        if (!goal) return;
        // One definition of what a state change writes, shared with Phase 4's
        // agent route. Empty for a same-state write, so a retry can never drag
        // a multi-year achievement date forward.
        const patch = resolveGoalStateWrite(goal, state, new Date().toISOString());
        if (Object.keys(patch).length === 0) return;
        const verb =
          state === 'achieved' ? 'Achieve' : state === 'abandoned' ? 'Abandon' : 'Reopen';
        setNextActionLabel(`${verb} goal: ${goal.name}`);
        set({ goals: get().goals.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
        // `achievedAt: undefined` must reach the DB as a CLEAR rather than be
        // dropped as an absent key. db.ts tests `'achievedAt' in updates` and
        // writes `?? null`, and the spread preserves the key — which is what
        // makes reopening a goal actually erase the stamp.
        if (userId) dbUpdateGoal(userId, id, patch).catch(console.error);
      },

      identifyUser: (userId: string) => {
        // Idempotent, and that is the whole reason it is safe to call from the
        // auth path: Supabase re-emits SIGNED_IN on every hidden→visible
        // transition and broadcasts it across tabs, so this runs on every tab
        // switch. Re-stamping the SAME account would flip `isLoading` back to
        // true under a planner that is fully loaded, which is the tab-switch
        // blank-screen bug initializeStore's own guard exists to prevent.
        if (get().userId === userId) return;

        // A DIFFERENT account (or the first one) — whatever is in these slices
        // belongs to someone else. On the routes that go on to load, this is
        // redundant with initializeStore's own replace; on the routes that do
        // not, it is the only thing standing between user B and user A's rows.
        // The history globals go with them: an undo stack recorded against A's
        // items must never be applicable to B's session.
        historyStack = [];
        historyIndex = -1;
        actionLog = [];
        prevStateJson = null;
        // WITH the stack, not apart from it — `initializeStore` resets the pair
        // together for the same reason. The subscriber's lazy-baseline branch
        // fires only on `!hasInitializedHistory && historyStack.length === 0`,
        // so a stack emptied while the flag stays true from the last session is
        // a session that can never record its 'Session start'. On the routes
        // this action exists to serve there is no `initializeStore` afterwards
        // to set it, so the first mutation of the new account would land with
        // `historyIndex` at -1 and nothing to undo back to.
        hasInitializedHistory = false;

        hydrateCustomTypes([]);
        // SAVED AND RESTORED, never a hard `false` — the rule set out at
        // `removeRefusedContainer`. An account switch with no intervening
        // SIGNED_OUT can land here while the PREVIOUS account's
        // `initializeStore` is still awaiting its fetch, and that load holds
        // the flag true across its whole window. Handing it back unblocked
        // there wakes the history subscriber mid-load, which is the bug that
        // comment was written for: a second 'Session start', a `historyIndex`
        // naming a snapshot the store does not hold, and one ⌘Z soft-deleting
        // every row the load brought in.
        const wasSuppressed = isUpdatingUndoRedo;
        isUpdatingUndoRedo = true;
        try {
          set({
            ...emptyAccountData(),
            userId,
            // See the interface note: "not asked for yet" has to read as
            // unsettled, or every `!isLoading` gate in the app treats an empty
            // store as a complete one.
            isLoading: true,
          });
        } finally {
          isUpdatingUndoRedo = wasSuppressed;
        }
      },

      initializeStore: async (userId: string) => {
        // Re-initializing the account that is already loaded is never a
        // refresh — it is a reset. It refetches six tables, flips isLoading
        // back to true (blanking any surface that gates on it), and throws away
        // the undo history below. Nothing calls this wanting that.
        //
        // The callers make it reachable by accident, not by intent:
        // supabase-provider's SIGNED_IN branch fires on token refresh and on
        // tab focus, not only on a real sign-in. Guarding here rather than at
        // each call site means a future caller cannot reintroduce it.
        //
        // `isLoading` is part of the condition so a genuine in-flight load is
        // never mistaken for a settled one — a second call while the first is
        // still running must be allowed through to replace it.
        //
        // And `loadFailedUserId`, so a FAILED load is not mistaken for a
        // finished one (see the field). Letting that account through is the
        // retry, and what it resets is the empty store the failure left: no
        // fetched data arrived, and the history recorded since was recorded
        // against that store, so undoing into it after the reload lands would
        // soft-delete every row the reload brought in. A row TYPED into that
        // store is replaced like the rest, and the reload brings it back only
        // if its write committed before the reload read. That is the load
        // window loadPlanner's comment in supabase-provider.tsx describes, and
        // this does not close it.
        const current = get();
        if (current.userId === userId && !current.isLoading && current.loadFailedUserId !== userId) {
          return;
        }

        // Block subscriber during initialization to prevent poisoned history entries
        const generation = ++loadGeneration;
        isUpdatingUndoRedo = true;
        hasInitializedHistory = false;

        // Reset history for new session
        historyStack = [];
        historyIndex = -1;
        actionLog = [];
        prevStateJson = null;

        set({
          userId,
          isLoading: true,
          error: null,
          loadFailedUserId: null,
          // The published side of the reset just above. A first load follows
          // identifyUser or clearStore, which have already emptied these; a
          // RETRY follows a failed load, where the history subscriber was live
          // and recorded entries, so without this the undo button and the
          // action log would offer that history for the whole of the retry
          // while ⌘Z, reading the emptied module state, did nothing.
          canUndo: false,
          canRedo: false,
          actionLog: [],
          historyIndex: -1,
        });

        try {
          const [
            items,
            projects,
            itemTypesResult,
            routinesResult,
            programsResult,
            goalsResult,
          ] =
            await Promise.all([
              fetchItems(userId),
              fetchProjects(userId),
              fetchItemTypes(userId),
              fetchRoutines(userId),
              // Rides the SAME Promise.all as items, deliberately: the overdue
              // sweep's only hydration gate is `!isLoading`, which is cleared by
              // the single set() below. Fetch programs anywhere else — a lazy
              // load, a second effect — and the sweep runs against an empty
              // list, reads every member of an inactive program as unprotected,
              // and unschedules them in one silent batch. See use-overdue-sweep.
              fetchPrograms(userId),
              // Goals ride the same Promise.all, and for the sweep's sake as
              // much as the programs above: the auto-age sweep subtracts
              // milestone-role items before unscheduling anything, and its only
              // hydration gate is the `!isLoading` that the single set() below
              // clears. Fetch goals anywhere else and the sweep runs against an
              // empty goal list, reads every milestone as unprotected, and
              // erases a year of target dates in one silent batch.
              fetchGoals(userId),
            ]);
          // A SLOWER RESPONSE FOR A PREVIOUS ACCOUNT MUST NEVER LAND ON THE
          // CURRENT ONE — the rule supabase-provider's `hydrateSettings`
          // already follows across its own await, and the one place on this
          // store that did not.
          //
          // An account switch with no intervening SIGNED_OUT (Supabase delivers
          // no event for it) re-stamps `userId` while this fetch is still in
          // flight. Everything below belongs to the account that is no longer
          // signed in, so it is dropped wholesale rather than partially
          // applied. Without this the `set()` below lands user A's items under
          // user B's id AND clears `isLoading` — after which
          // `identifyUser`-stamped B looks, to this function's own opening
          // guard, exactly like an account that is already loaded, so the next
          // `initializeStore(B)` early-returns and B is left reading A's rows
          // for the rest of the session.
          // SUPERSEDED covers the case `userId` cannot see. The opening guard
          // deliberately lets a second call through while the first is still
          // running ("a second call while the first is still running must be
          // allowed through to replace it"), so two loads for the SAME account
          // can overlap — a sign-out and immediate sign-in as A, or A → B → A
          // across tabs. The older one has stale rows and a stale history
          // baseline, and must bow out rather than land on top of the newer.
          if (loadGeneration !== generation) return;
          if (get().userId !== userId) {
            // Releasing the suppressor is this load's job only while it still
            // owns it, and the line above has just established that it does.
            // Skipping the release outright would latch it forever and silently
            // stop the history subscriber recording anything for the rest of
            // the session.
            isUpdatingUndoRedo = false;
            return;
          }

          const itemTypes = itemTypesResult ?? [];
          // null means the table is unreachable, NOT "no rows" — the flag gates
          // the UI so a write can't look like it landed and vanish.
          const routines = routinesResult ?? [];
          const programs = programsResult ?? [];
          const goals = goalsResult ?? [];

          // Custom types must be resolvable before any item renders.
          hydrateCustomTypes(itemTypes);

          const snapshot = { items, projects, routines, programs, goals };

          // Manually push the initial state to history (session start)
          historyStack.push(JSON.parse(JSON.stringify(snapshot)));
          actionLog.push({
            id: crypto.randomUUID(),
            label: 'Session start',
            timestamp: Date.now(),
          });
          historyIndex = 0;

          // Set prevStateJson so the subscriber doesn't double-save
          prevStateJson = JSON.stringify(snapshot);

          isUpdatingUndoRedo = true;
          set({
            ...projectItems(items),
            projects,
            itemTypes,
            itemTypesAvailable: itemTypesResult !== null,
            routines,
            programs,
            // Both tables arrive with migration 024, so either coming back
            // unreachable means the same thing: the whole collections feature
            // is not deployed and its UI must stay hidden.
            collectionsAvailable: routinesResult !== null && programsResult !== null,
            goals,
            goalsAvailable: goalsResult !== null,
            isLoading: false,
            canUndo: false,
            canRedo: false,
            actionLog: [...actionLog].reverse(),
            historyIndex: 0,
          });
          isUpdatingUndoRedo = false;
        } catch (err) {
          // Both bow-out conditions from the success path, in the same order
          // and for the same reasons.
          if (loadGeneration !== generation) return;
          isUpdatingUndoRedo = false;
          // A FAILED load for the previous account would otherwise clear
          // `isLoading` for the current one and put someone else's error on
          // their screen — and leave this function's opening guard reading the
          // new account as settled, so its own load could never start.
          if (get().userId !== userId) return;
          // The fetchers rethrow Supabase's plain error objects, which are not
          // Errors, so the message below is nearly always the fallback text.
          // This line is the only record of the cause.
          console.error('planner load failed', err);
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to load data',
            loadFailedUserId: userId,
          });
        }
      },

      clearStore: () => {
        historyStack = [];
        historyIndex = -1;
        actionLog = [];
        prevStateJson = null;

        hydrateCustomTypes([]);
        isUpdatingUndoRedo = true;
        set({
          ...emptyAccountData(),
          userId: null,
          isLoading: false,
        });
        isUpdatingUndoRedo = false;
      },

      clearUserScopedState: (scope) => {
        if (scope !== 'all') return;
        set({ ...PERSISTED_SETTINGS_DEFAULTS });
      },

      addItem: (customType, itemData, memberships) => {
        // Only hydrated custom slugs: 'task'/'habit' would write a corrupt
        // row through the task-shaped mapper, 'custom' is the envelope
        // discriminant, and unknown slugs shouldn't be minted by a typo.
        if (
          ['task', 'habit', 'custom'].includes(customType) ||
          !get().itemTypes.some((t) => t.name === customType)
        ) {
          return;
        }
        const config = getItemTypeConfig(customType);
        const timeBucket = autoCorrectBucket(itemData.startTime, itemData.timeBucket);

        const item: Item = {
          ...itemData,
          type: 'custom',
          customType,
          timeBucket,
          id: crypto.randomUUID(),
          status: 'pending',
          isScheduled: !!timeBucket,
          order: 0, // custom types aren't manually orderable (created_at sorts)
          projectId: projectIdFor(itemData.project, get().projects),
        };
        // Labelled AFTER the row is minted, not before: the receipt is a
        // question about THIS item's id and landing date, and neither exists
        // until it is built. The label is consumed by the next set() either
        // way, so the move costs nothing.
        setNextActionLabel(
          `Add ${config.label.toLowerCase()}: ${itemData.title}`,
          newMemberReceipt(get(), item, memberships, startDateOf(item)),
        );
        set((state) => ({
          ...projectItems([...state.items, item]),
          routines: withMembership(state.routines, item.id, memberships?.routineIds),
          goals: withGoalMembership(state.goals, item.id, memberships?.goalIds, memberships?.goalRole),
          programs: withMembership(state.programs, item.id, memberships?.programIds),
        }));

        const userId = get().userId;
        if (userId) persistNewItem(userId, item, memberships, get);
      },

      addTask: (taskData, memberships) => {
        const timeBucket = autoCorrectBucket(taskData.startTime, taskData.timeBucket);

        const task: TaskItem = {
          ...taskData,
          type: 'task',
          timeBucket,
          id: crypto.randomUUID(),
          status: 'pending',
          isScheduled: !!timeBucket,
          order: get().tasks.length,
          projectId: projectIdFor(taskData.project, get().projects),
        };
        // Resolved at the item's OWN start date, not today — a task created
        // for a Monday inside a program that ends on Sunday is exactly the case
        // decision 11's receipt exists for, and today would answer about the
        // wrong day. Undated (braindump) items have no landing date but they do
        // have a landing surface, so they fall back to today like every other
        // dateless caller.
        setNextActionLabel(
          `Add task: ${taskData.title}`,
          newMemberReceipt(get(), task, memberships, startDateOf(task)),
        );
        set((state) => ({
          ...projectItems([...state.items, task]),
          routines: withMembership(state.routines, task.id, memberships?.routineIds),
          goals: withGoalMembership(state.goals, task.id, memberships?.goalIds, memberships?.goalRole),
          programs: withMembership(state.programs, task.id, memberships?.programIds),
        }));

        const userId = get().userId;
        if (userId) persistNewItem(userId, task, memberships, get);
      },

      addTasksBulk: (type, itemsData) => {
        if (itemsData.length === 0) return;
        // One row is a normal add wearing a bulk sleeve — delegate so the
        // history label keeps its natural single-item form.
        if (itemsData.length === 1) {
          if (type === 'task') get().addTask(itemsData[0]);
          else get().addItem(type, itemsData[0]);
          return;
        }
        // Same slug guard as addItem, with 'task' additionally allowed:
        // 'habit' would write corrupt rows through the task-shaped mapper,
        // 'custom' is the envelope discriminant, unknown slugs stay unminted.
        const isCustom = type !== 'task';
        if (
          isCustom &&
          (type === 'habit' || type === 'custom' || !get().itemTypes.some((t) => t.name === type))
        ) {
          return;
        }

        // Always "items", never a pluralised type label — the undo toast
        // matches on this prefix, and "7 grocerys" is what naive pluralisation
        // buys.
        setNextActionLabel(`Bulk add: ${itemsData.length} items`);

        const baseOrder = get().tasks.length;
        const projects = get().projects;
        const rows: Item[] = itemsData.map((itemData, i) => {
          const timeBucket = autoCorrectBucket(itemData.startTime, itemData.timeBucket);
          return {
            ...itemData,
            ...(isCustom ? { type: 'custom' as const, customType: type } : { type: 'task' as const }),
            timeBucket,
            id: crypto.randomUUID(),
            status: 'pending',
            isScheduled: !!timeBucket,
            // Custom types aren't manually orderable (created_at sorts).
            order: isCustom ? 0 : baseOrder + i,
            projectId: projectIdFor(itemData.project, projects),
          } as Item;
        });

        // ONE set() for the whole paste: one history entry, one ⌘Z.
        set((state) => projectItems([...state.items, ...rows]));

        // Tasks: one INSERT statement, not N createItem calls — all-or-nothing
        // on the wire, and the undo-races-insert window stays as narrow as a
        // single add's (see createItems in lib/db.ts). Their explicit `order`
        // values carry the paste order through the shared created_at.
        //
        // Custom types can't ride that statement: they are order-0 by design
        // (created_at sorts, per the registry decision), and a single INSERT
        // stamps every row with the statement's created_at — the paste order
        // would scramble on reload. A sequential chain gives each row its own
        // timestamp; custom bulk adds are rare enough to pay the round trips.
        const userId = get().userId;
        if (userId) {
          if (isCustom) {
            void (async () => {
              for (const row of rows) {
                await dbCreateItem(userId, row).catch(console.error);
              }
            })();
          } else {
            dbCreateItems(userId, rows).catch(console.error);
          }
        }
      },

      updateTask: (id, updates) => {
        const task = findTaskLike(id);
        // A date change through the generic edit action IS a move verb, and two
        // of the surfaces decision 11 names by name arrive here rather than at
        // moveTaskToDate: the EOD review's "Tomorrow" button and date picker
        // (which is also how "Move all to tomorrow" works, one row at a time),
        // and the item dialog's date chip. Attaching the receipt to the update
        // itself is what stops the next such surface from being missed too.
        setNextActionLabel(
          `Edit task: ${task?.title || 'Unknown'}`,
          'startDate' in updates ? landingReceipt(get(), [id], updates.startDate) : undefined
        );

        const newUpdates = { ...updates };
        // Auto-correct bucket if start time changes
        if (updates.startTime && task) {
          const bucket = updates.timeBucket || task.timeBucket;
          const corrected = autoCorrectBucket(updates.startTime, bucket);
          if (corrected !== bucket) newUpdates.timeBucket = corrected;
        }
        // Re-file: the id follows the name, INCLUDING to undefined. Key
        // presence is the test, not truthiness — clearing `project` is how
        // unfiling is expressed, and leaving a stale id behind would let a
        // later rename of the old container pull the name back onto an item
        // the user had already taken out of it.
        if ('project' in updates) {
          newUpdates.projectId = projectIdFor(updates.project, get().projects);
        }

        // Stamp the agent clock LOCALLY too, not just in the row mapper.
        //
        // The store applies `{...item, ...updates}` optimistically and nothing
        // refetches for the rest of the session — there is no realtime
        // subscription, no polling, and `initializeStore` early-returns on
        // re-entry. So a status change whose stamp only existed server-side
        // left the store holding the PREVIOUS one, and the row went on
        // reporting elapsed time from the old state until a reload: answer a
        // question asked six hours ago and the row reads "Queued 6h" for a
        // state six seconds old. That is precisely the confident wrong number
        // this column was added to avoid.
        //
        // Set only when absent, so an explicit stamp — the one `diffItem`
        // carries back through undo — is preserved rather than overwritten.
        if ('aiStatus' in newUpdates && newUpdates.aiStatusAt === undefined) {
          newUpdates.aiStatusAt = new Date().toISOString();
        }

        updateItemAction(id, 'task', newUpdates);
      },

      changeItemType: (id, toType, opts) => {
        const state = get();
        const found = state.items.find((i) => i.id === id);
        if (!found) return;
        const fromType = dbTypeOf(found);
        if (fromType === toType) return;
        if (conversionBlock(found, toType, { items: state.items, milestoneIds: milestoneItemIds(state.goals) })) return;
        const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const todayStr = toDateStr(new Date(), tz);
        const target = convertItem(found, toType, {
          todayStr,
          anchorFloor: weekStartOf(todayStr, state.weekStartDay),
          repeat: opts?.repeat,
          projectIdFor: (name) => projectIdFor(name, state.projects),
          nextOrder: state.items.reduce((max, i) => (i.type !== 'habit' ? Math.max(max, i.order ?? 0) : max), 0) + 1,
        });
        setNextActionLabel(`Change type: ${found.title}`);
        // Matched by id alone: the id is unique across types, and the type is
        // exactly what is changing. applyHistoryState keys by id for the same
        // reason, so ⌘Z switches it back rather than deleting it.
        set((s) => projectItems(s.items.map((i) => (i.id === id ? target : i))));
        queueTypeSwitch(id, () => dbChangeItemType(id, fromType, target, state.userId ?? undefined));
      },

      deleteTask: (id) => {
        const found = findTaskLike(id);
        setNextActionLabel(`Delete task: ${found?.title || 'Unknown'}`);
        if (!found) return;
        // Cascade to subtasks explicitly: soft-delete doesn't fire the DB's
        // ON DELETE SET NULL (that's for the hard purge), and an orphaned
        // subtask would be unreachable — excluded from every view, parent gone.
        const children = get().items.filter(
          (i) => i.type !== 'habit' && i.parentItemId === id
        );
        set((state) =>
          projectItems(
            state.items.filter(
              (i) =>
                !(i.id === id && i.type === found.type) &&
                !children.some((c) => c.id === i.id)
            )
          )
        );

        dbDeleteItem(id, dbTypeOf(found)).catch(console.error);
        children.forEach((c) => dbDeleteItem(c.id, dbTypeOf(c)).catch(console.error));
      },

      toggleTaskStatus: (id, status?, date?) => {
        const found = findTaskLike(id);
        const task = found as TaskItem | undefined;
        if (!task || !found) return;

        if (isRecurring(task)) {
          // Per-date completion tracking — never change global status
          const dateStr = resolveDateStr(date);
          const alreadyDone = isCompletedOnDate(task, dateStr);
          const newCompletedDates = alreadyDone
            ? (task.completedDates ?? []).filter(d => d !== dateStr)
            : [...(task.completedDates ?? []), dateStr];

          setNextActionLabel(`${alreadyDone ? 'Uncomplete' : 'Complete'} task on ${dateStr}: ${task.title}`);
          set((state) => projectItems(
            state.items.map(i => i.id === id && i.type === found.type ? { ...i, completedDates: newCompletedDates } : i),
          ));
          dbSetItemCompletion(id, dbTypeOf(found), dateStr, !alreadyDone).catch(console.error);
          if (!alreadyDone) {
            celebrate();
            offerCheckin(task, dateStr);
          }
        } else {
          // One-off task — existing behavior unchanged
          const newStatus: TaskStatus = status ?? (task.status === 'completed' ? 'pending' : 'completed');
          setNextActionLabel(`${newStatus === 'completed' ? 'Complete' : 'Uncomplete'} task: ${task.title}`);
          updateItemAction(id, 'task', { status: newStatus });
          // Transition-only, like the recurring/habit taps: an explicit
          // status='completed' on an already-completed task must not celebrate.
          if (newStatus === 'completed' && task.status !== 'completed') {
            celebrate();
            offerAchievement(id);
          }
        }
      },

      scheduleTask: (id, bucket, time, date) => {
        const task = findTaskLike(id);
        setNextActionLabel(
          `Schedule task: ${task?.title || 'Unknown'}`,
          landingReceipt(get(), [id], date ?? startDateOf(task))
        );
        const finalBucket = autoCorrectBucket(time, bucket) ?? bucket;

        const updates: Partial<Task> = {
          isScheduled: true,
          timeBucket: finalBucket,
          startTime: time,
          inProjectBlock: false,
          previousStartTime: undefined,
          previousStartDate: undefined,
          ...(date ? { startDate: date } : {}),
        };

        updateItemAction(id, 'task', updates);
      },

      assignTaskToBucket: (id, bucket) => {
        const task = findTaskLike(id);
        setNextActionLabel(
          `Move task to ${bucket}: ${task?.title || 'Unknown'}`,
          landingReceipt(get(), [id], startDateOf(task))
        );
        const updates: Partial<Task> = {
          isScheduled: false,
          timeBucket: bucket,
          startTime: undefined,
          inProjectBlock: false,
          previousStartTime: undefined,
          previousStartDate: undefined,
        };

        updateItemAction(id, 'task', updates);
      },

      unscheduleTask: (id) => {
        const task = findTaskLike(id);
        if (!task) return; // habit ids no-op here by contract (sidebar drop)
        setNextActionLabel(`Unschedule task: ${task.title}`);
        updateItemAction(id, 'task', { isScheduled: false, timeBucket: undefined, startTime: undefined, startDate: undefined });
      },

      /**
       * Carry one task-like item to `dateStr`.
       *
       * The timeBucket fallback is load-bearing, not cosmetic: lib/day-items.ts
       * buckets (:98) and counts (:134) ONLY tasks that have a timeBucket, so a
       * carry that wrote startDate alone would move the item to the target day
       * and make it invisible in every day view.
       *
       * startTime is preserved on purpose — the user picked this one item, so
       * its clock time is meaningful. (The bulk verb below drops it; see there.)
       */
      moveTaskToDate: (id, dateStr) => {
        const task = findTaskLike(id);
        if (!task) return; // habit ids no-op here by contract (see findTaskLike)
        // 'Move task to' is the prefix hooks/use-undo-toast.ts SIGNIFICANT_ACTIONS
        // matches (shared with assignTaskToBucket) — keep it verbatim or the undo
        // toast silently stops appearing.
        setNextActionLabel(
          `Move task to ${dateStr}: ${task.title}`,
          landingReceipt(get(), [id], dateStr)
        );
        updateItemAction(id, 'task', {
          startDate: dateStr,
          timeBucket: task.timeBucket ?? 'anytime',
        });
      },

      /**
       * Bulk carry. Callers are responsible for excluding recurring items — a
       * recurring task's startDate is its recurrence anchor, so carrying it
       * rewrites the series rather than moving an occurrence.
       */
      moveTasksToDate: (ids, dateStr, bucket) => {
        const idSet = new Set(ids);
        // Resolved before the label is set: setNextActionLabel arms a pending
        // label consumed by the NEXT history save, so labelling a no-op would
        // mislabel whatever the user does next.
        //
        // MILESTONES ARE EXCLUDED, exactly as recurring items already are from
        // EOD's carry. For an ordinary task `startDate` is a scheduling
        // intention and "move all to tomorrow" is a kindness; for a milestone
        // it is the TARGET DATE — the one field that says when the checkpoint
        // was meant to happen — and a habitual bulk tap would silently walk a
        // goal's deadline forward a day at a time. Moving one deliberately is
        // still allowed everywhere (the dialog's date chip, the tray's "pick a
        // new date"); it is only the sweeping verb that must not.
        const milestones = milestoneItemIds(get().goals);
        const targets = get().items.filter(
          (i) => i.type !== 'habit' && idSet.has(i.id) && !milestones.has(i.id),
        );
        if (targets.length === 0) return;
        // 'Move all tasks' is already in SIGNIFICANT_ACTIONS; this is its first producer.
        setNextActionLabel(
          `Move all tasks to ${dateStr} (${targets.length})`,
          landingReceipt(get(), targets.map((t) => t.id), dateStr)
        );

        const writes = targets.map((item) => ({
          id: item.id,
          dbType: dbTypeOf(item),
          updates: {
            startDate: dateStr,
            // Same load-bearing visibility guarantee as moveTaskToDate. A group
            // week-grid drop passes the target bucket; otherwise keep own.
            timeBucket: bucket ?? item.timeBucket ?? 'anytime',
            // Deliberately cleared, unlike the single-item verb: a bulk carry can
            // drag 18 stale clock times (06:00, 22:30, …) onto today at once, and
            // deriveGridRange widens the schedule window to cover them, which
            // drives use-fit-hour-px to its MIN_HOUR_PX floor. The bulk verb would
            // then destroy the very fit-to-height contract this feature exists to
            // protect, so bulk-carried items land as untimed bucket rows.
            startTime: undefined,
            isScheduled: false,
          } satisfies Partial<Task>,
        }));

        // ONE set() => ONE history entry (the subscriber at the bottom of this
        // file snapshots per state change). A per-item loop would push N deep
        // clones, evict the user's real history at MAX_HISTORY_SIZE, and need N
        // presses of Cmd+Z to reverse a single user gesture.
        const patchById = new Map(writes.map((w) => [w.id, w.updates]));
        set((state) => projectItems(state.items.map((i) => {
          const updates = i.type !== 'habit' ? patchById.get(i.id) : undefined;
          return updates ? ({ ...i, ...updates } as Item) : i;
        })));

        // Every item persists — dbType per item, because a custom-type row is
        // matched on .eq('type', slug) and 'task' would silently write nothing.
        writes.forEach(({ id, dbType, updates }) =>
          dbUpdateItem(id, dbType, updates).catch(console.error),
        );
      },

      applyProposal: (proposal) => {
        const state = get();
        // Re-validate at the boundary rather than trusting whatever produced
        // the proposal: the card may have been rendered minutes ago, and the
        // items it references can be edited or deleted in the meantime.
        const { accepted } = validateProposalOperations(proposal.operations, {
          items: state.items,
          customTypeNames: state.itemTypes.map((t) => t.name),
          // The write boundary carries the guard too, not just the card: this
          // re-validation exists precisely because the planner can have changed
          // since the card was rendered — and an item can BECOME a milestone in
          // that window.
          milestoneIds: milestoneItemIds(state.goals),
        });
        if (accepted.length === 0) return 0;

        // Armed before the set(), like every other labelled action — the label
        // is consumed by the NEXT history save.
        setNextActionLabel(`Accept plan: ${proposal.summary}`);

        const created: Item[] = [];
        const patchById = new Map<string, Partial<Task>>();
        /**
         * Items a clear targeted, applied AFTER every operation is merged.
         *
         * Two update operations on one item merge later-op-wins, so expanding
         * the clear per-operation let a following op put back what it had just
         * removed — `[{startDate: null}, {timeBucket: 'afternoon'}]` produced an
         * item with a bucket and no day, which the grid drops (`!startDate`)
         * and the Braindump also drops (`isScheduled || timeBucket`). Invisible
         * everywhere, and persisted.
         *
         * The clear wins over a later reschedule rather than the reverse: a plan
         * saying both is incoherent, and of the two readings only this one
         * leaves the item somewhere the user can find it.
         */
        const unscheduled = new Set<string>();
        // Mirrors addTask's `order: get().tasks.length`, advanced per create so
        // a multi-item plan doesn't stack every new task on the same index.
        //
        // Top-level creates ONLY. Subtasks are absent from the tasks projection
        // (projectItems filters `!parentItemId`), so counting them here would
        // push the cursor past a length that never included them — and a step
        // added by hand afterwards, ordered by the real `tasks.length`, would
        // sort into the MIDDLE of the generated list after a reload.
        let orderCursor = state.tasks.length;
        // Steps get their own run, per parent, continuing that parent's
        // existing children rather than restarting at zero.
        const childCursors = new Map<string, number>();
        const nextChildOrder = (parentId: string) => {
          const seeded =
            childCursors.get(parentId) ??
            state.items.filter((i) => 'parentItemId' in i && i.parentItemId === parentId).length;
          childCursors.set(parentId, seeded + 1);
          return seeded;
        };

        for (const op of accepted) {
          if (op.kind === 'create') {
            const timeBucket = autoCorrectBucket(op.startTime, op.timeBucket);
            const common = {
              title: op.title,
              notes: op.notes,
              priority: op.priority,
              project: op.project,
              // Every other create path resolves this, and the container rename
              // fan-out is keyed on projectId — an item carrying only the NAME
              // silently stops following its project when the project is renamed.
              projectId: projectIdFor(op.project, state.projects),
              startDate: op.startDate,
              startTime: op.startTime,
              timeBucket,
              // Validation has already checked the parent exists, allows
              // children, and is not itself a child — and stripped the
              // scheduling fields, since nothing outside the parent's panel
              // renders a subtask.
              parentItemId: op.parentItemId,
              id: crypto.randomUUID(),
              status: 'pending' as const,
              isScheduled: !!timeBucket,
            };
            const order = op.parentItemId ? nextChildOrder(op.parentItemId) : orderCursor++;
            created.push(
              op.itemType === 'task'
                ? ({ ...common, type: 'task', order } as Item)
                : // Custom types aren't manually orderable (created_at sorts).
                  ({ ...common, type: 'custom', customType: op.itemType, order: 0 } as Item),
            );
            continue;
          }

          const { kind: _kind, itemId, ...rest } = op;
          void _kind;
          const target = state.items.find((i) => i.id === itemId);
          if (!target) continue;

          const updates = { ...rest } as Partial<Task>;

          // A cleared date is the UNSCHEDULE verb, not a null write.
          //
          // `unscheduleTask` clears startTime, timeBucket and isScheduled with
          // it, and this has to match: writing only the date would leave an
          // item that is `isScheduled` with a bucket and no day — placeable on
          // no surface, and reachable from nowhere but the Braindump it was
          // never put in. Validation has already refused this for a recurring
          // item and for any type that cannot live undated.
          //
          // `undefined` rather than `null` because that is how a clear is
          // spelled everywhere else in the store: `updatesToRow` is
          // presence-keyed, so a key present-and-undefined writes NULL while an
          // absent key is left alone.
          if (rest.startDate === null) unscheduled.add(itemId);
          // The simple clears: no companions, nothing derived from them.
          if (rest.startTime === null) updates.startTime = undefined;
          if (rest.priority === null) updates.priority = undefined;

          // Same reason as the create path: the id has to move with the name.
          if (updates.project !== undefined) {
            updates.projectId = projectIdFor(updates.project, state.projects);
          }
          // Same auto-correct the manual edit path applies: a concrete start
          // time overrides a mismatched bucket. Guarded on a REAL time, so
          // clearing one never reaches it.
          if (updates.startTime) {
            updates.timeBucket = autoCorrectBucket(
              updates.startTime,
              updates.timeBucket ?? target.timeBucket,
            );
          }
          // Merge rather than overwrite: two operations may touch one item.
          patchById.set(itemId, { ...(patchById.get(itemId) ?? {}), ...updates });
        }

        // Expanded on the MERGED patch — see the note on `unscheduled`.
        for (const id of unscheduled) {
          patchById.set(id, {
            ...(patchById.get(id) ?? {}),
            startDate: undefined,
            startTime: undefined,
            timeBucket: undefined,
            isScheduled: false,
          });
        }

        // ONE set() => ONE history entry => ONE Cmd+Z reverses the whole plan.
        // Accepting an AI proposal is a single user gesture and must undo like
        // one; see the same contract on moveTasksToDate.
        set((s) => projectItems([
          ...s.items.map((i) => {
            const updates = patchById.get(i.id);
            return updates ? ({ ...i, ...updates } as Item) : i;
          }),
          ...created,
        ]));

        const userId = get().userId;
        if (userId) {
          created.forEach((item) => dbCreateItem(userId, item).catch(console.error));
        }
        // dbType per item: a custom-type row is matched on .eq('type', slug),
        // so passing 'task' would silently write nothing.
        patchById.forEach((updates, id) => {
          const item = get().items.find((i) => i.id === id);
          if (item) dbUpdateItem(id, dbTypeOf(item), updates).catch(console.error);
        });

        return accepted.length;
      },

      /** Batched unscheduleTask (bulk "move to Braindump", auto-age sweep). */
      unscheduleTasks: (ids, opts) => {
        const idSet = new Set(ids);
        // Milestones excluded, and here it matters most: this verb CLEARS
        // startDate, and its heaviest caller is the unattended auto-age sweep.
        // Left in, a milestone thirty days behind would lose its target date
        // overnight — leaving the past-due bar (so the goal stops looking
        // behind), sinking below every dated checkpoint in nextMilestone's
        // ordering, and giving the goal timeline nothing to annotate. The
        // behind-ness would be laundered into "undated" rather than shown.
        const milestones = milestoneItemIds(get().goals);
        const targets = get().items.filter(
          (i) => i.type !== 'habit' && idSet.has(i.id) && !milestones.has(i.id),
        );
        if (targets.length === 0) return;
        // The prefix must stay exactly 'Unschedule task:' — that is the string in
        // hooks/use-undo-toast.ts SIGNIFICANT_ACTIONS. A plural 'Unschedule tasks:'
        // would NOT match its startsWith() test and the undo toast would never fire.
        //
        // ONE caller overrides it, and does so precisely to opt OUT of that
        // toast: the auto-age sweep (hooks/use-overdue-sweep.ts). A five-second
        // toast is a confirmation of something YOU just did; the sweep runs
        // unattended, often before the tab was open, so the toast was never a
        // receipt for it — it fired at whatever moment the app happened to
        // load. Its receipt is a dock line that persists instead. The history
        // entry is unaffected either way, so ⌘Z still reverses the sweep; only
        // the toast stands down.
        setNextActionLabel(
          opts?.label ??
            (targets.length === 1
              ? `Unschedule task: ${targets[0].title}`
              : `Unschedule task: ${targets.length} items`),
        );

        // Field-for-field identical to unscheduleTask so the single and batched
        // verbs can never drift apart.
        const updates: Partial<Task> = {
          isScheduled: false,
          timeBucket: undefined,
          startTime: undefined,
          startDate: undefined,
        };

        // One set() => one history entry => one undo (see moveTasksToDate).
        //
        // Keyed on `targetIds`, NOT on the caller's `idSet`. They used to be
        // interchangeable; the milestone exclusion above made them different,
        // and re-deriving from `idSet` here would clear a milestone's date in
        // the store while writing nothing for it — so it would look unscheduled
        // until the next reload silently put it back.
        const targetIds = new Set(targets.map((t) => t.id));
        set((state) => projectItems(state.items.map((i) => (
          targetIds.has(i.id) ? ({ ...i, ...updates } as Item) : i
        ))));

        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), updates).catch(console.error),
        );
      },

      restoreScheduling: (entries) => {
        // Rows the user has since deleted are silently skipped rather than
        // resurrected: a receipt can be hours old, and "put them back" must
        // never mean "and undelete the two you threw away in between".
        const byId = new Map(entries.map((e) => [e.id, e]));
        const targets = get().items.filter((i) => i.type !== 'habit' && byId.has(i.id));
        if (targets.length === 0) return;

        // 'Schedule task:' is a SIGNIFICANT_ACTIONS prefix, so this one DOES
        // raise the undo toast — unlike the sweep it reverses. This is a thing
        // the user just did, at a moment they were looking at the screen, which
        // is exactly the case a five-second toast is for.
        setNextActionLabel(
          targets.length === 1
            ? `Schedule task: ${targets[0].title}`
            : `Schedule task: ${targets.length} items`,
        );

        const updatesFor = (id: string): Partial<Task> => {
          const e = byId.get(id)!;
          return {
            isScheduled: e.isScheduled,
            startDate: e.startDate,
            timeBucket: e.timeBucket as Task['timeBucket'],
            startTime: e.startTime,
          };
        };

        // One set() => one history entry => one undo (see moveTasksToDate).
        set((state) => projectItems(state.items.map((i) => (
          i.type !== 'habit' && byId.has(i.id) ? ({ ...i, ...updatesFor(i.id) } as Item) : i
        ))));

        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), updatesFor(item.id)).catch(console.error),
        );
      },

      reorderTasks: (taskIds) => {
        setNextActionLabel('Reorder tasks');
        // Tasks absent from taskIds keep their current order — a partial list
        // (e.g. one filtered view) must never drop the rest of the store.
        const orderById = new Map(taskIds.map((id, index) => [id, index]));
        const changed: TaskItem[] = [];

        set((state) => projectItems(
          state.items.map((i) => {
            if (i.type !== 'task') return i;
            const order = orderById.get(i.id);
            if (order === undefined || order === i.order) return i;
            const updated = { ...i, order };
            changed.push(updated);
            return updated;
          }),
        ));

        changed.forEach((t) =>
          dbUpdateItem(t.id, 'task', { order: t.order }).catch(console.error)
        );
      },

      /**
       * Bulk delete for multi-select. Accepts a mixed selection of any kind
       * (habits + task-like), cascades task-like subtasks the way deleteTask
       * does, and does exactly ONE set() so the whole gesture is a single undo.
       * Ids are unique across the items table, so id-only membership is safe.
       */
      deleteItems: (ids) => {
        const idSet = new Set(ids);
        const targets = get().items.filter((i) => idSet.has(i.id));
        if (targets.length === 0) return;

        // Subtasks of any deleted task-like parent (habits carry none). Soft
        // delete doesn't fire the DB's ON DELETE SET NULL, so an orphaned
        // subtask would be unreachable — cascade explicitly, as deleteTask does.
        const deletedTaskLike = new Set(
          targets.filter((i) => i.type !== 'habit').map((i) => i.id)
        );
        const children = get().items.filter(
          (i) =>
            i.type !== 'habit' &&
            i.parentItemId != null &&
            deletedTaskLike.has(i.parentItemId) &&
            !idSet.has(i.id)
        );

        setNextActionLabel(`Delete items (${targets.length})`);

        const removeIds = new Set<string>([...idSet, ...children.map((c) => c.id)]);
        set((state) => projectItems(state.items.filter((i) => !removeIds.has(i.id))));

        [...targets, ...children].forEach((item) =>
          dbDeleteItem(item.id, dbTypeOf(item)).catch(console.error)
        );
      },

      /**
       * Bulk completion for multi-select. Marks every eligible id complete (or
       * incomplete) for `date`, routed per kind:
       *   - habit               → per-date completedDates + optimistic streak
       *                           (the RPC owns streak server-side, as in
       *                           toggleHabitStatus)
       *   - recurring task-like → per-date completedDates (never scalar status)
       *   - one-off task-like   → scalar status
       * Items already in the target state are skipped, so a re-complete never
       * double-counts a streak. One set() ⇒ one undo.
       */
      setItemsCompleted: (ids, completed, date) => {
        const idSet = new Set(ids);
        const dateStr = resolveDateStr(date);
        const targets = get().items.filter((i) => idSet.has(i.id));
        if (targets.length === 0) return;

        const patchById = new Map<string, Record<string, unknown>>();
        const dbWrites: (() => void)[] = [];

        for (const item of targets) {
          if (item.type === 'habit') {
            const habit = item as HabitItem;
            const wasCompleted = habit.completedDates.includes(dateStr);
            if (wasCompleted === completed) continue;
            // Completing also clears a skip for the day (mirrors toggleHabitStatus).
            const newSkippedDates = completed
              ? (habit.skippedDates ?? []).filter((d) => d !== dateStr)
              : habit.skippedDates ?? [];
            const newStatus = completed ? 'done' : 'pending';
            patchById.set(item.id, {
              status: newStatus,
              completedDates: completed
                ? [...habit.completedDates, dateStr]
                : habit.completedDates.filter((d) => d !== dateStr),
              skippedDates: newSkippedDates,
              streak: completed ? habit.streak + 1 : Math.max(0, habit.streak - 1),
            });
            const clearsSkip = completed && (habit.skippedDates ?? []).includes(dateStr);
            dbWrites.push(() => {
              // Streak + completedDates are server-owned on the completion RPC,
              // which never touches skipped_dates — so the skip-clear needs its
              // own write or it reappears on reload. That write is a per-date
              // intent (029), never the recomputed array: only `dateStr` moved.
              dbSetItemCompletion(item.id, 'habit', dateStr, completed).catch(console.error);
              if (clearsSkip) {
                dbSetItemSkip(item.id, 'habit', dateStr, false).catch(console.error);
              }
              dbUpdateItem(item.id, 'habit', { status: newStatus }).catch(console.error);
            });
          } else {
            const task = item as TaskItem;
            const dbType = dbTypeOf(item);
            if (isRecurring(task)) {
              if (isCompletedOnDate(task, dateStr) === completed) continue;
              patchById.set(item.id, {
                completedDates: completed
                  ? [...(task.completedDates ?? []), dateStr]
                  : (task.completedDates ?? []).filter((d) => d !== dateStr),
              });
              dbWrites.push(() =>
                dbSetItemCompletion(item.id, dbType, dateStr, completed).catch(console.error)
              );
            } else {
              const newStatus: TaskStatus = completed ? 'completed' : 'pending';
              if (task.status === newStatus) continue;
              patchById.set(item.id, { status: newStatus });
              dbWrites.push(() =>
                dbUpdateItem(item.id, dbType, { status: newStatus }).catch(console.error)
              );
            }
          }
        }

        if (patchById.size === 0) return;
        setNextActionLabel(`${completed ? 'Complete' : 'Uncomplete'} items (${patchById.size})`);

        set((state) =>
          projectItems(
            state.items.map((i) => {
              const patch = patchById.get(i.id);
              return patch ? ({ ...i, ...patch } as Item) : i;
            })
          )
        );

        dbWrites.forEach((w) => w());
      },

      /**
       * Collect a selection into a routine or program, or release it.
       *
       * The membership half of the bulk verbs, and the reason it is one action
       * rather than N calls to updateRoutine: each of those would push its own
       * history entry, so undoing "add twelve items to Summer" would take twelve
       * Cmd+Z. One set(), one entry, same contract the other bulk verbs hold.
       *
       * Both directions have a consequence the user must be told about, and they
       * are opposites:
       *  · ADDING to a container that is currently off hides the items on the
       *    spot. Allowed — that is what collecting into a paused program means —
       *    but never silently, so it carries decision 11's receipt.
       *  · REMOVING from a container that was hiding them makes them visible
       *    again, possibly weeks overdue, so it needs the sweep's release grace
       *    exactly as removeRoutine and updateRoutine do.
       */
      setItemsCollected: (ids, kind, containerId, member) => {
        const userId = get().userId;
        const idSet = new Set(ids);
        // Registry, not a type check: the subtask rule lives in isCollectible,
        // and a second copy here would drift the first time a capability moves.
        const eligible = get()
          .items.filter((i) => idSet.has(i.id) && isCollectible(i))
          .map((i) => i.id);
        if (eligible.length === 0) return;

        const list = kind === 'routine' ? get().routines : get().programs;
        const container = list.find((c) => c.id === containerId);
        if (!container) return;

        const eligibleSet = new Set(eligible);
        const nextIds = member
          ? [...container.itemIds, ...eligible.filter((id) => !container.itemIds.includes(id))]
          : container.itemIds.filter((id) => !eligibleSet.has(id));
        // Nothing to do — every item was already in the requested state. Bail
        // before the label, or an undo entry appears for a write that never was.
        if (nextIds.length === container.itemIds.length) return;

        const changed = Math.abs(nextIds.length - container.itemIds.length);
        const withNext = <T extends { id: string; itemIds: string[] }>(cs: T[]) =>
          cs.map((c) => (c.id === containerId ? { ...c, itemIds: nextIds } : c));
        const nextRoutines = kind === 'routine' ? withNext(get().routines) : get().routines;
        const nextPrograms = kind === 'program' ? withNext(get().programs) : get().programs;

        // Resolved against the PROSPECTIVE containers, not the current ones.
        // Every other caller of landingReceipt moves an item's date while the
        // containers hold still, so asking before the write is the same answer;
        // here it is the containers that move, and asking before would report
        // the world the user is leaving. Cheaper and simpler than writing first
        // and re-labelling, which would need the label read back out.
        const receipt = member
          ? landingReceipt(
              {
                items: get().items,
                routines: nextRoutines,
                programs: nextPrograms,
                userTimezone: get().userTimezone,
              },
              eligible,
            )
          : undefined;

        setNextActionLabel(
          member
            ? `Add to ${container.name}: ${changed} ${changed === 1 ? 'item' : 'items'}`
            : `Remove from ${container.name}: ${changed} ${changed === 1 ? 'item' : 'items'}`,
          receipt,
        );

        withReleaseGrace(() =>
          set(kind === 'routine' ? { routines: nextRoutines } : { programs: nextPrograms }),
        );

        if (userId) {
          const write =
            kind === 'routine'
              ? dbUpdateRoutine(userId, containerId, { itemIds: nextIds })
              : dbUpdateProgram(userId, containerId, { itemIds: nextIds });
          write.catch(console.error);
        }
      },

      /**
       * The bulk PROPERTY edits (the bar's Edit menu). One shape for all four:
       * eligible subset from lib/bulk-edit.ts → drop the items already there →
       * label → ONE set() → one DB write per changed item with its own slug.
       *
       * Filtering the no-ops is not tidiness. The count in the label is what the
       * undo strip reads out, and "Set priority: High · 5 items" over a selection
       * where three were already High would claim writes that never happened —
       * and a request that changes nothing must push no history entry at all.
       */
      setItemsPriority: (ids, priority) => {
        const idSet = new Set(ids);
        const targets = get().items.filter(
          (i) =>
            idSet.has(i.id) &&
            canBulkSetPriority(i) &&
            (i as { priority?: Priority }).priority !== priority
        );
        if (targets.length === 0) return;

        setNextActionLabel(
          priority
            ? `Set priority: ${PRIORITY_LABELS[priority]} · ${itemCount(targets.length)}`
            : `Clear priority · ${itemCount(targets.length)}`
        );
        // Key present with `undefined` on a clear: the spread must erase the
        // field locally, and taskUpdatesToRow turns it into a null.
        const patch = { priority };
        const targetIds = new Set(targets.map((i) => i.id));
        set((state) =>
          projectItems(
            state.items.map((i) => (targetIds.has(i.id) ? ({ ...i, ...patch } as Item) : i))
          )
        );
        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), patch).catch(console.error)
        );
      },

      /**
       * Re-file a selection. The id follows the name exactly as in
       * updateTask/updateHabit — resolved ONCE here, since every item is going
       * to the same place.
       *
       * An item sitting in its old project's time block has to come out of it.
       * `inProjectBlock` parks it inside the block with its own time stashed in
       * previousStartTime/Date (moveTasksToProjectBlock), and the block it is
       * parked in is the one it no longer belongs to — left alone, it would
       * render in no block at all and vanish from the day. So the release is
       * moveTaskOutOfProjectBlock's, folded into the same patch.
       */
      setItemsProject: (ids, name) => {
        const idSet = new Set(ids);
        const projectId = projectIdFor(name, get().projects);
        const patchById = new Map<string, Partial<Task>>();
        for (const item of get().items) {
          if (!idSet.has(item.id)) continue;
          if (name ? !canBulkSetProject(item) : !canBulkClearProject(item)) continue;
          const current = item.project;
          const sameName = name
            ? current != null && sameContainerName('project', current, name)
            : current == null;
          // Name AND id: a folded match whose id is stale (or missing, from
          // before 027) is still worth the write — it repairs the link.
          if (sameName && item.projectId === projectId) continue;

          const patch: Partial<Task> = { project: name, projectId };
          const parked = item as Partial<TaskItem>;
          if (parked.inProjectBlock && !sameName) {
            patch.inProjectBlock = false;
            patch.startTime = parked.previousStartTime;
            patch.startDate = parked.previousStartDate;
            patch.previousStartTime = undefined;
            patch.previousStartDate = undefined;
          }
          patchById.set(item.id, patch);
        }
        if (patchById.size === 0) return;

        setNextActionLabel(
          name
            ? `Set project: ${name} · ${itemCount(patchById.size)}`
            : `Clear project · ${itemCount(patchById.size)}`
        );
        const targets = get().items.filter((i) => patchById.has(i.id));
        set((state) =>
          projectItems(
            state.items.map((i) => {
              const patch = patchById.get(i.id);
              return patch ? ({ ...i, ...patch } as Item) : i;
            })
          )
        );
        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), patchById.get(item.id)!).catch(console.error)
        );
      },

      /**
       * One cue time across a selection. SETTING writes `reminderTime` alone,
       * so each item keeps the anchor phrase it was given — "after I pour my
       * coffee" is about that item, not about the hour. CLEARING writes both
       * halves, the dialog's "No reminder": an anchor with no time is a sentence
       * the scan will never say.
       *
       * Nothing else rides along. The dedupe stamp (reminder_sent_key) carries
       * the time it was sent for, so a retime re-arms by itself — see the
       * reminder note in lib/db.ts's allowlists.
       */
      setItemsReminder: (ids, time) => {
        const idSet = new Set(ids);
        const targets = get().items.filter(
          (i) =>
            idSet.has(i.id) &&
            canBulkSetReminder(i) &&
            (time ? i.reminderTime !== time : !!(i.reminderTime || i.reminderAnchor))
        );
        if (targets.length === 0) return;

        setNextActionLabel(
          time
            ? `Set reminder: ${time} · ${itemCount(targets.length)}`
            : `Clear reminder · ${itemCount(targets.length)}`
        );
        const patch: Partial<Task> = time
          ? { reminderTime: time }
          : { reminderTime: undefined, reminderAnchor: undefined };
        const targetIds = new Set(targets.map((i) => i.id));
        set((state) =>
          projectItems(
            state.items.map((i) => (targetIds.has(i.id) ? ({ ...i, ...patch } as Item) : i))
          )
        );
        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), patch).catch(console.error)
        );
      },

      /**
       * setItemsCollected for the third container role, with the role arrays
       * the goal carries.
       *
       * ADDING grants the plain `member` role only, and skips anything the goal
       * already holds in ANY role — the arrays are disjoint (goal_items' PK), so
       * appending a milestone to memberIds too would be the two-roles write
       * updateGoal refuses. Milestone and check-in are the goal's own decisions,
       * made where its timeline is visible; the item dialog's chip holds the same
       * line.
       *
       * REMOVING strips all three arrays, like the dialog's toggleGoal: taking
       * a milestone "out of the goal" must take it out, not quietly leave it
       * counting behind a list the user cannot see.
       *
       * No release grace and no receipt: a goal suppresses nothing (see
       * updateGoal), so no membership change here moves an item on the canvas.
       */
      setItemsGoal: (ids, goalId, member) => {
        const userId = get().userId;
        const goal = get().goals.find((g) => g.id === goalId);
        if (!goal) return;
        const idSet = new Set(ids);
        const eligible = get()
          .items.filter((i) => idSet.has(i.id) && canBulkCollect(i))
          .map((i) => i.id);
        if (eligible.length === 0) return;

        let patch: Pick<Goal, 'memberIds'> | Pick<Goal, 'memberIds' | 'milestoneIds' | 'checkinIds'>;
        let changed: number;
        if (member) {
          const held = new Set(goalItemIds(goal));
          const adding = eligible.filter((id) => !held.has(id));
          changed = adding.length;
          patch = { memberIds: [...goal.memberIds, ...adding] };
        } else {
          const strip = new Set(eligible);
          const without = (xs: string[]) => xs.filter((x) => !strip.has(x));
          const next = {
            memberIds: without(goal.memberIds),
            milestoneIds: without(goal.milestoneIds),
            checkinIds: without(goal.checkinIds),
          };
          changed =
            goal.memberIds.length - next.memberIds.length +
            goal.milestoneIds.length - next.milestoneIds.length +
            goal.checkinIds.length - next.checkinIds.length;
          patch = next;
        }
        // Already satisfied — bail before the label, as setItemsCollected does.
        if (changed === 0) return;

        setNextActionLabel(
          member
            ? `Add to ${goal.name}: ${itemCount(changed)}`
            : `Remove from ${goal.name}: ${itemCount(changed)}`
        );
        set({ goals: get().goals.map((g) => (g.id === goalId ? { ...g, ...patch } : g)) });
        if (userId) dbUpdateGoal(userId, goalId, patch).catch(console.error);
      },

      /**
       * Bulk bucket assignment for a group drag. Mirrors assignTaskToBucket
       * (untimed) for task-likes and assignHabitToBucket for habits, in one
       * set() ⇒ one undo. A group dropped on a timed slot degrades to the slot's
       * bucket, untimed — N items can't share one clock time coherently.
       */
      assignItemsToBucket: (ids, bucket) => {
        const idSet = new Set(ids);
        const targets = get().items.filter((i) => idSet.has(i.id));
        if (targets.length === 0) return;
        setNextActionLabel(`Move ${targets.length} items to ${bucket}`);

        const taskUpdates: Partial<Task> = {
          isScheduled: false,
          timeBucket: bucket,
          startTime: undefined,
          inProjectBlock: false,
          previousStartTime: undefined,
          previousStartDate: undefined,
        };
        const habitUpdates: Partial<HabitItem> = { timeBucket: bucket, startTime: undefined };

        set((state) =>
          projectItems(
            state.items.map((i) =>
              idSet.has(i.id)
                ? ({ ...i, ...(i.type === 'habit' ? habitUpdates : taskUpdates) } as Item)
                : i
            )
          )
        );

        targets.forEach((item) =>
          dbUpdateItem(
            item.id,
            dbTypeOf(item),
            item.type === 'habit' ? habitUpdates : taskUpdates
          ).catch(console.error)
        );
      },

      scheduleItemsAt: (ids, bucket, time, dateStr) => {
        const idSet = new Set(ids);
        const targets = get().items.filter((i) => idSet.has(i.id));
        if (targets.length === 0) return;
        const corrected = autoCorrectBucket(time, bucket) ?? bucket;
        // 'Schedule items' — plural — is its own SIGNIFICANT_ACTIONS prefix in
        // hooks/use-undo-toast.ts. The old label matched none of them, so a
        // group drag onto the grid produced no toast at ALL: no undo affordance
        // and, once decision 11 arrived, nowhere for the receipt to appear.
        // MILESTONES KEEP THEIR TARGET DATE, for the reason moveTasksToDate
        // states at length — but only the DATE is withheld, not the whole drop.
        // This verb carries time and bucket too, and refusing outright would
        // silently discard a drag the user plainly meant. So a milestone dropped
        // on an hour cell gets the hour and keeps its deadline.
        //
        // Without this the two halves of the SAME drop handler disagreed: an
        // untimed week column went through moveTasksToDate and preserved the
        // target date, while an hour cell one column over rewrote it.
        const milestones = milestoneItemIds(get().goals);
        const datedIds = targets
          .filter((i) => i.type !== 'habit' && !milestones.has(i.id))
          .map((i) => i.id);
        setNextActionLabel(
          `Schedule items: ${targets.length} items`,
          // Only the items that actually take the date belong in a receipt that
          // says where things landed.
          landingReceipt(get(), datedIds, dateStr)
        );

        // All land at the same clock time; the grid's overlap layout tiles them.
        const baseTaskUpdates: Partial<Task> = {
          isScheduled: true,
          timeBucket: corrected,
          startTime: time,
          inProjectBlock: false,
          previousStartTime: undefined,
          previousStartDate: undefined,
        };
        const habitUpdates: Partial<HabitItem> = { timeBucket: corrected, startTime: time };
        // ONE resolver for the optimistic set() and the DB write, deliberately:
        // Phase 1's unscheduleTasks bug was exactly two lists that had been
        // interchangeable until a milestone rule made them differ.
        const updatesFor = (item: Item): Partial<Task> | Partial<HabitItem> =>
          item.type === 'habit'
            ? habitUpdates
            : dateStr && !milestones.has(item.id)
              ? { ...baseTaskUpdates, startDate: dateStr }
              : baseTaskUpdates;

        set((state) =>
          projectItems(
            state.items.map((i) =>
              idSet.has(i.id) ? ({ ...i, ...updatesFor(i) } as Item) : i
            )
          )
        );

        targets.forEach((item) =>
          dbUpdateItem(item.id, dbTypeOf(item), updatesFor(item)).catch(console.error)
        );
      },

      setItemSkipped: (id, skipped, date) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        const config = getItemTypeConfig(itemTypeName(item));
        // Capability + recurrence, never `type === 'habit'`. A one-shot item
        // has no occurrence to skip, so this is a no-op rather than a write
        // that no surface would ever read back.
        if (!isSkippable(item)) return;

        // Types whose status vocabulary carries a skip value (habits) keep
        // going through the status toggle: it owns the interaction between a
        // skip, the day's completion and the server-side streak, and that
        // behavior is deliberately untouched here.
        if (config.skipStatus) {
          get().toggleHabitStatus(id, (skipped ? config.skipStatus : 'pending') as HabitStatus, undefined, date);
          return;
        }

        const dateStr = resolveDateStr(date);
        const current = item.skippedDates ?? [];
        if (current.includes(dateStr) === skipped) return;
        setNextActionLabel(
          `${skipped ? 'Skip' : 'Unskip'} ${config.label.toLowerCase()} on ${dateStr}: ${item.title}`,
        );

        const optimistic: Partial<Task> = {
          skippedDates: skipped ? [...current, dateStr] : current.filter((d) => d !== dateStr),
        };
        // A skipped occurrence is not a completed one — same exclusivity the
        // habit path enforces. Completion belongs to the atomic RPC, so it is
        // applied optimistically here and written there, never as an absolute
        // array through the update allowlist.
        const clearCompletion = skipped && isCompletedOnDate(item, dateStr);
        if (clearCompletion) {
          optimistic.completedDates = (item.completedDates ?? []).filter((d) => d !== dateStr);
        }

        set((state) => projectItems(
          state.items.map((i) => (i.id === id && i.type === item.type ? { ...i, ...optimistic } as Item : i)),
        ));

        if (clearCompletion) {
          dbSetItemCompletion(id, dbTypeOf(item), dateStr, false).catch(console.error);
        }
        // Per-date intent, not the whole array: this path knows the one date
        // that moved, so it says so. Writing `optimistic.skippedDates` whole
        // would make this client's copy the new server truth.
        dbSetItemSkip(id, dbTypeOf(item), dateStr, skipped).catch(console.error);
      },

      /**
       * Pause or resume ONE item.
       *
       * Writes nothing but the two pause columns — never status, streak,
       * completedDates, skippedDates, startDate, repeat* or timeBucket. That
       * restraint is the feature: because a streak only ever moves inside the
       * completion RPC and nothing in the app decays one on a missed day,
       * "pause without losing your streak" needs no streak handling at all, and
       * resume finds the item exactly where it was (an item with no timeBucket
       * is invisible in day views, so a pause that touched it would strand it).
       *
       * A resume sets `pausedUntil` to today rather than clearing the pair, so
       * the interval stays readable on the row — the auto-age sweep's resume
       * grace is computed from it, and clearing would make a returning user's
       * whole backlog sweepable the next morning.
       */
      setItemPaused: (id, paused, until) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        if (!isPausable(item)) return;
        const config = getItemTypeConfig(itemTypeName(item));

        // TODAY, deliberately — NOT resolveDateStr(), which resolves the
        // navigable selectedDate. Pausing is not a per-date verb the way
        // completing or skipping is (plan decision 3: dateless surfaces resolve
        // at today), so browsing next week and hitting Pause must not write a
        // resume date from the day you happen to be looking at. Both values
        // come off one instant so they cannot straddle midnight.
        const tz = get().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const now = new Date();
        const todayStr = toDateStr(now, tz);
        if (isPausedOn(item, todayStr, tz) === paused) return;

        const updates: Partial<Task> = paused
          ? { pausedAt: now.toISOString(), pausedUntil: until }
          : { pausedUntil: todayStr };

        setNextActionLabel(
          paused
            ? `Pause ${config.label.toLowerCase()}: ${item.title}`
            : `Resume ${config.label.toLowerCase()}: ${item.title}`,
        );

        set((state) => projectItems(
          state.items.map((i) => (i.id === id ? { ...i, ...updates } as Item : i)),
        ));
        dbUpdateItem(id, dbTypeOf(item), updates).catch(console.error);
      },

      addHabit: (habitData, memberships) => {
        const timeBucket = autoCorrectBucket(habitData.startTime, habitData.timeBucket);

        const habit: HabitItem = {
          ...habitData,
          type: 'habit',
          timeBucket,
          id: crypto.randomUUID(),
          streak: 0,
          status: 'pending',
          completedDates: [],
          skippedDates: [],
          dailyCounts: {},
          currentDayCount: 0,
          projectId: projectIdFor(habitData.project, get().projects),
        };
        // No date argument: habits are date-blind, so the receipt resolves at
        // today — the same answer assignHabitToBucket takes, for the same
        // reason (decision 3).
        setNextActionLabel(
          `Add habit: ${habitData.title}`,
          newMemberReceipt(get(), habit, memberships),
        );
        set((state) => ({
          ...projectItems([...state.items, habit]),
          routines: withMembership(state.routines, habit.id, memberships?.routineIds),
          goals: withGoalMembership(state.goals, habit.id, memberships?.goalIds, memberships?.goalRole),
          programs: withMembership(state.programs, habit.id, memberships?.programIds),
        }));

        const userId = get().userId;
        if (userId) persistNewItem(userId, habit, memberships, get);
      },

      updateHabit: (id, updates) => {
        const habit = findItem(id, 'habit');
        setNextActionLabel(`Edit habit: ${habit?.title || 'Unknown'}`);

        const newUpdates = { ...updates };
        // Auto-correct bucket if start time changes
        if (updates.startTime && habit) {
          const bucket = updates.timeBucket || habit.timeBucket;
          const corrected = autoCorrectBucket(updates.startTime, bucket);
          if (corrected !== bucket) newUpdates.timeBucket = corrected;
        }
        // See updateTask — the id follows the name on every re-file.
        if ('project' in updates) {
          newUpdates.projectId = projectIdFor(updates.project, get().projects);
        }

        updateItemAction(id, 'habit', newUpdates);
      },

      deleteHabit: (id) => {
        const habit = findItem(id, 'habit');
        setNextActionLabel(`Delete habit: ${habit?.title || 'Unknown'}`);
        if (!habit) return;
        set((state) => projectItems(state.items.filter((i) => !(i.id === id && i.type === 'habit'))));

        dbDeleteItem(id, 'habit').catch(console.error);
      },

      toggleHabitStatus: (id, status, count, date) => {
        const habit = findItem(id, 'habit') as HabitItem | undefined;
        if (!habit) return;
        const statusLabel = status === 'done' ? 'Complete' : status === 'skipped' ? 'Skip' : 'Reset';
        setNextActionLabel(`${statusLabel} habit: ${habit.title}`);
        const dateStr = resolveDateStr(date);

        const wasCompleted = habit.completedDates.includes(dateStr);
        const wasSkipped = (habit.skippedDates ?? []).includes(dateStr);
        let newCompletedDates = [...habit.completedDates];
        let newSkippedDates = [...(habit.skippedDates ?? [])];
        const newDailyCounts = { ...(habit.dailyCounts ?? {}) };
        let newStreak = habit.streak;

        // Completion goes through the intent-based atomic RPC: it sets the
        // desired end state for the date and owns the streak transition
        // server-side (streak moves only if the array actually changes), so
        // streak and completion history can't desync under partial failure,
        // stale clients, or rapid double-toggles. The optimistic values below
        // are UI-only; the companion update deliberately excludes
        // completedDates AND streak.
        if (status === 'done' && !wasCompleted) {
          newCompletedDates.push(dateStr);
          newStreak += 1;
        } else if (status !== 'done' && wasCompleted) {
          newCompletedDates = newCompletedDates.filter((d) => d !== dateStr);
          newStreak = Math.max(0, newStreak - 1);
        }

        if (status === 'skipped' && !wasSkipped) {
          newSkippedDates.push(dateStr);
        } else if (status !== 'skipped' && wasSkipped) {
          newSkippedDates = newSkippedDates.filter((d) => d !== dateStr);
        }

        if (count !== undefined) {
          newDailyCounts[dateStr] = count;
        }

        const optimistic: Partial<HabitItem> = {
          status,
          completedDates: newCompletedDates,
          skippedDates: newSkippedDates,
          dailyCounts: newDailyCounts,
          currentDayCount: count !== undefined ? count : habit.currentDayCount || 0,
          streak: newStreak,
        };

        set((state) => projectItems(
          state.items.map((i) => (i.id === id && i.type === 'habit' ? { ...i, ...optimistic } as Item : i)),
        ));

        dbSetItemCompletion(id, 'habit', dateStr, status === 'done').catch(console.error);
        // skippedDates joins completedDates and streak in the exclusion list:
        // all three are per-date/server-owned state that the companion update
        // must not clobber with this client's recomputed copy. The skip moves
        // through its own intent RPC, and only when it actually changed.
        const { completedDates: _cd, streak: _st, skippedDates: _sd, ...rest } = optimistic;
        if (wasSkipped !== (status === 'skipped')) {
          dbSetItemSkip(id, 'habit', dateStr, status === 'skipped').catch(console.error);
        }
        dbUpdateItem(id, 'habit', rest).catch(console.error);
        if (status === 'done' && !wasCompleted) {
          celebrate();
          // Habits can serve as check-ins too — `isCheckinEligible` asks only
          // that the item recurs — so the bridge belongs on both completion
          // verbs, not just the task one.
          offerCheckin(habit, dateStr);
        }
      },

      scheduleHabit: (id, bucket, time) => {
        const habit = findItem(id, 'habit');
        setNextActionLabel(`Schedule habit: ${habit?.title || 'Unknown'}`);
        const finalBucket = autoCorrectBucket(time, bucket) ?? bucket;
        updateItemAction(id, 'habit', { timeBucket: finalBucket, startTime: time });
      },

      assignHabitToBucket: (id, bucket) => {
        const habit = findItem(id, 'habit');
        // Habits are date-blind, so the receipt resolves at today — which is
        // what a dateless surface must use anyway (decision 3).
        setNextActionLabel(
          `Move habit to ${bucket}: ${habit?.title || 'Unknown'}`,
          landingReceipt(get(), [id])
        );
        updateItemAction(id, 'habit', { timeBucket: bucket, startTime: undefined });
      },

      resetHabitStreak: (id) => {
        const habit = findItem(id, 'habit');
        setNextActionLabel(`Reset streak: ${habit?.title || 'Unknown'}`);
        // Streak counter only — completedDates/dailyCounts are completion
        // history on unified items and must survive a streak reset. The
        // confirm dialog copy in item-dialog matches this wording.
        updateItemAction(id, 'habit', { streak: 0 });
      },

      setSelectedDate: (date) => set({ selectedDate: date }),
      setViewMode: (viewMode) => {
        set({ viewMode, defaultView: viewMode });
        const userId = get().userId;
        if (userId) saveSettings(userId, { default_view: viewMode });
      },
      setGroupBy: (groupBy) => set({ groupBy }),
      setFilters: (filters) => set({ filters }),
      clearFilters: () => set({ filters: {} }),
      setTimelineItemFilter: (timelineItemFilter) => set({ timelineItemFilter }),

      addProject: (name, emoji, extra) => {
        // The label goes AFTER the guard. Armed before it, a no-op create
        // leaves `Add project: Foo` pending on a module-level variable and the
        // user's next unlabelled mutation is logged and undone under that name.
        const alreadyExists = get().projects.some((p) => sameContainerName('project', p.name, name));
        if (alreadyExists) return null;
        setNextActionLabel(`Add project: ${name}`);

        const project: Project = { ...extra, id: crypto.randomUUID(), name, emoji };
        set((state) => ({ projects: [...state.projects, project] }));
        const entryId = lastHistoryEntryId();

        const userId = get().userId;
        if (userId) {
          dbCreateProject(userId, project).catch((error) => {
            undoFailedCreate(error, entryId, project.id, name);
          });
        }
        return project.id;
      },

      /**
       * The first-run starter set, and the repair that shares its shape.
       *
       * ONE `set()` AND ONE HISTORY ENTRY, not six. Six `addProject` calls would
       * work and would be wrong: the history popover would open on a brand-new
       * account already listing six actions the user did not perform, and their
       * first ⌘Z would delete one starter container while leaving five. This is
       * a single arrival, so it undoes as one.
       *
       * GUARDS, ALL FOUR. `userId` because a create without one writes nothing
       * and leaves an optimistic row that vanishes on reload. `isLoading`
       * because `initializeStore` REPLACES `projects` and `items`
       * wholesale when its fetch resolves — anything seeded inside that window
       * is silently discarded, which is the same trap `canCreate` guards in the
       * console and the one the e2e suite found the hard way. `loadFailedUserId`
       * because the emptiness check below is only evidence when a load filled
       * the arrays: after a failed one they are empty because nothing arrived,
       * not because the account has no containers, so a plan made before the
       * failure would commit on no evidence at all. And the container arrays
       * being empty, re-checked HERE rather than trusted from the plan: the
       * plan was computed before two awaits (the latch read and the bin read),
       * and a fetch resolving in between is exactly how an account with
       * containers gets a second set of them.
       *
       * ADOPTION IS PART OF THE SAME `set()`. When a container is created for a
       * name its items already carry, those items get the new id in the same
       * commit — otherwise the store holds members whose `groupId` is undefined
       * while the database has just linked them, and the next edit writes the
       * stale shape back.
       */
      seedStarterContainers: (plan, forUserId) => {
        const state = get();
        const userId = state.userId;
        // THE OWNER CHECK, and it is not redundant with the caller's. The plan
        // is computed across two more awaits after the caller looked, and
        // Supabase delivers a bare SIGNED_IN for a different user with no
        // intervening SIGNED_OUT — the provider handles that case in two other
        // places. Without this, one account's plan was committed into another
        // account's store, and with adoption in the mix that meant creating a
        // container named after someone else's data.
        if (!userId || userId !== forUserId || state.isLoading) return 'refused';
        if (state.loadFailedUserId === userId) return 'refused';
        if (state.projects.length > 0) return 'refused';
        // Distinguished from a refusal on purpose: this is a stable answer, and
        // the caller latches on it so the account stops being asked. A refusal
        // is "ask again next load".
        if (plan.projects.length === 0) return 'nothing-to-do';

        const projects: Project[] = plan.projects.map((p) => ({
          id: crypto.randomUUID(),
          name: p.name,
          emoji: p.emoji,
        }));

        const projectByName = new Map(projects.map((p) => [p.name, p]));

        /**
         * NO HISTORY ENTRY, and this is a change of mind the review earned.
         *
         * The plan asked for the seed to be "undoable like anything else", and
         * the first version obliged with one entry. Two consequences neither of
         * us had costed: a brand-new account arrives with `canUndo: true` and a
         * logged action its owner did not perform, and pressing ⌘Z — the very
         * first thing many people try — SOFT-DELETES all six rows, which puts
         * six containers the user never made into a Trash they have never opened
         * and reserves all six names for thirty days, because the unique indexes
         * have no `WHERE deleted_at IS NULL`.
         *
         * Decision 2 asks for "fully deletable", and they are: every one goes
         * through the console's ordinary delete. It does not ask for undoable,
         * and a seed is not a user action — the same reasoning `undoFailedCreate`
         * already applies to itself two hundred lines up.
         *
         * Suppressed the way the rollback suppresses: save and restore the flag
         * rather than clearing it, because `initializeStore` holds it true
         * across its whole fetch and a hard `false` here would hand it back
         * unblocked mid-load.
         */
        const wasSuppressed = isUpdatingUndoRedo;
        isUpdatingUndoRedo = true;
        try {
          set((s) => ({
            projects: [...s.projects, ...projects],
            ...projectItems(
              s.items.map((item) => {
                // Matched on the EXACT stored text, never a trimmed copy. The
                // adopting UPDATE filters on the name it is given, so a store
                // that links " Personal" while the database matches "Personal"
                // produces a link that looks right until the next reload drops
                // it. planSeed keeps names exact for the same reason.
                const p = item.project ? projectByName.get(item.project) : undefined;
                return p && !item.projectId ? { ...item, projectId: p.id } : item;
              })
            ),
          }));
          /**
           * BOTH BASELINES, and the second one is not optional — the first
           * version updated only `prevStateJson` and undo walked straight past
           * the seed.
           *
           * `updatePrevStateBaseline` sets what the NEXT change is diffed
           * against. But history is a stack of whole snapshots, and the one at
           * `historyIndex` is still 'Session start' from before the seed. The
           * user's first real edit pushes a snapshot on top of that, so one ⌘Z
           * lands on the pre-seed state and takes the containers with it — the
           * suppression having made sure there was no entry in between to stop
           * at.
           *
           * Rewriting that snapshot in place is the honest fix rather than a
           * patch: the seed is part of what this session STARTED with, which is
           * exactly what 'Session start' is supposed to name. Length and index
           * are untouched, so it cannot break the invariant that `historyIndex`
           * names the state the store holds.
           */
          const s = get();
          const seeded = {
            items: s.items,
            projects: s.projects,
            routines: s.routines,
            programs: s.programs,
            goals: s.goals,
          };
          updatePrevStateBaseline(seeded);
          if (historyStack[historyIndex]) {
            historyStack[historyIndex] = JSON.parse(JSON.stringify(seeded));
          }
        } finally {
          isUpdatingUndoRedo = wasSuppressed;
        }

        // Sequential per container: the adopt UPDATE must not go out before the
        // INSERT it depends on, or `items_project_id_fkey` rejects it — the
        // composite key means a bad id takes the whole statement down.
        //
        // A REFUSED INSERT IS ROLLED BACK, exactly as a hand-made one is. Two
        // tabs opening a first run both read the latch as false and both plan
        // the same names; the second one's insert hits the unique index, and
        // without this the tab keeps six containers that do not exist — and the
        // first item filed into one is rejected by the composite FK and lost.
        for (const project of projects) {
          dbCreateProject(userId, project)
            .then(() => adoptContainerMembers(userId, project.id, project.name))
            .catch((error) => rollbackSeedContainer(error, project.id, project.name));
        }

        return 'committed';
      },

      updateProject: (id, updates) => {
        const project = get().projects.find((p) => p.id === id);
        setNextActionLabel(`Edit project: ${project?.name || 'Unknown'}`);
        // THE RENAME FAN-OUT (migration 027). Members hold the name for display
        // and the id for identity; renaming has to move the name on every one of
        // them or the container silently empties. Keyed on projectId, so a
        // member whose text drifted still follows and a same-named stranger does
        // not. Guarded on the name actually changing — an emoji or colour edit
        // arrives through this same action.
        const renamedTo =
          updates.name !== undefined && project && updates.name !== project.name
            ? updates.name
            : null;
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
          ...(renamedTo
            ? projectItems(
                // EVERY type follows the rename since 039 — one CLASSIFY axis
                // means a habit is an ordinary member of the container it names.
                state.items.map((i) =>
                  i.projectId === id ? { ...i, project: renamedTo } : i
                )
              )
            : {}),
        }));

        const userId = get().userId;
        if (userId) {
          // CHAINED, not fired side by side, and this is the safety net under
          // `takenBy`. That guard can only see LIVE projects — the store never
          // loads soft-deleted ones — while projects_user_id_name_key is a
          // plain unique index that spans them. So renaming onto a TRASHED
          // project's name passes the guard, and the two writes do not fail
          // together: the container UPDATE raises 23505 while the member
          // fan-out touches no unique index and succeeds. The container would
          // keep its old name while every member claimed the new one.
          //
          // Sequencing them turns that corruption into an ordinary optimistic
          // update that reverts on reload, which is the failure mode every
          // other write in this store already has. A better message needs the
          // trashed names, which arrive with the Trash in Phase 4.
          const write = dbUpdateProject(userId, id, updates);
          (renamedTo
            ? write.then(() => {
                // A ROUND TRIP HAS PASSED, so re-check before firing. Chaining
                // fixed the split write but moved this dispatch AFTER undo's:
                // undo restores the old name with plain per-item writes and no
                // fan-out of its own, so a ⌘Z landing inside this window used to
                // be overwritten here — the container reverted while every
                // member kept the name the user had just undone, and unlike an
                // ordinary optimistic write that state survives a reload.
                if (get().projects.find((p) => p.id === id)?.name !== renamedTo) return;
                return dbRenameContainerMembers(userId, id, renamedTo);
              })
            : write
          ).catch(console.error);
        }
      },

      removeProject: (id) => {
        const project = get().projects.find((p) => p.id === id);
        setNextActionLabel(`Delete project: ${project?.name || 'Unknown'}`);
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          ...projectItems(state.items.map((i) =>
            // EVERY type, since 039. This is the one live repair for the whole
            // CLASSIFY axis — cleanupOrphanedReferences below looks like a
            // safety net and is not; it has no callers anywhere in the app.
            //
            // In-session only, and that is pre-existing: dbDeleteProject stamps
            // projects.deleted_at while items.project is plain text with no FK
            // and no trigger, so a reload re-reads the dead name.
            // Name-referenced containers are the documented parked limitation
            // (migration 024).
            //
            // The DB row keeps BOTH halves on purpose — deleteProject only
            // stamps deleted_at, so the link survives for a Trash restore to
            // reconnect (Phase 4). That in-session/persisted asymmetry is
            // pre-existing and unchanged here.
            //
            // `project &&` guards the whole disjunction, not just the name half:
            // an id that is not in the store leaves `project` undefined, and
            // `i.projectId === project?.id` then reads `undefined === undefined`
            // and unfiles every item that never had an id — which is all of them
            // before 027's backfill reaches an account.
            //
            // Folded, and that half arrived with the collapse: `makeAddDraft`
            // writes a lowercase 'personal' against a seeded 'Personal' whenever
            // the container list has not loaded, so an exact comparison left
            // exactly those items pointing at a container that no longer exists.
            project &&
            (i.projectId === project.id ||
              (i.project && sameContainerName('project', i.project, project.name)))
              ? unfiled(i, state.projects, id)
              : i
          )),
        }));

        const userId = get().userId;
        if (userId) dbDeleteProject(userId, id).catch(console.error);
      },

      // These three, and every identity lookup below, ask the container registry
      // whether this kind folds rather than spelling a comparison — so the policy
      // has one home rather than being re-decided per call site.
      //
      // IT FOLDS (`CONTAINER_KINDS.project.caseFold`), and that is a change of
      // answer, not just of wording: before 039 collapsed the two CLASSIFY kinds
      // these were `===` in effect, and this comment said so. The merged kind
      // inherited the habit-group half's policy, because `makeAddDraft` writes a
      // lowercase 'personal' against a seeded 'Personal' whenever the container
      // list has not loaded.
      //
      // The consequence to know about: two LIVE container rows whose names fold
      // equal are indistinguishable here — `find` returns whichever comes first
      // in store order, and `removeProject` below would unfile BOTH rows'
      // members. Migration 039 refuses to run against an account in that state
      // rather than leaving it to be discovered; see its section 1b.
      getProjectEmoji: (name) => {
        const project = get().projects.find((p) => sameContainerName('project', p.name, name));
        return project?.emoji || '';
      },

      /**
       * Stored colour wins; then the three legacy theme tokens; then the
       * name-hash ramp.
       *
       * THE TOKEN MAP CAME OVER FROM `getHabitGroupColor` (039). It is
       * theme-aware (app/globals.css) and existed because Wellness / Work /
       * Personal were the shipped habit-group names — dropping it would restyle
       * those rows for every account that still has them. The cost of keeping it
       * on the merged axis is that a PROJECT named "work" now draws
       * `--habit-work` instead of its name-hash colour, which is a different
       * colour and not a different meaning. Stored colours pass through
       * untouched either way, so anything the user actually picked is unaffected.
       */
      getProjectColor: (name) => {
        const project = get().projects.find((p) => sameContainerName('project', p.name, name));
        if (project?.color) return project.color;
        const normalized = foldContainerName('project', name);
        const legacyToken: Record<string, string> = {
          wellness: 'var(--habit-wellness)',
          work: 'var(--habit-work)',
          personal: 'var(--habit-personal)',
        };
        return legacyToken[normalized] || accentColorForName(normalized);
      },

      getProject: (name) => {
        return get().projects.find((p) => sameContainerName('project', p.name, name));
      },

      // TASK-LIKE, not 'task'. These three used findItem(id, 'task') and wrote
      // dbUpdateItem(id, 'task', …) while every affordance that reaches them —
      // project-block's availableTasks, its move button, and the drag arming —
      // reads the `tasks` PROJECTION, which is `type !== 'habit'`. So a custom
      // item rendered a live "move to block" button and a live drop target, and
      // the verb returned state unchanged: no row moved, no DB write (db.ts
      // filters .eq('type', type), so 'task' matches zero rows for a custom
      // item), and the group path still reported success and cleared the
      // selection. Armed on the way in, dead on arrival.
      moveTaskToProjectBlock: (taskId) => {
        const moved = findTaskLike(taskId);
        setNextActionLabel(`Move task into project block: ${moved?.title || 'Unknown'}`);
        // resolveDateStr = toDateStr(selectedDate, userTimezone) — the user-tz
        // day the canvas is derived against, so a machine-tz off-by-one can't
        // file this into a project block on the wrong day.
        const selectedDateStr = resolveDateStr();
        let taskUpdates: Partial<Task> | null = null;
        let dbType = 'task';

        set((state) => {
          const task = state.items.find(
            (i) => i.id === taskId && i.type !== 'habit'
          ) as TaskItem | undefined;
          if (!task || !task.project) return state;
          dbType = dbTypeOf(task);

          const project = state.projects.find((p) =>
            sameContainerName('project', p.name, task.project!)
          );
          if (!project || !project.startTime || !project.timeBucket) return state;

          taskUpdates = {
            inProjectBlock: true,
            previousStartTime: task.startTime,
            previousStartDate: task.startDate,
            startTime: undefined,
            timeBucket: project.timeBucket,
            isScheduled: true,
            startDate: selectedDateStr,
          };

          return projectItems(state.items.map((i) =>
            i.id === taskId && i.type !== 'habit' ? { ...i, ...taskUpdates! } as Item : i
          ));
        });

        if (taskUpdates) dbUpdateItem(taskId, dbType, taskUpdates).catch(console.error);
      },

      moveTasksToProjectBlock: (taskIds) => {
        setNextActionLabel(`Move ${taskIds.length} tasks into project block`);
        // resolveDateStr = toDateStr(selectedDate, userTimezone) — the user-tz
        // day the canvas is derived against, so a machine-tz off-by-one can't
        // file this into a project block on the wrong day.
        const selectedDateStr = resolveDateStr();
        const updatesMap = new Map<string, Partial<Task>>();
        const dbTypes = new Map<string, string>();

        set((state) => {
          const firstTask = state.items.find(
            (i): i is TaskItem => i.type !== 'habit' && taskIds.includes(i.id)
          );
          if (!firstTask || !firstTask.project) return state;

          const project = state.projects.find((p) =>
            sameContainerName('project', p.name, firstTask.project!)
          );
          if (!project || !project.startTime || !project.timeBucket) return state;

          return projectItems(state.items.map((i) => {
            if (i.type === 'habit' || !taskIds.includes(i.id)) return i;
            dbTypes.set(i.id, dbTypeOf(i));
            const updates: Partial<Task> = {
              inProjectBlock: true,
              previousStartTime: i.startTime,
              previousStartDate: i.startDate,
              startTime: undefined,
              timeBucket: project.timeBucket,
              isScheduled: true,
              startDate: selectedDateStr,
            };
            updatesMap.set(i.id, updates);
            return { ...i, ...updates } as Item;
          }));
        });

        updatesMap.forEach((updates, id) =>
          dbUpdateItem(id, dbTypes.get(id) ?? 'task', updates).catch(console.error)
        );
      },

      moveTaskOutOfProjectBlock: (taskId) => {
        const moved = findTaskLike(taskId);
        setNextActionLabel(`Move task out of project block: ${moved?.title || 'Unknown'}`);
        let taskUpdates: Partial<Task> | null = null;
        let dbType = 'task';

        set((state) => {
          const task = state.items.find(
            (i) => i.id === taskId && i.type !== 'habit'
          ) as TaskItem | undefined;
          if (!task) return state;
          dbType = dbTypeOf(task);
          taskUpdates = {
            inProjectBlock: false,
            startTime: task.previousStartTime,
            startDate: task.previousStartDate,
            previousStartTime: undefined,
            previousStartDate: undefined,
          };
          return projectItems(state.items.map((i) =>
            i.id === taskId && i.type !== 'habit' ? { ...i, ...taskUpdates! } as Item : i
          ));
        });

        if (taskUpdates) dbUpdateItem(taskId, dbType, taskUpdates).catch(console.error);
      },

      // addHabitGroup / updateHabitGroup / removeHabitGroup lived here until
      // migration 039 collapsed the two CLASSIFY kinds. addProject,
      // updateProject and removeProject are the whole axis now — the
      // reassignment that made the group delete different is a registry
      // question (`containerRequired`), answered by `unfiled`.

      restoreFromTrash: (entry) => {
        const userId = get().userId;
        const state = get();

        /**
         * The next state, computed BEFORE anything is labelled.
         *
         * TRAP A — an armed label with no state change. setNextActionLabel
         * writes a module-level variable that only saveToHistory consumes, and
         * saveToHistory only runs when the subscriber sees the snapshot JSON
         * actually move. So labelling a restore that turns out to be a no-op
         * (the row is already back — a double-click, a stale bin) leaves
         * "Restore project: Work" armed, and the user's next unrelated edit is
         * logged, undone and receipted under that name. Returning early here,
         * before the label, is what makes that unreachable.
         */
        const next = (() => {
          switch (entry.kind) {
            case 'item': {
              const item = entry.entity as Item;
              if (state.items.some((i) => i.id === item.id)) return null;
              // The co-deleted subtasks land in the SAME projection rebuild —
              // db.restoreItem's cascade puts them back in the database, and a
              // parent that reappeared with an empty checklist until the next
              // reload would read as the subtasks having been lost.
              const back = [item, ...(entry.children ?? [])].filter(
                (i) => !state.items.some((existing) => existing.id === i.id)
              );
              if (back.length === 0) return null;
              return projectItems([...state.items, ...back]);
            }
            case 'project': {
              const project = entry.entity as Project;
              if (state.projects.some((p) => p.id === project.id)) return null;
              // Members re-file in the same set(). The link never left the
              // database — removeProject clears the store's copy and writes
              // nothing to items — so this is the store catching up with what a
              // reload would have shown anyway, not a new claim about the data.
              //
              // KNOWN LIMIT, and it is the price of doing this at all: ⌘Z after
              // a restore goes through applyHistoryState, whose per-item diff
              // sees {project: undefined, projectId: undefined} against the
              // pre-restore snapshot and writes both as NULL. So undoing a
              // restore does not merely re-bin the container — it also severs
              // the DB link the NEXT restore would have reconnected, and a
              // second trip through the Trash returns an empty container. The
              // gesture is rare (you have just deliberately restored the thing)
              // and the outcome still matches what the delete confirm promised
              // — "they just stop being filed under Work" — so it is accepted
              // rather than papered over. Fixing it properly means teaching the
              // history diff that a container's membership is the container's
              // to own, which is a change to undo, not to this action.
              const members = new Set(entry.memberIds ?? []);
              return {
                projects: [...state.projects, project],
                ...projectItems(
                  members.size === 0
                    ? state.items
                    : state.items.map((i) =>
                        // No type test: one CLASSIFY axis means a restored
                        // container re-files every kind of member it had.
                        members.has(i.id)
                          ? { ...i, project: project.name, projectId: project.id }
                          : i
                      )
                ),
              };
            }
            case 'routine': {
              const routine = entry.entity as Routine;
              if (state.routines.some((r) => r.id === routine.id)) return null;
              // itemIds arrive already hydrated from the join tables — see
              // listDeleted on why an empty array here would hard-delete the
              // very membership the soft delete preserved.
              return { routines: [...state.routines, routine] };
            }
            case 'program': {
              const program = entry.entity as Program;
              if (state.programs.some((p) => p.id === program.id)) return null;
              return { programs: [...state.programs, program] };
            }
            case 'goal': {
              const goal = entry.entity as Goal;
              if (state.goals.some((g) => g.id === goal.id)) return null;
              // All three role arrays arrive hydrated, WITH their roles — see
              // listDeleted. Restored from bare ids they would come back as
              // plain members, which is a silent change to the goal's progress
              // denominator that the visible gate (the row is back) cannot see.
              return { goals: [...state.goals, goal] };
            }
          }
        })();
        if (!next) return;

        setNextActionLabel(`Restore ${TRASH_NOUNS[entry.kind]}: ${entry.name}`);

        /**
         * TRAP B — exactly ONE set(). A second one produces a second history
         * entry that the label has already been spent on, so it logs as
         * "Unknown action" and ⌘Z undoes only half the restore: the container
         * comes back trashed while its members stay re-filed. Every slice this
         * touches is in the object above for that reason.
         *
         * A restored container releases its members' suppression, so this rides
         * withReleaseGrace exactly as removeRoutine and updateRoutine do.
         */
        if (entry.kind === 'routine' || entry.kind === 'program') {
          withReleaseGrace(() => set(next));
        } else {
          set(next);
        }

        if (!userId) return;
        switch (entry.kind) {
          case 'item':
            dbRestoreItem(entry.id, itemDbType(entry.entity as Item)).catch(console.error);
            break;
          case 'project':
            dbRestoreProject(userId, entry.id).catch(console.error);
            break;
          case 'routine':
            dbRestoreRoutine(userId, entry.id).catch(console.error);
            break;
          case 'program':
            dbRestoreProgram(userId, entry.id).catch(console.error);
            break;
          case 'goal':
            // No withReleaseGrace above for this kind, deliberately: a goal
            // suppresses nothing, so restoring one releases nothing onto the
            // canvas and there is no grace period to open.
            dbRestoreGoal(userId, entry.id).catch(console.error);
            break;
        }
      },

      // getHabitGroupEmoji / getHabitGroupColor lived here until 039 collapsed
      // the two CLASSIFY kinds. getProjectEmoji and getProjectColor answer for
      // the whole axis now, and the latter absorbed this one's theme tokens.

      cleanupOrphanedReferences: () => {
        const state = get();
        // Keyed on the FOLDED name so membership answers the same question the
        // rest of the app does: a habit stored as 'personal' is not an orphan
        // while a group called 'Personal' exists.
        const projectNames = new Set(state.projects.map((p) => foldContainerName('project', p.name)));

        set(projectItems(state.items.map((i) => {
          // NB this whole action currently has ZERO CALLERS — it is declared,
          // implemented, and wired to nothing. Kept correct rather than deleted
          // because the container work (memory/plans/display-menu.md, phase B)
          // wants exactly this sweep once containers move to ids. If you wire
          // it up, note that it only mutates state: persisting the repair needs
          // dbTypeOf, not a hardcoded 'task' — see moveTaskToProjectBlock.
          if (!i.project || projectNames.has(foldContainerName('project', i.project))) return i;
          // Where an orphan lands is the same registry question the delete path
          // asks — `unfiled` reads `containerRequired` / `orphanContainerFallback`
          // rather than testing for a habit.
          return unfiled(i, state.projects, '');
        })));
      },

      // Undo/Redo
      canUndo: false,
      canRedo: false,

      undo: () => {
        if (historyIndex <= 0) return;

        const currentState = get();
        const userId = currentState.userId;

        isUndoRedoAction = true;
        historyIndex--;
        const prevState = historyStack[historyIndex];

        if (!prevState) {
          historyIndex++;
          isUndoRedoAction = false;
          return;
        }

        applyHistoryState(prevState, currentState, {
          canUndo: historyIndex > 0,
          canRedo: true,
        }, userId, set);

        isUndoRedoAction = false;
      },

      redo: () => {
        if (historyIndex >= historyStack.length - 1) return;

        const currentState = get();
        const userId = currentState.userId;

        isUndoRedoAction = true;
        historyIndex++;
        const nextState = historyStack[historyIndex];

        if (!nextState) {
          historyIndex--;
          isUndoRedoAction = false;
          return;
        }

        applyHistoryState(nextState, currentState, {
          canUndo: true,
          canRedo: historyIndex < historyStack.length - 1,
        }, userId, set);

        isUndoRedoAction = false;
      },
      };
    },
    {
      name: 'planner-storage',
      partialize: (state) => ({
        compactMode: state.compactMode,
        viewMode: state.viewMode,
        chillMode: state.chillMode,
        groupBy: state.groupBy,
        showCurrentTimeIndicator: state.showCurrentTimeIndicator,
        timelineItemFilter: state.timelineItemFilter,
        showCompletedTasks: state.showCompletedTasks,
        showPausedOnGrid: state.showPausedOnGrid,
        defaultView: state.defaultView,
        defaultTimeBucket: state.defaultTimeBucket,
        animationsEnabled: state.animationsEnabled,
        weekStartDay: state.weekStartDay,
        timeFormat: state.timeFormat,
      }),
    }
  )
);

/** The first day of the week holding `dateStr` (YYYY-MM-DD), by the user's week start. */
function weekStartOf(dateStr: string, weekStartDay: 'sunday' | 'monday' | 'saturday'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const start = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
  return addDaysToDateStr(dateStr, -((weekday - start + 7) % 7));
}

/**
 * Type switches for one item run one at a time. Each write filters on the type
 * it expects to find, so an undo pressed before the switch it undoes has
 * landed would match nothing and the switch would then land on top of it,
 * leaving the table on the new type while the store shows the old. A failed
 * switch is said out loud: the store has already moved, and every later write
 * to the item would miss until a reload put the saved type back.
 */
const typeSwitchChain = new Map<string, Promise<void>>();
function queueTypeSwitch(id: string, write: () => Promise<void>): Promise<void> {
  const prev = typeSwitchChain.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(write);
  typeSwitchChain.set(id, next);
  next.then(
    () => {
      if (typeSwitchChain.get(id) === next) typeSwitchChain.delete(id);
    },
    (err) => {
      if (typeSwitchChain.get(id) === next) typeSwitchChain.delete(id);
      console.error(err);
      toast.error('Couldn’t save the type change', {
        description: 'Reload to see the saved version before editing this item again.',
      });
    },
  );
  return next;
}

/**
 * Restore a history snapshot into the store and sync the delta to the DB.
 * One generic path for both kinds (the old per-kind version synced habit
 * edits only when status changed — undoing a habit title edit never
 * persisted); items missing from one side restore or soft-delete.
 */
function applyHistoryState(
  target: HistoryState,
  // HistoryState itself, rather than a hand-repeated structural copy: the two
  // lists were identical and the copy was a second place to forget a slice.
  // Callers pass the whole store, which is assignable.
  currentState: HistoryState,
  flags: { canUndo: boolean; canRedo: boolean },
  userId: string | null,
  set: (partial: Partial<PlannerStore>) => void,
) {
  const restoredItems: Item[] = JSON.parse(JSON.stringify(target.items));
  const restoredProjects: Project[] = JSON.parse(JSON.stringify(target.projects));
  // The `?? []` here is a tolerance for snapshots that predate a field, NOT a
  // licence to omit one from saveToHistory: an absent slice reads downstream as
  // "every row deleted" and syncContainers will faithfully soft-delete them all.
  // Every key of HistoryState must be snapshotted; this only softens the crash.
  const restoredRoutines: Routine[] = JSON.parse(JSON.stringify(target.routines ?? []));
  const restoredPrograms: Program[] = JSON.parse(JSON.stringify(target.programs ?? []));
  const restoredGoals: Goal[] = JSON.parse(JSON.stringify(target.goals ?? []));

  const info = getHistoryInfo();
  set({
    ...projectItems(restoredItems),
    projects: restoredProjects,
    routines: restoredRoutines,
    programs: restoredPrograms,
    goals: restoredGoals,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
    actionLog: info.actionLog,
    historyIndex: info.currentIndex,
  });

  updatePrevStateBaseline({
    items: restoredItems,
    projects: restoredProjects,
    routines: restoredRoutines,
    programs: restoredPrograms,
    goals: restoredGoals,
  });

  if (!userId) return;

  // By id alone. Ids are unique across types, and keying by type too made an
  // undone TYPE SWITCH read as "one item gone, another appeared": the restore
  // matched nothing and the delete soft-deleted the item itself.
  const key = (i: Item) => i.id;
  // DB writes filter on the SLUG stored in items.type — the 'custom' envelope
  // discriminant matches zero rows and every write would silently no-op
  // (undoing a custom-item delete would "restore" it until the next reload).
  const dbType = (i: Item) => (i.type === 'custom' ? i.customType : i.type);
  const currentById = new Map(currentState.items.map((i) => [key(i), i]));
  const restoredById = new Map(restoredItems.map((i) => [key(i), i]));

  restoredItems.forEach((item) => {
    const cur = currentById.get(key(item));
    if (!cur) {
      dbRestoreItem(item.id, dbType(item)).catch(console.error);
      return;
    }
    // completedDates/skippedDates must never be written as an absolute array
    // from a snapshot — the set_item_completion / set_item_skip RPCs own those
    // columns, and a clobber here would race an in-flight toggle. Replay the
    // delta as per-date intents instead (adjustStreak=false on completion: the
    // patch below restores streak absolutely).
    //
    // updateItem now reconciles these at the boundary too, so a miss here is no
    // longer data loss — but doing it in-place keeps the restore to one round
    // trip per changed date instead of a read plus the same intents.
    const replayDates = () => {
      const curDates = new Set(cur.completedDates ?? []);
      const restoredDates = new Set(item.completedDates ?? []);
      restoredDates.forEach((d) => {
        if (!curDates.has(d)) dbSetItemCompletion(item.id, dbType(item), d, true, false).catch(console.error);
      });
      curDates.forEach((d) => {
        if (!restoredDates.has(d)) dbSetItemCompletion(item.id, dbType(item), d, false, false).catch(console.error);
      });
      const curSkips = new Set(cur.skippedDates ?? []);
      const restoredSkips = new Set(item.skippedDates ?? []);
      restoredSkips.forEach((d) => {
        if (!curSkips.has(d)) dbSetItemSkip(item.id, dbType(item), d, true).catch(console.error);
      });
      curSkips.forEach((d) => {
        if (!restoredSkips.has(d)) dbSetItemSkip(item.id, dbType(item), d, false).catch(console.error);
      });
    };
    if (dbType(cur) !== dbType(item)) {
      // A type switch is undone by switching back with the snapshot's whole
      // row, which carries every other column that moved alongside it. The
      // date intents wait for it: they are addressed by the restored type.
      queueTypeSwitch(item.id, () => dbChangeItemType(item.id, dbType(cur), item, userId)).then(replayDates, () => {});
      return;
    }
    const patch = diffItem(cur, item);
    const datesMoved = 'completedDates' in patch || 'skippedDates' in patch;
    delete patch.completedDates;
    delete patch.skippedDates;
    if (datesMoved) replayDates();
    if (Object.keys(patch).length > 0) {
      dbUpdateItem(item.id, dbType(item), patch).catch(console.error);
    }
  });
  currentState.items.forEach((item) => {
    if (!restoredById.has(key(item))) dbDeleteItem(item.id, dbType(item)).catch(console.error);
  });

  // Containers diff by id, never by name — names are mutable, and a name-keyed
  // set-diff turns a rename undo into a bogus restore/delete pair (the delete
  // half would soft-delete the only copy of the row).
  syncContainers(
    currentState.projects, restoredProjects, PROJECT_FIELDS,
    (id) => dbRestoreProject(userId, id),
    (id, patch) => dbUpdateProject(userId, id, patch),
    (id) => dbDeleteProject(userId, id),
  );
  // Routines ride the same diff, but their update callback carries join-table
  // reconciliation: ROUTINE_FIELDS includes `itemIds`, so a membership undo
  // arrives here as an {itemIds} patch and dbUpdateRoutine turns it into
  // inserts/deletes. A column-mapper-style callback would drop it silently and
  // membership undo would never reach the DB.
  syncContainers(
    currentState.routines, restoredRoutines, ROUTINE_FIELDS,
    (id) => dbRestoreRoutine(userId, id),
    (id, patch) => dbUpdateRoutine(userId, id, patch),
    (id) => dbDeleteRoutine(userId, id),
  );
  // Programs carry TWO member arrays (itemIds and routineIds), both in
  // PROGRAM_FIELDS and both reconciled by dbUpdateProgram against their own
  // join table. Undoing "added Morning to Summer" therefore arrives here as a
  // {routineIds} patch and deletes exactly that one join row.
  syncContainers(
    currentState.programs, restoredPrograms, PROGRAM_FIELDS,
    (id) => dbRestoreProgram(userId, id),
    (id, patch) => dbUpdateProgram(userId, id, patch),
    (id) => dbDeleteProgram(userId, id),
  );
  // Goals carry THREE member arrays, all in GOAL_FIELDS, and dbUpdateGoal
  // reconciles whichever of them the diff produced — a patch naming one role
  // leaves the other two alone rather than emptying them. That property is the
  // whole reason this call site works: syncContainers patches only the fields
  // that differ, so undoing "added a milestone" arrives as {milestoneIds} and
  // nothing else, and it fires as .catch(console.error) — anything thrown here
  // would be a silent no-op rather than a visible failure.
  syncContainers(
    currentState.goals, restoredGoals, GOAL_FIELDS,
    (id) => dbRestoreGoal(userId, id),
    (id, patch) => dbUpdateGoal(userId, id, patch),
    (id) => dbDeleteGoal(userId, id),
  );
}

function syncContainers<T extends { id: string }>(
  current: T[],
  restored: T[],
  fields: readonly (keyof T & string)[],
  restore: (id: string) => Promise<void>,
  update: (id: string, patch: Partial<T>) => Promise<void>,
  remove: (id: string) => Promise<void>,
) {
  const currentById = new Map(current.map((c) => [c.id, c]));
  const restoredById = new Map(restored.map((c) => [c.id, c]));

  restored.forEach((r) => {
    const cur = currentById.get(r.id);
    if (!cur) {
      // The trashed row may have drifted from the snapshot (e.g. renamed
      // before deletion) — push the full restored shape after undeleting.
      restore(r.id).catch(console.error);
      const { id: _id, ...fullPatch } = r;
      update(r.id, fullPatch as Partial<T>).catch(console.error);
      return;
    }
    const patch: Partial<T> = {};
    for (const field of fields) {
      if (field === 'id') continue;
      if (JSON.stringify(cur[field]) !== JSON.stringify(r[field])) patch[field] = r[field];
    }
    if (Object.keys(patch).length > 0) update(r.id, patch).catch(console.error);
  });
  current.forEach((c) => {
    if (!restoredById.has(c.id)) remove(c.id).catch(console.error);
  });
}

// Subscribe to changes and save to history
let isUpdatingUndoRedo = false;

/**
 * Which `initializeStore` call currently owns `isUpdatingUndoRedo`.
 *
 * The flag is a plain boolean, set true for the WHOLE of a load and released at
 * each of that load's three exits. With two loads overlapping — an account
 * switch mid-fetch — the slower one's exit would otherwise release a flag the
 * faster one is still relying on, waking the history subscriber inside a window
 * where the store is being replaced wholesale. A superseded load compares its
 * generation, finds it stale, and leaves the flag to whoever took over.
 */
let loadGeneration = 0;
let hasInitializedHistory = false;

// Initialize prevStateJson eagerly with the store's initial state
// This captures the "before" state so we can properly undo the first action
const initialStoreState = usePlannerStore.getState();
// ANNOTATED, and that is the point: this literal used to be untyped, so it was
// the one place a new history slice could be forgotten silently. Every other
// site is forced by the compiler (saveToHistory takes a HistoryState), but a
// bare object handed to JSON.stringify accepts anything. Miss a slice here and
// the session-start baseline holds no goals, so undoing back to it reads every
// goal as "present in current, absent in restored" — which syncContainers
// executes as a DELETE of all of them.
const historySlice = (s: HistoryState): HistoryState => ({
  items: s.items,
  projects: s.projects,
  routines: s.routines,
  programs: s.programs,
  goals: s.goals,
});

let prevStateJson: string | null = JSON.stringify(historySlice(initialStoreState));

// Function to update baseline from undo/redo actions
const updatePrevStateBaseline = (state: HistoryState) => {
  prevStateJson = JSON.stringify(state);
};

usePlannerStore.subscribe((state) => {
  if (isUndoRedoAction || isUpdatingUndoRedo) return;

  const currentState = historySlice(state);

  const currentStateJson = JSON.stringify(currentState);

  // Initialize history with baseline state if not already done
  // This handles the case when no user is logged in (initializeStore not called)
  if (!hasInitializedHistory && historyStack.length === 0) {
    hasInitializedHistory = true;
    // Save the PREVIOUS state as baseline (captured before this change)
    const baselineState = prevStateJson ? JSON.parse(prevStateJson) : currentState;
    historyStack.push(JSON.parse(JSON.stringify(baselineState)));
    actionLog.push({
      id: crypto.randomUUID(),
      label: 'Session start',
      timestamp: Date.now(),
    });
    historyIndex = 0;
  }

  // Only save if data actually changed (not just view state)
  if (currentStateJson !== prevStateJson) {
    saveToHistory(currentState);
    // Update canUndo/canRedo and actionLog after saving (prevent recursive trigger)
    isUpdatingUndoRedo = true;
    const info = getHistoryInfo();
    usePlannerStore.setState({
      canUndo: historyIndex > 0,
      canRedo: false,
      actionLog: info.actionLog,
      historyIndex: info.currentIndex,
    });
    isUpdatingUndoRedo = false;
  }

  prevStateJson = currentStateJson;
});

/* ── batches ───────────────────────────────────────────────────────────── */

/** One receipt for a batch, by landingReceipt's own rule: say it once, or count. */
function mergeReceipts(receipts: string[]): string | undefined {
  if (receipts.length === 0) return undefined;
  return new Set(receipts).size === 1
    ? receipts[0]
    : `${receipts.length} of these are hidden where they landed`;
}

/**
 * Run several single verbs as ONE history entry, so one ⌘Z (or the one undo
 * strip) takes back the whole batch. The verbs keep their own side effects and
 * database writes; only the history is folded.
 *
 * It holds the subscriber off for the length of `fn`, so prevStateJson stays at
 * the pre-batch state, then pokes the store once: the subscriber diffs before
 * against after and saves a single entry under `label`. A batch that changed
 * nothing saves nothing, and its label does not leak onto the next action.
 *
 * `quiet` collects the completion verbs' celebration and offers and fires them
 * once, after the entry exists and judged on the final state — one burst and
 * one offer per goal instead of one per item.
 *
 * Nested inside another batch (or inside anything else holding the subscriber
 * off), `fn` runs inline and the outer scope records it. One exception to the
 * ordering above: a quiet batch nested in a loud one owns the quiet scope but
 * not the entry, so its effects fire before the outer entry is saved (no
 * caller nests today). A throw still records what was applied as one entry and
 * rethrows; its quiet effects are dropped.
 */
export function batchHistory(
  label: string,
  n: number,
  fn: () => void,
  opts?: { quiet?: boolean },
): void {
  // Quiet bookkeeping applies on every path, including the nested one: an
  // inner quiet batch joins the outermost quiet scope.
  const ownsQuiet = !!opts?.quiet && quietDepth === 0;
  if (opts?.quiet) quietDepth++;
  if (ownsQuiet) {
    batchCompleted = false;
    deferredAchievementIds = [];
    deferredCheckins = [];
  }

  const recordsHistory = !(isUndoRedoAction || isUpdatingUndoRedo);
  const outerReceipts = batchReceipts;
  if (recordsHistory) batchReceipts = [];
  let failed = false;
  try {
    if (recordsHistory) isUpdatingUndoRedo = true;
    fn();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (recordsHistory) {
      // It was false on entry, or recordsHistory would be false.
      isUpdatingUndoRedo = false;
      const receipts = batchReceipts ?? [];
      batchReceipts = outerReceipts;
      pendingActionLabel = label;
      pendingActionReceipt = mergeReceipts(receipts);
      pendingActionBatch = n;
      usePlannerStore.setState({});
      pendingActionLabel = null;
      pendingActionReceipt = undefined;
      pendingActionBatch = undefined;
    }
    if (opts?.quiet) quietDepth--;
    if (ownsQuiet) {
      const effects: BatchEffects = {
        completed: batchCompleted,
        achievementIds: deferredAchievementIds,
        checkins: deferredCheckins,
      };
      batchCompleted = false;
      deferredAchievementIds = [];
      deferredCheckins = [];
      if (!failed) flushBatchEffects(effects);
    }
  }
}

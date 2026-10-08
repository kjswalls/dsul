import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * The item sheet's edits, shared with the iPhone.
 *
 * verb-writes-fixtures.test.ts pins what the sheet's verbs write; this pins its
 * edits (lib/item-edit.ts: the title, the notes, and the priority, times per
 * day, reminder, time, repeat and project chips), its Delete, Add a subtask
 * and Reset streak, and the routine and season chips' toggles.
 * Each case drives the web's REAL
 * gesture for the same change over the real planner store, with the db layer
 * mocked and the clock pinned (Thursday 1 October), and records to
 * tests/fixtures/day/edit-writes.json:
 *
 *  - `edit`, the exact body the phone sends to /api/app/items/:id: a key
 *    absent or null exactly as on the wire;
 *  - `updates`, the updateItem payload the gesture sent (`{}` when it sent
 *    none, null for a case the row refuses), which the route must write;
 *  - `after`, the item as the store leaves it (null once deleted), which
 *    DsulCore's `editing` must reproduce;
 *  - `removed`, the ids the store deleted, in the order it deleted them, which
 *    DsulCore's `deleting` and the route's child pass must match;
 *  - `created`, the row the store created (null for anything but a new
 *    subtask), which DsulCore's `subtaskItem` and the route's insert must
 *    match.
 *
 * The gestures: a typed field or a chip is the item panel's (components/
 * planner/item-dialog.tsx): the draft seeded from the item (draftFromItem), the
 * field or chip's change applied, the keys that differ from the seed marked
 * changed, then the panel's own save, commitEdit: taskUpdatesFromDraft /
 * habitUpdatesFromDraft and the store action they name, then the schedule pass
 * (lib/item-edit.ts planTimeEdit, through scheduleTask / scheduleHabit /
 * updateTask). Delete is lib/item-verbs.ts's: deleteTask, or
 * deleteHabit. Add a subtask is the panel's subtask field
 * (components/planner/item-detail-sections.tsx SubtasksSection.addSubtask):
 * addTask with the trimmed title and the parent. Reset streak is the verb the
 * phone offers (lib/item-verbs.ts resetStreak), run only when it is eligible,
 * so at 0 it writes nothing. A refused case comes from `refusal` alone, since
 * the store has no such refusal: the dialog never caps a field, and never
 * offers a subtask under a habit or a subtask, a reset on a task, a priority on
 * a habit, a count on a task, a reminder on a subtask, a time on a subtask
 * or an undated task, or a repeat its type doesn't list. A repeat on a
 * subtask is the route's refusal alone: the web's panel offers one, which
 * would show nowhere, since a subtask shows only in its parent's sheet.
 * Fifteen cases have a body the route's schema refuses, which the phone never
 * builds: `reminder-anchor-without-time` (cue words with no time),
 * `time-refused-anytime-with-a-time`, `time-refused-empty`, the nine repeat
 * bodies whose days or day sit beside the wrong frequency, are missing, out
 * of order or out of range, `project-refused-not-a-uuid`, and the two collect
 * bodies, `collect-refused-container-not-a-uuid` and `collect-refused-kind-goal`.
 *
 * The Time chip's cases (2d) go through commitEdit's both passes: a part of
 * day picked away from the stored one is scheduleTask, which releases a
 * project block; a new time alone is updateTask twice (the mapper, then the
 * second pass's setTime), auto-corrected, and keeps the block.
 *
 * The Repeat chip's cases (2e) are the chip's rows: a frequency, then Custom
 * days' keys or Monthly's day, written by the mappers as all three keys
 * together (repeatPatch), or nothing when the draft is its seed. fetchGoals
 * holds no goals here, so no case takes a goal role back: item-repeat-edit
 * and the route's tests pin that.
 *
 * The project chip's cases (2f) drive the bulk Move to project for the one
 * item, setItemsProject([id], name), the rule's own home (lib/item-edit.ts
 * projectRefilePatch), over a store seeded with `projects` (Work and Health),
 * which the phone's tests resolve a `projectId` against. The item dialog's
 * project change has a no-op rule of its own (it holds the name alone), so
 * the panel isn't driven here: item-project-edit.test.ts shows the dialog
 * writes what these write wherever it writes. Name and id, a parked task's
 * release, and a habit's clear, which always writes since an unfiled habit
 * reads ''. One body the schema refuses: a project id that isn't a uuid.
 *
 * The routine and season cases (2f-b) drive the bulk bar's toggle for the one
 * item, setItemsCollected([id], kind, containerId, member), over a store
 * holding the one routine (Morning routine) or season (Autumn) the case names.
 * A membership is no column of the item, so `updates` is `{}` and `after` is
 * `item`; the one key no other case has, `member`, holds the container's
 * `itemIds` before and after the gesture (equal when the store wrote nothing),
 * which DsulCore's `settingMembership` must reproduce. The route writes one
 * row of it (lib/db.ts addContainerMember / removeContainerMember).
 *
 * In `updates`, a key present with null is a column cleared (the store wrote
 * undefined, which lib/db.ts sends as SQL NULL).
 *
 * `trim` pins String.prototype.trim, which the schema's `.trim()` and
 * `cleanNotes` use, for DsulCore's `jsTrim`: Foundation's whitespace set is a
 * different one.
 *
 * `limits` holds lib/item-edit.ts's caps, the cue words', the times a day's
 * and the length's among them.
 *
 * `bulk` pins lib/bulk-add.ts's `isBulkPaste` and `splitBulkLinesWithMeta`,
 * which DsulCore's BulkLines.swift ports for a paste into the new-subtask
 * field: what a line break is, which list markers come off, and JS's `\s`.
 * `streakRun` pins `streakRunText`, and `copy` the sentences both sides say
 * (`EDIT_COPY`).
 *
 * `buckets` pins lib/time-bucket.ts, which DsulCore's DayBuckets.swift ports
 * for the Time sheet: `forTime` is getBucketForTime (JS's parseInt on the
 * hour, edges included), `corrected` is autoCorrectBucket (null kept as null)
 * and `starts` is BUCKET_START_TIMES, where Add a time starts the wheel.
 * `durations` pins the Time chip's lengths and their words (lib/item-edit.ts
 * DURATION_ORDER and durationLabel), for DsulCore's EditCopy. `repeats` pins
 * the Repeat chip's words: lib/planner-types.ts REPEAT_FREQUENCY_LABELS, in
 * its order, and WEEKDAY_LABELS, for DsulCore's Cadence. `containers` pins
 * the container nouns (lib/container-registry.ts CONTAINER_KINDS' label,
 * labelPlural and the project's unsetLabel), for DsulCore's ContainerWords.
 *
 * Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/edit-writes-fixtures.test.ts
 *
 * Never hand-edit the JSON: the inputs live here.
 */

type DbCall =
  | { fn: 'updateItem'; id: string; type: string; updates: Record<string, unknown> }
  | { fn: 'deleteItem'; id: string; type: string }
  | { fn: 'createItem'; item: Item }
  | { fn: 'updateRoutine' | 'updateSeason'; id: string; itemIds: string[] };

// The mock factory runs while the imports below are still resolving, before
// any module-level const exists, so the log it writes to is hoisted with it.
const log = vi.hoisted(() => ({ calls: [] as DbCall[] }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  /** A JSON-safe copy that keeps a cleared column as an explicit null. */
  const written = (updates: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, v ?? null]))));
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    // A JSON copy, as the fixture holds it: asJson isn't defined yet when the
    // hoisted factory runs.
    createItem: vi.fn(async (_userId: string, item: Item) => {
      log.calls.push({ fn: 'createItem', item: JSON.parse(JSON.stringify(item)) });
    }),
    updateItem: vi.fn(async (id: string, type: string, updates: Record<string, unknown>) => {
      log.calls.push({ fn: 'updateItem', id, type, updates: written(updates) });
    }),
    deleteItem: vi.fn(async (id: string, type: string) => {
      log.calls.push({ fn: 'deleteItem', id, type });
    }),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async () => {}),
    setItemSkip: vi.fn(async () => {}),
    createProject: vi.fn(async () => {}),
    updateProject: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    restoreProject: vi.fn(async () => {}),
    fetchRoutines: vi.fn(async () => []),
    createRoutine: vi.fn(async () => {}),
    // A membership write, logged with the list it sends; no earlier case makes one.
    updateRoutine: vi.fn(async (_userId: string, id: string, updates: { itemIds?: string[] }) => {
      if (updates.itemIds) log.calls.push({ fn: 'updateRoutine', id, itemIds: [...updates.itemIds] });
    }),
    deleteRoutine: vi.fn(async () => {}),
    restoreRoutine: vi.fn(async () => {}),
    fetchSeasons: vi.fn(async () => []),
    createSeason: vi.fn(async () => {}),
    updateSeason: vi.fn(async (_userId: string, id: string, updates: { itemIds?: string[] }) => {
      if (updates.itemIds) log.calls.push({ fn: 'updateSeason', id, itemIds: [...updates.itemIds] });
    }),
    deleteSeason: vi.fn(async () => {}),
    restoreSeason: vi.fn(async () => {}),
    fetchGoals: vi.fn(async () => []),
    // No RPC: the per-table fallback, started synchronously (the fetchers above).
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createGoal: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    deleteGoal: vi.fn(async () => {}),
    restoreGoal: vi.fn(async () => {}),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { DRAFT_KEYS, commitEdit, draftFromItem, type ItemDraft } from '@/components/planner/item-dialog';
import { ItemWriteSchema } from '@/lib/app-api';
import {
  DURATION_ORDER,
  EDIT_COPY,
  EDIT_LIMITS,
  MAX_DURATION_MINUTES,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  TIMES_PER_DAY_MAX,
  durationLabel,
  editPatch,
  editRefusal,
  editShapeFromRow,
  resetStreakPatch,
  resetStreakRefusal,
  sameProjectName,
  streakRunText,
  subtaskRefusal,
  type ItemEdit,
} from '@/lib/item-edit';
import { MAX_BULK_ITEMS, isBulkPaste, splitBulkLinesWithMeta } from '@/lib/bulk-add';
import { ITEM_VERBS, type VerbContext } from '@/lib/item-verbs';
import { getItemTypeConfig, isCollectible, itemTypeName } from '@/lib/item-registry';
import { capabilityShape } from '@/lib/item-pause';
import { BUCKET_START_TIMES, autoCorrectBucket, getBucketForTime } from '@/lib/time-bucket';
import {
  REPEAT_FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  type Item,
  type Project,
  type Routine,
  type Season,
  type TimeBucket,
} from '@/lib/planner-types';
import { CONTAINER_KINDS } from '@/lib/container-registry';

const FILE = path.resolve(__dirname, '../fixtures/day/edit-writes.json');
const USER = 'user-1';

// ── Builders (day-fixtures.test.ts's, with ids of their own) ─────────────────

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const task = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: uid(n), title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const custom = (n: number, customType: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'custom',
    customType,
    id: uid(n),
    title,
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...over,
  }) as Item;

const habit = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id: uid(n),
    title,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

/**
 * The row the route reads for an edit (lib/app-api.ts WRITE_ROW_COLUMNS' keys
 * plus EDIT_COLUMNS), as far as lib/item-edit.ts looks at it.
 */
const shapeOf = (item: Item) => {
  const i = item as {
    parentItemId?: string;
    streak?: number;
    priority?: string;
    timesPerDay?: number;
    reminderTime?: string;
    reminderAnchor?: string;
    startDate?: string;
    timeBucket?: string;
    inProjectBlock?: boolean;
    startTime?: string;
    isScheduled?: boolean;
    duration?: number;
    repeatFrequency?: string;
    repeatDays?: number[];
    repeatMonthDay?: number;
    project?: string;
    projectId?: string;
    previousStartTime?: string;
    previousStartDate?: string;
  };
  return editShapeFromRow({
    id: item.id,
    type: itemTypeName(item),
    parent_item_id: i.parentItemId ?? null,
    title: item.title,
    notes: item.notes ?? null,
    streak: i.streak ?? null,
    priority: i.priority ?? null,
    times_per_day: i.timesPerDay ?? null,
    reminder_time: i.reminderTime ?? null,
    reminder_anchor: i.reminderAnchor ?? null,
    start_date: i.startDate ?? null,
    time_bucket: i.timeBucket ?? null,
    in_project_block: i.inProjectBlock ?? null,
    start_time: i.startTime ?? null,
    is_scheduled: i.isScheduled ?? null,
    duration: i.duration ?? null,
    repeat_frequency: i.repeatFrequency ?? null,
    repeat_days: i.repeatDays ?? null,
    repeat_month_day: i.repeatMonthDay ?? null,
    // An unfiled habit is '' in the store and NULL in the row.
    project: i.project || null,
    project_id: i.projectId ?? null,
    previous_start_time: i.previousStartTime ?? null,
    previous_start_date: i.previousStartDate ?? null,
  });
};

// ── Running one case ─────────────────────────────────────────────────────────

/** 11:00 on Thursday 1 October in New York. */
const NOW = '2026-10-01T15:00:00.000Z';
const TODAY = '2026-10-01';
const NY = 'America/New_York';

const store = () => usePlannerStore.getState();

/**
 * A fresh store holding `items` (and `seed`'s projects, routines and seasons,
 * none unless given), then `act`: the first item as the store leaves it (null
 * once gone), and every write it sent, in order. Nothing in an act is awaited:
 * the store writes optimistically and fires its db calls in the same tick, so
 * the log is complete when `act` returns.
 */
async function run(
  items: Item[],
  act: () => void,
  seed: { projects?: Project[]; routines?: Routine[]; seasons?: Season[] } = {},
): Promise<{ after: Item | null; calls: DbCall[] }> {
  vi.setSystemTime(new Date(NOW));
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(structuredClone(items));
  vi.mocked(db.fetchProjects).mockResolvedValue(structuredClone(seed.projects ?? []));
  vi.mocked(db.fetchRoutines).mockResolvedValue(structuredClone(seed.routines ?? []));
  vi.mocked(db.fetchSeasons).mockResolvedValue(structuredClone(seed.seasons ?? []));
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(NOW), userTimezone: NY });
  log.calls.length = 0;
  act();
  const after = store().items.find((i) => i.id === items[0].id);
  return { after: after ? JSON.parse(JSON.stringify(after)) : null, calls: log.calls.splice(0) };
}

/**
 * The item panel's edit: the draft seeded as the panel seeds it (draftFromItem), `change`
 * applied as the chip or field applies it, the changed DRAFT_KEYS found as scheduleSave finds
 * them, and the panel's own save (commitEdit): the mapper's payload to the store action it
 * names, then the schedule pass. A draft equal to its seed marks nothing changed, so nothing
 * is written; commitEdit never saves a blank title.
 */
function editInDialog(item: Item, change: Partial<ItemDraft>): void {
  const prev = draftFromItem(item);
  const next: ItemDraft = { ...prev, ...change };
  const changed = DRAFT_KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0) return;
  commitEdit(item, next, changed);
}

/** lib/item-verbs.ts's Delete, once confirmed. */
function deleteIt(item: Item): void {
  if (item.type === 'habit') store().deleteHabit(item.id);
  else store().deleteTask(item.id);
}

/**
 * The panel's change for one edit: the field typed, or the chip's pick. No
 * reminder clears the time and the words together; the time input and Right
 * after each set their own key, so words left alone stay as seeded.
 */
function panelChange(edit: ItemEdit): Partial<ItemDraft> {
  switch (edit.action) {
    case 'title':
      return { title: edit.title };
    case 'notes':
      return { notes: edit.notes ?? '' };
    case 'priority':
      return { priority: edit.priority ?? 'none' };
    case 'timesPerDay':
      return { timesPerDay: String(edit.timesPerDay) };
    case 'reminder':
      if (edit.time === null) return { reminderTime: '', reminderAnchor: '' };
      return {
        reminderTime: edit.time,
        ...(edit.anchor !== undefined ? { reminderAnchor: edit.anchor ?? '' } : {}),
      };
    case 'time':
      // The chip's rows: a part of day (Anytime also clears the time, so a body with Anytime
      // carries startTime: null), the time input or No specific time, and a length.
      return {
        ...(edit.timeBucket !== undefined ? { timeBucket: edit.timeBucket ?? 'none' } : {}),
        ...(edit.startTime !== undefined ? { startTime: edit.startTime ?? '' } : {}),
        ...(edit.duration !== undefined ? { duration: String(edit.duration) } : {}),
      };
    case 'repeat':
      // The chip's rows: a frequency, then Custom days' keys or Monthly's day. A body with custom
      // always carries its days, so the chip's own pre-selection of today never reaches a case.
      return {
        repeatFrequency: edit.frequency,
        ...(edit.days !== undefined ? { repeatDays: edit.days } : {}),
        ...(edit.monthDay !== undefined ? { repeatMonthDay: edit.monthDay } : {}),
      };
    case 'project':
      throw new Error('panelChange: a project case drives setItemsProject (projectCase), never the dialog');
  }
}

/** Every updateItem payload of the gesture, merged, in the order sent. */
const merged = (calls: DbCall[]) =>
  Object.assign({}, ...calls.flatMap((c) => (c.fn === 'updateItem' ? [c.updates] : []))) as Record<string, unknown>;

type EditCase = {
  name: string;
  item: Item;
  /** The live subtasks the store holds beside `item`, for a delete. */
  children: Item[];
  /** The wire body. */
  edit: Record<string, unknown>;
  /** The route's refusal code, or null. */
  refusal: string | null;
  updates: Record<string, unknown> | null;
  after: Item | null;
  removed: string[];
  /** A row the gesture creates: Add a subtask (2b) onward. */
  created: Item | null;
  /**
   * A collect case's container (2f-b): its `itemIds` before and after the gesture, equal when
   * the store wrote nothing. Only collect cases carry it.
   */
  member?: { kind: 'routine' | 'season'; containerId: string; before: string[]; after: string[] };
};
type TrimCase = { name: string; input: string; expected: string };
/** A paste into the new-subtask field, as lib/bulk-add.ts reads it. */
type BulkCase = { name: string; input: string; isBulk: boolean; titles: string[]; truncated: boolean };
type StreakRunCase = { streak: number; text: string };
/**
 * lib/item-edit.ts's caps, which DsulCore's `EditLimits` must equal, and
 * lib/bulk-add.ts's, which its `maxBulkItems` must.
 */
type EditLimits = {
  title: number;
  notes: number;
  outerTitle: number;
  outerNotes: number;
  newTitle: number;
  bulkMax: number;
  anchor: number;
  outerAnchor: number;
  timesPerDayMax: number;
  durationMax: number;
};
/** lib/time-bucket.ts's rules, which DsulCore's bucketForTime, autoCorrectBucket and bucketStartTime must equal. */
type EditBuckets = {
  forTime: { time: string; bucket: TimeBucket }[];
  corrected: { time: string; bucket: TimeBucket | null; expected: TimeBucket | null }[];
  starts: Record<'morning' | 'afternoon' | 'evening', string>;
};
/** The Time chip's lengths and their words, which DsulCore's EditCopy must equal. */
type EditDurations = { presets: number[]; labels: { minutes: number; label: string }[] };
/** The Repeat chip's frequencies and weekdays, in the web's order and words, which DsulCore's Cadence must equal. */
type EditRepeats = { labels: { frequency: string; label: string }[]; weekdays: string[] };
/** lib/container-registry.ts CONTAINER_KINDS' words, which DsulCore's ContainerWords must equal. */
type EditContainers = {
  project: { label: string; labelPlural: string; unsetLabel: string };
  routine: { label: string; labelPlural: string };
  season: { label: string; labelPlural: string };
};
type EditWrites = {
  today: string;
  limits: EditLimits;
  /** The projects the project cases' store holds, which the phone resolves a `projectId` against. */
  projects: { id: string; name: string }[];
  cases: EditCase[];
  trim: TrimCase[];
  bulk: BulkCase[];
  streakRun: StreakRunCase[];
  copy: Record<string, string>;
  repeats: EditRepeats;
  containers: EditContainers;
  buckets: EditBuckets;
  durations: EditDurations;
};

async function editCase(name: string, item: Item, edit: ItemEdit, refusal: string | null = null): Promise<EditCase> {
  const base = { name, item, children: [], edit, refusal, removed: [], created: null };
  if (refusal) return { ...base, updates: null, after: item };
  const { after, calls } = await run([item], () => editInDialog(item, panelChange(edit)));
  if (calls.some((c) => c.fn !== 'updateItem')) throw new Error(`${name}: an edit wrote more than the item`);
  return { ...base, updates: merged(calls), after };
}

async function deleteCase(name: string, item: Item, children: Item[] = []): Promise<EditCase> {
  const { after, calls } = await run([item, ...children], () => deleteIt(item));
  if (calls.some((c) => c.fn !== 'deleteItem')) throw new Error(`${name}: a delete wrote more than deletes`);
  return {
    name,
    item,
    children,
    edit: { action: 'delete' },
    refusal: null,
    updates: {},
    after,
    removed: calls.flatMap((c) => (c.fn === 'deleteItem' ? [c.id] : [])),
    created: null,
  };
}

/**
 * The panel's subtask field: SubtasksSection.addSubtask, addTask({title,
 * parentItemId}) with the title already trimmed, the new row's id pinned to
 * `uid(n)` (the store mints it with crypto.randomUUID) so the fixture can name
 * it. One row created, and nothing else written.
 */
async function subtaskCase(
  name: string,
  item: Item,
  children: Item[],
  title: string,
  n: number,
  refusal: string | null = null,
): Promise<EditCase> {
  const base = { name, item, children, edit: { action: 'addSubtask', id: uid(n), title }, refusal, removed: [] };
  if (refusal) return { ...base, updates: null, after: item, created: null };
  const { after, calls } = await run([item, ...children], () => {
    const minted = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(uid(n) as ReturnType<typeof crypto.randomUUID>);
    try {
      store().addTask({ title, parentItemId: item.id });
    } finally {
      minted.mockRestore();
    }
  });
  const [call] = calls;
  if (calls.length !== 1 || call.fn !== 'createItem') throw new Error(`${name}: an add wrote more than one new row`);
  return { ...base, updates: {}, after, created: call.item };
}

/** The projects every project case's store holds: Work and Health. */
const PROJECTS: Project[] = [
  { id: uid(1310), name: 'Work' },
  { id: uid(1311), name: 'Health' },
] as Project[];

/** The bulk Move to project for one item: setItemsProject([id], name), the rule's home. */
async function projectCase(
  name: string,
  item: Item,
  target: string | null,
  refusal: string | null = null,
): Promise<EditCase> {
  const project = target === null ? null : PROJECTS.find((p) => p.id === target);
  const edit = { action: 'project', projectId: target } as const;
  const base = { name, item, children: [], edit, refusal, removed: [], created: null };
  if (refusal) return { ...base, updates: null, after: item };
  const { after, calls } = await run([item], () => store().setItemsProject([item.id], project?.name), {
    projects: PROJECTS,
  });
  if (calls.some((c) => c.fn !== 'updateItem')) throw new Error(`${name}: a re-file wrote more than the item`);
  return { ...base, updates: merged(calls), after };
}

/** The smallest routine the store takes: Morning routine, first in the list. */
const routineOf = (id: string, name: string, itemIds: string[]): Routine => ({ id, name, sortOrder: 0, itemIds });

/** The smallest season: on by date with no dates, so on every day, holding no routines. */
const seasonOf = (id: string, name: string, itemIds: string[]): Season => ({
  id,
  name,
  state: 'auto',
  itemIds,
  routineIds: [],
});

/**
 * The bulk bar's toggle for one item: setItemsCollected([id], kind, containerId, member).
 * The item panel's chips (item-dialog.tsx toggleRoutine / toggleSeason, through
 * updateRoutine / updateSeason) write the same end list: an add appended, a
 * remove filtered out.
 */
async function collectCase(
  name: string,
  item: Item,
  kind: 'routine' | 'season',
  before: string[],
  member: boolean,
  refusal: string | null = null,
  edit?: Record<string, unknown>,
): Promise<EditCase> {
  const containerId = kind === 'routine' ? uid(1340) : uid(1341);
  const body = edit ?? { action: 'collect', kind, containerId, member };
  const base = { name, item, children: [], edit: body, refusal, removed: [], created: null };
  if (refusal) return { ...base, updates: null, after: item };
  const seed =
    kind === 'routine'
      ? { routines: [routineOf(containerId, 'Morning routine', before)] }
      : { seasons: [seasonOf(containerId, 'Autumn', before)] };
  const { after, calls } = await run(
    [item],
    () => store().setItemsCollected([item.id], kind, containerId, member),
    seed,
  );
  const written = calls.flatMap((c) => (c.fn === 'updateRoutine' || c.fn === 'updateSeason' ? [c] : []));
  if (written.length !== calls.length || written.length > 1) throw new Error(`${name}: a toggle wrote more than one list`);
  if (written[0] && (written[0].id !== containerId || written[0].fn !== (kind === 'routine' ? 'updateRoutine' : 'updateSeason'))) {
    throw new Error(`${name}: a toggle wrote another container`);
  }
  const afterIds = written[0]?.itemIds ?? before;
  return { ...base, updates: {}, after, member: { kind, containerId, before, after: afterIds } };
}

/** Today, as the sheet passes it to a verb. */
const VERB_CTX: VerbContext = {
  dateStr: TODAY,
  date: new Date(NOW),
  todayStr: TODAY,
  tz: NY,
  milestoneIds: new Set(),
};

/** lib/item-verbs.ts's Reset streak, as the phone offers it: only when eligible. */
async function resetCase(name: string, item: Item, refusal: string | null = null): Promise<EditCase> {
  const base = { name, item, children: [], edit: { action: 'resetStreak' }, refusal, removed: [], created: null };
  if (refusal) return { ...base, updates: null, after: item };
  const { after, calls } = await run([item], () => {
    const live = store().items.find((i) => i.id === item.id)!;
    if (ITEM_VERBS.resetStreak.eligible(live, VERB_CTX)) ITEM_VERBS.resetStreak.run(live, VERB_CTX);
  });
  if (calls.some((c) => c.fn !== 'updateItem')) throw new Error(`${name}: a reset wrote more than the item`);
  return { ...base, updates: merged(calls), after };
}

/**
 * One case per rule of lib/bulk-add.ts a port could get wrong. Escapes, not
 * literal characters, wherever the character is the point.
 */
function bulkCases(): BulkCase[] {
  const inputs: [string, string][] = [
    ['CRLF is one break', 'a\r\nb'],
    ['a lone CR is a break', 'a\rb'],
    ['blank lines between are dropped', 'a\n\n\nb'],
    ['dash', '- a\n- b'],
    ['star', '* a\n* b'],
    ['plus', '+ a\n+ b'],
    ['bullet', '\u2022 a\n\u2022 b'],
    ['en dash', '\u2013 a\n\u2013 b'],
    ['em dash', '\u2014 a\n\u2014 b'],
    ['numbered with a dot', '1. a\n2. b'],
    ['numbered with a paren', '12) a\n13) b'],
    ['unchecked box', '- [ ] a\n- [ ] b'],
    ['checked box', '- [x] a\n- [x] b'],
    ['capital X box, starred', '* [X] a\n* [X] b'],
    ['a box with no space after it strips the dash alone', '- [ ]task'],
    ['four digits are not a list number', '1234. a\n1234) b'],
    ['a dash with no space after it stays', '-a\n-b'],
    ['an indented marker', '  - indented\n\t- tabbed'],
    ['stripped once, never twice', '- - hello\n* - there'],
    ['a marker followed by a no-break space', '-\u00a0a\n-\u00a0b'],
    ['no-break spaces and byte order marks around a line', '\u00a0a\ufeff\n\ufeffb\u00a0'],
    ['a line separator inside a line is not a break', 'a\u2028b\nc'],
    ['next line inside a line is not a break', 'a\u0085b\nc'],
    ['an Arabic-Indic digit is not a list number', '\u0661. a\n\u0662. b'],
    ['a marker alone is an empty line', '- \nb'],
    ['blank lines only', '\n \n\t\n'],
    ['one line with a trailing newline is not a list', 'Eggs\n'],
    ['past the cap', Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => `item ${i + 1}`).join('\n')],
  ];
  return inputs.map(([name, input]) => ({ name, input, isBulk: isBulkPaste(input), ...splitBulkLinesWithMeta(input) }));
}

// ── The cases ────────────────────────────────────────────────────────────────

async function build(): Promise<EditWrites> {
  const plan = task(1101, 'Draft Q3 plan', { startDate: TODAY, timeBucket: 'morning', notes: 'Three slides.' });
  const stretch = habit(1102, 'Stretch', { streak: 4, completedDates: ['2026-09-30'], timeBucket: 'morning' });
  const errand = custom(1103, 'errand', 'Post office', { startDate: TODAY, timeBucket: 'afternoon' });
  const oatMilk = task(1104, 'Oat milk', { parentItemId: uid(1120), isScheduled: false });
  const bank = (n: number, over: Record<string, unknown> = {}) =>
    task(n, 'Call the bank', { startDate: TODAY, timeBucket: 'afternoon', ...over });

  // Sequential, never Promise.all: every case resets the one store.
  const cases: EditCase[] = [];
  for (const args of [
    ['title-task', plan, { action: 'title', title: 'Draft Q4 plan' }],
    ['title-habit', stretch, { action: 'title', title: 'Stretch for ten minutes' }],
    ['title-custom', errand, { action: 'title', title: 'Post office, then the bank' }],
    ['title-subtask', oatMilk, { action: 'title', title: 'Oat milk, two cartons' }],
    ['title-unchanged', bank(1105), { action: 'title', title: 'Call the bank' }],
    // Stored text over the cap may be edited at its own length; it may not grow.
    ['title-stored-over-cap-kept-length', task(1106, 'a'.repeat(700)), { action: 'title', title: 'b'.repeat(650) }],
    ['title-growth-refused', task(1107, 'Short note'), { action: 'title', title: 'c'.repeat(EDIT_LIMITS.title + 1) }, 'invalid'],
    ['notes-set', bank(1108), { action: 'notes', notes: 'Ask about the wire fee.\nHave the card ready.' }],
    ['notes-habit', stretch, { action: 'notes', notes: 'Hamstrings first.' }],
    ['notes-clear', bank(1109, { notes: 'Ask about the wire fee.' }), { action: 'notes', notes: null }],
    ['notes-trim', bank(1110, { notes: 'Old words.' }), { action: 'notes', notes: '  New words.\n\n' }],
    ['notes-unchanged', bank(1111, { notes: 'Same words.' }), { action: 'notes', notes: 'Same words.' }],
    ['notes-growth-refused', bank(1112, { notes: 'Short.' }), { action: 'notes', notes: 'n'.repeat(EDIT_LIMITS.notes + 1) }, 'invalid'],
  ] as [string, Item, ItemEdit, string?][]) {
    cases.push(await editCase(...args));
  }

  const offsite = task(1120, 'Plan the offsite', { startDate: TODAY, timeBucket: 'morning' });
  cases.push(
    await deleteCase('delete-parent-with-two', offsite, [
      task(1121, 'Book the room', { parentItemId: offsite.id, isScheduled: false, order: 1 }),
      task(1122, 'Send the invite', { parentItemId: offsite.id, isScheduled: false, order: 2, status: 'completed' }),
    ]),
    // No row can name a habit as its parent (lib/db.ts validateParentItemId),
    // but one that did would stay: deleteHabit takes nothing with it.
    await deleteCase('delete-habit', habit(1130, 'Meditate', { streak: 12, completedDates: ['2026-09-30'] }), [
      task(1131, 'Cushion', { parentItemId: uid(1130), isScheduled: false }),
    ]),
    await deleteCase('delete-subtask', task(1140, 'Oat milk', { parentItemId: uid(1141), isScheduled: false })),
    await deleteCase('delete-custom-with-child', custom(1150, 'errand', 'Post office', { startDate: TODAY }), [
      task(1151, 'Stamps', { parentItemId: uid(1150), isScheduled: false }),
    ])
  );

  const lisbon = task(1160, 'Pack for Lisbon', { startDate: TODAY, timeBucket: 'evening' });
  cases.push(
    // The parent is the only task, and its subtask doesn't count: order 1.
    await subtaskCase(
      'subtask-under-task',
      lisbon,
      [task(1161, 'Passport', { parentItemId: lisbon.id, isScheduled: false, order: 1 })],
      'Adapter plug',
      1162,
    ),
    // A task even under a custom item.
    await subtaskCase('subtask-under-custom', custom(1170, 'errand', 'Post office', { startDate: TODAY }), [], 'Stamps', 1171),
    await subtaskCase('subtask-refused-habit', habit(1180, 'Floss'), [], 'Buy floss', 1181, 'no_subtasks'),
    await subtaskCase(
      'subtask-refused-nested',
      task(1190, 'Passport', { parentItemId: lisbon.id, isScheduled: false }),
      [],
      'Renew it',
      1191,
      'nested',
    ),
    await resetCase(
      'reset-streak',
      habit(1200, 'Meds', {
        streak: 41,
        completedDates: ['2026-09-29', '2026-09-30'],
        dailyCounts: { '2026-09-30': 1 },
        timeBucket: 'morning',
      }),
    ),
    await resetCase('reset-streak-at-zero', habit(1201, 'Floss', { streak: 0 })),
    await resetCase('reset-refused-task', task(1202, 'Call the bank'), 'no_streak')
  );

  // The chips (2c): the priority, times per day and reminder chips' picks.
  const roadmap = task(1210, 'Draft Q4 roadmap', { startDate: TODAY, timeBucket: 'morning' });
  const dentist = task(1230, 'Call the dentist', { startDate: TODAY, timeBucket: 'afternoon' });
  const meds = (n: number) => habit(n, 'Meds', { reminderTime: '08:00', reminderAnchor: 'I pour my coffee' });
  for (const args of [
    ['priority-set', roadmap, { action: 'priority', priority: 'high' }],
    ['priority-clear', task(1211, 'Reply to Avery', { priority: 'high' }), { action: 'priority', priority: null }],
    ['priority-unchanged', task(1212, 'Call the dentist', { priority: 'medium' }), { action: 'priority', priority: 'medium' }],
    // A subtask's page offers a priority (Q7 a).
    [
      'priority-subtask',
      task(1213, 'Pull the numbers', { parentItemId: uid(1210), isScheduled: false }),
      { action: 'priority', priority: 'low' },
    ],
    ['priority-custom', custom(1214, 'errand', 'Post office', { startDate: TODAY }), { action: 'priority', priority: 'medium' }],
    ['priority-refused-habit', habit(1215, 'Stretch'), { action: 'priority', priority: 'high' }, 'no_priority'],
    [
      'times-per-day',
      habit(1220, 'Water', { timesPerDay: 3, dailyCounts: { [TODAY]: 1 } }),
      { action: 'timesPerDay', timesPerDay: 5 },
    ],
    // Back to once a day is written as 1, never cleared.
    ['times-back-to-one', habit(1221, 'Water', { timesPerDay: 3 }), { action: 'timesPerDay', timesPerDay: 1 }],
    // None stored reads as once a day.
    ['times-unchanged', habit(1222, 'Floss'), { action: 'timesPerDay', timesPerDay: 1 }],
    ['times-refused-task', task(1223, 'Call the bank'), { action: 'timesPerDay', timesPerDay: 2 }, 'no_count'],
    ['reminder-set', dentist, { action: 'reminder', time: '14:45' }],
    [
      'reminder-anchor',
      habit(1231, 'Meds', { reminderTime: '08:00' }),
      { action: 'reminder', time: '08:00', anchor: '  I pour my coffee ' },
    ],
    ['reminder-time-only-keeps-anchor', meds(1232), { action: 'reminder', time: '07:30' }],
    ['reminder-anchor-cleared', meds(1233), { action: 'reminder', time: '08:00', anchor: null }],
    ['reminder-unchanged', meds(1234), { action: 'reminder', time: '08:00', anchor: 'I pour my coffee' }],
    [
      'reminder-clear',
      habit(1235, 'Floss', { reminderTime: '21:00', reminderAnchor: 'I brush my teeth' }),
      { action: 'reminder', time: null },
    ],
    // Stored words over the cap may be edited at their own length; they may not grow.
    [
      'reminder-anchor-stored-over-cap-kept-length',
      habit(1236, 'Floss', { reminderTime: '21:00', reminderAnchor: 'a'.repeat(700) }),
      { action: 'reminder', time: '21:00', anchor: 'b'.repeat(650) },
    ],
    [
      'reminder-anchor-growth-refused',
      habit(1237, 'Floss', { reminderTime: '21:00', reminderAnchor: 'I brush my teeth' }),
      { action: 'reminder', time: '21:00', anchor: 'c'.repeat(EDIT_LIMITS.anchor + 1) },
      'invalid',
    ],
    [
      'reminder-refused-subtask',
      task(1238, 'Pull the numbers', { parentItemId: uid(1230), isScheduled: false }),
      { action: 'reminder', time: '09:00' },
      'not_remindable',
    ],
    // The schema's refusal, not the row's: words with no time.
    [
      'reminder-anchor-without-time',
      habit(1239, 'Meds', { reminderTime: '08:00' }),
      { action: 'reminder', time: null, anchor: 'I pour my coffee' },
      'invalid',
    ],
  ] as [string, Item, ItemEdit, string?][]) {
    cases.push(await editCase(...args));
  }

  // The Time chip (2d): a part of day, a specific time and a length, through commitEdit's both
  // passes. A task in a project block, its own slot remembered.
  const block = (n: number) =>
    task(n, 'Review PRs', {
      startDate: TODAY,
      timeBucket: 'morning',
      inProjectBlock: true,
      previousStartTime: '14:00',
      previousStartDate: '2026-09-30',
    });
  for (const args of [
    // Not scheduled, so a time schedules it (scheduleTask), the block fields cleared.
    [
      'time-unscheduled-dated',
      task(1240, 'Draft Q4 roadmap', { startDate: TODAY, timeBucket: 'morning', isScheduled: false }),
      { action: 'time', startTime: '10:00' },
    ],
    [
      'time-same-bucket-new-time',
      task(1241, 'Draft Q4 roadmap', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00', duration: 120 }),
      { action: 'time', startTime: '10:30' },
    ],
    [
      'time-crossing-buckets-by-bucket',
      task(1242, 'Gym', { startDate: TODAY, timeBucket: 'evening', startTime: '17:30', duration: 60 }),
      { action: 'time', timeBucket: 'morning', startTime: '07:00' },
    ],
    // The mapper's auto-correct files the time: no part of day sent.
    [
      'time-crossing-buckets-by-time',
      task(1243, 'Standup', { startDate: TODAY, timeBucket: 'morning', startTime: '10:00' }),
      { action: 'time', startTime: '15:00' },
    ],
    [
      'time-anytime-drops-time',
      task(1244, 'Lunch walk', { startDate: TODAY, timeBucket: 'afternoon', startTime: '12:30' }),
      { action: 'time', timeBucket: 'anytime', startTime: null },
    ],
    // The dialog's effectiveBucket: a dated task with none reads as Anytime, and picking it
    // writes it. The phone never sends this (Anytime is already checked there).
    ['time-dated-no-bucket-anytime', task(1245, 'Call the bank', { startDate: TODAY }), { action: 'time', timeBucket: 'anytime' }],
    [
      'time-habit-set',
      habit(1250, 'Stretch', { timeBucket: 'morning' }),
      { action: 'time', timeBucket: 'evening', startTime: '21:00' },
    ],
    [
      'time-habit-no-specific-time',
      habit(1251, 'Meds', { timeBucket: 'morning', startTime: '08:00' }),
      { action: 'time', startTime: null },
    ],
    // "No specific bucket": the server takes it; the phone's sheet never offers it.
    [
      'time-habit-clear',
      habit(1252, 'Read', { timeBucket: 'evening', startTime: '21:30' }),
      { action: 'time', timeBucket: null, startTime: null },
    ],
    // The time files the habit back in Morning, and the web writes it anyway.
    [
      'time-habit-time-overrules-bucket',
      habit(1253, 'Meds', { timeBucket: 'morning', startTime: '09:00' }),
      { action: 'time', timeBucket: 'evening' },
    ],
    // A part of day picked away from the block's releases it; a new time alone keeps it.
    ['time-in-project-block-by-bucket', block(1260), { action: 'time', timeBucket: 'afternoon' }],
    ['time-in-project-block-same-bucket', block(1261), { action: 'time', startTime: '09:30' }],
    ['time-in-project-block-cross-bucket-by-time', block(1262), { action: 'time', startTime: '15:00' }],
    [
      'time-duration-only',
      task(1263, 'Review PRs', { startDate: TODAY, timeBucket: 'afternoon', startTime: '13:30', duration: 60 }),
      { action: 'time', duration: 90 },
    ],
    // A length alone never schedules.
    [
      'time-duration-only-unscheduled',
      task(1264, 'Groceries', { startDate: TODAY, timeBucket: 'anytime', isScheduled: false }),
      { action: 'time', duration: 45 },
    ],
    // None stored reads as the type's default block, 30: already so.
    [
      'time-duration-seed-unchanged',
      task(1265, 'Call the dentist', { startDate: TODAY, timeBucket: 'afternoon', startTime: '15:00' }),
      { action: 'time', duration: 30 },
    ],
    ['time-duration-habit', habit(1266, 'Journal', { timeBucket: 'morning', duration: 15 }), { action: 'time', duration: 30 }],
    [
      'time-custom',
      custom(1267, 'errand', 'Post office', { startDate: TODAY, timeBucket: 'afternoon' }),
      { action: 'time', timeBucket: 'evening' },
    ],
    ['time-refused-undated', task(1270, 'Call the bank', { isScheduled: false }), { action: 'time', duration: 45 }, 'not_dated'],
    // Before not_dated: a subtask has no time of its own at all.
    [
      'time-refused-subtask',
      task(1271, 'Pull the numbers', { parentItemId: uid(1241), isScheduled: false }),
      { action: 'time', duration: 45 },
      'not_for_subtask',
    ],
    // The row's refusal: a time sent alone, under a stored Anytime.
    [
      'time-refused-time-on-anytime',
      task(1272, 'Groceries', { startDate: TODAY, timeBucket: 'anytime' }),
      { action: 'time', startTime: '09:00' },
      'invalid',
    ],
    // The schema's two: a time beside Anytime in the same body, and nothing to change.
    [
      'time-refused-anytime-with-a-time',
      task(1273, 'Groceries', { startDate: TODAY, timeBucket: 'morning' }),
      { action: 'time', timeBucket: 'anytime', startTime: '09:00' },
      'invalid',
    ],
    ['time-refused-empty', task(1274, 'Groceries', { startDate: TODAY, timeBucket: 'morning' }), { action: 'time' }, 'invalid'],
  ] as [string, Item, ItemEdit, string?][]) {
    cases.push(await editCase(...args));
  }

  // The Repeat chip (2e): a frequency, with Custom days' keys or Monthly's day, written as all
  // three keys together, or nothing when the draft is its seed.
  const gym = (n: number) => task(n, 'Gym', { startDate: TODAY });
  for (const args of [
    [
      'repeat-none-task',
      task(1280, 'Water the plants', { startDate: '2026-09-01', timeBucket: 'morning', repeatFrequency: 'daily' }),
      { action: 'repeat', frequency: 'none' },
    ],
    ['repeat-daily', task(1281, 'Groceries', { startDate: TODAY, timeBucket: 'anytime' }), { action: 'repeat', frequency: 'daily' }],
    [
      'repeat-custom',
      task(1282, 'Gym', { startDate: TODAY, timeBucket: 'evening' }),
      { action: 'repeat', frequency: 'custom', days: [1, 3, 5] },
    ],
    ['repeat-monthly', task(1283, 'Pay rent', { startDate: TODAY }), { action: 'repeat', frequency: 'monthly', monthDay: 1 }],
    // A habit always repeats: the registry never offers it No repeat.
    ['repeat-refused-habit-none', habit(1284, 'Meds'), { action: 'repeat', frequency: 'none' }, 'frequency_not_allowed'],
    // A repeat touches no status: a finished one-off stays finished.
    [
      'repeat-finished-one-off-keeps-status',
      task(1285, 'Renew passport', { startDate: '2026-09-30', status: 'completed' }),
      { action: 'repeat', frequency: 'weekdays' },
    ],
    // The same days in another order differ by JSON, as the dialog compares its draft.
    [
      'repeat-custom-days-reordered',
      task(1286, 'Gym', { startDate: TODAY, repeatFrequency: 'custom', repeatDays: [3, 1] }),
      { action: 'repeat', frequency: 'custom', days: [1, 3] },
    ],
    [
      'repeat-custom-to-monthly',
      task(1287, 'Gym', { startDate: TODAY, repeatFrequency: 'custom', repeatDays: [1, 3] }),
      { action: 'repeat', frequency: 'monthly', monthDay: 15 },
    ],
    // None stored reads as the type's default, 'none' for a task: already so.
    ['repeat-unchanged-none', task(1288, 'Groceries', { startDate: TODAY }), { action: 'repeat', frequency: 'none' }],
    [
      'repeat-unchanged-days',
      task(1289, 'Gym', { startDate: TODAY, repeatFrequency: 'custom', repeatDays: [1, 3] }),
      { action: 'repeat', frequency: 'custom', days: [1, 3] },
    ],
    // A stale day under Daily is in the seed, so Daily sent alone is already so, and it stays.
    [
      'repeat-stale-month-day-kept',
      task(1290, 'Stretch', { startDate: TODAY, repeatFrequency: 'daily', repeatMonthDay: 15 }),
      { action: 'repeat', frequency: 'daily' },
    ],
    // No day stored seeds the 1st.
    [
      'repeat-monthly-no-day-stored',
      task(1291, 'Pay rent', { startDate: TODAY, repeatFrequency: 'monthly' }),
      { action: 'repeat', frequency: 'monthly', monthDay: 1 },
    ],
    ['repeat-habit-weekdays', habit(1292, 'Meds'), { action: 'repeat', frequency: 'weekdays' }],
    ['repeat-habit-custom', habit(1293, 'Water the plants'), { action: 'repeat', frequency: 'custom', days: [0, 3] }],
    [
      'repeat-custom-type-monthly',
      custom(1294, 'errand', 'Pay rent', { startDate: TODAY }),
      { action: 'repeat', frequency: 'monthly', monthDay: 31 },
    ],
    // A subtask shows only in its parent's sheet, so a repeat there would show nowhere.
    [
      'repeat-refused-subtask',
      task(1295, 'Write the three bets', { parentItemId: uid(1), isScheduled: false }),
      { action: 'repeat', frequency: 'daily' },
      'not_for_subtask',
    ],
    ['repeat-weekends', task(1296, 'Long run', { startDate: TODAY }), { action: 'repeat', frequency: 'weekends' }],
    // The schema's nine: days or a day beside the wrong frequency, missing, out of order or out
    // of range.
    ['repeat-refused-days-without-custom', gym(1297), { action: 'repeat', frequency: 'daily', days: [1] }, 'invalid'],
    ['repeat-refused-custom-without-days', gym(1298), { action: 'repeat', frequency: 'custom' }, 'invalid'],
    ['repeat-refused-custom-empty-days', gym(1299), { action: 'repeat', frequency: 'custom', days: [] }, 'invalid'],
    ['repeat-refused-days-unsorted', gym(1300), { action: 'repeat', frequency: 'custom', days: [3, 1] }, 'invalid'],
    ['repeat-refused-day-twice', gym(1301), { action: 'repeat', frequency: 'custom', days: [1, 1] }, 'invalid'],
    ['repeat-refused-day-seven', gym(1302), { action: 'repeat', frequency: 'custom', days: [7] }, 'invalid'],
    [
      'repeat-refused-month-day-without-monthly',
      gym(1303),
      { action: 'repeat', frequency: 'daily', monthDay: 1 },
      'invalid',
    ],
    ['repeat-refused-monthly-without-day', gym(1304), { action: 'repeat', frequency: 'monthly' }, 'invalid'],
    ['repeat-refused-month-day-32', gym(1305), { action: 'repeat', frequency: 'monthly', monthDay: 32 }, 'invalid'],
  ] as [string, Item, ItemEdit, string?][]) {
    cases.push(await editCase(...args));
  }

  // The project chip (2f): the bulk Move to project for the one item, by name and id, with the
  // release of a task parked in its old project's block. Work is uid(1310), Health uid(1311).
  const WORK = uid(1310);
  const HEALTH = uid(1311);
  const standup = (n: number, over: Record<string, unknown> = {}) =>
    task(n, 'Standup', { startDate: TODAY, project: 'Work', projectId: WORK, ...over });
  /** Parked in Work's block (moveTasksToProjectBlock): the block's part of day, its own slot stashed. */
  const parked = (n: number, over: Record<string, unknown> = {}) =>
    task(n, 'Review PRs', {
      project: 'Work',
      projectId: WORK,
      startDate: TODAY,
      timeBucket: 'morning',
      inProjectBlock: true,
      previousStartTime: '14:00',
      previousStartDate: TODAY,
      ...over,
    });
  for (const args of [
    ['project-set', task(1312, 'Groceries', { startDate: TODAY, timeBucket: 'anytime' }), WORK],
    ['project-same-name-and-id', standup(1313), WORK],
    // The project kind folds case: 'work' is already Work, and stays as written.
    ['project-same-name-folded', standup(1314, { project: 'work' }), WORK],
    // Name AND id: a folded match whose id is stale, or missing, still writes, which repairs the link.
    ['project-same-name-stale-id', standup(1315, { projectId: uid(1399) }), WORK],
    ['project-text-only-relink', standup(1316, { projectId: undefined }), WORK],
    ['project-move', standup(1317), HEALTH],
    ['project-clear', standup(1318), null],
    ['project-clear-text-only', standup(1319, { project: 'Health', projectId: undefined }), null],
    ['project-clear-unfiled', task(1320, 'Groceries', { startDate: TODAY }), null],
    // A habit carries '' unfiled, as lib/db.ts itemFromRow serves it.
    ['project-habit-set', habit(1321, 'Meds', { project: '' }), WORK],
    ['project-habit-clear', habit(1322, 'Water the plants', { project: 'Health', projectId: HEALTH }), null],
    // '' is a name to the bulk path, so an unfiled habit's clear writes, as the web's always does.
    ['project-habit-clear-unfiled', habit(1323, 'Floss', { project: '' }), null],
    ['project-custom', custom(1324, 'errand', 'Post office', { startDate: TODAY }), WORK],
    // Out of the block it no longer belongs to: its own slot back, the block's part of day kept.
    ['project-leave-block', parked(1325), HEALTH],
    ['project-leave-block-clear', parked(1326), null],
    // A same-name link repair keeps it in its own block.
    ['project-same-name-in-block', parked(1327, { projectId: uid(1399) }), WORK],
    // Parked from the braindump, with nothing stashed: released with no time and no day.
    ['project-leave-block-undated', parked(1328, { previousStartTime: undefined, previousStartDate: undefined }), HEALTH],
    [
      'project-refused-subtask',
      task(1329, 'Write the three bets', { parentItemId: uid(1), isScheduled: false }),
      WORK,
      'not_for_subtask',
    ],
    // The schema's: a project is named by its id, never its name.
    ['project-refused-not-a-uuid', task(1330, 'Groceries', { startDate: TODAY }), 'work', 'invalid'],
  ] as [string, Item, string | null, string?][]) {
    cases.push(await projectCase(...args));
  }

  // The routine and season chips (2f-b): Morning routine is uid(1340), Autumn uid(1341).
  const groceries = (n: number) => task(n, 'Groceries', { startDate: TODAY });
  for (const args of [
    // Members the store hasn't loaded (trashed, or another list's) are kept, in place.
    ['collect-routine-add', groceries(1342), 'routine', [uid(1343), uid(1344)], true],
    ['collect-routine-remove', habit(1345, 'Journal'), 'routine', [uid(1346), uid(1345), uid(1347)], false],
    // Already so: nothing written, and no history entry.
    ['collect-routine-already-member', habit(1348, 'Meds'), 'routine', [uid(1348)], true],
    ['collect-routine-remove-absent', groceries(1349), 'routine', [uid(1350)], false],
    ['collect-season-add', habit(1351, 'Journal'), 'season', [], true],
    ['collect-season-remove', task(1352, 'Gym', { startDate: TODAY }), 'season', [uid(1353), uid(1352)], false],
    ['collect-custom-add', custom(1354, 'errand', 'Post office', { startDate: TODAY }), 'routine', [], true],
    // A subtask shows only in its parent's sheet (isCollectible).
    [
      'collect-refused-subtask',
      task(1355, 'Write the three bets', { parentItemId: uid(1), isScheduled: false }),
      'routine',
      [],
      true,
      'not_collectible',
    ],
    // The schema's: a container is named by its id, and only a routine or a season.
    [
      'collect-refused-container-not-a-uuid',
      groceries(1356),
      'routine',
      [],
      true,
      'invalid',
      { action: 'collect', kind: 'routine', containerId: 'morning', member: true },
    ],
    [
      'collect-refused-kind-goal',
      groceries(1357),
      'routine',
      [],
      true,
      'invalid',
      { action: 'collect', kind: 'goal', containerId: uid(1340), member: true },
    ],
  ] as [string, Item, 'routine' | 'season', string[], boolean, string?, Record<string, unknown>?][]) {
    cases.push(await collectCase(...args));
  }

  const trim = (
    [
      ['spaces', '  hi  '],
      ['tabs and line ends', '\t\n\u000b\f\r hi \r\n'],
      ['no-break space', ' hi '],
      ['byte order mark', '﻿ hi '],
      ['next line is not whitespace to JS', '\u0085hi\u0085'],
      ['line and paragraph separators', ' hi '],
      ['ogham and the en quad to hair space range', '   hi '],
      ['narrow no-break, math and ideographic spaces', '  hi　'],
      ['zero-width space is not whitespace', '​hi​'],
      ['inner whitespace stays', ' a \n b '],
      ['only whitespace', '  ﻿\n'],
      ['a space at position 500', `${'x'.repeat(500)} `],
    ] as [string, string][]
  ).map(([name, input]) => ({ name, input, expected: input.trim() }));

  const limits: EditLimits = {
    title: EDIT_LIMITS.title,
    notes: EDIT_LIMITS.notes,
    outerTitle: OUTER_LIMITS.title,
    outerNotes: OUTER_LIMITS.notes,
    newTitle: NEW_TITLE_LIMIT,
    bulkMax: MAX_BULK_ITEMS,
    anchor: EDIT_LIMITS.anchor,
    outerAnchor: OUTER_LIMITS.anchor,
    timesPerDayMax: TIMES_PER_DAY_MAX,
    durationMax: MAX_DURATION_MINUTES,
  };
  const streakRun = [0, 1, 2, 41].map((streak) => ({ streak, text: streakRunText(streak) }));
  // JS's edges among them: parseInt's leading digits ("9:30", "12pm"), its leading space, sign
  // and hex (" 9:00", "-1:00" filing as Evening under `hour < 5`, "0x0f:00" as 15), NaN for "",
  // "x" and ":30" (Anytime), "24:00" filing as Evening, and a time that isn't one correcting
  // Morning to Anytime.
  const buckets: EditBuckets = {
    forTime: [
      ...['00:00', '11:59', '12:00', '16:59', '17:00', '23:59', '04:59', '05:00', '9:30', '24:00', '', 'x'],
      ...[' 9:00', '12pm', '-1:00', '0x0f:00', ':30'],
    ].map((time) => ({ time, bucket: getBucketForTime(time) })),
    corrected: (
      [
        ['15:00', 'morning'],
        ['09:00', 'evening'],
        ['09:00', 'anytime'],
        ['', 'morning'],
        ['21:00', null],
        ['12:00', 'morning'],
        ['16:59', 'evening'],
        ['17:00', 'afternoon'],
        ['x', 'morning'],
      ] as [string, TimeBucket | null][]
    ).map(([time, bucket]) => ({ time, bucket, expected: autoCorrectBucket(time, bucket ?? undefined) ?? null })),
    starts: { ...BUCKET_START_TIMES },
  };
  const presets = DURATION_ORDER.map(Number);
  const durations: EditDurations = {
    presets,
    labels: [...presets, 50, 75, 180].map((minutes) => ({ minutes, label: durationLabel(minutes) })),
  };
  return {
    today: TODAY,
    limits,
    projects: PROJECTS.map(({ id, name }) => ({ id, name })),
    cases,
    trim,
    bulk: bulkCases(),
    streakRun,
    copy: { ...EDIT_COPY },
    repeats: {
      labels: Object.entries(REPEAT_FREQUENCY_LABELS).map(([frequency, label]) => ({ frequency, label })),
      weekdays: [...WEEKDAY_LABELS],
    },
    containers: {
      project: {
        label: CONTAINER_KINDS.project.label,
        labelPlural: CONTAINER_KINDS.project.labelPlural,
        unsetLabel: CONTAINER_KINDS.project.unsetLabel!,
      },
      routine: { label: CONTAINER_KINDS.routine.label, labelPlural: CONTAINER_KINDS.routine.labelPlural },
      season: { label: CONTAINER_KINDS.season.label, labelPlural: CONTAINER_KINDS.season.labelPlural },
    },
    buckets,
    durations,
  };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';
/** As the fixture holds it: undefined dropped from items, a cleared key kept as null. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));
const asWritten = (updates: Record<string, unknown>) =>
  asJson(Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, v ?? null])));

describe('edit writes shared with DsulCore', () => {
  let generated: EditWrites;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    generated = await build();
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, serialize(generated));
    }
  });
  afterAll(() => vi.useRealTimers());

  it('edit-writes.json exists', () => {
    expect(existsSync(FILE), `missing ${FILE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('edit-writes.json has cases with unique names', () => {
    for (const list of [generated.cases, generated.trim, generated.bulk]) {
      expect(list.length).toBeGreaterThan(0);
      const names = list.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('edit-writes.json is what the web does today', () => {
    // On drift: if the change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ItemEdit.swift and in /api/app/items/:id.
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(serialize(generated)));
  });

  it('every body is one the route parses, but those the schema refuses', () => {
    const refused: string[] = [];
    for (const c of generated.cases) {
      const parsed = ItemWriteSchema.safeParse(c.edit);
      if (!parsed.success) {
        // Refused before the row is read, so its refusal is the schema's.
        expect(c.refusal, c.name).toBe('invalid');
        refused.push(c.name);
        continue;
      }
      // Nothing the schema would add or strip: the fixture is the wire.
      expect(asJson(parsed.data), c.name).toEqual(c.edit);
    }
    expect(refused).toEqual([
      'reminder-anchor-without-time',
      'time-refused-anytime-with-a-time',
      'time-refused-empty',
      'repeat-refused-days-without-custom',
      'repeat-refused-custom-without-days',
      'repeat-refused-custom-empty-days',
      'repeat-refused-days-unsorted',
      'repeat-refused-day-twice',
      'repeat-refused-day-seven',
      'repeat-refused-month-day-without-monthly',
      'repeat-refused-monthly-without-day',
      'repeat-refused-month-day-32',
      'project-refused-not-a-uuid',
      'collect-refused-container-not-a-uuid',
      'collect-refused-kind-goal',
    ]);
  });

  it('lib/item-edit.ts refuses, and writes, what the web gesture did', () => {
    const fields = ['title', 'notes', 'priority', 'timesPerDay', 'reminder', 'time', 'repeat', 'project'];
    for (const c of generated.cases) {
      if (!fields.includes(String(c.edit.action))) continue;
      // A body the schema refuses never reaches the row (the check above).
      if (!ItemWriteSchema.safeParse(c.edit).success) continue;
      const edit = ItemWriteSchema.parse(c.edit) as ItemEdit;
      const shape = shapeOf(c.item);
      const config = getItemTypeConfig(itemTypeName(c.item));
      expect(editRefusal(shape, edit, config)?.code ?? null, c.name).toBe(c.refusal);
      if (c.refusal) {
        expect(c.updates, c.name).toBeNull();
        expect(c.after, c.name).toEqual(asJson(c.item));
        continue;
      }
      // The project the route reads for a project edit, from the fixture's own list.
      const project =
        edit.action === 'project'
          ? edit.projectId === null
            ? null
            : generated.projects.find((p) => p.id === edit.projectId)!
          : undefined;
      const patch = editPatch(shape, edit, config, { project });
      expect(asWritten(patch), c.name).toEqual(c.updates);
      // The phone's step is the item with the patch on it, and so is the store's.
      expect(asJson({ ...c.item, ...patch }), c.name).toEqual(c.after);
    }
  });

  it('a reminder writes both columns, and a time alone keeps the words', () => {
    const reminders = generated.cases.filter(
      (c) => c.edit.action === 'reminder' && c.refusal === null && Object.keys(c.updates!).length > 0,
    );
    expect(reminders.length).toBeGreaterThan(0);
    for (const c of reminders) {
      expect(Object.keys(c.updates!).sort(), c.name).toEqual(['reminderAnchor', 'reminderTime']);
    }
    const timeAlone = reminders.filter((c) => c.edit.time !== null && !('anchor' in c.edit));
    expect(timeAlone.map((c) => c.name).sort()).toEqual(['reminder-set', 'reminder-time-only-keeps-anchor']);
    for (const c of timeAlone) {
      expect(c.updates!.reminderAnchor, c.name).toEqual(
        (c.item as { reminderAnchor?: string }).reminderAnchor?.trim() || null,
      );
    }
    const unchanged = generated.cases.find((c) => c.name === 'reminder-unchanged')!;
    expect(unchanged.refusal).toBeNull();
    expect(unchanged.updates).toEqual({});
  });

  it('a time edit never writes the day, and releases a block only when its part of day moves', () => {
    const times = generated.cases.filter((c) => c.edit.action === 'time' && c.refusal === null);
    expect(times.length).toBeGreaterThan(0);
    for (const c of times) expect(c.updates, c.name).not.toHaveProperty('startDate');
    const blocks = times.filter((c) => (c.item as { inProjectBlock?: boolean }).inProjectBlock);
    expect(blocks.map((c) => c.name).sort()).toEqual([
      'time-in-project-block-by-bucket',
      'time-in-project-block-cross-bucket-by-time',
      'time-in-project-block-same-bucket',
    ]);
    expect(blocks.filter((c) => 'inProjectBlock' in c.updates!).map((c) => c.name)).toEqual([
      'time-in-project-block-by-bucket',
    ]);
    const released = blocks.find((c) => c.name === 'time-in-project-block-by-bucket')!;
    expect(released.updates).toMatchObject({ inProjectBlock: false, previousStartTime: null, previousStartDate: null });
  });

  it('a repeat writes its three keys together, and nothing else', () => {
    const repeats = generated.cases.filter(
      (c) => c.edit.action === 'repeat' && c.refusal === null && Object.keys(c.updates!).length > 0,
    );
    expect(repeats.length).toBeGreaterThan(0);
    // Never the date, the status, the streak or the completion history.
    const kept = (i: Item | null) => {
      const x = i as { status?: string; startDate?: string; streak?: number; completedDates?: string[] };
      return { status: x.status, startDate: x.startDate, streak: x.streak, completedDates: x.completedDates };
    };
    for (const c of repeats) {
      expect(Object.keys(c.updates!).sort(), c.name).toEqual(['repeatDays', 'repeatFrequency', 'repeatMonthDay']);
      expect(kept(c.after), c.name).toEqual(kept(asJson(c.item)));
    }
  });

  it('a re-file writes the name and the id, and the release only when it leaves a block', () => {
    const refiles = generated.cases.filter(
      (c) => c.edit.action === 'project' && c.refusal === null && Object.keys(c.updates!).length > 0,
    );
    expect(refiles.length).toBeGreaterThan(0);
    const release = ['inProjectBlock', 'previousStartDate', 'previousStartTime', 'startDate', 'startTime'];
    for (const c of refiles) {
      const i = c.item as { project?: string; inProjectBlock?: boolean; timeBucket?: string };
      const target = c.edit.projectId === null ? undefined : generated.projects.find((p) => p.id === c.edit.projectId)!.name;
      const leaves = Boolean(i.inProjectBlock) && !sameProjectName(i.project, target);
      expect(Object.keys(c.updates!).sort(), c.name).toEqual(
        [...(leaves ? release : []), 'project', 'projectId'].sort(),
      );
      // The part of day stays the block's: the stash holds none.
      expect((c.after as { timeBucket?: string }).timeBucket, c.name).toEqual(i.timeBucket);
    }
    expect(refiles.filter((c) => 'inProjectBlock' in c.updates!).map((c) => c.name)).toEqual([
      'project-leave-block',
      'project-leave-block-clear',
      'project-leave-block-undated',
    ]);
  });

  it('a toggle writes one list or none, in the store’s order', () => {
    const toggles = generated.cases.filter((c) => c.edit.action === 'collect');
    expect(toggles.length).toBeGreaterThan(0);
    for (const c of toggles) {
      // The route's gate, on the row it reads.
      const i = c.item as { parentItemId?: string };
      const collectible = isCollectible(capabilityShape({ type: itemTypeName(c.item), parent_item_id: i.parentItemId }));
      if (c.refusal) {
        expect(c.updates, c.name).toBeNull();
        expect(c.member, c.name).toBeUndefined();
        if (c.refusal === 'not_collectible') expect(collectible, c.name).toBe(false);
        else expect(ItemWriteSchema.safeParse(c.edit).success, c.name).toBe(false);
        expect(c.after, c.name).toEqual(asJson(c.item));
        continue;
      }
      expect(collectible, c.name).toBe(true);
      // A membership is no field of the item.
      expect(c.updates, c.name).toEqual({});
      expect(c.after, c.name).toEqual(asJson(c.item));
      const { kind, containerId, before, after } = c.member!;
      expect({ kind, containerId }, c.name).toEqual({ kind: c.edit.kind, containerId: c.edit.containerId });
      const id = c.item.id;
      const expected = c.edit.member
        ? before.includes(id) ? before : [...before, id]
        : before.filter((x) => x !== id);
      expect(after, c.name).toEqual(expected);
    }
    // Every case but the collect ones keeps its bytes: no `member` key.
    expect(generated.cases.filter((c) => c.member).every((c) => c.edit.action === 'collect')).toBe(true);
  });

  it('a delete takes the item and, unless it is a habit, its subtasks, in the store’s order', () => {
    for (const c of generated.cases) {
      if (c.edit.action !== 'delete') continue;
      const cascades = c.item.type !== 'habit';
      const expected = [c.item.id, ...(cascades ? c.children.filter((ch) => (ch as { parentItemId?: string }).parentItemId === c.item.id) : []).map((ch) => ch.id)];
      expect(c.removed, c.name).toEqual(expected);
      expect(c.after, c.name).toBeNull();
      expect(c.updates, c.name).toEqual({});
    }
  });

  it('a new subtask is the store’s task under the item, and is refused where the route refuses it', () => {
    for (const c of generated.cases) {
      if (c.edit.action !== 'addSubtask') continue;
      const config = getItemTypeConfig(itemTypeName(c.item));
      expect(subtaskRefusal(shapeOf(c.item), config)?.code ?? null, c.name).toBe(c.refusal);
      // The parent is never written: the add is a new row.
      expect(c.after, c.name).toEqual(asJson(c.item));
      if (c.refusal) {
        expect(c.updates, c.name).toBeNull();
        expect(c.created, c.name).toBeNull();
        continue;
      }
      expect(c.updates, c.name).toEqual({});
      // The store's `tasks.length`: every task-like row that is not a subtask.
      const order = [c.item, ...c.children].filter(
        (i) => i.type !== 'habit' && !(i as { parentItemId?: string }).parentItemId,
      ).length;
      expect(c.created, c.name).toEqual({
        type: 'task',
        id: c.edit.id,
        title: c.edit.title,
        status: 'pending',
        isScheduled: false,
        order,
        parentItemId: c.item.id,
      });
    }
  });

  it('a reset writes the streak alone, and nothing at 0', () => {
    for (const c of generated.cases) {
      if (c.edit.action !== 'resetStreak') continue;
      const config = getItemTypeConfig(itemTypeName(c.item));
      expect(resetStreakRefusal(config)?.code ?? null, c.name).toBe(c.refusal);
      if (c.refusal) {
        expect(c.updates, c.name).toBeNull();
        expect(c.after, c.name).toEqual(asJson(c.item));
        continue;
      }
      const patch = resetStreakPatch(shapeOf(c.item));
      expect(asWritten(patch), c.name).toEqual(c.updates);
      expect(asJson({ ...c.item, ...patch }), c.name).toEqual(c.after);
      // The completion history stays: days already ticked remain ticked.
      const kept = (i: Item | null) => ({
        completedDates: (i as { completedDates?: string[] }).completedDates,
        dailyCounts: (i as { dailyCounts?: Record<string, number> }).dailyCounts,
      });
      expect(kept(c.after), c.name).toEqual(kept(asJson(c.item)));
    }
  });

  it('the cases reach every answer the route gives', () => {
    const cases = generated.cases;
    const actions = new Set(cases.map((c) => c.edit.action));
    expect(actions).toEqual(
      new Set([
        'title',
        'notes',
        'delete',
        'addSubtask',
        'resetStreak',
        'priority',
        'timesPerDay',
        'reminder',
        'time',
        'repeat',
        'project',
        'collect',
      ]),
    );
    // Refused, already so, a write, and a cleared column.
    expect(cases.some((c) => c.refusal === 'invalid' && c.edit.action === 'title')).toBe(true);
    expect(cases.some((c) => c.refusal === 'invalid' && c.edit.action === 'notes')).toBe(true);
    for (const action of ['title', 'notes', 'priority', 'timesPerDay', 'reminder', 'time', 'repeat', 'project']) {
      const of = cases.filter((c) => c.edit.action === action && !c.refusal);
      expect(of.some((c) => Object.keys(c.updates!).length === 0), action).toBe(true);
      expect(of.some((c) => Object.keys(c.updates!).length > 0), action).toBe(true);
    }
    expect(cases.some((c) => c.edit.notes === null && c.updates?.notes === null)).toBe(true);
    // A stored title over the cap is edited at a length the cap alone would refuse.
    expect(cases.some((c) => c.updates?.title && String(c.updates.title).length > EDIT_LIMITS.title)).toBe(true);
    // A cascade, a delete that cascades nothing, and a habit that takes nothing with it.
    expect(cases.some((c) => c.removed.length > 2)).toBe(true);
    expect(cases.some((c) => c.edit.action === 'delete' && c.removed.length === 1 && c.children.length === 0)).toBe(true);
    expect(cases.some((c) => c.item.type === 'habit' && c.removed.length === 1 && c.children.length > 0)).toBe(true);
    // A new subtask under a task and under a custom item, and both refusals.
    const added = cases.filter((c) => c.edit.action === 'addSubtask');
    expect(new Set(added.filter((c) => c.created).map((c) => c.item.type))).toEqual(new Set(['task', 'custom']));
    expect(new Set(added.map((c) => c.refusal))).toEqual(new Set([null, 'no_subtasks', 'nested']));
    // A reset that writes, one already so, and one refused.
    const resets = cases.filter((c) => c.edit.action === 'resetStreak');
    expect(resets.some((c) => c.updates && Object.keys(c.updates).length > 0)).toBe(true);
    expect(resets.some((c) => c.updates && Object.keys(c.updates).length === 0)).toBe(true);
    expect(resets.some((c) => c.refusal === 'no_streak')).toBe(true);
    // The chips' refusals: each capability, and the two cue-word refusals, one
    // the schema's (no time) and one the growth cap's.
    expect(cases.some((c) => c.refusal === 'no_priority' && c.edit.action === 'priority')).toBe(true);
    expect(cases.some((c) => c.refusal === 'no_count' && c.edit.action === 'timesPerDay')).toBe(true);
    expect(cases.some((c) => c.refusal === 'not_remindable' && c.edit.action === 'reminder')).toBe(true);
    const refusedReminders = cases.filter((c) => c.refusal === 'invalid' && c.edit.action === 'reminder');
    expect(refusedReminders.filter((c) => !ItemWriteSchema.safeParse(c.edit).success)).toHaveLength(1);
    expect(refusedReminders.filter((c) => ItemWriteSchema.safeParse(c.edit).success)).toHaveLength(1);
    // A priority cleared with null, and a reminder turned off with both columns cleared.
    expect(cases.some((c) => c.edit.priority === null && c.updates?.priority === null)).toBe(true);
    expect(
      cases.some(
        (c) => c.edit.action === 'reminder' && c.edit.time === null && c.updates?.reminderTime === null && c.updates?.reminderAnchor === null,
      ),
    ).toBe(true);
    // A count already so with none stored: none reads as once a day.
    const timesUnchanged = cases.find((c) => c.name === 'times-unchanged')!;
    expect(timesUnchanged.updates).toEqual({});
    expect(timesUnchanged.item).not.toHaveProperty('timesPerDay');
    // The Time chip's refusals: each code, and three invalids, two the schema's and one the row's.
    const times = cases.filter((c) => c.edit.action === 'time');
    expect(times.some((c) => c.refusal === 'not_dated')).toBe(true);
    expect(times.some((c) => c.refusal === 'not_for_subtask')).toBe(true);
    const refusedTimes = times.filter((c) => c.refusal === 'invalid');
    expect(refusedTimes.filter((c) => !ItemWriteSchema.safeParse(c.edit).success)).toHaveLength(2);
    expect(refusedTimes.filter((c) => ItemWriteSchema.safeParse(c.edit).success)).toHaveLength(1);
    // A habit's time cleared with both keys null, a time on a custom item, and a write whose
    // end row is the stored one.
    expect(
      times.some(
        (c) =>
          c.item.type === 'habit' &&
          c.edit.timeBucket === null &&
          c.updates?.timeBucket === null &&
          c.updates?.startTime === null,
      ),
    ).toBe(true);
    expect(times.some((c) => c.item.type === 'custom' && c.updates && Object.keys(c.updates).length > 0)).toBe(true);
    const overruled = cases.find((c) => c.name === 'time-habit-time-overrules-bucket')!;
    expect(Object.keys(overruled.updates!).length).toBeGreaterThan(0);
    expect(overruled.after).toEqual(asJson(overruled.item));
    // The Repeat chip's refusals: a frequency the type doesn't list, a subtask, and the schema's.
    const repeats = cases.filter((c) => c.edit.action === 'repeat');
    expect(repeats.some((c) => c.refusal === 'frequency_not_allowed')).toBe(true);
    expect(repeats.some((c) => c.refusal === 'not_for_subtask')).toBe(true);
    expect(repeats.some((c) => c.refusal === 'invalid' && !ItemWriteSchema.safeParse(c.edit).success)).toBe(true);
    // Every frequency sent and written, by a habit, a task and a custom item between them.
    for (const frequency of Object.keys(REPEAT_FREQUENCY_LABELS)) {
      expect(
        repeats.some((c) => c.edit.frequency === frequency && !c.refusal && Object.keys(c.updates!).length > 0),
        frequency,
      ).toBe(true);
    }
    expect(new Set(repeats.filter((c) => !c.refusal).map((c) => c.item.type))).toEqual(new Set(['task', 'habit', 'custom']));
    // The project chip's: a subtask refused and the schema's body; a set by a habit, a task and a
    // custom item; a habit's clear written though it was unfiled; a release; a same-name repair
    // that keeps the block.
    const refiles = cases.filter((c) => c.edit.action === 'project');
    expect(refiles.some((c) => c.refusal === 'not_for_subtask')).toBe(true);
    expect(refiles.some((c) => c.refusal === 'invalid' && !ItemWriteSchema.safeParse(c.edit).success)).toBe(true);
    expect(
      new Set(refiles.filter((c) => !c.refusal && Object.keys(c.updates!).length > 0).map((c) => c.item.type)),
    ).toEqual(new Set(['task', 'habit', 'custom']));
    const habitClear = cases.find((c) => c.name === 'project-habit-clear-unfiled')!;
    expect((habitClear.item as { project?: string }).project).toBe('');
    expect(habitClear.updates).toEqual({ project: null, projectId: null });
    expect(refiles.some((c) => c.updates?.inProjectBlock === false)).toBe(true);
    const repair = cases.find((c) => c.name === 'project-same-name-in-block')!;
    expect(Object.keys(repair.updates!).sort()).toEqual(['project', 'projectId']);
    expect((repair.after as { inProjectBlock?: boolean }).inProjectBlock).toBe(true);
    // A folded match, already so, keeps the name as written.
    const folded = cases.find((c) => c.name === 'project-same-name-folded')!;
    expect(folded.updates).toEqual({});
    expect((folded.after as { project?: string }).project).toBe('work');
    // The routine and season chips': a subtask refused and the schema's two bodies; for each
    // kind an add and a remove that write; and each no-op, an add of a member and a remove of
    // one that isn't.
    const toggles = cases.filter((c) => c.edit.action === 'collect');
    expect(toggles.some((c) => c.refusal === 'not_collectible')).toBe(true);
    expect(toggles.filter((c) => c.refusal === 'invalid' && !ItemWriteSchema.safeParse(c.edit).success)).toHaveLength(2);
    const moved = (c: EditCase) => JSON.stringify(c.member!.before) !== JSON.stringify(c.member!.after);
    for (const kind of ['routine', 'season']) {
      for (const member of [true, false]) {
        expect(
          toggles.some((c) => !c.refusal && c.edit.kind === kind && c.edit.member === member && moved(c)),
          `${kind} ${member ? 'add' : 'remove'}`,
        ).toBe(true);
      }
    }
    for (const member of [true, false]) {
      expect(toggles.some((c) => !c.refusal && c.edit.member === member && !moved(c))).toBe(true);
    }
    // By a task, a habit and a custom item between them.
    expect(new Set(toggles.filter((c) => !c.refusal && moved(c)).map((c) => c.item.type))).toEqual(
      new Set(['task', 'habit', 'custom']),
    );
  });

  it('buckets and durations are lib/time-bucket.ts’s and the Time chip’s', () => {
    expect(generated.buckets.starts).toEqual({ morning: '05:00', afternoon: '12:00', evening: '17:00' });
    expect(generated.buckets.forTime.find((b) => b.time === '9:30')?.bucket).toBe('morning');
    expect(generated.buckets.forTime.find((b) => b.time === 'x')?.bucket).toBe('anytime');
    expect(generated.buckets.corrected.find((b) => b.bucket === null)?.expected).toBeNull();
    expect(generated.durations.presets).toEqual([15, 30, 45, 60, 90, 120]);
    expect(generated.durations.labels.find((l) => l.minutes === 90)?.label).toBe('1.5 hours');
    expect(generated.durations.labels.find((l) => l.minutes === 75)?.label).toBe('75 min');
    expect(generated.limits.durationMax).toBe(1440);
  });

  it('bulk reaches a list, a single line and the cap', () => {
    expect(generated.bulk.some((c) => c.isBulk)).toBe(true);
    expect(generated.bulk.some((c) => !c.isBulk)).toBe(true);
    const capped = generated.bulk.filter((c) => c.truncated);
    expect(capped).toHaveLength(1);
    expect(capped[0].titles).toHaveLength(MAX_BULK_ITEMS);
    expect(generated.copy.subtaskPasteCapped).toContain(String(MAX_BULK_ITEMS));
  });

  it('trim is JavaScript’s, which differs from Foundation’s on U+0085 and U+FEFF', () => {
    const byName = (name: string) => generated.trim.find((c) => c.name === name)!;
    expect(byName('next line is not whitespace to JS').expected).toBe('\u0085hi\u0085');
    expect(byName('byte order mark').expected).toBe('hi');
    expect(byName('only whitespace').expected).toBe('');
  });
});

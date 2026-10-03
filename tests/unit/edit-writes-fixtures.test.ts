import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * The item sheet's edits, shared with the iPhone.
 *
 * verb-writes-fixtures.test.ts pins what the sheet's verbs write; this pins its
 * edits (lib/item-edit.ts), its Delete, Add a subtask and Reset streak. Each
 * case drives the web's REAL
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
 * The gestures: a typed field is the item panel's (components/planner/
 * item-dialog.tsx): seeded from the item, the keys that differ from the seed
 * marked changed, then taskUpdatesFromDraft / habitUpdatesFromDraft and the
 * store action they name. Delete is lib/item-verbs.ts's: deleteTask, or
 * deleteHabit. Add a subtask is the panel's subtask field
 * (components/planner/item-detail-sections.tsx SubtasksSection.addSubtask):
 * addTask with the trimmed title and the parent. Reset streak is the verb the
 * phone offers (lib/item-verbs.ts resetStreak), run only when it is eligible,
 * so at 0 it writes nothing. A refused case comes from `refusal` alone, since
 * the store has no such refusal: the dialog never caps a field, and never
 * offers a subtask under a habit or a subtask, or a reset on a task.
 *
 * In `updates`, a key present with null is a column cleared (the store wrote
 * undefined, which lib/db.ts sends as SQL NULL).
 *
 * `trim` pins String.prototype.trim, which the schema's `.trim()` and
 * `cleanNotes` use, for DsulCore's `jsTrim`: Foundation's whitespace set is a
 * different one.
 *
 * `bulk` pins lib/bulk-add.ts's `isBulkPaste` and `splitBulkLinesWithMeta`,
 * which DsulCore's BulkLines.swift ports for a paste into the new-subtask
 * field: what a line break is, which list markers come off, and JS's `\s`.
 * `streakRun` pins `streakRunText`, and `copy` the sentences both sides say
 * (`EDIT_COPY`).
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
  | { fn: 'createItem'; item: Item };

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
    updateRoutine: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
    restoreRoutine: vi.fn(async () => {}),
    fetchSeasons: vi.fn(async () => []),
    createSeason: vi.fn(async () => {}),
    updateSeason: vi.fn(async () => {}),
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
import { habitUpdatesFromDraft, taskUpdatesFromDraft, type ItemDraft } from '@/components/planner/item-dialog';
import { ItemWriteSchema } from '@/lib/app-api';
import {
  EDIT_COPY,
  EDIT_LIMITS,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  editPatch,
  editRefusal,
  editShapeFromRow,
  resetStreakPatch,
  resetStreakRefusal,
  streakRunText,
  subtaskRefusal,
  type ItemEdit,
} from '@/lib/item-edit';
import { MAX_BULK_ITEMS, isBulkPaste, splitBulkLinesWithMeta } from '@/lib/bulk-add';
import { ITEM_VERBS, type VerbContext } from '@/lib/item-verbs';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';

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
const shapeOf = (item: Item) =>
  editShapeFromRow({
    id: item.id,
    type: itemTypeName(item),
    parent_item_id: (item as { parentItemId?: string }).parentItemId ?? null,
    title: item.title,
    notes: item.notes ?? null,
    streak: (item as { streak?: number }).streak ?? null,
  });

// ── Running one case ─────────────────────────────────────────────────────────

/** 11:00 on Thursday 1 October in New York. */
const NOW = '2026-10-01T15:00:00.000Z';
const TODAY = '2026-10-01';
const NY = 'America/New_York';

const store = () => usePlannerStore.getState();

/**
 * A fresh store holding `items`, then `act`: the first item as the store
 * leaves it (null once gone), and every write it sent, in order. Nothing in an
 * act is awaited: the store writes optimistically and fires its db calls in
 * the same tick, so the log is complete when `act` returns.
 */
async function run(items: Item[], act: () => void): Promise<{ after: Item | null; calls: DbCall[] }> {
  vi.setSystemTime(new Date(NOW));
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(structuredClone(items));
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(NOW), userTimezone: NY });
  log.calls.length = 0;
  act();
  const after = store().items.find((i) => i.id === items[0].id);
  return { after: after ? JSON.parse(JSON.stringify(after)) : null, calls: log.calls.splice(0) };
}

/**
 * The panel's typed field: the draft seeded as draftFromItem seeds it, the
 * one field changed, and the save scheduleSave → commitEdit makes of it. A
 * value equal to the seed marks nothing changed, so nothing is written, and a
 * blank title is a state passed through, never saved.
 */
function typeInto(item: Item, key: 'title' | 'notes', value: string): void {
  const prev = { title: item.title, notes: item.notes || '' } as ItemDraft;
  const next = { ...prev, [key]: value } as ItemDraft;
  const changed = (['title', 'notes'] as const).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0 || !next.title.trim()) return;
  if (item.type === 'habit') {
    const updates = habitUpdatesFromDraft(next, changed);
    if (Object.keys(updates).length > 0) store().updateHabit(item.id, updates);
  } else {
    const updates = taskUpdatesFromDraft(next, changed);
    if (Object.keys(updates).length > 0) store().updateTask(item.id, updates);
  }
}

/** lib/item-verbs.ts's Delete, once confirmed. */
function deleteIt(item: Item): void {
  if (item.type === 'habit') store().deleteHabit(item.id);
  else store().deleteTask(item.id);
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
};
type EditWrites = {
  today: string;
  limits: EditLimits;
  cases: EditCase[];
  trim: TrimCase[];
  bulk: BulkCase[];
  streakRun: StreakRunCase[];
  copy: Record<string, string>;
};

async function editCase(name: string, item: Item, edit: ItemEdit, refusal: string | null = null): Promise<EditCase> {
  const base = { name, item, children: [], edit, refusal, removed: [], created: null };
  if (refusal) return { ...base, updates: null, after: item };
  const { after, calls } = await run([item], () =>
    edit.action === 'title' ? typeInto(item, 'title', edit.title) : typeInto(item, 'notes', edit.notes ?? '')
  );
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
  };
  const streakRun = [0, 1, 2, 41].map((streak) => ({ streak, text: streakRunText(streak) }));
  return { today: TODAY, limits, cases, trim, bulk: bulkCases(), streakRun, copy: { ...EDIT_COPY } };
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

  it('every body is one the route parses', () => {
    for (const c of generated.cases) {
      const parsed = ItemWriteSchema.safeParse(c.edit);
      expect(parsed.success, c.name).toBe(true);
      // Nothing the schema would add or strip: the fixture is the wire.
      expect(asJson(parsed.data), c.name).toEqual(c.edit);
    }
  });

  it('lib/item-edit.ts refuses, and writes, what the web gesture did', () => {
    for (const c of generated.cases) {
      if (c.edit.action !== 'title' && c.edit.action !== 'notes') continue;
      const edit = ItemWriteSchema.parse(c.edit) as ItemEdit;
      const shape = shapeOf(c.item);
      const config = getItemTypeConfig(itemTypeName(c.item));
      expect(editRefusal(shape, edit, config)?.code ?? null, c.name).toBe(c.refusal);
      if (c.refusal) {
        expect(c.updates, c.name).toBeNull();
        expect(c.after, c.name).toEqual(asJson(c.item));
        continue;
      }
      const patch = editPatch(shape, edit);
      expect(asWritten(patch), c.name).toEqual(c.updates);
      // The phone's step is the item with the patch on it, and so is the store's.
      expect(asJson({ ...c.item, ...patch }), c.name).toEqual(c.after);
    }
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
    expect(actions).toEqual(new Set(['title', 'notes', 'delete', 'addSubtask', 'resetStreak']));
    // Refused, already so, a write, and a cleared column.
    expect(cases.some((c) => c.refusal === 'invalid' && c.edit.action === 'title')).toBe(true);
    expect(cases.some((c) => c.refusal === 'invalid' && c.edit.action === 'notes')).toBe(true);
    for (const action of ['title', 'notes']) {
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

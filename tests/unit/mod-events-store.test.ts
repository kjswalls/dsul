import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * The raise sites (memory/plans/mods.md, "Recipes", build order item 2): the
 * user's own store actions raise one event per real transition, undo and
 * agent merges raise nothing, a quiet batch flushes its events once, a
 * suppressed run (a recipe's own tick) raises nothing, and ⌘Z takes back what
 * a listener did before the user's tick.
 *
 * Same harness as history-batch.test.ts: db mocked, the REAL store driven.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    createItems: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async () => {}),
    setItemSkip: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { batchHistory, getActionLog, mergeAgentStates, usePlannerStore } from '@/lib/planner-store';
import { useEODStore } from '@/lib/eod-store';
import {
  subscribeModEvents,
  withSuppressed,
  __resetModEventsForTests,
  type ModEvent,
} from '@/lib/mod-events';
import { PREVIEW_ALLOWED_ACTIONS } from '@/lib/preview-write-guard';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-03-10';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as Item;

const habit = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'habit',
    id,
    title: `Habit ${id}`,
    project: 'Wellness',
    streak: 2,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

const recurring = (id: string, over: Partial<Item> = {}): Item =>
  task(id, { repeatFrequency: 'daily', startDate: '2026-03-01', ...over });

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;
type NewTask = Parameters<ReturnType<typeof store>['addTask']>[0];
type NewHabit = Parameters<ReturnType<typeof store>['addHabit']>[0];
const newTask = (title: string, over: Partial<NewTask> = {}) => ({ title, ...over }) as NewTask;

let events: ModEvent[] = [];
/** Run the dispatch task, then hand back (and clear) what was delivered. */
const delivered = () => {
  vi.runAllTimers();
  const out = events;
  events = [];
  return out;
};
const kinds = () => delivered().map((e) => e.kind);

async function load(items: Item[]) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchItemTypes).mockResolvedValue([
    { id: 'it-1', name: 'errand', label: 'Errand', labelPlural: 'Errands' },
  ] as Awaited<ReturnType<typeof db.fetchItemTypes>>);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  // Nothing the load did may count.
  vi.runAllTimers();
  events = [];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  __resetModEventsForTests();
  events = [];
  subscribeModEvents((e) => events.push(e));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('toggleTaskStatus', () => {
  beforeEach(() => load([task('t1'), recurring('r1'), task('w1', { startDate: '2026-03-12' })]));

  it('one-off with a startDate reports that day, not the selected one', () => {
    store().toggleTaskStatus('w1');
    expect(delivered()).toEqual([{ kind: 'item.completed', itemId: 'w1', date: '2026-03-12', type: 'task' }]);
  });

  it('one-off: a tick raises one completed for the day acted on, after the action returns', () => {
    store().toggleTaskStatus('t1');
    expect(events).toEqual([]);
    expect(delivered()).toEqual([{ kind: 'item.completed', itemId: 't1', date: TODAY, type: 'task' }]);

    store().toggleTaskStatus('t1', 'completed');
    expect(delivered()).toEqual([]);

    store().toggleTaskStatus('t1');
    expect(delivered()).toEqual([{ kind: 'item.uncompleted', itemId: 't1', date: TODAY, type: 'task' }]);
  });

  it('recurring: completed then uncompleted, both on the date passed', () => {
    store().toggleTaskStatus('r1', undefined, new Date('2026-03-08T12:00:00Z'));
    store().toggleTaskStatus('r1', undefined, new Date('2026-03-08T12:00:00Z'));
    expect(delivered()).toEqual([
      { kind: 'item.completed', itemId: 'r1', date: '2026-03-08', type: 'task' },
      { kind: 'item.uncompleted', itemId: 'r1', date: '2026-03-08', type: 'task' },
    ]);
  });

  it('a missing item raises nothing', () => {
    store().toggleTaskStatus('nope');
    expect(delivered()).toEqual([]);
  });
});

describe('toggleHabitStatus', () => {
  beforeEach(() => load([habit('h1')]));

  it('raises one event per real transition, at most one per call', () => {
    store().toggleHabitStatus('h1', 'done');
    expect(delivered()).toEqual([{ kind: 'item.completed', itemId: 'h1', date: TODAY, type: 'habit' }]);

    store().toggleHabitStatus('h1', 'done', 3);
    expect(kinds()).toEqual([]);

    store().toggleHabitStatus('h1', 'skipped');
    expect(kinds()).toEqual(['item.skipped']);

    store().toggleHabitStatus('h1', 'pending');
    expect(kinds()).toEqual([]);

    store().toggleHabitStatus('h1', 'done');
    store().toggleHabitStatus('h1', 'pending');
    expect(kinds()).toEqual(['item.completed', 'item.uncompleted']);
  });
});

describe('setItemSkipped', () => {
  beforeEach(() => load([habit('h1'), recurring('r1', { completedDates: [TODAY] })]));

  it('a habit skip raises exactly one item.skipped (no double from the delegation)', () => {
    store().setItemSkipped('h1', true);
    expect(delivered()).toEqual([{ kind: 'item.skipped', itemId: 'h1', date: TODAY, type: 'habit' }]);
  });

  it('a recurring task: skip raises, a repeat skip and an unskip raise nothing', () => {
    store().setItemSkipped('r1', true);
    // The skip also cleared the day's completion; it is only a skip.
    expect(delivered()).toEqual([{ kind: 'item.skipped', itemId: 'r1', date: TODAY, type: 'task' }]);
    store().setItemSkipped('r1', true);
    store().setItemSkipped('r1', false);
    expect(delivered()).toEqual([]);
  });
});

describe('setItemsCompleted', () => {
  beforeEach(() => load([task('a'), task('b', { status: 'completed' }), habit('c')]));

  it('raises once per item that changed', () => {
    store().setItemsCompleted(['a', 'b', 'c'], true);
    expect(delivered()).toEqual([
      { kind: 'item.completed', itemId: 'a', date: TODAY, type: 'task' },
      { kind: 'item.completed', itemId: 'c', date: TODAY, type: 'habit' },
    ]);
    store().setItemsCompleted(['a', 'b', 'c'], true);
    expect(delivered()).toEqual([]);
  });
});

describe('creates', () => {
  beforeEach(() => load([]));

  it('addTask, addHabit and addItem each raise one item.created', () => {
    const tid = store().addTask(newTask('Buy milk', { startDate: TODAY }));
    const hid = store().addHabit({ title: 'Read', project: 'Wellness' } as NewHabit);
    store().addItem('errand', newTask('Post office'));
    const out = delivered();
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'item.created', itemId: tid, type: 'task', date: TODAY });
    expect(out[1]).toEqual({ kind: 'item.created', itemId: hid, type: 'habit' });
    expect(out[2]).toMatchObject({ kind: 'item.created', type: 'errand' });
  });

  it('addItem with an unknown slug raises nothing', () => {
    store().addItem('nope', newTask('x'));
    expect(delivered()).toEqual([]);
  });

  it('addTasksBulk: one row raises once, three rows three times', () => {
    store().addTasksBulk('task', [newTask('one')]);
    expect(kinds()).toEqual(['item.created']);
    store().addTasksBulk('errand', [newTask('a'), newTask('b'), newTask('c')]);
    const out = delivered();
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.kind === 'item.created' && e.type === 'errand')).toBe(true);
  });
});

describe('quiet batches', () => {
  beforeEach(() => load([task('t1'), task('t2'), task('t3')]));

  it('queue inside the batch and flush once, after its entry exists', () => {
    let logAtDispatch = '';
    subscribeModEvents(() => {
      logAtDispatch ||= getActionLog()[0].label;
    });
    batchHistory(
      'Complete items (3)',
      3,
      () => {
        for (const id of ['t1', 't2', 't3']) store().toggleTaskStatus(id);
        vi.runAllTimers();
        expect(events).toEqual([]);
      },
      { quiet: true },
    );
    expect(events).toEqual([]);
    expect(kinds()).toEqual(['item.completed', 'item.completed', 'item.completed']);
    expect(logAtDispatch).toBe('Complete items (3)');
  });

  it('a batch that throws still delivers the writes it applied', () => {
    expect(() =>
      batchHistory(
        'Complete items (2)',
        2,
        () => {
          store().toggleTaskStatus('t1');
          throw new Error('boom');
        },
        { quiet: true },
      ),
    ).toThrow('boom');
    expect(item('t1').status).toBe('completed');
    expect(delivered()).toEqual([{ kind: 'item.completed', itemId: 't1', date: TODAY, type: 'task' }]);
  });

  it('setItemsCompleted inside a quiet batch flushes once, after the entry', () => {
    let logAtDispatch = '';
    subscribeModEvents(() => {
      logAtDispatch ||= getActionLog()[0].label;
    });
    batchHistory('Complete items (2)', 2, () => store().setItemsCompleted(['t1', 't2'], true), { quiet: true });
    expect(kinds()).toEqual(['item.completed', 'item.completed']);
    expect(logAtDispatch).toBe('Complete items (2)');
  });

  it('a quiet batch nested in a loud one delivers each transition once', () => {
    batchHistory('Outer', 2, () => {
      store().toggleTaskStatus('t1');
      batchHistory('Inner', 1, () => store().toggleTaskStatus('t2'), { quiet: true });
    });
    expect(delivered().map((e) => (e as { itemId: string }).itemId).sort()).toEqual(['t1', 't2']);
  });

  it('a suppressed run raises nothing: a recipe\'s own tick', () => {
    withSuppressed(() =>
      batchHistory('Recipe: x', 1, () => store().toggleTaskStatus('t1'), { quiet: true }),
    );
    withSuppressed(() => store().toggleTaskStatus('t2'));
    expect(delivered()).toEqual([]);
    expect(item('t1').status).toBe('completed');
    expect(item('t2').status).toBe('completed');
  });
});

describe('what never raises', () => {
  beforeEach(() => load([task('t1'), task('t2')]));

  it('undo and redo of a tick', () => {
    store().toggleTaskStatus('t1');
    delivered();
    store().undo();
    store().redo();
    expect(delivered()).toEqual([]);
  });

  // A tick or a capture the server made (the iPhone, a reminder's Done, a
  // server recipe run) reaches this browser as a load, which raises nothing,
  // so the browser never runs that tick's recipes a second time.
  it('a load bringing in what the server ticked, skipped and added', async () => {
    store().clearStore();
    vi.mocked(db.fetchItems).mockResolvedValue([
      habit('h9', { completedDates: [TODAY] }),
      recurring('r9', { skippedDates: [TODAY] }),
      task('n9', { status: 'completed' }),
      task('c9'),
    ]);
    events = [];
    await store().initializeStore(USER);
    expect(delivered()).toEqual([]);
  });

  it('an agent merge', () => {
    expect(
      mergeAgentStates([
        { id: 't1', assignee: 'openclaw', aiStatus: 'done', aiResult: 'Done.', aiStatusAt: '2026-10-07T08:00:00.000Z' },
      ]),
    ).toBe(1);
    expect(delivered()).toEqual([]);
  });
});

describe('⌘Z ordering', () => {
  beforeEach(() => load([task('t1'), task('t2')]));

  it('undoes what the listener did before the user\'s tick', () => {
    subscribeModEvents((e) => {
      if (e.kind === 'item.completed' && e.itemId === 't1') store().toggleTaskStatus('t2');
    });
    store().toggleTaskStatus('t1');
    // The listener's own tick runs suppressed, so it raises nothing further.
    expect(kinds()).toEqual(['item.completed']);
    expect(item('t2').status).toBe('completed');

    store().undo();
    expect(item('t2').status).toBe('pending');
    expect(item('t1').status).toBe('completed');
    store().undo();
    expect(item('t1').status).toBe('pending');
  });
});

describe('review.saved', () => {
  it('raises when the date moves, and not for the same date again', async () => {
    useEODStore.setState({ lastEodReviewDate: null });
    await useEODStore.getState().saveLastReviewDate(null, TODAY);
    await useEODStore.getState().saveLastReviewDate(null, TODAY);
    expect(delivered()).toEqual([{ kind: 'review.saved', date: TODAY }]);
  });
});

/**
 * The look-only preview (lib/planner-snapshot.ts) paints THIS browser's copy
 * of the last session while the load is still in flight. A recipe that fired
 * on it would be answering a tick nobody made this session, against rows that
 * are about to be replaced — so the write barrier is the mod-event barrier
 * too: every raise site is an action it refuses, and the landing itself has
 * never raised anything (the test above). Nothing in mod-events.ts knows about
 * the preview, and nothing needs to.
 */
describe('the look-only preview', () => {
  beforeEach(() => load([task('t1'), habit('h1'), recurring('r1')]));
  const preview = () => usePlannerStore.setState({ isPreview: true, isLoading: true });
  const landing = () => usePlannerStore.setState({ isPreview: false, isLoading: false });

  it('refuses every action that raises, so no recipe can hear a cached row', () => {
    for (const name of RAISING_ACTIONS) expect(PREVIEW_ALLOWED_ACTIONS.has(name), name).toBe(false);
    preview();
    expect(store().addTask(newTask('Buy milk'))).toBe('');
    store().addItem('errand', newTask('Post office'));
    store().addTasksBulk('task', [newTask('one'), newTask('two')]);
    store().toggleTaskStatus('t1');
    store().toggleHabitStatus('h1', 'done');
    store().setItemSkipped('r1', true);
    store().setItemsCompleted(['t1'], true);
    expect(delivered()).toEqual([]);
    // Refused at entry, so the cached rows are untouched as well.
    expect(store().items.map((i) => i.id)).toEqual(['t1', 'h1', 'r1']);
    expect(item('t1').status).toBe('pending');
  });

  it('raises nothing at the landing, however much changed under the cached rows', async () => {
    preview();
    vi.mocked(db.fetchItems).mockResolvedValue([
      habit('h1', { completedDates: [TODAY] }),
      recurring('r1', { skippedDates: [TODAY] }),
      task('t1', { status: 'completed' }),
      task('new1'),
    ]);
    events = [];
    await store().initializeStore(USER);
    expect(store().isPreview).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it('raises a capture held through the preview once it is filed at the landing', () => {
    preview();
    expect(store().addTask(newTask('Water the plants'))).toBe('');
    expect(delivered()).toEqual([]);
    // What held-captures.ts does with the line it kept: files it after the
    // landing, one entry each, exactly as if the Enter had landed then. Raised
    // is all this pins: whether a recipe hears it depends on the account's mods
    // having loaded (recipes-engine.test.ts, 'guards').
    landing();
    const id = store().addTask(newTask('Water the plants'));
    expect(delivered()).toEqual([{ kind: 'item.created', itemId: id, type: 'task' }]);
  });

  it('raises nothing for rows a landing brings back: they are not new', () => {
    landing();
    store().refileItems([[task('q1')]]);
    expect(store().items.some((i) => i.id === 'q1')).toBe(true);
    store().settleLandedRows([{ row: task('q1', { title: 'Renamed' }), filed: task('q1'), gone: false }]);
    expect(item('q1').title).toBe('Renamed');
    expect(delivered()).toEqual([]);
  });
});

/**
 * The actions that raise. The plan asks for the list: a raise from any other
 * planner-store action fails below, and the preview barrier must refuse each
 * one. eod-store's single raise is covered by the review test above.
 */
const RAISING_ACTIONS = [
  'addItem',
  'addTask',
  'addTasksBulk',
  'addHabit',
  'toggleTaskStatus',
  'setItemsCompleted',
  'setItemSkipped',
  'toggleHabitStatus',
];

describe('raise sites', () => {
  const ALLOWED = RAISING_ACTIONS;
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('emit( appears only inside the named actions', () => {
    const lines = read('lib/planner-store.ts').split('\n');
    const found = new Set<string>();
    lines.forEach((line, i) => {
      if (!/\bemit\(/.test(line) || /const emit = /.test(line)) return;
      // The nearest store action opened above this line.
      for (let j = i; j >= 0; j--) {
        const m = lines[j].match(/^ {6}(\w+): (?:async )?\(/);
        if (m) {
          found.add(m[1]);
          break;
        }
      }
    });
    expect([...found].sort()).toEqual([...ALLOWED].sort());
  });

  it('the bus is raised directly only from emit, the batch flush and saveLastReviewDate', () => {
    const files = readdirSync(join(process.cwd(), 'lib'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && f !== 'mod-events.ts')
      .map((f) => `lib/${f.split(sep).join('/')}`);
    const hits: string[] = [];
    for (const file of files) {
      read(file).split('\n').forEach((line) => {
        if (/^\s*(\/\/|\*)/.test(line) || /^import /.test(line)) return;
        if (/\braiseModEvents?\(/.test(line)) hits.push(`${file}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([
      'lib/eod-store.ts: if (prev !== date) raiseModEvent({ kind: \'review.saved\', date });',
      'lib/planner-store.ts: else raiseModEvent(e);',
      'lib/planner-store.ts: raiseModEvents(modEvents);',
      'lib/planner-store.ts: else raiseModEvents(effects.modEvents);',
    ]);
  });
});

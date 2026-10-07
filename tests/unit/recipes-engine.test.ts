import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The browser recipe engine (lib/recipes/engine.ts, memory/plans/mods.md
 * "Recipes", build order 4) driven through the REAL planner store and event
 * bus: trigger matching, filters, the verbs' own gates, create, the cap, the
 * rate limit, no cascade, undo order, the stake lock, the guards, the run log
 * and the UI steps.
 *
 * Same harness as mod-events-store.test.ts: db mocked, the real store driven.
 */

const sb = vi.hoisted(() => ({
  calls: [] as { table: string; op: string; args: unknown[] }[],
  /** What the next mod_runs upsert's select answers. */
  claimData: [{ id: 1 }] as unknown[],
}));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let result: unknown = { data: null, error: null };
      for (const op of ['insert', 'upsert', 'update', 'select', 'eq', 'order', 'limit', 'in']) {
        builder[op] = (...args: unknown[]) => {
          sb.calls.push({ table, op, args });
          if (op === 'select' && sb.calls.some((c) => c.table === table && c.op === 'upsert')) {
            result = { data: sb.claimData, error: null };
          }
          return builder;
        };
      }
      builder.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  }),
}));
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
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { toast } from 'sonner';
import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { useEODStore } from '@/lib/eod-store';
import { useModsStore } from '@/lib/mods-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useViewStore } from '@/lib/view-store';
import { useUIStore } from '@/lib/ui-store';
import { EXT_BEEMINDER, EXT_ORGANIZE } from '@/lib/extension-registry';
import { __resetModEventsForTests } from '@/lib/mod-events';
import {
  __resetRecipeEngineForTests,
  executeRecipe,
  runRecipeFromCommand,
  startRecipeEngine,
} from '@/lib/recipes/engine';
import { runRecipeCommand } from '@/lib/recipes/command-run';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';
import type { RecipeManifest, UserMod } from '@/lib/mods/schema';

const USER = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-03-10'; // a Tuesday
const NOON = new Date(`${TODAY}T12:00:00Z`);

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

/** Items a step names by id: the schema takes uuids only. */
const B = '00000000-0000-4000-8000-00000000000b';
const H = '00000000-0000-4000-8000-0000000000a1';
const T = '00000000-0000-4000-8000-0000000000a2';

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;
const flush = () => vi.runAllTimers();
const toastTexts = () => vi.mocked(toast).mock.calls.map((c) => c[0]);

let slugN = 0;
function recipe(manifest: Omit<RecipeManifest, 'version' | 'filters'> & Partial<RecipeManifest>, over: Partial<UserMod> = {}): UserMod {
  slugN++;
  return {
    id: crypto.randomUUID(),
    userId: USER,
    kind: 'recipe',
    slug: `r${slugN}`,
    name: `Recipe ${slugN}`,
    enabled: true,
    manifest: { version: 1, filters: {}, ...manifest },
    disabledReason: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...over,
  };
}

function seedRecipes(...rows: UserMod[]) {
  useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, safeMode: false, rows });
}

const modRunInserts = () =>
  sb.calls.filter((c) => c.table === 'mod_runs' && c.op === 'insert').map((c) => c.args[0] as { claim_key: string; summary: Record<string, unknown> });

async function load(items: Item[], projects: { id: string; name: string; emoji: string }[] = []) {
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchProjects).mockResolvedValue(projects as Awaited<ReturnType<typeof db.fetchProjects>>);
  vi.mocked(db.fetchItemTypes).mockResolvedValue([
    { id: 'it-1', name: 'errand', label: 'Errand', labelPlural: 'Errands' },
  ] as Awaited<ReturnType<typeof db.fetchItemTypes>>);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: NOON, userTimezone: 'UTC' });
  flush();
  vi.mocked(toast).mockClear();
  sb.calls = [];
}

let stop: () => void = () => {};
const navigate = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOON);
  __resetModEventsForTests();
  __resetRecipeEngineForTests();
  sb.calls = [];
  sb.claimData = [{ id: 1 }];
  navigate.mockClear();
  useModsStore.getState().reset();
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {}, hydratedUserId: USER });
  stop = startRecipeEngine({ navigate });
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  // A test that swapped toast's implementation must not leak it, pass or fail.
  vi.mocked(toast).mockReset();
});

describe('triggers', () => {
  beforeEach(() => load([task('t1'), task('t2'), habit('h1')]));

  const toastOn = (on: string) => recipe({ trigger: { on } as RecipeManifest['trigger'], steps: [{ do: 'toast', text: `on ${on}` }] });

  it('each event kind starts only its own recipes', async () => {
    seedRecipes(
      toastOn('item.completed'),
      toastOn('item.uncompleted'),
      toastOn('item.skipped'),
      toastOn('item.created'),
      toastOn('review.saved'),
      toastOn('command')
    );
    store().toggleTaskStatus('t1');
    flush();
    expect(toastTexts()).toEqual(['on item.completed']);

    vi.mocked(toast).mockClear();
    store().toggleTaskStatus('t1');
    flush();
    expect(toastTexts()).toEqual(['on item.uncompleted']);

    vi.mocked(toast).mockClear();
    store().setItemSkipped('h1', true);
    flush();
    expect(toastTexts()).toEqual(['on item.skipped']);

    vi.mocked(toast).mockClear();
    store().addTask({ title: 'New' } as Parameters<ReturnType<typeof store>['addTask']>[0]);
    flush();
    expect(toastTexts()).toEqual(['on item.created']);

    vi.mocked(toast).mockClear();
    useEODStore.setState({ lastEodReviewDate: null });
    await useEODStore.getState().saveLastReviewDate(null, TODAY);
    flush();
    expect(toastTexts()).toEqual(['on review.saved']);
  });

  it('a ⌘K recipe runs from the command door, never from an event', () => {
    const r = toastOn('command');
    seedRecipes(r);
    store().toggleTaskStatus('t1');
    flush();
    expect(toastTexts()).toEqual([]);
    runRecipeCommand(r.id);
    expect(toastTexts()).toEqual(['on command']);
    expect(vi.mocked(toast).mock.calls[0][1]).toEqual({ description: `Recipe: ${r.name}` });
  });

  it('an event that no longer holds at dispatch runs nothing, not even its UI steps', () => {
    const r = recipe({ trigger: { on: 'item.completed' }, steps: [{ do: 'toast', text: 'ran' }, { do: 'create', type: 'task', title: 'Next' }] });
    seedRecipes(r);
    const before = store().items.length;
    // ⌘Z lands between the tick and the queued dispatch.
    store().toggleTaskStatus('t1');
    store().undo();
    flush();
    expect(toastTexts()).toEqual([]);
    expect(store().items).toHaveLength(before);
    expect(modRunInserts()).toEqual([]);
  });

  it('an added item that is gone by dispatch starts nothing', () => {
    seedRecipes(recipe({ trigger: { on: 'item.created' }, steps: [{ do: 'toast', text: 'added' }] }));
    store().addTask({ title: 'Brief' } as Parameters<ReturnType<typeof store>['addTask']>[0]);
    const added = store().items.find((i) => i.title === 'Brief')!;
    store().deleteTask(added.id);
    flush();
    expect(toastTexts()).toEqual([]);
  });

  it('a step on the trigger item re-checks its gate: completing a done item is a skip', () => {
    const r = recipe({ trigger: { on: 'item.completed' }, steps: [{ do: 'complete', item: 'trigger' }] });
    seedRecipes(r);
    store().toggleTaskStatus('t1');
    flush();
    expect(modRunInserts()[0].summary).toMatchObject({ did: 0, skipped: 1, steps: ['skip:ineligible'] });
  });
});

describe('filters', () => {
  beforeEach(() =>
    load(
      [
        task('t1', { project: 'Work', title: 'Write report' }),
        task('t2', { project: 'Home', title: 'Write card' }),
        habit('h1'),
        habit('h2', { pausedAt: '2026-03-01T00:00:00Z', pausedUntil: '2026-04-01' } as Partial<Item>),
        task('target'),
      ],
      [{ id: 'p1', name: 'work', emoji: '' }]
    )
  );

  const completesTarget = (filters: RecipeManifest['filters']) =>
    recipe({ trigger: { on: 'item.completed' }, filters, steps: [{ do: 'toast', text: 'hit' }] });

  const fires = (filters: RecipeManifest['filters'], act: () => void) => {
    seedRecipes(completesTarget(filters));
    vi.mocked(toast).mockClear();
    act();
    flush();
    return toastTexts().includes('hit');
  };

  it('type, asked of the registry', () => {
    expect(fires({ types: ['habit'] }, () => store().toggleTaskStatus('t1'))).toBe(false);
    expect(fires({ types: ['task'] }, () => store().toggleTaskStatus('t2'))).toBe(true);
  });

  it('project folds case', () => {
    expect(fires({ projects: ['work'] }, () => store().toggleTaskStatus('t1'))).toBe(true);
    expect(fires({ projects: ['work'] }, () => store().toggleTaskStatus('t2'))).toBe(false);
  });

  it('title contains, any case', () => {
    expect(fires({ title: { contains: 'REPORT' } }, () => store().toggleTaskStatus('t1'))).toBe(true);
    expect(fires({ title: { contains: 'report' } }, () => store().toggleTaskStatus('t2'))).toBe(false);
  });

  it('weekday is the event date, not the clock', () => {
    // 2026-03-08 is a Sunday; today is a Tuesday.
    const onSunday = () => store().toggleHabitStatus('h1', 'done', undefined, new Date('2026-03-08T12:00:00Z'));
    expect(fires({ weekdays: [0] }, onSunday)).toBe(true);
    expect(fires({ weekdays: [2] }, () => store().toggleHabitStatus('h1', 'done'))).toBe(true);
    expect(fires({ weekdays: [3] }, () => store().toggleTaskStatus('t1'))).toBe(false);
  });

  it('open today: an unticked item is open again', () => {
    // On a tick it is refused outright (recipes-validate.test.ts).
    store().toggleHabitStatus('h1', 'done');
    flush();
    seedRecipes(
      recipe({ trigger: { on: 'item.uncompleted' }, filters: { openToday: true }, steps: [{ do: 'toast', text: 'open' }] })
    );
    vi.mocked(toast).mockClear();
    store().toggleHabitStatus('h1', 'pending');
    flush();
    expect(toastTexts()).toEqual(['open']);
  });

  it('open today: a paused item fails', () => {
    seedRecipes(
      recipe({ trigger: { on: 'item.uncompleted' }, filters: { openToday: true }, steps: [{ do: 'toast', text: 'paused' }] })
    );
    store().toggleHabitStatus('h2', 'done');
    flush();
    vi.mocked(toast).mockClear();
    store().toggleHabitStatus('h2', 'pending');
    flush();
    expect(toastTexts()).toEqual([]);
  });
});

describe('create', () => {
  beforeEach(() => load([task('t1')], [{ id: 'p1', name: 'Work', emoji: '' }]));

  const createRecipe = (step: Record<string, unknown>) =>
    recipe({ trigger: { on: 'command' }, steps: [{ do: 'create', type: 'task', title: 'Stretch', ...step } as never] });

  it('adds a task on today, in the project named any case', () => {
    const r = createRecipe({ project: 'work', bucket: 'evening' });
    seedRecipes(r);
    runRecipeFromCommand(r.id);
    const added = store().items.find((i) => i.title === 'Stretch')!;
    expect(added).toMatchObject({ type: 'task', startDate: TODAY, project: 'Work', timeBucket: 'evening' });
  });

  it('refuses a habit and an unknown project', () => {
    const asHabit = { version: 1 as const, trigger: { on: 'command' as const }, filters: {}, steps: [{ do: 'create' as const, type: 'habit', title: 'Daily' }] };
    expect(executeRecipe({ name: 'H', slug: 'h' }, asHabit)).toMatchObject({ did: 0, refused: 1, steps: ['refuse:type'] });
    const r = createRecipe({ project: 'Nowhere' });
    seedRecipes(r);
    runRecipeFromCommand(r.id);
    expect(store().items.some((i) => i.title === 'Stretch')).toBe(false);
    expect(modRunInserts()[0].summary).toMatchObject({ steps: ['refuse:no-project'] });
  });
});

describe('the cap', () => {
  beforeEach(() => load([]));

  it('stops at 25 writes and says so (a manifest past the schema)', () => {
    const steps = Array.from({ length: 31 }, (_, i) => ({ do: 'create' as const, type: 'task', title: `Row ${i}` }));
    const s = executeRecipe({ name: 'Big', slug: 'big' }, { version: 1, trigger: { on: 'command' }, filters: {}, steps });
    expect(s).toMatchObject({ did: 25, of: 31, stopped: 6 });
    expect(store().items).toHaveLength(25);
    expect(toastTexts()).toContain('Big did 25 of 31 steps.');
    // One run, one entry.
    expect(getActionLog()[0].label).toBe('Recipe: Big');
  });
});

describe('rate limit', () => {
  beforeEach(() => load([]));

  it('the 11th run in a minute switches the recipe off and says why', () => {
    const r = recipe({ trigger: { on: 'command' }, steps: [{ do: 'toast', text: 'tick' }] });
    seedRecipes(r);
    for (let i = 0; i < 10; i++) runRecipeFromCommand(r.id);
    expect(toastTexts().filter((t) => t === 'tick')).toHaveLength(10);
    runRecipeFromCommand(r.id);
    expect(toastTexts().filter((t) => t === 'tick')).toHaveLength(10);
    const row = useModsStore.getState().rows[0];
    expect(row).toMatchObject({ enabled: false, disabledReason: 'It ran more than 10 times in a minute.' });
    expect(toastTexts()).toContain(`Switched off ${r.name}. It ran more than 10 times in a minute.`);
    const update = sb.calls.find((c) => c.table === 'user_mods' && c.op === 'update');
    expect(update?.args[0]).toEqual({ enabled: false, disabled_reason: 'It ran more than 10 times in a minute.' });
    // And it stays off.
    runRecipeFromCommand(r.id);
    expect(toastTexts().filter((t) => t === 'tick')).toHaveLength(10);
  });

  it('the 101st run in a day switches it off too', () => {
    const r = recipe({ trigger: { on: 'command' }, steps: [{ do: 'toast', text: 'tick' }] });
    seedRecipes(r);
    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(new Date(NOON.getTime() + i * 7_000));
      runRecipeFromCommand(r.id);
    }
    expect(useModsStore.getState().rows[0].enabled).toBe(true);
    vi.setSystemTime(new Date(NOON.getTime() + 100 * 7_000));
    runRecipeFromCommand(r.id);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: false, disabledReason: 'It ran more than 100 times today.' });
    expect(toastTexts().filter((t) => t === 'tick')).toHaveLength(100);
  });
});

describe('suppression and undo', () => {
  beforeEach(() => load([task('a'), task(B)]));

  it("a recipe's own tick starts nothing", () => {
    const a = recipe({ trigger: { on: 'item.completed' }, filters: { title: { contains: 'Task a' } }, steps: [{ do: 'complete', item: { id: B } }] });
    const b = recipe({ trigger: { on: 'item.completed' }, steps: [{ do: 'toast', text: 'B ran' }] });
    seedRecipes(a, b);
    store().toggleTaskStatus('a');
    flush();
    flush();
    expect(item(B).status).toBe('completed');
    expect(toastTexts().filter((t) => t === 'B ran')).toHaveLength(1);
  });

  it('⌘Z takes back the recipe before the tick that started it', () => {
    const r = recipe(
      { trigger: { on: 'item.completed' }, filters: { title: { contains: 'Task a' } }, steps: [{ do: 'complete', item: { id: B } }] },
      { name: 'Chain' }
    );
    seedRecipes(r);
    store().toggleTaskStatus('a');
    flush();
    expect(getActionLog()[0].label).toBe('Recipe: Chain');
    store().undo();
    expect(item(B).status).toBe('pending');
    expect(item('a').status).toBe('completed');
    store().undo();
    expect(item('a').status).toBe('pending');
  });
});

describe('stake lock', () => {
  beforeEach(() => load([task(T), habit(H, { title: 'Vitamins' })]));

  const verbs = () =>
    recipe({
      trigger: { on: 'command' },
      steps: [
        { do: 'complete', item: { id: H } },
        { do: 'complete', item: { id: T } },
        { do: 'create', type: 'task', title: 'vitamins' },
      ],
    });

  it('with Beeminder on: no verb on a habit, no create titled after a goal; a task is fine', () => {
    useExtensionsStore.setState({ enabled: { [EXT_BEEMINDER]: true }, configs: { [EXT_BEEMINDER]: { goals: 'Vitamins: vit' } } });
    const r = verbs();
    seedRecipes(r);
    runRecipeFromCommand(r.id);
    expect(item(H).completedDates).toEqual([]);
    expect(item(T).status).toBe('completed');
    expect(modRunInserts()[0].summary).toMatchObject({ steps: ['refuse:stake', 'done', 'refuse:stake'] });
  });

  it('while the extension configs are loading, the lock holds', () => {
    useExtensionsStore.setState({ configsLoaded: false });
    const r = verbs();
    seedRecipes(r);
    runRecipeFromCommand(r.id);
    expect(modRunInserts()[0].summary).toMatchObject({ steps: ['refuse:stake', 'done', 'refuse:stake'] });
  });

  it('with stakes off, the habit verb runs', () => {
    const r = verbs();
    seedRecipes(r);
    runRecipeFromCommand(r.id);
    expect(item(H).completedDates).toEqual([TODAY]);
    expect(modRunInserts()[0].summary).toMatchObject({ steps: ['done', 'done', 'done'] });
  });
});

describe('guards', () => {
  beforeEach(() => load([task('t1')]));
  const r = () => recipe({ trigger: { on: 'item.completed' }, steps: [{ do: 'toast', text: 'ran' }] });

  it('safe mode runs nothing, and neither does ⌘K', () => {
    const one = r();
    seedRecipes(one);
    useModsStore.setState({ safeMode: true });
    store().toggleTaskStatus('t1');
    flush();
    runRecipeFromCommand(one.id);
    expect(toastTexts()).toEqual([]);
  });

  it('a switched-off recipe runs nothing', () => {
    seedRecipes({ ...r(), enabled: false });
    store().toggleTaskStatus('t1');
    flush();
    expect(toastTexts()).toEqual([]);
  });

  it('nothing runs while the planner is loading', () => {
    seedRecipes(r());
    store().toggleTaskStatus('t1');
    usePlannerStore.setState({ isLoading: true });
    flush();
    expect(toastTexts()).toEqual([]);
  });

  it("nothing runs for another account's rows", () => {
    seedRecipes(r());
    useModsStore.setState({ hydratedUserId: '22222222-2222-4222-8222-222222222222' });
    store().toggleTaskStatus('t1');
    flush();
    expect(toastTexts()).toEqual([]);
  });
});

describe('run log', () => {
  beforeEach(() => load([task('t1', { title: 'Secret plans' }), task(T, { title: 'Other secret' })]));

  it('one mod_runs row per run, kind run, no titles', () => {
    const r = recipe({ trigger: { on: 'item.completed' }, steps: [{ do: 'complete', item: { id: T } }] });
    seedRecipes(r);
    store().toggleTaskStatus('t1');
    flush();
    const rows = modRunInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER, mod_id: r.id, summary: { kind: 'run', trigger: 'item.completed', did: 1, of: 1 } });
    expect(rows[0].claim_key).toMatch(/^run:/);
    expect(JSON.stringify(rows[0].summary)).not.toMatch(/secret/i);
  });
});

describe('UI steps', () => {
  beforeEach(() => load([]));

  it('go to sets scope and layout', () => {
    useViewStore.setState({ scope: 'day', layout: 'buckets' });
    executeRecipe({ name: 'G', slug: 'g' }, { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'goto', scope: 'week', layout: 'list' }] });
    expect(useViewStore.getState()).toMatchObject({ scope: 'week', layout: 'list' });
  });

  it('Organize: nothing while it is off; with it on and no console here, arms and goes home', () => {
    useUIStore.setState({ activeDialog: null });
    useExtensionsStore.setState({ enabled: { [EXT_ORGANIZE]: false } });
    const m: RecipeManifest = { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'organize' }] };
    executeRecipe({ name: 'O', slug: 'o' }, m);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    useExtensionsStore.setState({ enabled: { [EXT_ORGANIZE]: true } });
    executeRecipe({ name: 'O', slug: 'o' }, m);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'organize' });
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('UI steps run after the batch: the entry exists before any toast', () => {
    const seen: string[] = [];
    vi.mocked(toast).mockImplementation(((t: string) => {
      seen.push(`${t}:${getActionLog()[0]?.label}`);
    }) as never);
    executeRecipe(
      { name: 'Order', slug: 'order' },
      { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'toast', text: 'hi' }, { do: 'create', type: 'task', title: 'X' }] }
    );
    expect(seen).toEqual(['hi:Recipe: Order']);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Applying what a mod's hook held (lib/mods/broker.ts applyHeld, memory/plans/
 * mods.md build order 8), through the REAL planner store and event bus: one
 * history entry under the host's label, nothing raised, the history window,
 * the stale checks and the run log. Same harness as recipes-engine.test.ts.
 */

const sb = vi.hoisted(() => ({ calls: [] as { table: string; op: string; args: unknown[] }[] }));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const op of ['insert', 'upsert', 'update', 'select', 'eq', 'order', 'limit', 'in']) {
        builder[op] = (...args: unknown[]) => {
          sb.calls.push({ table, op, args });
          return builder;
        };
      }
      builder.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
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
const sheet = vi.hoisted(() => ({ hosted: false, order: [] as string[] }));
vi.mock('@/lib/mods/ui/open-panel', () => ({
  isSheetHosted: () => sheet.hosted,
  closeModSheet: vi.fn(() => void sheet.order.push('closeSheet')),
  openModPanel: vi.fn(),
}));
vi.mock('@/lib/ui-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ui-store')>();
  return { ...actual, openEditFor: vi.fn(() => void sheet.order.push('openItem')) };
});

import { toast } from 'sonner';
import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { __resetModEventsForTests, subscribeModEvents, type ModEvent } from '@/lib/mod-events';
import { __resetBrokerForTests, applyHeld, type ApplyContext } from '@/lib/mods/broker';
import { createHookState, type HeldWrite, type HookState } from '@/lib/mods/broker-core';
import { MOD_USES, type UserMod } from '@/lib/mods/schema';
import * as db from '@/lib/db';
import { closeModSheet, openModPanel } from '@/lib/mods/ui/open-panel';
import { openEditFor } from '@/lib/ui-store';
import type { Item } from '@/lib/planner-types';

const USER = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-03-10';
const NOON = new Date(`${TODAY}T12:00:00Z`);
const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id.slice(-2)}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as Item;

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;

function mod(over: Partial<UserMod> = {}): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: USER,
    kind: 'mod',
    slug: 'water',
    name: 'Water',
    enabled: true,
    manifest: { version: 1, uses: [...MOD_USES], commands: [] },
    disabledReason: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...over,
  };
}

function seed(...rows: UserMod[]) {
  useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, safeMode: false, rows });
}

function heldHook(row: UserMod, writes: HeldWrite[], over: Partial<HookState> = {}): HookState {
  const h = createHookState({
    modId: row.id,
    gen: 1,
    hookId: crypto.randomUUID(),
    slug: row.slug,
    hookKind: 'item.completed',
    origin: null,
    manifest: { version: 1, uses: [...MOD_USES], commands: [], panels: [], settings: [] },
    snapshot: {},
    pendingTimers: 0,
    toastsLastMinute: 0,
  });
  h.writes.push(...writes);
  return Object.assign(h, over);
}

const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  userId: USER,
  stillCurrent: () => true,
  event: { kind: 'item.completed', itemId: T1, date: TODAY, type: 'task' },
  hookLabel: 'item.completed',
  deps: { navigate: vi.fn() },
  ...over,
});

const runInserts = () =>
  sb.calls
    .filter((c) => c.table === 'mod_runs' && c.op === 'insert')
    .map((c) => c.args[0] as { claim_key: string; summary: Record<string, unknown> });

async function load(items: Item[]) {
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: NOON, userTimezone: 'UTC' });
  vi.runAllTimers();
  sb.calls = [];
}

let events: ModEvent[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOON);
  __resetModEventsForTests();
  __resetBrokerForTests();
  useModsStore.getState().reset();
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {}, hydratedUserId: USER });
  // T1 is ticked: the event that started the hook still holds.
  await load([task(T1, { status: 'completed' }), task(T2)]);
  events = [];
  subscribeModEvents((e) => void events.push(e));
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(toast).mockReset();
});

describe('applying held writes', () => {
  it('writes go into one `Mod: <name> · <hook>` entry and raise nothing', () => {
    const row = mod();
    seed(row);
    const r = applyHeld(
      heldHook(row, [
        { kind: 'edit', id: T2, patch: { title: 'Renamed', priority: 'low' } },
        { kind: 'create', type: 'task', title: 'Stretch' },
        { kind: 'verb', id: T2, verb: 'complete' },
      ]),
      ctx()
    );
    vi.runAllTimers();
    expect(r).toEqual({ status: 'applied', fault: null, toasts: 0 });
    expect(getActionLog()[0].label).toBe('Mod: Water · item.completed');
    expect(getActionLog()[1].label).not.toMatch(/^Mod: /);
    expect(item(T2)).toMatchObject({ title: 'Renamed', priority: 'low', status: 'completed' });
    expect(store().items.some((i) => i.title === 'Stretch')).toBe(true);
    expect(events).toEqual([]);
    const [run] = runInserts();
    expect(run.claim_key).toMatch(/^run:/);
    expect(run.summary).toMatchObject({ kind: 'run', trigger: 'item.completed', did: 3, of: 3, steps: ['done', 'done', 'done'] });
  });

  it('the label is the display label: a name that fails the rule shows the slug', () => {
    const row = mod({ name: 'Sign in' });
    seed(row);
    applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'X' } }]), ctx());
    expect(getActionLog()[0].label).toBe('Mod: water · item.completed');
  });

  it('a write asked again at apply is refused or skipped, and logged so', () => {
    const row = mod();
    seed(row);
    applyHeld(
      heldHook(
        row,
        [
          { kind: 'verb', id: T1, verb: 'complete' },
          { kind: 'edit', id: '00000000-0000-4000-8000-00000000dead', patch: { title: 'X' } },
          { kind: 'create', type: 'task', title: 'Y', project: 'Nowhere' },
        ],
        { stopped: 1 }
      ),
      ctx()
    );
    expect(runInserts()[0].summary).toMatchObject({
      did: 0,
      of: 4,
      skipped: 1,
      refused: 2,
      stopped: 1,
      steps: ['skip:ineligible', 'refuse:no-item', 'refuse:no-project', 'stop:cap'],
    });
  });

  it('the 11th real entry in 10 minutes is dropped with a history fault', () => {
    const row = mod();
    seed(row);
    for (let i = 0; i < 10; i++) {
      const r = applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: `Name ${i}` } }]), ctx());
      expect(r).toMatchObject({ fault: null });
    }
    const r = applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Eleventh' } }]), ctx());
    expect(r).toMatchObject({ status: 'applied', fault: { code: 'history' } });
    expect(item(T2).title).toBe('Name 9');
    expect(runInserts().at(-1)!.summary).toMatchObject({ refused: 1, steps: ['refuse:history'] });
    // Ten minutes on, there is room again.
    vi.setSystemTime(new Date(NOON.getTime() + 600_001));
    expect(applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Later' } }]), ctx())).toMatchObject({
      fault: null,
    });
  });

  it('a batch whose writes were all refused adds no entry and does not count', () => {
    const row = mod();
    seed(row);
    for (let i = 0; i < 15; i++) {
      applyHeld(heldHook(row, [{ kind: 'verb', id: T1, verb: 'complete' }]), ctx());
    }
    expect(getActionLog()[0].label).not.toMatch(/^Mod: /);
    expect(applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Real' } }]), ctx())).toMatchObject({
      fault: null,
    });
  });

  it('every mod together gets 20 entries in the window: the 21st is dropped', () => {
    const rows = [mod({ slug: 'a', name: 'A' }), mod({ slug: 'b', name: 'B' }), mod({ slug: 'c', name: 'C' })];
    seed(...rows);
    for (let i = 0; i < 20; i++) {
      const row = rows[i % 2];
      expect(applyHeld(heldHook(row, [{ kind: 'edit', id: T2, patch: { title: `N${i}` } }]), ctx())).toMatchObject({
        fault: null,
      });
    }
    expect(applyHeld(heldHook(rows[2], [{ kind: 'edit', id: T2, patch: { title: 'N20' } }]), ctx())).toMatchObject({
      fault: { code: 'history' },
    });
  });

  it('a ⌘Z between dispatch and apply (the item no longer ticked) is stale: no writes, no toast', () => {
    const row = mod();
    seed(row);
    store().toggleTaskStatus(T1);
    vi.runAllTimers();
    const h = heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Nope' } }]);
    h.ui.push({ kind: 'toast', text: 'Nope' });
    expect(applyHeld(h, ctx())).toEqual({ status: 'stale' });
    expect(item(T2).title).not.toBe('Nope');
    expect(toast).not.toHaveBeenCalled();
    expect(runInserts().at(-1)!.summary).toMatchObject({ did: 0, skipped: 1, steps: ['skip:stale'] });
  });

  it('a mod switched off mid-hook, a newer generation or another account applies nothing', () => {
    const row = mod();
    seed({ ...row, enabled: false });
    const edit: HeldWrite[] = [{ kind: 'edit', id: T2, patch: { title: 'Nope' } }];
    expect(applyHeld(heldHook(row, edit), ctx())).toEqual({ status: 'stale' });
    seed(row);
    expect(applyHeld(heldHook(row, edit), ctx({ stillCurrent: () => false }))).toEqual({ status: 'stale' });
    expect(applyHeld(heldHook(row, edit), ctx({ userId: '22222222-2222-4222-8222-222222222222' }))).toEqual({
      status: 'stale',
    });
    useModsStore.setState({ safeMode: true });
    expect(applyHeld(heldHook(row, edit), ctx())).toEqual({ status: 'stale' });
    expect(item(T2).title).not.toBe('Nope');
  });

  it('a toast runs after the batch, under host chrome, and nothing is logged without writes', () => {
    const row = mod({ name: 'Sign in' });
    seed(row);
    const h = heldHook(row, []);
    h.ui.push({ kind: 'toast', text: '3 glasses' });
    expect(applyHeld(h, ctx({ event: { kind: 'command', id: 'log' }, hookLabel: 'command Log' }))).toEqual({
      status: 'applied',
      fault: null,
      toasts: 1,
    });
    expect(toast).toHaveBeenCalledWith('3 glasses', { description: 'Your mod: water' });
    expect(runInserts()).toEqual([]);
  });
});

describe('a panel\'s hooks (build order 9)', () => {
  const action = { kind: 'ui.action' as const, panelId: 'water', action: 'add', atoms: {} };

  beforeEach(() => {
    sheet.hosted = false;
    sheet.order = [];
    vi.mocked(openModPanel).mockClear();
    vi.mocked(closeModSheet).mockClear();
    vi.mocked(openEditFor).mockClear();
  });

  it('a held ui.open goes through the panel router', () => {
    const row = mod();
    seed(row);
    const h = heldHook(row, [], { hookKind: 'ui.action' });
    h.ui.push({ kind: 'openPanel', panelId: 'water' });
    applyHeld(h, ctx({ event: action, hookLabel: 'Water' }));
    expect(openModPanel).toHaveBeenCalledWith({ modId: row.id, panelId: 'water' });
  });

  it('atoms commit as the mod\'s own, and only when a bridge is there', () => {
    const row = mod();
    seed(row);
    const commitAtoms = vi.fn();
    const panels = { atoms: () => ({}), atomKinds: () => ({}), actionShown: () => true, commitAtoms };
    const h = heldHook(row, [], { hookKind: 'ui.action' });
    h.atomOverlay.set('done', true);
    h.atomOverlay.set('note', 'hi');
    applyHeld(h, ctx({ event: action, hookLabel: 'Water', panels }));
    expect(commitAtoms).toHaveBeenCalledWith(row.id, { done: true, note: 'hi' });
    expect(() => applyHeld(heldHook(row, [], { hookKind: 'ui.action' }), ctx({ event: action }))).not.toThrow();
  });

  it('a press\'s writes skip the history window, a command\'s do not', () => {
    const row = mod();
    seed(row);
    for (let i = 0; i < 15; i++) {
      const r = applyHeld(
        heldHook(row, [{ kind: 'edit', id: T2, patch: { title: `Press ${i}` } }], { hookKind: 'ui.action' }),
        ctx({ event: action, hookLabel: 'Water' })
      );
      expect(r).toMatchObject({ fault: null });
    }
    expect(getActionLog()[0].label).toBe('Mod: Water · Water');
    expect(item(T2).title).toBe('Press 14');
    const changed = { kind: 'atom.changed' as const, key: 'note', value: 'x' };
    expect(
      applyHeld(
        heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Field' } }], { hookKind: 'atom.changed' }),
        ctx({ event: changed, hookLabel: 'note' })
      )
    ).toMatchObject({ fault: null });
    for (let i = 0; i < 10; i++) {
      const r = applyHeld(
        heldHook(row, [{ kind: 'edit', id: T2, patch: { title: `Cmd ${i}` } }], { hookKind: 'command' }),
        ctx({ event: { kind: 'command', id: 'log' }, hookLabel: 'command Log' })
      );
      expect(r).toMatchObject({ fault: null });
    }
    expect(
      applyHeld(
        heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Eleventh' } }], { hookKind: 'command' }),
        ctx({ event: { kind: 'command', id: 'log' }, hookLabel: 'command Log' })
      )
    ).toMatchObject({ fault: { code: 'history' } });
  });

  it('on the phone the sheet closes before a held openItem or a nav step', () => {
    const row = mod();
    seed(row);
    sheet.hosted = true;
    const h = heldHook(row, [], { hookKind: 'ui.action' });
    h.ui.push({ kind: 'openItem', id: T2 });
    h.ui.push({ kind: 'step', step: { do: 'organize' } });
    const navigate = vi.fn(() => void sheet.order.push('nav'));
    applyHeld(h, ctx({ event: action, hookLabel: 'Water', deps: { navigate } }));
    expect(sheet.order.slice(0, 3)).toEqual(['closeSheet', 'openItem', 'closeSheet']);
    expect(openEditFor).toHaveBeenCalledTimes(1);

    sheet.hosted = false;
    sheet.order = [];
    const d = heldHook(row, [], { hookKind: 'ui.action' });
    d.ui.push({ kind: 'openItem', id: T2 });
    applyHeld(d, ctx({ event: action, hookLabel: 'Water' }));
    expect(sheet.order).toEqual(['openItem']);
  });

  it('a resolve never applies anything', () => {
    const row = mod();
    seed(row);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = heldHook(row, [{ kind: 'edit', id: T2, patch: { title: 'Drawn' } }], { hookKind: 'ui.resolve' });
    h.ui.push({ kind: 'toast', text: 'hi' });
    h.atomOverlay.set('a', 1);
    expect(applyHeld(h, ctx({ event: { kind: 'ui.resolve', panelId: 'water' } }))).toEqual({ status: 'stale' });
    expect(item(T2).title).not.toBe('Drawn');
    expect(toast).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

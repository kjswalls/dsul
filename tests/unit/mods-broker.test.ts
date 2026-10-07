import { describe, expect, it, vi } from 'vitest';
import {
  DELETE,
  METHOD_USES,
  MOD_STORE_TOTAL_MAX_BYTES,
  brokerCall,
  createHookState,
  type BrokerEnv,
  type HookState,
  type PlannerView,
} from '@/lib/mods/broker-core';
import { MOD_METHODS, type ModMethod } from '@/lib/mods/protocol';
import { MOD_USES, type ModUse } from '@/lib/mods/schema';
import type { Item } from '@/lib/planner-types';

/**
 * The broker's rules (lib/mods/broker-core.ts, memory/plans/mods.md build
 * order 8) against a fake BrokerEnv: no store, no frame.
 */

const MOD = '11111111-1111-4111-8111-111111111111';
const HOOK = '22222222-2222-4222-8222-222222222222';
const T1 = '00000000-0000-4000-8000-0000000000a1';
const H1 = '00000000-0000-4000-8000-0000000000b1';
const DONE = '00000000-0000-4000-8000-0000000000c1';
const TODAY = '2026-03-10';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id.slice(-2)}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    project: 'Work',
    priority: 'high',
    notes: 'private notes',
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as Item;

const habit = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'habit',
    id,
    title: 'Vitamins',
    project: 'Wellness',
    streak: 7,
    status: 'pending',
    completedDates: ['2026-03-09'],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

const ITEMS = [task(T1), habit(H1), task(DONE, { status: 'completed', title: 'Done one' })];

function env(over: Partial<BrokerEnv> = {}, view: Partial<PlannerView> = {}): BrokerEnv {
  return {
    planner: () => ({
      items: ITEMS,
      projects: [{ name: 'Work' }, { name: 'Wellness' }],
      routines: [],
      seasons: [],
      goals: [],
      userTimezone: 'UTC',
      ...view,
    }),
    stakeFacts: () => ({ lockOn: false, configsKnown: true, beeminder: {} }),
    canCreateType: (t) => t === 'task' || t === 'errand',
    todayAndTime: () => ({ today: TODAY, hhmm: '12:00' }),
    lookRefOk: () => true,
    log: vi.fn(),
    ...over,
  };
}

function hook(over: Partial<Parameters<typeof createHookState>[0]> = {}): HookState {
  return createHookState({
    modId: MOD,
    gen: 1,
    hookId: HOOK,
    slug: 'water',
    hookKind: 'command',
    origin: null,
    manifest: { version: 1, uses: [...MOD_USES], commands: [] },
    snapshot: {},
    pendingTimers: 0,
    toastsLastMinute: 0,
    ...over,
  });
}

const call = (e: BrokerEnv, h: HookState, method: ModMethod, args: unknown = null) =>
  brokerCall(e, h, { modId: MOD, gen: 1, hookId: HOOK, method, argsJson: JSON.stringify(args) });

const value = (a: ReturnType<typeof call>) => {
  if (!a || !a.ok) throw new Error(`not ok: ${JSON.stringify(a)}`);
  return a.value as never;
};

/** One valid argument per method, for the gate tests. */
const SAMPLE: Record<ModMethod, unknown> = {
  today: null,
  log: { level: 'info', text: 'hi' },
  after: { ms: 1000 },
  'items.get': { id: T1 },
  'items.query': {},
  'containers.list': null,
  'verbs.eligible': { id: T1, verb: 'complete' },
  'items.create': { type: 'task', title: 'Stretch' },
  'items.edit': { id: T1, title: 'Renamed' },
  'verbs.run': { id: T1, verb: 'complete' },
  'store.get': { key: 'n' },
  'store.keys': null,
  'store.set': { key: 'n', value: 1 },
  'store.delete': { key: 'n' },
  'ui.toast': { text: 'Hi' },
  'ui.openItem': { id: T1 },
  'nav.go': { scope: 'day', layout: 'list' },
  'nav.organize': null,
  'look.set': { look: 'paper' },
};

describe('the gates', () => {
  it.each(MOD_METHODS.filter((m) => METHOD_USES[m]).map((m) => [m, METHOD_USES[m] as ModUse]))(
    '%s needs "%s"',
    (method, use) => {
      const without = hook({ manifest: { version: 1, uses: MOD_USES.filter((u) => u !== use), commands: [] } });
      expect(call(env(), without, method, SAMPLE[method])).toEqual({ ok: false, error: `needs "${use}" in manifest.uses` });
      const answer = call(env(), hook(), method, SAMPLE[method]);
      expect(answer?.ok, JSON.stringify(answer)).toBe(true);
    }
  );

  it('today, log and after need no use', () => {
    const none = hook({ manifest: { version: 1, uses: [], commands: [] } });
    for (const m of ['today', 'log', 'after'] as const) expect(call(env(), none, m, SAMPLE[m])?.ok).toBe(true);
  });

  it('drops a call that is not the live hook, and answers nothing', () => {
    const h = hook();
    const e = env();
    const base = { method: 'today' as const, argsJson: 'null' };
    expect(brokerCall(e, null, { modId: MOD, gen: 1, hookId: HOOK, ...base })).toBeNull();
    expect(brokerCall(e, h, { modId: MOD, gen: 2, hookId: HOOK, ...base })).toBeNull();
    expect(brokerCall(e, h, { modId: MOD, gen: 1, hookId: T1, ...base })).toBeNull();
    expect(brokerCall(e, h, { modId: T1, gen: 1, hookId: HOOK, ...base })).toBeNull();
    expect(h.calls).toBe(0);
  });

  it('the 51st call aborts the hook, and every call after it is refused', () => {
    const h = hook();
    for (let i = 0; i < 50; i++) expect(call(env(), h, 'today')?.ok).toBe(true);
    expect(call(env(), h, 'today')).toEqual({ ok: false, error: 'too many calls' });
    expect(h.aborted?.code).toBe('calls');
    expect(call(env(), h, 'today')).toEqual({ ok: false, error: 'the hook was stopped' });
  });

  it('refuses arguments that are not the method’s', () => {
    expect(call(env(), hook(), 'items.get', { id: 'nope' })?.ok).toBe(false);
    expect(call(env(), hook(), 'today', { extra: 1 })?.ok).toBe(false);
    expect(brokerCall(env(), hook(), { modId: MOD, gen: 1, hookId: HOOK, method: 'today', argsJson: '{' })).toEqual({
      ok: false,
      error: 'arguments are not JSON',
    });
  });

  it('nav, openItem and look.set only during a command', () => {
    const timer = hook({ hookKind: 'timer' });
    for (const m of ['nav.go', 'nav.organize', 'ui.openItem', 'look.set'] as const) {
      expect(call(env(), timer, m, SAMPLE[m]), m).toEqual({ ok: false, error: 'only during a command' });
    }
    expect(timer.ui).toEqual([]);
  });

  it('during an undo hook: no item writes and no Look, but the store and a toast', () => {
    const h = hook({ hookKind: 'item.uncompleted', origin: 'undo' });
    for (const m of ['items.create', 'items.edit', 'verbs.run'] as const) {
      expect(call(env(), h, m, SAMPLE[m]), m).toEqual({ ok: false, error: 'not during undo' });
    }
    expect(call(env(), hook({ origin: 'undo' }), 'look.set', SAMPLE['look.set'])).toEqual({
      ok: false,
      error: 'not during undo',
    });
    expect(value(call(env(), h, 'store.set', { key: 'n', value: 1 }))).toEqual({ ok: true });
    expect(value(call(env(), h, 'ui.toast', { text: 'Undone' }))).toEqual({ ok: true });
    expect(h.writes).toEqual([]);
  });
});

describe('reads', () => {
  it('projects an item without completion records, the streak or notes', () => {
    const got = value(call(env(), hook(), 'items.get', { id: H1 })) as Record<string, unknown>;
    expect(got).toEqual({
      id: H1,
      type: 'habit',
      title: 'Vitamins',
      project: 'Wellness',
      priority: null,
      timeBucket: null,
      startDate: null,
      recurring: true,
      done: false,
      skipped: false,
      open: true,
    });
    const text = JSON.stringify(value(call(env(), hook(), 'items.query', {})));
    for (const hidden of ['completedDates', 'streak', 'notes', 'private notes', '2026-03-09']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('queries in planner order, by type, project, done and limit', () => {
    const ids = (q: unknown) => (value(call(env(), hook(), 'items.query', q)) as { id: string }[]).map((i) => i.id);
    expect(ids({})).toEqual([T1, H1, DONE]);
    expect(ids({ type: 'habit' })).toEqual([H1]);
    expect(ids({ project: 'work' })).toEqual([T1, DONE]);
    expect(ids({ done: true })).toEqual([DONE]);
    expect(ids({ limit: 1 })).toEqual([T1]);
    expect(call(env(), hook(), 'items.query', { limit: 101 })?.ok).toBe(false);
  });

  it('lists container names only', () => {
    expect(value(call(env(), hook(), 'containers.list'))).toEqual({
      projects: ['Work', 'Wellness'],
      routines: [],
      seasons: [],
      goals: [],
    });
  });

  it('today has no part of day before 05:00', () => {
    expect(value(call(env({ todayAndTime: () => ({ today: TODAY, hhmm: '04:30' }) }), hook(), 'today'))).toEqual({
      date: TODAY,
      time: '04:30',
      bucket: null,
    });
    expect((value(call(env(), hook(), 'today')) as { bucket: string }).bucket).toBe('afternoon');
  });

  it('asks the verb gates', () => {
    expect(value(call(env(), hook(), 'verbs.eligible', { id: T1, verb: 'complete' }))).toBe(true);
    expect(value(call(env(), hook(), 'verbs.eligible', { id: DONE, verb: 'complete' }))).toBe(false);
  });
});

describe('writes', () => {
  it('creates are held, never applied, with the type, title and project rules', () => {
    const h = hook();
    expect(value(call(env(), h, 'items.create', { type: 'task', title: '  Stretch ', project: 'work' }))).toEqual({ ok: true });
    expect(h.writes).toEqual([{ kind: 'create', type: 'task', title: 'Stretch', project: 'Work' }]);
    expect(value(call(env(), h, 'items.create', { type: 'habit', title: 'Floss' }))).toEqual({ ok: false, reason: 'type' });
    expect(value(call(env(), h, 'items.create', { type: 'nope', title: 'Floss' }))).toEqual({ ok: false, reason: 'type' });
    expect(value(call(env(), h, 'items.create', { type: 'task', title: 'x', project: 'Nowhere' }))).toEqual({
      ok: false,
      reason: 'no-project',
    });
    for (const title of ['see https://x.test', 'go to evil.com/x', 'sk-abcdef123', 'x'.repeat(121)]) {
      expect(call(env(), h, 'items.create', { type: 'task', title })?.ok, title).toBe(false);
    }
    expect(h.writes).toHaveLength(1);
  });

  it('refuses a create titled after a Beeminder goal while the lock is on', () => {
    const locked = env({ stakeFacts: () => ({ lockOn: true, configsKnown: true, beeminder: { goals: 'Vitamins: vit' } }) });
    expect(value(call(locked, hook(), 'items.create', { type: 'task', title: 'vitamins' }))).toEqual({
      ok: false,
      reason: 'stake',
    });
    expect(value(call(locked, hook(), 'items.create', { type: 'task', title: 'Stretch' }))).toEqual({ ok: true });
  });

  it('the 26th write is refused with cap and counted', () => {
    const h = hook();
    for (let i = 0; i < 25; i++) expect(value(call(env(), h, 'items.create', { type: 'task', title: `T${i}` }))).toEqual({ ok: true });
    expect(value(call(env(), h, 'items.edit', { id: T1, title: 'More' }))).toEqual({ ok: false, reason: 'cap' });
    expect(h.writes).toHaveLength(25);
    expect(h.stopped).toBe(1);
  });

  it('edits title, priority and project, never notes or dates', () => {
    const h = hook();
    expect(value(call(env(), h, 'items.edit', { id: T1, priority: 'low', project: null }))).toEqual({ ok: true });
    expect(h.writes).toEqual([{ kind: 'edit', id: T1, patch: { priority: 'low', project: null } }]);
    expect(call(env(), h, 'items.edit', { id: T1, notes: 'x' })?.ok).toBe(false);
    expect(call(env(), h, 'items.edit', { id: T1, startDate: TODAY })?.ok).toBe(false);
    expect(call(env(), h, 'items.edit', { id: T1 })?.ok).toBe(false);
    expect(value(call(env(), h, 'items.edit', { id: T1, project: 'Nowhere' }))).toEqual({ ok: false, reason: 'no-project' });
  });

  it('refuses a title or project change on a stake-eligible item while locked', () => {
    const locked = env({ stakeFacts: () => ({ lockOn: true, configsKnown: true, beeminder: {} }) });
    expect(value(call(locked, hook(), 'items.edit', { id: H1, title: 'Other' }))).toEqual({ ok: false, reason: 'stake' });
    expect(value(call(locked, hook(), 'items.edit', { id: H1, project: 'Work' }))).toEqual({ ok: false, reason: 'stake' });
    expect(value(call(locked, hook(), 'items.edit', { id: T1, title: 'Fine' }))).toEqual({ ok: true });
  });

  it('runs only the recipe verbs, and only eligible ones', () => {
    for (const verb of ['tick', 'delete', 'resetStreak']) {
      expect(call(env(), hook(), 'verbs.run', { id: T1, verb })?.ok, verb).toBe(false);
    }
    expect(value(call(env(), hook(), 'verbs.run', { id: DONE, verb: 'complete' }))).toEqual({
      ok: false,
      reason: 'ineligible',
    });
    expect(call(env(), hook(), 'verbs.run', { id: T1, verb: 'complete', inDays: 2 })?.ok).toBe(false);
    const h = hook();
    expect(value(call(env(), h, 'verbs.run', { id: T1, verb: 'reschedule', inDays: 2 }))).toEqual({ ok: true });
    expect(h.writes).toEqual([{ kind: 'verb', id: T1, verb: 'reschedule', inDays: 2 }]);
  });
});

describe('the store', () => {
  it('reads see the overlay over the snapshot', () => {
    const h = hook({ snapshot: { a: 1, b: 2 } });
    call(env(), h, 'store.set', { key: 'a', value: 10 });
    call(env(), h, 'store.delete', { key: 'b' });
    call(env(), h, 'store.set', { key: 'c', value: [1] });
    expect(value(call(env(), h, 'store.get', { key: 'a' }))).toBe(10);
    expect(value(call(env(), h, 'store.get', { key: 'b' }))).toBeNull();
    expect(value(call(env(), h, 'store.keys'))).toEqual(['a', 'c']);
    expect(h.snapshot).toEqual({ a: 1, b: 2 });
    expect(h.storeOverlay.get('b')).toBe(DELETE);
  });

  it('a value over 8KB, or a store past its total, is too_big: a reply, not an error', () => {
    const h = hook();
    expect(value(call(env(), h, 'store.set', { key: 'big', value: 'x'.repeat(9000) }))).toEqual({
      ok: false,
      reason: 'too_big',
    });
    // 20KB of arguments is still under the args cap: the store answers, not the protocol.
    expect(value(call(env(), h, 'store.set', { key: 'big', value: 'x'.repeat(16_000) }))).toEqual({
      ok: false,
      reason: 'too_big',
    });
    const full = hook({ snapshot: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(7400)])) });
    expect(value(call(env(), full, 'store.set', { key: 'one-more', value: 'x'.repeat(2000) }))).toEqual({
      ok: false,
      reason: 'too_big',
    });
    expect(MOD_STORE_TOTAL_MAX_BYTES).toBeLessThan(65_536);
  });

  it('keys are 1 to 64 characters with no control characters', () => {
    expect(call(env(), hook(), 'store.set', { key: '', value: 1 })?.ok).toBe(false);
    expect(call(env(), hook(), 'store.set', { key: 'x'.repeat(65), value: 1 })?.ok).toBe(false);
    expect(call(env(), hook(), 'store.set', { key: 'a\nb', value: 1 })?.ok).toBe(false);
  });
});

describe('ui and timers', () => {
  it('one toast per hook, and three a minute', () => {
    const h = hook();
    expect(value(call(env(), h, 'ui.toast', { text: 'One' }))).toEqual({ ok: true });
    expect(value(call(env(), h, 'ui.toast', { text: 'Two' }))).toEqual({ ok: false, reason: 'rate' });
    expect(value(call(env(), hook({ toastsLastMinute: 3 }), 'ui.toast', { text: 'Four' }))).toEqual({
      ok: false,
      reason: 'rate',
    });
    expect(h.ui).toEqual([{ kind: 'toast', text: 'One' }]);
  });

  it('a toast may not pass for the app', () => {
    expect(call(env(), hook(), 'ui.toast', { text: 'Sign in again' })?.ok).toBe(false);
  });

  it('timers are at least 1s, and at most 10 pending', () => {
    expect(call(env(), hook(), 'after', { ms: 999 })?.ok).toBe(false);
    expect(call(env(), hook(), 'after', { ms: 3_600_001 })?.ok).toBe(false);
    const h = hook({ pendingTimers: 9 });
    expect(value(call(env(), h, 'after', { ms: 1000, name: 'nudge' }))).toEqual({ ok: true });
    expect(value(call(env(), h, 'after', { ms: 1000 }))).toEqual({ ok: false, reason: 'too_many' });
    expect(h.timers).toEqual([{ ms: 1000, name: 'nudge' }]);
  });

  it('a command may open an item, go to a view, open Organize and set a Look, all held', () => {
    const h = hook();
    call(env(), h, 'ui.openItem', { id: T1 });
    call(env(), h, 'nav.go', { scope: 'week', layout: 'schedule' });
    call(env(), h, 'nav.organize');
    call(env(), h, 'look.set', { light: 'paper' });
    expect(h.ui).toEqual([
      { kind: 'openItem', id: T1 },
      { kind: 'step', step: { do: 'goto', scope: 'week', layout: 'schedule' } },
      { kind: 'step', step: { do: 'organize' } },
      { kind: 'step', step: { do: 'setTheme', mode: 'light', theme: 'paper' } },
    ]);
    expect(call(env(), h, 'nav.go', { scope: 'month', layout: 'list' })?.ok).toBe(false);
    expect(value(call(env({ lookRefOk: () => false }), hook(), 'look.set', { look: 'nope' }))).toEqual({
      ok: false,
      reason: 'no-look',
    });
  });

  it('log lines go to the console sink, at most 20 a hook', () => {
    const e = env();
    const h = hook();
    for (let i = 0; i < 20; i++) expect(call(e, h, 'log', { level: 'warn', text: `${i}` })?.ok).toBe(true);
    expect(call(e, h, 'log', { level: 'info', text: 'more' })?.ok).toBe(false);
    expect(e.log).toHaveBeenCalledWith('warn', 'water', '0');
  });
});

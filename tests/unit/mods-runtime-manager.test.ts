import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createModRuntime, type RuntimeDeps } from '@/lib/mods/runtime-manager';
import type { BrokerEnv, HookState, PanelBridge } from '@/lib/mods/broker-core';
import type { ApplyResult } from '@/lib/mods/broker';
import { parseFrameMessage, type Fault, type HookEvent, type HostMessage, type ModMethod } from '@/lib/mods/protocol';
import { MOD_IDLE_UNLOAD_MS, MOD_LOADED_MAX } from '@/lib/mods/limits';
import type { ModManifest, UserMod } from '@/lib/mods/schema';
import type { SandboxStatus } from '@/lib/mods/sandbox-host';
import type { ModCode } from '@/lib/mods-store';

/**
 * The runtime manager (lib/mods/runtime-manager.ts, memory/plans/mods.md build
 * order 8) against a fake sandbox that answers as the frame and a worker
 * would, with each mod's behaviour scripted per test.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-03-10';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MANIFEST: ModManifest = {
  version: 1,
  uses: ['storage', 'ui'],
  commands: [{ id: 'log', label: 'Log a glass' }],
  panels: [{ id: 'water', label: 'Water', card: true }],
  settings: [],
};

type Call = (method: ModMethod, args?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;

interface Behaviour {
  hooks: string[];
  /** What the code declares; the stored manifest unless a test says otherwise. */
  declared?: unknown;
  loadFault?: Fault;
  /** A fault ends the hook faulted; `{ resultJson }` ends it ok with a resolve's tree. */
  onHook?: (e: HookEvent, call: Call) => Promise<Outcome> | Outcome;
}

type Outcome = Fault | { resultJson: string } | void;

class FakeSandbox {
  status: SandboxStatus = 'ready';
  posted: HostMessage[] = [];
  behaviours = new Map<string, Behaviour>();
  private listeners = new Set<(p: ReturnType<typeof parseFrameMessage>) => void>();
  private removed = new Set<() => void>();
  private replies = new Map<string, (m: HostMessage) => void>();

  ensure = vi.fn(async () => this.status);
  onMessage = (fn: (p: ReturnType<typeof parseFrameMessage>) => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  onRemoved = (fn: () => void) => {
    this.removed.add(fn);
    return () => this.removed.delete(fn);
  };
  remove = vi.fn(() => {
    for (const fn of this.removed) fn();
  });
  say(m: unknown) {
    const parsed = parseFrameMessage(m);
    for (const fn of this.listeners) fn(parsed);
  }
  post = (m: HostMessage) => {
    if (this.status !== 'ready') return false;
    this.posted.push(m);
    if (m.t === 'load') {
      const b = this.behaviours.get(m.modId);
      queueMicrotask(() => {
        if (!b) return;
        if (b.loadFault) this.say({ t: 'loaded', modId: m.modId, gen: m.gen, ok: false, fault: b.loadFault });
        else {
          const manifestJson = JSON.stringify(b.declared ?? MANIFEST);
          this.say({ t: 'loaded', modId: m.modId, gen: m.gen, ok: true, hooks: b.hooks, manifestJson });
        }
      });
    } else if (m.t === 'hook') {
      const b = this.behaviours.get(m.modId);
      queueMicrotask(async () => {
        let n = 0;
        const call: Call = (method, args = null) =>
          new Promise((resolve) => {
            const callId = n++;
            this.replies.set(`${m.hookId}:${callId}`, (r) => resolve(r as never));
            this.say({ t: 'call', modId: m.modId, gen: m.gen, hookId: m.hookId, callId, method, argsJson: JSON.stringify(args) });
          });
        const f = await b?.onHook?.(m.event, call);
        const key = { t: 'done', modId: m.modId, gen: m.gen, hookId: m.hookId };
        if (f && 'resultJson' in f) this.say({ ...key, ok: true, resultJson: f.resultJson });
        else this.say(f ? { ...key, ok: false, fault: f } : { ...key, ok: true });
      });
    } else if (m.t === 'reply') {
      this.replies.get(`${m.hookId}:${m.callId}`)?.(m);
    }
    return true;
  };
  sent<T extends HostMessage['t']>(t: T) {
    return this.posted.filter((m): m is Extract<HostMessage, { t: T }> => m.t === t);
  }
}

let sandbox: FakeSandbox;
let rows: UserMod[];
let codes: Map<string, ModCode>;
let hidden: boolean;
let ready: boolean;
type Fn<K extends keyof RuntimeDeps> = Mock<Extract<RuntimeDeps[K], (...args: never[]) => unknown>>;
let deps: Omit<RuntimeDeps, 'apply' | 'logFault' | 'disable' | 'storeSet' | 'loadCode'> & {
  apply: Fn<'apply'>;
  logFault: Fn<'logFault'>;
  disable: Fn<'disable'>;
  storeSet: Fn<'storeSet'>;
  loadCode: Fn<'loadCode'>;
};

const env = (): BrokerEnv => ({
  planner: () => ({ items: [], projects: [], routines: [], seasons: [], goals: [], userTimezone: 'UTC' }),
  stakeFacts: () => ({ lockOn: false, configsKnown: true, beeminder: {} }),
  canCreateType: () => true,
  todayAndTime: () => ({ today: TODAY, hhmm: '12:00' }),
  lookRefOk: () => true,
  log: () => {},
});

function addMod(n: number, b: Behaviour, over: Partial<UserMod> = {}): UserMod {
  const row: UserMod = {
    id: id(n),
    userId: USER,
    kind: 'mod',
    slug: `mod${n}`,
    name: `Mod ${n}`,
    enabled: true,
    manifest: MANIFEST,
    disabledReason: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...over,
  };
  rows.push(row);
  codes.set(row.id, { enabled: true, source: `// mod ${n}`, store: {}, manifest: row.manifest, updatedAt: row.updatedAt });
  sandbox.behaviours.set(row.id, b);
  return row;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const REVIEW = { kind: 'review.saved' as const, date: TODAY };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  sandbox = new FakeSandbox();
  rows = [];
  codes = new Map();
  hidden = false;
  ready = true;
  deps = {
    sandbox,
    env,
    ready: () => ready,
    userId: () => USER,
    rows: () => rows.filter((r) => r.enabled),
    loadCode: vi.fn(async (modId: string) => codes.get(modId) ?? null),
    storeSet: vi.fn<RuntimeDeps['storeSet']>(async () => 'ok'),
    logFault: vi.fn<RuntimeDeps['logFault']>(),
    disable: vi.fn((modId: string, reason: string) => {
      rows = rows.map((r) => (r.id === modId ? { ...r, enabled: false, disabledReason: reason } : r));
    }),
    switchedOff: vi.fn(),
    apply: vi.fn(
      (hook: HookState): ApplyResult => ({
        status: 'applied',
        fault: null,
        toasts: hook.ui.filter((u) => u.kind === 'toast').length,
      })
    ),
    uiDeps: { navigate: vi.fn() },
    hidden: () => hidden,
  };
});
afterEach(() => vi.useRealTimers());

describe('loading', () => {
  it('loads a mod lazily on its first event, then runs the hook', async () => {
    const seen: HookEvent[] = [];
    const row = addMod(1, { hooks: ['review.saved'], onHook: (e) => void seen.push(e) });
    const rt = createModRuntime(deps);
    expect(sandbox.posted).toEqual([]);
    rt.dispatch(REVIEW);
    await settle();
    expect(deps.loadCode).toHaveBeenCalledWith(row.id);
    expect(sandbox.sent('load')).toEqual([{ t: 'load', modId: row.id, gen: 1, source: '// mod 1' }]);
    expect(seen).toEqual([REVIEW]);
    expect(deps.apply).toHaveBeenCalledTimes(1);
    // Loaded once; the next event reuses it.
    rt.dispatch(REVIEW);
    await settle();
    expect(sandbox.sent('load')).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('a mod that does not listen for the event is not woken again for it', async () => {
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.dispatch(REVIEW);
    await settle();
    expect(sandbox.sent('load')).toHaveLength(1);
    expect(sandbox.sent('hook')).toEqual([]);
    rt.dispatch(REVIEW);
    await settle();
    expect(sandbox.sent('load')).toHaveLength(1);
  });

  it(`keeps at most ${MOD_LOADED_MAX} loaded, unloading the least recently used idle one`, async () => {
    for (let n = 1; n <= MOD_LOADED_MAX + 1; n++) addMod(n, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    for (let n = 1; n <= MOD_LOADED_MAX + 1; n++) {
      rt.runCommand(id(n), 'log');
      await settle();
      vi.advanceTimersByTime(10);
    }
    expect(rt.loadedIds()).toHaveLength(MOD_LOADED_MAX);
    expect(rt.loadedIds()).not.toContain(id(1));
    expect(sandbox.sent('unload')).toEqual([{ t: 'unload', modId: id(1), gen: 1 }]);
  });

  it('a stored manifest the code does not declare is a load fault, and nothing runs', async () => {
    addMod(1, { hooks: ['command'], declared: { version: 1, uses: ['storage', 'ui', 'items:write'], commands: MANIFEST.commands } });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.sent('hook')).toEqual([]);
    expect(deps.logFault).toHaveBeenCalledWith(
      USER,
      id(1),
      expect.objectContaining({ code: 'load', message: 'manifest does not match the code; open it in Make and save' })
    );
    expect(rt.loadedIds()).toEqual([]);
  });

  it('an invalid stored manifest is a load fault before anything loads', async () => {
    const row = addMod(1, { hooks: ['command'] });
    codes.set(row.id, { ...codes.get(row.id)!, manifest: { version: 1, uses: ['network'] } });
    const rt = createModRuntime(deps);
    rt.runCommand(row.id, 'log');
    await settle();
    expect(sandbox.sent('load')).toEqual([]);
    expect(deps.logFault).toHaveBeenCalledWith(USER, row.id, expect.objectContaining({ code: 'load', message: 'manifest invalid' }));
  });

  it('after `gone`, the next event loads a new generation', async () => {
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    sandbox.say({ t: 'gone', modId: id(1), gen: 1, fault: { code: 'broken', message: 'crashed' } });
    expect(rt.loadedIds()).toEqual([]);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.sent('load').map((m) => m.gen)).toEqual([1, 2]);
    expect(sandbox.sent('hook').at(-1)).toMatchObject({ gen: 2 });
  });

  it('runs nothing while the sandbox is unavailable, and records no fault', async () => {
    sandbox.status = 'unavailable';
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.posted).toEqual([]);
    expect(deps.logFault).not.toHaveBeenCalled();
  });
});

describe('hot reload', () => {
  it('reloads on a changed source or manifest, never on updated_at alone', async () => {
    const row = addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(row.id, 'log');
    await settle();

    // A store write moved updated_at: the code is read again, and nothing reloads.
    codes.set(row.id, { ...codes.get(row.id)!, updatedAt: '2026-03-02T00:00:00Z' });
    rows[0] = { ...rows[0], updatedAt: '2026-03-02T00:00:00Z' };
    rt.rowsChanged();
    await settle();
    expect(deps.loadCode).toHaveBeenCalledTimes(2);
    expect(sandbox.sent('load')).toHaveLength(1);

    // The source changed: a new generation swaps in, and the old one goes.
    codes.set(row.id, { ...codes.get(row.id)!, source: '// v2', updatedAt: '2026-03-03T00:00:00Z' });
    rows[0] = { ...rows[0], updatedAt: '2026-03-03T00:00:00Z' };
    rt.rowsChanged();
    await settle();
    expect(sandbox.sent('load').map((m) => [m.gen, m.source])).toEqual([
      [1, '// mod 1'],
      [2, '// v2'],
    ]);
    expect(sandbox.sent('unload')).toEqual([{ t: 'unload', modId: row.id, gen: 1 }]);
  });

  it('a reload that fails leaves the old generation running', async () => {
    const row = addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(row.id, 'log');
    await settle();
    sandbox.behaviours.set(row.id, { hooks: ['command'], loadFault: { code: 'load', message: 'SyntaxError: x' } });
    rt.saved(row.id);
    await settle();
    expect(deps.logFault).toHaveBeenCalledWith(USER, row.id, expect.objectContaining({ code: 'load' }));
    expect(sandbox.sent('unload')).toEqual([]);
    rt.runCommand(row.id, 'log');
    await settle();
    expect(sandbox.sent('hook').map((m) => m.gen)).toEqual([1, 1]);
  });

  it('keys still to flush survive a reload: the snapshot is not replaced', async () => {
    const values: unknown[] = [];
    const row = addMod(1, {
      hooks: ['command'],
      onHook: async (_e, call) => {
        const got = await call('store.get', { key: 'n' });
        values.push(got.value);
        await call('store.set', { key: 'n', value: ((got.value as number) ?? 0) + 1 });
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(row.id, 'log');
    await settle();
    // The row says 0 glasses now (another device), but our 1 is still dirty.
    codes.set(row.id, { ...codes.get(row.id)!, source: '// v2', store: { n: 0 } });
    rt.saved(row.id);
    await settle();
    rt.runCommand(row.id, 'log');
    await settle();
    expect(values).toEqual([null, 1]);
  });
});

describe('the store', () => {
  it('coalesces 50 writes to one key into one RPC per 5s, with the latest value', async () => {
    let next = 0;
    addMod(1, {
      hooks: ['command'],
      onHook: async (_e, call) => {
        for (let i = 0; i < 25; i++) await call('store.set', { key: 'n', value: ++next });
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    rt.runCommand(id(1), 'log');
    await settle();
    expect(deps.storeSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.storeSet.mock.calls).toEqual([[id(1), 'n', 50]]);
  });

  it('a key whose RPC errors is retried at the next flush, then dropped with a fault that does not count', async () => {
    deps.storeSet.mockResolvedValue('error');
    addMod(1, { hooks: ['command'], onHook: async (_e, call) => void (await call('store.set', { key: 'n', value: 1 })) });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(deps.storeSet).toHaveBeenCalledTimes(4);
    expect(deps.logFault).toHaveBeenCalledWith(USER, id(1), expect.objectContaining({ hook: 'store', counted: false }));
    expect(deps.disable).not.toHaveBeenCalled();
  });

  it('flushAll skips the 5s gate', async () => {
    addMod(1, { hooks: ['command'], onHook: async (_e, call) => void (await call('store.set', { key: 'n', value: 1 })) });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    await rt.flushAll();
    expect(deps.storeSet).toHaveBeenCalledWith(id(1), 'n', 1);
  });
});

describe('faults', () => {
  const failing = (f: Fault): Behaviour => ({ hooks: ['command'], onHook: () => f });

  it('a faulted hook applies nothing: no writes, store or timers', async () => {
    addMod(1, {
      hooks: ['command'],
      onHook: async (_e, call) => {
        await call('store.set', { key: 'n', value: 1 });
        await call('after', { ms: 1000 });
        return { code: 'error', message: 'TypeError: boom' };
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(deps.apply).not.toHaveBeenCalled();
    await rt.flushAll();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.storeSet).not.toHaveBeenCalled();
    expect(sandbox.sent('hook')).toHaveLength(1);
  });

  it('three faults in 10 minutes switch the mod off and say so', async () => {
    const row = addMod(1, failing({ code: 'cpu', message: 'InternalError: interrupted' }));
    const rt = createModRuntime(deps);
    for (let i = 0; i < 3; i++) {
      rt.runCommand(row.id, 'log');
      await settle();
    }
    expect(deps.disable).toHaveBeenCalledWith(row.id, '3 errors in 10 minutes. Last: InternalError: interrupted');
    expect(deps.switchedOff).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
    expect(rt.loadedIds()).toEqual([]);
  });

  it('a save from this tab clears the count', async () => {
    const row = addMod(1, failing({ code: 'error', message: 'x' }));
    const rt = createModRuntime(deps);
    for (let i = 0; i < 2; i++) {
      rt.runCommand(row.id, 'log');
      await settle();
    }
    rt.saved(row.id);
    await settle();
    for (let i = 0; i < 2; i++) {
      rt.runCommand(row.id, 'log');
      await settle();
    }
    expect(deps.disable).not.toHaveBeenCalled();
  });

  it('a wall fault while the tab is hidden is logged but does not count, and fault logs are capped', async () => {
    hidden = true;
    const row = addMod(1, failing({ code: 'wall', message: 'the hook took too long' }));
    const rt = createModRuntime(deps);
    for (let i = 0; i < 25; i++) {
      rt.runCommand(row.id, 'log');
      await settle();
    }
    expect(deps.disable).not.toHaveBeenCalled();
    expect(deps.logFault).toHaveBeenCalledTimes(20);
    expect(deps.logFault.mock.calls[0][2]).toMatchObject({ code: 'wall', counted: false });
  });

  it('31 hooks in a minute switch the mod off at once, in the recipe wording', async () => {
    const row = addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    for (let i = 0; i < 31; i++) {
      rt.runCommand(row.id, 'log');
      await settle();
    }
    expect(sandbox.sent('hook')).toHaveLength(30);
    expect(deps.disable).toHaveBeenCalledWith(row.id, 'It ran more than 30 times in a minute.');
  });

  it('the 51st call faults the hook even though the mod caught the refusal', async () => {
    addMod(1, {
      hooks: ['command'],
      onHook: async (_e, call) => {
        for (let i = 0; i < 60; i++) await call('today');
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.logFault).toHaveBeenCalledWith(USER, id(1), expect.objectContaining({ code: 'calls' }));
  });

  it('a message the host cannot read is a protocol fault for the mod that sent it', async () => {
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    sandbox.say({ t: 'done', modId: id(1), gen: 1, hookId: 'not-a-uuid', ok: true, extra: 1 });
    expect(deps.logFault).toHaveBeenCalledWith(USER, id(1), expect.objectContaining({ code: 'protocol' }));
    expect(rt.loadedIds()).toEqual([]);
  });
});

describe('events', () => {
  it('a timer the hook held fires its own hook, only after the hook settled ok', async () => {
    const seen: string[] = [];
    addMod(1, {
      hooks: ['command', 'timer'],
      onHook: async (e, call) => {
        seen.push(e.kind === 'timer' ? `timer:${e.name}` : e.kind);
        if (e.kind === 'command') await call('after', { ms: 2000, name: 'nudge' });
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    await vi.advanceTimersByTimeAsync(1999);
    expect(seen).toEqual(['command']);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['command', 'timer:nudge']);
  });

  it('an undo of a mod’s own run is not delivered to that mod', async () => {
    const heard: string[] = [];
    const hooks = ['item.uncompleted'];
    const a = addMod(1, { hooks, onHook: () => void heard.push('a') }, { name: 'Water' });
    addMod(2, { hooks, onHook: () => void heard.push('b') }, { name: 'Other' });
    deps.env = () => ({
      ...env(),
      planner: () => ({
        items: [{ id: id(9), type: 'task', title: 't', status: 'pending', isScheduled: false, order: 0 } as never],
        projects: [],
        routines: [],
        seasons: [],
        goals: [],
        userTimezone: 'UTC',
      }),
    });
    const rt = createModRuntime(deps);
    rt.dispatchUndo({
      kind: 'item.uncompleted',
      origin: 'undo',
      itemId: id(9),
      date: TODAY,
      type: 'task',
      undoneLabel: `Mod: Water · command Log a glass`,
    });
    await settle();
    expect(heard).toEqual(['b']);
    expect(sandbox.sent('hook')[0].event).toMatchObject({ kind: 'item.uncompleted', origin: 'undo' });
    expect(a.id).toBe(id(1));
  });

  it('runs a command only if the stored manifest declares it', async () => {
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'nope');
    await settle();
    expect(sandbox.posted).toEqual([]);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.sent('hook')[0].event).toEqual({ kind: 'command', id: 'log' });
  });

  it('nothing runs while the runtime is not ready, or after stop', async () => {
    addMod(1, { hooks: ['command'] });
    const rt = createModRuntime(deps);
    ready = false;
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.posted).toEqual([]);
    ready = true;
    await rt.stop();
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.posted).toEqual([]);
  });

  it('a mod switched off is unloaded with its timers', async () => {
    const seen: string[] = [];
    addMod(1, {
      hooks: ['command', 'timer'],
      onHook: async (e, call) => {
        seen.push(e.kind);
        if (e.kind === 'command') await call('after', { ms: 1000 });
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    rows[0] = { ...rows[0], enabled: false };
    rt.rowsChanged();
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(['command']);
    expect(sandbox.sent('unload')).toEqual([{ t: 'unload', modId: id(1), gen: 1 }]);
  });
});

describe('consent and races', () => {
  it('runs nothing whose row the database holds switched off, and reads the rows again', async () => {
    const refresh = vi.fn();
    const row = addMod(1, { hooks: ['command'] });
    codes.set(row.id, { ...codes.get(row.id)!, enabled: false });
    const rt = createModRuntime({ ...deps, refresh });
    rt.runCommand(row.id, 'log');
    await settle();
    expect(sandbox.sent('load')).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('runs nothing whose stored uses are wider than the ones this tab switched on', async () => {
    const refresh = vi.fn();
    const wider: ModManifest = { ...MANIFEST, uses: [...MANIFEST.uses, 'items:write'] };
    // Saved wider on another device; this tab's row still shows the old uses, switched on.
    const row = addMod(1, { hooks: ['command'], declared: wider });
    codes.set(row.id, { ...codes.get(row.id)!, manifest: wider });
    const rt = createModRuntime({ ...deps, refresh });
    rt.runCommand(row.id, 'log');
    await settle();
    expect(sandbox.sent('load')).toEqual([]);
    expect(sandbox.sent('hook')).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a loaded mod whose row went off in the database stops when the change is read', async () => {
    const row = addMod(1, { hooks: ['command'] });
    const rt = createModRuntime({ ...deps, refresh: vi.fn() });
    rt.runCommand(row.id, 'log');
    await settle();
    codes.set(row.id, { ...codes.get(row.id)!, enabled: false, source: '// v2', updatedAt: '2026-03-02T00:00:00Z' });
    rows[0] = { ...rows[0], updatedAt: '2026-03-02T00:00:00Z' };
    rt.rowsChanged();
    await settle();
    expect(sandbox.sent('load')).toHaveLength(1);
    expect(sandbox.sent('unload')).toEqual([{ t: 'unload', modId: row.id, gen: 1 }]);
    expect(rt.loadedIds()).toEqual([]);
  });

  it('switching a mod off mid-hook ends the hook with no wall fault and keeps the sandbox', async () => {
    addMod(1, { hooks: ['command'], onHook: () => new Promise<void>(() => {}) });
    const rt = createModRuntime(deps);
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.sent('hook')).toHaveLength(1);
    rows[0] = { ...rows[0], enabled: false };
    rt.rowsChanged();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sandbox.remove).not.toHaveBeenCalled();
    expect(deps.logFault).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('a flush that lands while a reload reads the row keeps the newer snapshot', async () => {
    const values: unknown[] = [];
    const row = addMod(1, {
      hooks: ['command'],
      onHook: async (_e, call) => {
        const got = await call('store.get', { key: 'n' });
        values.push(got.value);
        if (got.value === null) await call('store.set', { key: 'n', value: 1 });
      },
    });
    const rt = createModRuntime(deps);
    rt.runCommand(row.id, 'log');
    await settle();

    // The reload's read goes out before the flush and answers after it.
    let answer!: (c: ModCode) => void;
    const stale = { ...codes.get(row.id)!, source: '// v2', store: {} };
    deps.loadCode.mockImplementationOnce(() => new Promise<ModCode>((resolve) => (answer = resolve)));
    rt.saved(row.id);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.storeSet).toHaveBeenCalledWith(row.id, 'n', 1);
    answer(stale);
    await settle();
    expect(sandbox.sent('load')).toHaveLength(2);

    rt.runCommand(row.id, 'log');
    await settle();
    expect(values).toEqual([null, 1]);
  });
});

describe('panels (build order 9)', () => {
  const TREE = JSON.stringify({ type: 'button', label: '+1', action: 'add' });
  const RESOLVE = { kind: 'ui.resolve' as const, panelId: 'water' };

  /** A panel bridge holding one cached tree at seq 1 with one button and two atoms. */
  function bridge(over: Partial<PanelBridge> = {}): PanelBridge {
    return {
      atoms: () => ({ note: 'hi' }),
      atomKinds: () => ({ note: { kind: 'text' }, done: { kind: 'checkbox' } }),
      actionShown: (_m, panelId, action, arg, seq) => panelId === 'water' && action === 'add' && arg === undefined && seq === 1,
      commitAtoms: vi.fn(),
      ...over,
    };
  }

  function panelRuntime(over: Partial<RuntimeDeps> = {}) {
    const onPanelsStale = vi.fn();
    const onUserHooksSlowed = vi.fn();
    const rt = createModRuntime({ ...deps, panels: bridge(), onPanelsStale, onUserHooksSlowed, ...over });
    return { rt, onPanelsStale, onUserHooksSlowed };
  }

  it('resolvePanel loads on demand and hands back the tree, off the hook rate', async () => {
    addMod(1, { hooks: ['ui.resolve'], onHook: () => ({ resultJson: TREE }) });
    const { rt, onPanelsStale } = panelRuntime();
    for (let i = 0; i < 40; i++) {
      const p = rt.resolvePanel(id(1), 'water');
      await settle();
      expect(await p).toEqual({ ok: true, resultJson: TREE });
    }
    expect(sandbox.sent('load')).toHaveLength(1);
    expect(sandbox.sent('hook')[0].event).toEqual(RESOLVE);
    // 40 resolves would trip the 30-a-minute hook rate; they never touch it.
    expect(deps.disable).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    // One resolve never starts another.
    expect(onPanelsStale).not.toHaveBeenCalled();
    expect(rt.resolvesPanels(id(1))).toBe(true);
  });

  it('a mod with no resolve handler draws nothing, and a panel it does not declare is dropped', async () => {
    addMod(1, { hooks: ['command'] });
    const { rt } = panelRuntime();
    const p = rt.resolvePanel(id(1), 'water');
    await settle();
    expect(await p).toEqual({ ok: true });
    expect(sandbox.sent('hook')).toEqual([]);
    expect(rt.resolvesPanels(id(1))).toBe(false);
    // Loaded now: answered with no hook and no queue.
    expect(await rt.resolvePanel(id(1), 'water')).toEqual({ ok: true });
    expect(await rt.resolvePanel(id(1), 'other')).toBe('dropped');
    expect(await rt.resolvePanel(id(9), 'water')).toBe('off');
  });

  it('a resolve asked while newer code is on its way waits for it, not the old hooks', async () => {
    addMod(1, { hooks: ['command'] });
    const { rt } = panelRuntime();
    const first = rt.resolvePanel(id(1), 'water');
    await settle();
    expect(await first).toEqual({ ok: true });
    // The new code adds a resolve handler; the save queues the reload.
    sandbox.behaviours.set(id(1), { hooks: ['command', 'ui.resolve'], onHook: () => ({ resultJson: TREE }) });
    rows[0] = { ...rows[0], updatedAt: '2026-03-02T00:00:00Z' };
    codes.set(id(1), { ...codes.get(id(1))!, source: '// mod 1, v2', updatedAt: '2026-03-02T00:00:00Z' });
    rt.saved(id(1));
    const p = rt.resolvePanel(id(1), 'water');
    await settle();
    expect(await p).toEqual({ ok: true, resultJson: TREE });
  });

  it('a resolve that faults settles with the fault and redraws nothing', async () => {
    addMod(1, { hooks: ['ui.resolve'], onHook: () => ({ code: 'error', message: 'TypeError: boom' }) });
    const { rt, onPanelsStale } = panelRuntime();
    const p = rt.resolvePanel(id(1), 'water');
    await settle();
    expect(await p).toEqual({ fault: { code: 'error', message: 'TypeError: boom' } });
    expect(deps.logFault).toHaveBeenCalledTimes(1);
    expect(onPanelsStale).not.toHaveBeenCalled();
  });

  it('a hook other than a resolve that settles ok tells the panels; a faulted one does not', async () => {
    let fail = false;
    addMod(1, { hooks: ['command'], onHook: () => (fail ? { code: 'error', message: 'x' } : undefined) });
    const { rt, onPanelsStale } = panelRuntime();
    rt.runCommand(id(1), 'log');
    await settle();
    expect(onPanelsStale).toHaveBeenCalledWith(id(1), 'hook');
    onPanelsStale.mockClear();
    fail = true;
    rt.runCommand(id(1), 'log');
    await settle();
    expect(onPanelsStale).not.toHaveBeenCalled();
  });

  it('saved() tells the panels whether or not the mod is loaded', () => {
    addMod(1, { hooks: ['ui.resolve'] });
    const { rt, onPanelsStale } = panelRuntime();
    rt.saved(id(1));
    expect(onPanelsStale).toHaveBeenCalledWith(id(1), 'saved');
  });

  describe('every way out of the queue settles the work', () => {
    it('not ready', async () => {
      addMod(1, { hooks: ['ui.resolve'] });
      const { rt } = panelRuntime();
      ready = false;
      expect(await rt.resolvePanel(id(1), 'water')).toBe('dropped');
    });

    it('not ready by the time the queue runs', async () => {
      addMod(1, {
        hooks: ['ui.resolve', 'command'],
        onHook: (e) => (e.kind === 'command' ? new Promise<void>((r) => setTimeout(r, 100)) : { resultJson: TREE }),
      });
      const { rt } = panelRuntime();
      rt.runCommand(id(1), 'log');
      await settle();
      const p = rt.resolvePanel(id(1), 'water');
      ready = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBe('dropped');
    });

    it('a failed load', async () => {
      addMod(1, { hooks: [], loadFault: { code: 'load', message: 'nope' } });
      const { rt } = panelRuntime();
      const p = rt.resolvePanel(id(1), 'water');
      await settle();
      expect(await p).toBe('dropped');
    });

    it('a full queue', async () => {
      addMod(1, { hooks: ['ui.resolve', 'command'], onHook: () => new Promise<void>(() => {}) });
      const { rt } = panelRuntime();
      rt.runCommand(id(1), 'log');
      await settle();
      const settled: unknown[] = [];
      for (let i = 0; i < 60; i++) void rt.resolvePanel(id(1), 'water').then((o) => settled.push(o));
      await settle();
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.every((o) => o === 'dropped')).toBe(true);
    });

    it('a row change that switches it off, for running and queued work', async () => {
      addMod(1, { hooks: ['ui.resolve'], onHook: () => new Promise<void>(() => {}) });
      const { rt } = panelRuntime();
      const running = rt.resolvePanel(id(1), 'water');
      await settle();
      const queued = rt.resolvePanel(id(1), 'water');
      rows[0] = { ...rows[0], enabled: false };
      rt.rowsChanged();
      expect(await running).toBe('off');
      expect(await queued).toBe('off');
    });

    it('a switch-off by its fault count drains what waits', async () => {
      addMod(1, { hooks: ['command', 'ui.resolve'], onHook: (e) => (e.kind === 'command' ? { code: 'error', message: 'x' } : undefined) });
      const { rt } = panelRuntime();
      rt.runCommand(id(1), 'log');
      rt.runCommand(id(1), 'log');
      rt.runCommand(id(1), 'log');
      const p = rt.resolvePanel(id(1), 'water');
      await settle();
      expect(deps.disable).toHaveBeenCalledTimes(1);
      expect(await p).toBe('off');
    });

    it('stop', async () => {
      addMod(1, { hooks: ['ui.resolve'], onHook: () => new Promise<void>(() => {}) });
      const { rt } = panelRuntime();
      const running = rt.resolvePanel(id(1), 'water');
      await settle();
      const queued = rt.resolvePanel(id(1), 'water');
      await rt.stop();
      expect(await running).toBe('dropped');
      expect(await queued).toBe('dropped');
      expect(await rt.resolvePanel(id(1), 'water')).toBe('dropped');
    });

  });

  describe("the person's own hooks", () => {
    it('runAction counts a press only on the tree the person saw, and loads on demand', async () => {
      const seen: HookEvent[] = [];
      addMod(1, { hooks: ['ui.action'], onHook: (e) => void seen.push(e) });
      const { rt, onPanelsStale } = panelRuntime();
      const p = rt.runAction(id(1), 'water', 'add', undefined, { note: 'hi' }, 1);
      await settle();
      expect(await p).toEqual({ ok: true });
      expect(seen).toEqual([{ kind: 'ui.action', panelId: 'water', action: 'add', atoms: { note: 'hi' } }]);
      expect(deps.apply).toHaveBeenCalledWith(
        expect.objectContaining({ hookKind: 'ui.action' }),
        expect.objectContaining({ hookLabel: 'Water' })
      );
      expect(onPanelsStale).toHaveBeenCalledWith(id(1), 'hook');

      onPanelsStale.mockClear();
      // A newer tree (seq 2), another button, another panel: dropped, and the panel redraws.
      expect(await rt.runAction(id(1), 'water', 'add', undefined, {}, 2)).toBe('dropped');
      expect(await rt.runAction(id(1), 'water', 'remove', undefined, {}, 1)).toBe('dropped');
      expect(await rt.runAction(id(1), 'other', 'add', undefined, {}, 1)).toBe('dropped');
      expect(onPanelsStale).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(1);
    });

    it('runAction works after an idle unload: the tree is the check, not the generation', async () => {
      addMod(1, { hooks: ['ui.action'] });
      const { rt } = panelRuntime();
      const first = rt.runAction(id(1), 'water', 'add', undefined, {}, 1);
      await settle();
      expect(await first).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(MOD_IDLE_UNLOAD_MS + 1);
      expect(rt.loadedIds()).toEqual([]);
      const second = rt.runAction(id(1), 'water', 'add', undefined, {}, 1);
      await settle();
      expect(await second).toEqual({ ok: true });
      expect(sandbox.sent('load')).toHaveLength(2);
    });

    it('61 presses in a minute drop the excess quietly and never switch the mod off', async () => {
      addMod(1, { hooks: ['ui.action'] });
      const { rt, onUserHooksSlowed } = panelRuntime();
      const outcomes: unknown[] = [];
      for (let i = 0; i < 61; i++) {
        const p = rt.runAction(id(1), 'water', 'add', undefined, {}, 1);
        await settle();
        outcomes.push(await p);
      }
      expect(outcomes.filter((o) => o === 'dropped')).toHaveLength(1);
      expect(onUserHooksSlowed).toHaveBeenCalledTimes(1);
      expect(deps.disable).not.toHaveBeenCalled();
      expect(deps.logFault).not.toHaveBeenCalled();
      // A command still has its own rate, untouched by the presses.
      rt.runCommand(id(1), 'log');
      await settle();
      expect(deps.disable).not.toHaveBeenCalled();
    });

    it('atomChanged takes only a key a tree shows, and the latest value wins while one waits', async () => {
      const seen: HookEvent[] = [];
      addMod(1, {
        hooks: ['atom.changed', 'command'],
        onHook: (e) => {
          seen.push(e);
          if (e.kind === 'command') return new Promise<void>((r) => setTimeout(r, 100));
        },
      });
      const { rt } = panelRuntime();
      expect(await rt.atomChanged(id(1), 'unshown', 'x')).toBe('dropped');
      rt.runCommand(id(1), 'log');
      await settle();
      const a = rt.atomChanged(id(1), 'note', 'a');
      const b = rt.atomChanged(id(1), 'note', 'ab');
      const c = rt.atomChanged(id(1), 'done', true);
      await vi.advanceTimersByTimeAsync(200);
      expect(await a).toEqual({ ok: true });
      expect(await b).toEqual({ ok: true });
      expect(await c).toEqual({ ok: true });
      expect(seen.slice(1)).toEqual([
        { kind: 'atom.changed', key: 'note', value: 'ab' },
        { kind: 'atom.changed', key: 'done', value: true },
      ]);
    });
  });

  it('a hook starts with the atoms, their kinds and the parsed settings', async () => {
    const manifest: ModManifest = {
      ...MANIFEST,
      settings: [{ kind: 'number', key: 'goal', label: 'Goal', default: 8, min: 1, max: 20 }],
    };
    const row = addMod(1, { hooks: ['command'], declared: manifest }, { manifest });
    codes.set(row.id, { ...codes.get(row.id)!, store: { '@settings': { goal: 12, stray: 1 } } });
    const { rt } = panelRuntime();
    rt.runCommand(row.id, 'log');
    await settle();
    const hook = deps.apply.mock.calls[0][0];
    expect(hook.atoms).toEqual({ note: 'hi' });
    expect(hook.atomKinds).toEqual({ note: { kind: 'text' }, done: { kind: 'checkbox' } });
    expect(hook.settings).toEqual({ goal: 12 });
  });

  it('settingsChanged updates the snapshot in memory, with no reload, and redraws', async () => {
    const manifest: ModManifest = {
      ...MANIFEST,
      settings: [{ kind: 'number', key: 'goal', label: 'Goal', default: 8 }],
    };
    addMod(1, { hooks: ['command'], declared: manifest }, { manifest });
    const { rt, onPanelsStale } = panelRuntime();
    rt.runCommand(id(1), 'log');
    await settle();
    rt.settingsChanged(id(1), { goal: 3 });
    expect(onPanelsStale).toHaveBeenCalledWith(id(1), 'settings');
    rt.runCommand(id(1), 'log');
    await settle();
    expect(sandbox.sent('load')).toHaveLength(1);
    expect(deps.apply.mock.calls[1][0].settings).toEqual({ goal: 3 });
    expect(deps.storeSet).not.toHaveBeenCalled();
  });

  it('panelFault counts a tree the host refused as an error fault', async () => {
    addMod(1, { hooks: ['ui.resolve'] });
    const { rt } = panelRuntime();
    for (let i = 0; i < 3; i++) rt.panelFault(id(1), 'water', 'the panel: root is not JSON');
    expect(deps.logFault).toHaveBeenCalledTimes(3);
    expect(deps.disable).toHaveBeenCalledTimes(1);
  });
});

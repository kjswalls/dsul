import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createModRuntime, type RuntimeDeps } from '@/lib/mods/runtime-manager';
import type { BrokerEnv, HookState } from '@/lib/mods/broker-core';
import type { ApplyResult } from '@/lib/mods/broker';
import { parseFrameMessage, type Fault, type HookEvent, type HostMessage, type ModMethod } from '@/lib/mods/protocol';
import { MOD_LOADED_MAX } from '@/lib/mods/limits';
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
const MANIFEST: ModManifest = { version: 1, uses: ['storage', 'ui'], commands: [{ id: 'log', label: 'Log a glass' }] };

type Call = (method: ModMethod, args?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;

interface Behaviour {
  hooks: string[];
  /** What the code declares; the stored manifest unless a test says otherwise. */
  declared?: unknown;
  loadFault?: Fault;
  onHook?: (e: HookEvent, call: Call) => Promise<Fault | void> | Fault | void;
}

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
        this.say(f ? { t: 'done', modId: m.modId, gen: m.gen, hookId: m.hookId, ok: false, fault: f } : { t: 'done', modId: m.modId, gen: m.gen, hookId: m.hookId, ok: true });
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
  codes.set(row.id, { source: `// mod ${n}`, store: {}, manifest: row.manifest, updatedAt: row.updatedAt });
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

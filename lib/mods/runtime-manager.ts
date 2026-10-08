import type { ModEvent, ModOnlyEvent } from '@/lib/mod-events';
import { stillHolds } from '@/lib/recipes/validate-core';
import type { UiStepDeps } from '@/lib/recipes/ui-steps';
import {
  DELETE,
  brokerCall,
  createHookState,
  projectItem,
  type BrokerEnv,
  type HeldTimer,
  type HookState,
  type Json,
  type PanelBridge,
} from './broker-core';
import type { ApplyContext, ApplyResult } from './broker';
import { createFaultCounter, faultReason, wallFaultCounts } from './faults';
import type { FaultSummary } from './faults-log';
import { modDisplayLabel } from './labels';
import {
  MOD_FAULT_LOGS_PER_HOUR,
  MOD_HOST_BACKSTOP_MS,
  MOD_IDLE_UNLOAD_MS,
  MOD_LOADED_MAX,
  MOD_QUEUE_MAX,
  MOD_STORE_FLUSH_MS,
  MOD_USER_HOOKS_PER_MINUTE,
} from './limits';
import {
  AtomValueSchema,
  ModIdentSchema,
  fault,
  type AtomValue,
  type Fault,
  HookEventSchema,
  MOD_UI_EVENT_KINDS,
  type FrameMessage,
  type HookEvent,
  type HostMessage,
  type ModEventKind,
  type ParsedFrameMessage,
} from './protocol';
import { createHookRate, hookRateReason } from './rate';
import {
  ModManifestSchema,
  manifestsEqual,
  parseModManifest,
  parseModSettings,
  type ModSettingValue,
  consentWidened,
  type ModManifest,
  type UserMod,
} from './schema';
import type { SandboxStatus } from './sandbox-host';
import type { StoreSetResult } from './store-rpc';
import type { ModCode } from '@/lib/mods-store';

/**
 * The mod runtime's host side (memory/plans/mods.md, build order 8): which
 * mods are loaded, in which generation, what each is doing, and what happens
 * when one misbehaves. Everything it touches is injected (RuntimeDeps), so
 * tests drive it with a fake sandbox; components/mods/mod-host.tsx binds the
 * real one.
 *
 * Loading is lazy. A mod loads on its first event or command, at most
 * MOD_LOADED_MAX at once (the least recently used idle one makes room), and
 * unloads after MOD_IDLE_UNLOAD_MS with no timer pending. Each load is a new
 * generation in a new worker. The hooks a load reports are remembered against
 * the row's updated_at, so a mod that never listens to ticks is not loaded
 * for every tick.
 *
 * One hook at a time per mod, at most MOD_QUEUE_MAX waiting. A hook's calls
 * are answered by the broker only while it is the live one; when it settles
 * ok, lib/mods/broker.ts applies what it held, and this commits the store
 * overlay and schedules its timers. A faulted hook applies nothing.
 *
 * Faults are logged (capped per hour) and counted: MOD_FAULTS_TO_OFF in the
 * window, or one `rate` breach, switches the mod off with a reason.
 *
 * Hot reload is keyed on content: a row whose updated_at moved is read again,
 * and only a changed source or manifest loads a new generation, which swaps in
 * on success and leaves the old one running on failure. updated_at alone
 * moves on every store write (061's trigger), so it is never enough.
 *
 * `$.store` never touches the network inside a hook. The snapshot comes with
 * the code; committed writes mark keys dirty, and the dirty keys flush one
 * mod_store_set each, at most once per MOD_STORE_FLUSH_MS per mod.
 *
 * Panels (build order 9). A panel's resolve, a press on it and a field the
 * person committed are hooks like any other, with three differences. They
 * stay off the hook rate: resolves are paced by the panel state
 * (lib/mods/ui/panel-store.ts), and the person's own hooks have a budget of
 * their own whose excess is dropped quietly, never faulted. Their work
 * carries `settle`, which every way out of the queue calls exactly once, so a
 * panel never waits on work that left. And a hook other than a resolve that
 * settles ok tells the panels to redraw (`onPanelsStale`); a resolve never
 * does, so one resolve never starts another.
 */

export interface RuntimeSandbox {
  ensure(): Promise<SandboxStatus>;
  post(message: HostMessage): boolean;
  onMessage(fn: (p: ParsedFrameMessage) => void): () => void;
  onRemoved(fn: () => void): () => void;
  remove(): void;
}

export interface RuntimeDeps {
  sandbox: RuntimeSandbox;
  env: () => BrokerEnv;
  /** modRuntimeReady(): nothing runs while false. */
  ready: () => boolean;
  userId: () => string | null;
  /** Every switched-on mod row, as the store holds them now. */
  rows: () => UserMod[];
  loadCode: (modId: string) => Promise<ModCode | null>;
  storeSet: (modId: string, key: string, value: unknown) => Promise<StoreSetResult>;
  logFault: (userId: string, modId: string, summary: FaultSummary) => void;
  disable: (modId: string, reason: string) => void;
  /** "A mod was switched off", under the mod's display label. */
  switchedOff: (row: UserMod) => void;
  apply: (hook: HookState, ctx: ApplyContext) => ApplyResult;
  uiDeps: UiStepDeps;
  /** Whether the document is hidden now (a hidden frame's timers are throttled). */
  hidden: () => boolean;
  /** Reads Make's rows again: this tab's view of a mod disagreed with the database. */
  refresh?: () => void;
  now?: () => number;
  /** The panels' atoms and cached trees. Without it no press or field reaches a mod. */
  panels?: PanelBridge;
  /** A mod's visible panels should redraw, and why (a panel in error redraws only for some). */
  onPanelsStale?: (modId: string, why: PanelsStaleReason) => void;
  /** The person pressed or typed faster than the mod's budget: "Slow down a little". */
  onUserHooksSlowed?: (modId: string) => void;
}

/**
 * Why panels went stale: a hook other than a resolve settled ok, the mod was
 * saved or switched on, its row changed under this tab, or its settings saved.
 */
export type PanelsStaleReason = 'hook' | 'saved' | 'enabled' | 'changed' | 'settings';

/**
 * How a piece of work left the queue. `dropped`: it never ran, or ran and was
 * cut off with no fault (not ready, a full queue, an unload). `off`: the mod
 * is off or gone. An ok resolve carries its tree's JSON text, unparsed.
 */
export type SettleOutcome = { ok: true; resultJson?: string } | { fault: Fault } | 'dropped' | 'off';

type Work =
  | { kind: 'hook'; event: HookEvent; label: string; settle?: (o: SettleOutcome) => void }
  /** A changed source or manifest: load a new generation, swap on success. */
  | { kind: 'reload' };

interface Loaded {
  gen: number;
  hooks: ModEventKind[];
  sourceHash: string;
  manifest: ModManifest;
  updatedAt: string;
}

interface ModState {
  modId: string;
  loaded: Loaded | null;
  loading: boolean;
  /** The hooks the last load reported, while the row's updated_at is the one it loaded. */
  knownHooks: { updatedAt: string; hooks: ModEventKind[] } | null;
  /** The last hook faulted: load a fresh generation before the next. */
  needsReload: boolean;
  checking: boolean;

  snapshot: Record<string, Json>;
  /** key → write number, so a key written again during its RPC stays dirty. */
  dirty: Map<string, number>;
  failures: Map<string, number>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
  /** Flushes started, so a load can tell one ran while it read the row. */
  flushes: number;

  queue: Work[];
  busy: boolean;
  timers: Map<number, ReturnType<typeof setTimeout>>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  toastTimes: number[];
  faultLogTimes: number[];
  lastUsedAt: number;
}

/** `why` says what a fault-less end was, for the work's settle. */
type HookOutcome = { ok: true; resultJson?: string } | { ok: false; fault: Fault | null; why?: 'dropped' | 'off' };
type LoadOutcome = Extract<FrameMessage, { t: 'loaded' }> | { ok: false; fault: Fault | null };

export interface ModRuntime {
  dispatch(e: ModEvent): void;
  dispatchUndo(e: ModOnlyEvent): void;
  runCommand(modId: string, commandId: string): void;
  /** The rows changed (a refresh, a switch): unload what went off, re-read what moved. */
  rowsChanged(): void;
  /** This tab saved the mod: a fresh fault count and, if loaded, a new generation. */
  saved(modId: string): void;
  /** Switched on: a fresh fault count. */
  enabled(modId: string): void;
  /** The tab went hidden: a wall fault in flight does not count. */
  noteHidden(): void;
  flushAll(): Promise<void>;
  /** Flushes (best effort), unloads everything and clears every timer. */
  stop(): Promise<void>;
  /** Test and debugging aid: mod ids with a loaded generation. */
  loadedIds(): string[];

  /** Draws a panel: its resolve, loading the mod on demand. Off the hook rate. */
  resolvePanel(modId: string, panelId: string): Promise<SettleOutcome>;
  /**
   * A press on a panel's button, as the person saw it: `seq` is the cached
   * tree's at the press, and the press counts only while that tree is still
   * the current one and holds (action, arg).
   */
  runAction(
    modId: string,
    panelId: string,
    action: string,
    arg: string | undefined,
    atoms: Record<string, AtomValue>,
    seq: number
  ): Promise<SettleOutcome>;
  /** A field the person committed. A newer value for the same key replaces one still waiting. */
  atomChanged(modId: string, key: string, value: AtomValue): Promise<SettleOutcome>;
  /** Whether the mod draws panels, as far as its last load says. */
  resolvesPanels(modId: string): boolean;
  /** Make saved the mod's settings: the snapshot takes them now, with no reload. */
  settingsChanged(modId: string, values: Record<string, ModSettingValue>): void;
  /** A resolve's tree failed the host's checks: a counted `error` fault. */
  panelFault(modId: string, panelId: string, message: string): void;
}

/** cyrb53: a short content hash for "did the source change". */
function hashSource(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${s.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** The frame's reply to a hook for a worker it does not have: a reload, never a strike (lib/mods/sandbox/frame-script.mjs). */
const NOT_LOADED = 'the mod is not loaded';
const FLUSH_RETRIES = 3;
const HOUR_MS = 3_600_000;

export function hookEventOf(e: ModEvent | ModOnlyEvent): HookEvent {
  switch (e.kind) {
    case 'item.completed':
    case 'item.skipped':
      return { kind: e.kind, itemId: e.itemId, date: e.date, type: e.type };
    case 'item.uncompleted':
      return { kind: e.kind, origin: 'origin' in e ? e.origin : 'user', itemId: e.itemId, date: e.date, type: e.type };
    case 'item.created':
      return { kind: e.kind, itemId: e.itemId, type: e.type, ...(e.date && { date: e.date }) };
    case 'review.saved':
      return { kind: e.kind, date: e.date };
  }
}

export function createModRuntime(deps: RuntimeDeps): ModRuntime {
  const now = deps.now ?? (() => Date.now());
  const states = new Map<string, ModState>();
  /** Generations only ever go up, across unloads, so a late message can never match a new worker. */
  const gens = new Map<string, number>();
  const pendingLoads = new Map<string, (m: LoadOutcome) => void>();
  const running = new Map<string, { hook: HookState; resolve: (o: HookOutcome) => void }>();
  const counter = createFaultCounter();
  const rate = createHookRate();
  /** The person's own hooks (ui.action, atom.changed): a minute budget, no daily one. */
  const userRate = createHookRate(MOD_USER_HOOKS_PER_MINUTE, Number.POSITIVE_INFINITY);
  let hiddenEpoch = 0;
  let timerIds = 0;
  let writeNo = 0;
  let stopped = false;
  let warnedUnavailable = false;
  let lastRefresh = -Infinity;

  const rowOf = (modId: string) => deps.rows().find((r) => r.id === modId);
  const today = () => deps.env().todayAndTime().today;
  const keyOf = (modId: string, gen: number) => `${modId}:${gen}`;

  function stateFor(modId: string): ModState {
    let s = states.get(modId);
    if (!s) {
      s = {
        modId,
        loaded: null,
        loading: false,
        knownHooks: null,
        needsReload: false,
        checking: false,
        snapshot: {},
        dirty: new Map(),
        failures: new Map(),
        flushTimer: null,
        flushing: null,
        flushes: 0,
        queue: [],
        busy: false,
        timers: new Map(),
        idleTimer: null,
        toastTimes: [],
        faultLogTimes: [],
        lastUsedAt: 0,
      };
      states.set(modId, s);
    }
    return s;
  }

  /** At most one refresh every few seconds, however many events find the row stale. */
  function askRefresh(): void {
    const t = now();
    if (t - lastRefresh < 5000) return;
    lastRefresh = t;
    deps.refresh?.();
  }

  /**
   * Whether the code just read may run under what this tab's row says the
   * user switched on. The row in the database must be on, and its `uses`
   * no wider than the ones this tab's row shows: a save on another device
   * that widened them switched it off there, and this tab's cached row may
   * not know yet. Either way the mod does not run, and the rows are read
   * again.
   */
  function consented(modId: string, code: ModCode, manifest: ModManifest): boolean {
    const row = rowOf(modId);
    if (code.enabled && row && !consentWidened(parseModManifest(row), manifest)) return true;
    askRefresh();
    return false;
  }

  /* ── faults ──────────────────────────────────────────────────────────── */

  function logFault(s: ModState, hook: string, f: Fault, counted: boolean): void {
    const userId = deps.userId();
    const t = now();
    s.faultLogTimes = s.faultLogTimes.filter((x) => t - x < HOUR_MS);
    if (!userId || s.faultLogTimes.length >= MOD_FAULT_LOGS_PER_HOUR) {
      console.warn(`[mods] ${hook}: ${f.code}: ${f.message}`);
      return;
    }
    s.faultLogTimes.push(t);
    deps.logFault(userId, s.modId, {
      kind: 'fault',
      hook,
      code: f.code,
      message: f.message,
      day: today(),
      ...(!counted && { counted: false as const }),
    });
  }

  function switchOff(s: ModState, reason: string): void {
    const row = rowOf(s.modId);
    deps.disable(s.modId, reason);
    if (row) deps.switchedOff(row);
    drainQueue(s, 'off');
    unload(s, true, 'off');
  }

  /** Work leaving the queue without running: its settle hears why. */
  function drop(work: Work, why: 'dropped' | 'off'): void {
    if (work.kind === 'hook') settle(work, why);
  }

  function drainQueue(s: ModState, why: 'dropped' | 'off'): void {
    const queue = s.queue;
    s.queue = [];
    for (const work of queue) drop(work, why);
  }

  function settle(work: Extract<Work, { kind: 'hook' }>, o: SettleOutcome): void {
    const fn = work.settle;
    work.settle = undefined;
    try {
      fn?.(o);
    } catch (err) {
      console.error('[mods] settle:', err);
    }
  }

  /** Logs the fault, counts it when it counts, and switches the mod off on a trip. */
  function onFault(s: ModState, hook: string, f: Fault, counts = true): void {
    logFault(s, hook, f, counts);
    if (f.code === 'rate') return switchOff(s, f.message);
    if (counts && counter.record(s.modId, now())) switchOff(s, faultReason(f.code, f.message));
  }

  /* ── loading ─────────────────────────────────────────────────────────── */

  function unload(s: ModState, clearTimers: boolean, why: 'dropped' | 'off' = 'dropped'): void {
    // A hook in flight ends here, unfaulted: the frame kills its worker on
    // unload and answers nothing, so waiting would end in a false wall fault
    // and the backstop's remove() of every other mod's worker.
    const run = running.get(s.modId);
    if (run && run.hook.gen === s.loaded?.gen) run.resolve({ ok: false, fault: null, why });
    if (s.loaded) deps.sandbox.post({ t: 'unload', modId: s.modId, gen: s.loaded.gen });
    s.loaded = null;
    s.needsReload = false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (clearTimers) {
      for (const handle of s.timers.values()) clearTimeout(handle);
      s.timers.clear();
    }
  }

  /** Room under MOD_LOADED_MAX, unloading the least recently used idle mod if it must. */
  function makeRoom(s: ModState): boolean {
    if (s.loaded) return true;
    const busy = [...states.values()].filter((o) => o !== s && (o.loaded || o.loading));
    if (busy.length < MOD_LOADED_MAX) return true;
    const idle = busy
      .filter((o) => o.loaded && !o.loading && !o.busy && o.queue.length === 0 && o.timers.size === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) return false;
    void flush(idle);
    unload(idle, false);
    return true;
  }

  function requestLoad(modId: string, gen: number, source: string): Promise<LoadOutcome> {
    return new Promise((resolve) => {
      const key = keyOf(modId, gen);
      const timer = setTimeout(() => {
        pendingLoads.delete(key);
        resolve({ ok: false, fault: fault('wall', 'the sandbox stopped answering') });
        deps.sandbox.remove();
      }, MOD_HOST_BACKSTOP_MS);
      pendingLoads.set(key, (m) => {
        clearTimeout(timer);
        pendingLoads.delete(key);
        resolve(m);
      });
      if (!deps.sandbox.post({ t: 'load', modId, gen, source })) pendingLoads.get(key)?.({ ok: false, fault: null });
    });
  }

  /**
   * Loads a new generation. With one already loaded it is a hot reload: the
   * new one swaps in on success, and the old keeps running on failure.
   */
  async function load(s: ModState): Promise<boolean> {
    if (s.loading) return false;
    if (!makeRoom(s)) {
      console.warn('[mods] too many mods are busy; an event was dropped.');
      return false;
    }
    s.loading = true;
    try {
      const status = await deps.sandbox.ensure();
      if (status !== 'ready') {
        if (!warnedUnavailable) console.warn(`[mods] mods cannot run here (${status}).`);
        warnedUnavailable = true;
        return false;
      }
      if (s.flushing) await s.flushing;
      // Store writes committed or flushed from here on are newer than the row read next.
      const flushesBefore = s.flushes;
      const code = await deps.loadCode(s.modId);
      if (!code || stopped) return false;

      const manifest = ModManifestSchema.safeParse(code.manifest);
      if (!manifest.success) {
        onFault(s, 'load', fault('load', 'manifest invalid'));
        return false;
      }
      if (!consented(s.modId, code, manifest.data)) {
        // A generation already running stops too: the row says it may not.
        if (s.loaded) {
          drainQueue(s, 'off');
          unload(s, true, 'off');
        }
        return false;
      }
      const gen = (gens.get(s.modId) ?? 0) + 1;
      gens.set(s.modId, gen);
      const r = await requestLoad(s.modId, gen, code.source);
      if (!r.ok) {
        if (r.fault) onFault(s, 'load', r.fault);
        return false;
      }
      let declared: unknown;
      try {
        declared = JSON.parse(r.manifestJson);
      } catch {
        declared = null;
      }
      if (!manifestsEqual(code.manifest, declared)) {
        deps.sandbox.post({ t: 'unload', modId: s.modId, gen });
        onFault(s, 'load', fault('load', 'manifest does not match the code; open it in Make and save'));
        return false;
      }
      // Switched off, or the runtime stopped, while it loaded.
      if (stopped || !rowOf(s.modId)) {
        deps.sandbox.post({ t: 'unload', modId: s.modId, gen });
        return false;
      }

      const old = s.loaded;
      s.loaded = { gen, hooks: r.hooks, sourceHash: hashSource(code.source), manifest: manifest.data, updatedAt: code.updatedAt };
      s.knownHooks = { updatedAt: code.updatedAt, hooks: r.hooks };
      s.needsReload = false;
      // The row's store replaces the snapshot only when nothing newer is in
      // memory: no key still to flush, and no flush ran while the row was
      // read (its answer may predate that flush's writes).
      if (s.dirty.size === 0 && !s.flushing && s.flushes === flushesBefore) {
        s.snapshot = { ...(code.store as Record<string, Json>) };
      }
      if (old) deps.sandbox.post({ t: 'unload', modId: s.modId, gen: old.gen });
      return true;
    } finally {
      s.loading = false;
    }
  }

  /** The row's updated_at moved: read the code again and reload only if it changed. */
  async function checkForChange(s: ModState): Promise<void> {
    if (s.checking || !s.loaded) return;
    s.checking = true;
    try {
      const code = await deps.loadCode(s.modId);
      if (!code || !s.loaded) return;
      const manifest = ModManifestSchema.safeParse(code.manifest);
      if (manifest.success && !consented(s.modId, code, manifest.data)) {
        // Off in the database, or asking for more than was switched on: what
        // runs here stops now, rather than at the next refresh.
        drainQueue(s, 'off');
        unload(s, true, 'off');
        void flush(s);
        return;
      }
      const changed =
        hashSource(code.source) !== s.loaded.sourceHash || !manifestsEqual(code.manifest, s.loaded.manifest);
      if (changed) {
        enqueue(s, { kind: 'reload' });
        deps.onPanelsStale?.(s.modId, 'changed');
      } else {
        s.loaded.updatedAt = code.updatedAt;
        if (s.knownHooks) s.knownHooks.updatedAt = code.updatedAt;
      }
    } finally {
      s.checking = false;
    }
  }

  /* ── hooks ───────────────────────────────────────────────────────────── */

  function enqueue(s: ModState, work: Work): void {
    if (stopped) return drop(work, 'dropped');
    if (s.queue.length >= MOD_QUEUE_MAX) {
      console.warn('[mods] a mod has too much waiting; an event was dropped.');
      return drop(work, 'dropped');
    }
    s.queue.push(work);
    void pump(s);
  }

  async function pump(s: ModState): Promise<void> {
    if (s.busy) return;
    s.busy = true;
    try {
      while (s.queue.length > 0 && !stopped) {
        const work = s.queue.shift()!;
        if (!deps.ready() || !rowOf(s.modId)) {
          const why = rowOf(s.modId) ? 'dropped' : 'off';
          drop(work, why);
          drainQueue(s, why);
          break;
        }
        if (work.kind === 'reload') {
          if (s.loaded) await load(s);
          continue;
        }
        if (!s.loaded || s.needsReload) {
          if (!(await load(s))) {
            // Whatever waited for this load cannot run either.
            const why = rowOf(s.modId) ? 'dropped' : 'off';
            drop(work, why);
            for (const w of s.queue) if (w.kind === 'hook') drop(w, why);
            s.queue = s.queue.filter((w) => w.kind === 'reload');
            continue;
          }
        }
        await runHook(s, work);
      }
    } catch (err) {
      console.error('[mods] runtime:', err);
    } finally {
      s.busy = false;
      if (stopped) drainQueue(s, 'dropped');
      armIdle(s);
    }
  }

  function armIdle(s: ModState): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (!s.loaded || stopped) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (!s.loaded || s.busy || s.queue.length > 0) return;
      // A pending timer keeps the mod loaded; it is asked again when one fires.
      if (s.timers.size > 0) return armIdle(s);
      void flush(s);
      unload(s, false);
    }, MOD_IDLE_UNLOAD_MS);
  }

  function withItem(e: HookEvent, manifest: ModManifest): HookEvent {
    if (!('itemId' in e) || !manifest.uses.includes('items:read')) return e;
    const env = deps.env();
    const view = env.planner();
    const item = view.items.find((i) => i.id === e.itemId);
    return { ...e, item: item ? projectItem(item, env.todayAndTime().today, view) : null };
  }

  /** Runs one hook, and settles its work however it ends. */
  async function runHook(s: ModState, work: Extract<Work, { kind: 'hook' }>): Promise<void> {
    let outcome: SettleOutcome = 'dropped';
    try {
      outcome = await runHookInner(s, work);
    } finally {
      settle(work, outcome);
    }
  }

  async function runHookInner(s: ModState, work: Extract<Work, { kind: 'hook' }>): Promise<SettleOutcome> {
    const loaded = s.loaded;
    const userId = deps.userId();
    const row = rowOf(s.modId);
    if (!row) return 'off';
    if (!loaded || !userId) return 'dropped';
    // No handler: nothing runs, and a resolve draws nothing.
    if (!loaded.hooks.includes(work.event.kind)) return { ok: true };

    // A panel's hooks are paced elsewhere (resolvePanel, runAction, atomChanged).
    if (!isPanelKind(work.event.kind)) {
      const breach = rate.take(s.modId, now(), today());
      if (breach) {
        const f = fault('rate', hookRateReason(breach));
        onFault(s, work.label, f);
        return { fault: f };
      }
    }

    const t = now();
    s.lastUsedAt = t;
    s.toastTimes = s.toastTimes.filter((x) => t - x < 60_000);
    const hook = createHookState({
      modId: s.modId,
      gen: loaded.gen,
      hookId: crypto.randomUUID(),
      slug: row.slug,
      hookKind: work.event.kind,
      origin: work.event.kind === 'item.uncompleted' ? work.event.origin : null,
      manifest: loaded.manifest,
      snapshot: s.snapshot,
      pendingTimers: s.timers.size,
      toastsLastMinute: s.toastTimes.length,
      atoms: { ...(deps.panels?.atoms(s.modId) ?? {}) },
      atomKinds: { ...(deps.panels?.atomKinds(s.modId) ?? {}) },
      settings: parseModSettings(loaded.manifest, s.snapshot['@settings']),
    });
    const event = withItem(work.event, loaded.manifest);

    const epoch = hiddenEpoch;
    const hiddenAtStart = deps.hidden();
    const wallStart = Date.now();
    const monoStart = typeof performance !== 'undefined' ? performance.now() : wallStart;
    const outcome = await new Promise<HookOutcome>((resolve) => {
      const timer = setTimeout(() => {
        running.delete(s.modId);
        resolve({ ok: false, fault: fault('wall', 'the sandbox stopped answering') });
        deps.sandbox.remove();
      }, MOD_HOST_BACKSTOP_MS);
      running.set(s.modId, {
        hook,
        resolve: (o) => {
          clearTimeout(timer);
          running.delete(s.modId);
          resolve(o);
        },
      });
      if (!deps.sandbox.post({ t: 'hook', modId: s.modId, gen: hook.gen, hookId: hook.hookId, event })) {
        running.get(s.modId)?.resolve({ ok: false, fault: null });
      }
    });

    if (hook.aborted || !outcome.ok) {
      const f = hook.aborted ?? (outcome.ok ? null : outcome.fault);
      // A fresh generation before the next hook: whatever this one left is not trusted.
      if (s.loaded?.gen === hook.gen) s.needsReload = true;
      if (!f) return (!outcome.ok && outcome.why) || 'dropped';
      if (f.code === 'broken' && f.message === NOT_LOADED) {
        if (s.loaded?.gen === hook.gen) s.loaded = null;
        return 'dropped';
      }
      let counts = true;
      if (f.code === 'wall') {
        counts = wallFaultCounts({
          hidden: hiddenAtStart || deps.hidden() || hiddenEpoch !== epoch,
          wallElapsedMs: Date.now() - wallStart,
          monoElapsedMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - monoStart,
        });
      }
      onFault(s, work.label, f, counts);
      return { fault: f };
    }

    // A resolve is read-only (the broker's RESOLVE_ALLOWED): nothing to apply,
    // and nothing to tell the panels, so one draw never starts another.
    if (work.event.kind === 'ui.resolve') {
      return outcome.resultJson === undefined ? { ok: true } : { ok: true, resultJson: outcome.resultJson };
    }

    const result = deps.apply(hook, {
      userId,
      stillCurrent: () => s.loaded?.gen === hook.gen,
      event: work.event,
      hookLabel: work.label,
      deps: deps.uiDeps,
      ...(deps.panels && { panels: deps.panels }),
    });
    if (result.status === 'stale') return 'dropped';

    // The store overlay and the timers commit only now, on ok.
    for (const [key, value] of hook.storeOverlay) {
      if (value === DELETE) delete s.snapshot[key];
      else s.snapshot[key] = value;
      s.dirty.set(key, ++writeNo);
    }
    if (hook.storeOverlay.size > 0) scheduleFlush(s);
    for (const timer of hook.timers) schedule(s, timer);
    for (let i = 0; i < result.toasts; i++) s.toastTimes.push(now());
    if (result.fault) {
      onFault(s, work.label, result.fault);
      return { fault: result.fault };
    }
    // What the hook changed may show in a panel. A fault redraws nothing.
    deps.onPanelsStale?.(s.modId, 'hook');
    return { ok: true };
  }

  function schedule(s: ModState, t: HeldTimer): void {
    const id = ++timerIds;
    s.timers.set(
      id,
      setTimeout(() => {
        s.timers.delete(id);
        enqueue(s, { kind: 'hook', event: { kind: 'timer', name: t.name }, label: 'timer' });
      }, t.ms)
    );
  }

  /* ── the store ───────────────────────────────────────────────────────── */

  /** A flush MOD_STORE_FLUSH_MS after the first write since the last one, so a burst is one RPC a key. */
  function scheduleFlush(s: ModState): void {
    if (s.flushTimer || s.flushing || s.dirty.size === 0 || stopped) return;
    s.flushTimer = setTimeout(() => {
      s.flushTimer = null;
      void flush(s);
    }, MOD_STORE_FLUSH_MS);
  }

  /** One mod_store_set per dirty key, in turn, with the latest value. */
  async function flush(s: ModState): Promise<void> {
    if (s.flushing) return s.flushing;
    if (s.dirty.size === 0) return;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    s.flushes++;
    s.flushing = (async () => {
      for (const [key, written] of [...s.dirty]) {
        const value = Object.hasOwn(s.snapshot, key) ? s.snapshot[key] : null;
        const r = await deps.storeSet(s.modId, key, value);
        // Written again meanwhile: the next flush sends the newer value.
        if (s.dirty.get(key) !== written) continue;
        if (r === 'ok') {
          s.dirty.delete(key);
          s.failures.delete(key);
          continue;
        }
        if (r === 'error') {
          const n = (s.failures.get(key) ?? 0) + 1;
          if (n <= FLUSH_RETRIES) {
            s.failures.set(key, n);
            continue;
          }
        }
        // Given up: logged, never counted toward switching the mod off.
        s.dirty.delete(key);
        s.failures.delete(key);
        const message =
          r === 'too_big' ? 'the store is full' : r === 'gone' ? 'the mod is gone' : 'the store could not be saved';
        logFault(s, 'store', fault('error', `${message} (${key.slice(0, 64)})`), false);
      }
    })();
    try {
      await s.flushing;
    } finally {
      s.flushing = null;
      scheduleFlush(s);
    }
  }

  /* ── the frame ───────────────────────────────────────────────────────── */

  function onMessage(p: ParsedFrameMessage): void {
    if (!p.ok) {
      const s = p.modId ? states.get(p.modId) : undefined;
      if (!s) return;
      running.get(s.modId)?.resolve({ ok: false, fault: null });
      onFault(s, 'protocol', fault('protocol', 'the sandbox sent a message the app could not read'));
      unload(s, false);
      return;
    }
    const m = p.message;
    switch (m.t) {
      case 'loaded':
        pendingLoads.get(keyOf(m.modId, m.gen))?.(m);
        return;
      case 'call': {
        const answer = brokerCall(deps.env(), running.get(m.modId)?.hook ?? null, m);
        if (!answer) return;
        deps.sandbox.post(
          answer.ok
            ? { t: 'reply', modId: m.modId, gen: m.gen, hookId: m.hookId, callId: m.callId, ok: true, value: answer.value }
            : { t: 'reply', modId: m.modId, gen: m.gen, hookId: m.hookId, callId: m.callId, ok: false, error: answer.error }
        );
        return;
      }
      case 'done': {
        const run = running.get(m.modId);
        if (!run || run.hook.gen !== m.gen || run.hook.hookId !== m.hookId) return;
        // Only a resolve's tree is read; any other hook's result was never sent.
        const resultJson = m.ok && run.hook.hookKind === 'ui.resolve' ? m.resultJson : undefined;
        run.resolve(m.ok ? { ok: true, ...(resultJson !== undefined && { resultJson }) } : { ok: false, fault: m.fault });
        return;
      }
      case 'gone': {
        const s = states.get(m.modId);
        if (!s) return;
        pendingLoads.get(keyOf(m.modId, m.gen))?.({ ok: false, fault: m.fault });
        const run = running.get(m.modId);
        if (run && run.hook.gen === m.gen) run.resolve({ ok: false, fault: m.fault });
        // It loads again, at a new generation, on its next event. Timers stay.
        if (s.loaded?.gen === m.gen) s.loaded = null;
        return;
      }
    }
  }

  function onRemoved(): void {
    for (const resolve of [...pendingLoads.values()]) resolve({ ok: false, fault: null });
    for (const run of [...running.values()]) run.resolve({ ok: false, fault: null });
    for (const s of states.values()) {
      s.loaded = null;
      s.needsReload = false;
    }
  }

  const offMessage = deps.sandbox.onMessage(onMessage);
  const offRemoved = deps.sandbox.onRemoved(onRemoved);

  /* ── the doors ───────────────────────────────────────────────────────── */

  function deliver(e: ModEvent | ModOnlyEvent, skip?: (row: UserMod) => boolean): void {
    if (stopped || !deps.ready()) return;
    const event = hookEventOf(e);
    if ('itemId' in e) {
      const item = deps.env().planner().items.find((i) => i.id === e.itemId);
      if (!stillHolds(e, item)) return;
    }
    for (const row of deps.rows()) {
      if (skip?.(row)) continue;
      const s = stateFor(row.id);
      const known = s.loaded?.hooks ?? (s.knownHooks?.updatedAt === row.updatedAt ? s.knownHooks.hooks : null);
      if (known && !known.includes(event.kind)) continue;
      enqueue(s, { kind: 'hook', event, label: event.kind });
    }
  }

  return {
    dispatch: (e) => deliver(e),

    dispatchUndo: (e) =>
      // Undoing a mod's own run never wakes that mod.
      deliver(e, (row) => e.undoneLabel.startsWith(`Mod: ${modDisplayLabel(row)} ·`)),

    runCommand(modId, commandId) {
      if (stopped || !deps.ready()) return;
      const row = rowOf(modId);
      const manifest = row && ModManifestSchema.safeParse(row.manifest);
      const command = manifest?.success ? manifest.data.commands.find((c) => c.id === commandId) : undefined;
      if (!row || !command) return;
      enqueue(stateFor(modId), {
        kind: 'hook',
        event: { kind: 'command', id: command.id },
        label: `command ${command.label}`,
      });
    },

    rowsChanged() {
      if (stopped) return;
      const rows = new Map(deps.rows().map((r) => [r.id, r] as const));
      for (const s of states.values()) {
        const row = rows.get(s.modId);
        if (!row) {
          // Off or deleted: nothing of it runs here any more.
          drainQueue(s, 'off');
          unload(s, true, 'off');
          void flush(s);
          continue;
        }
        if (s.loaded && row.updatedAt !== s.loaded.updatedAt) void checkForChange(s);
      }
    },

    saved(modId) {
      counter.clear(modId);
      const s = states.get(modId);
      if (s?.loaded) enqueue(s, { kind: 'reload' });
      else if (s) s.knownHooks = null;
      // Loaded, the redraw queues behind the reload; not, it loads the new code.
      deps.onPanelsStale?.(modId, 'saved');
    },

    enabled(modId) {
      counter.clear(modId);
      rate.clear(modId);
      userRate.clear(modId);
      deps.onPanelsStale?.(modId, 'enabled');
    },

    noteHidden() {
      hiddenEpoch++;
    },

    async flushAll() {
      await Promise.all([...states.values()].map((s) => flush(s)));
    },

    async stop() {
      if (stopped) return;
      const flushes = [...states.values()].map((s) => flush(s));
      stopped = true;
      offMessage();
      offRemoved();
      for (const run of [...running.values()]) run.resolve({ ok: false, fault: null });
      for (const resolve of [...pendingLoads.values()]) resolve({ ok: false, fault: null });
      for (const s of states.values()) {
        drainQueue(s, 'dropped');
        if (s.flushTimer) clearTimeout(s.flushTimer);
        s.flushTimer = null;
        unload(s, true);
      }
      await Promise.allSettled(flushes);
    },

    loadedIds: () => [...states.values()].filter((s) => s.loaded).map((s) => s.modId),

    resolvePanel(modId, panelId) {
      return new Promise<SettleOutcome>((resolve) => {
        const target = panelTarget(modId, panelId);
        if (typeof target === 'string') return resolve(target);
        const s = stateFor(modId);
        // A mod whose last load registered no resolve draws nothing, unloaded.
        // Not while newer code is on its way in: the resolve queues behind
        // the reload, which may be what adds the handler.
        const stale =
          s.needsReload ||
          s.loading ||
          s.queue.some((w) => w.kind === 'reload') ||
          (s.loaded !== null && s.loaded.updatedAt !== target.row.updatedAt);
        const known = s.loaded?.hooks ?? (s.knownHooks?.updatedAt === target.row.updatedAt ? s.knownHooks.hooks : null);
        if (!stale && known && !known.includes('ui.resolve')) return resolve({ ok: true });
        enqueue(s, {
          kind: 'hook',
          event: { kind: 'ui.resolve', panelId },
          label: `panel ${target.panel.label}`,
          settle: resolve,
        });
      });
    },

    runAction(modId, panelId, action, arg, atoms, seq) {
      return new Promise<SettleOutcome>((resolve) => {
        const target = panelTarget(modId, panelId);
        if (typeof target === 'string') return resolve(target);
        // Only what the person saw: the panel's cached tree, still at the
        // press's seq, holds this button. Not the runtime's generation, so an
        // idle unload or a reload never swallows a press: it loads on demand.
        const event = { kind: 'ui.action' as const, panelId, action, ...(arg !== undefined && { arg }), atoms };
        if (
          !deps.panels?.actionShown(modId, panelId, action, arg, seq) ||
          !HookEventSchema.safeParse(event).success
        ) {
          deps.onPanelsStale?.(modId, 'hook');
          return resolve('dropped');
        }
        if (!takeUserHook(modId)) return resolve('dropped');
        enqueue(stateFor(modId), { kind: 'hook', event, label: target.panel.label, settle: resolve });
      });
    },

    atomChanged(modId, key, value) {
      return new Promise<SettleOutcome>((resolve) => {
        if (stopped || !deps.ready()) return resolve('dropped');
        if (!rowOf(modId)) return resolve('off');
        const kinds = deps.panels?.atomKinds(modId);
        if (!kinds || !Object.hasOwn(kinds, key) || !ModIdentSchema.safeParse(key).success) return resolve('dropped');
        if (!AtomValueSchema.safeParse(value).success) return resolve('dropped');
        const s = stateFor(modId);
        // The latest value wins: one still waiting for this key takes it, and
        // both callers hear how that one hook ends.
        const waiting = s.queue.find(
          (w): w is Extract<Work, { kind: 'hook' }> =>
            w.kind === 'hook' && w.event.kind === 'atom.changed' && w.event.key === key
        );
        if (waiting) {
          waiting.event = { kind: 'atom.changed', key, value };
          const before = waiting.settle;
          waiting.settle = (o) => {
            before?.(o);
            resolve(o);
          };
          return;
        }
        if (!takeUserHook(modId)) return resolve('dropped');
        enqueue(s, { kind: 'hook', event: { kind: 'atom.changed', key, value }, label: key, settle: resolve });
      });
    },

    resolvesPanels(modId) {
      const s = states.get(modId);
      const hooks = s?.loaded?.hooks ?? s?.knownHooks?.hooks;
      return !!hooks?.includes('ui.resolve');
    },

    settingsChanged(modId, values) {
      if (stopped) return;
      const s = stateFor(modId);
      // Make already wrote them (mod_store_set), so they are not dirty. The
      // bump keeps a load in flight from replacing this with an older row.
      s.snapshot['@settings'] = { ...values } as Json;
      s.flushes++;
      deps.onPanelsStale?.(modId, 'settings');
    },

    panelFault(modId, panelId, message) {
      if (stopped || !rowOf(modId)) return;
      const panel = parseModManifest(rowOf(modId)!)?.panels.find((p) => p.id === panelId);
      onFault(stateFor(modId), `panel ${panel?.label ?? panelId}`, fault('error', message));
    },
  };

  /** The row and its declared panel, or how a panel request ends without them. */
  function panelTarget(
    modId: string,
    panelId: string
  ): { row: UserMod; panel: ModManifest['panels'][number] } | 'dropped' | 'off' {
    if (stopped || !deps.ready()) return 'dropped';
    const row = rowOf(modId);
    if (!row) return 'off';
    const panel = parseModManifest(row)?.panels.find((p) => p.id === panelId);
    return panel ? { row, panel } : 'dropped';
  }

  /** The person's own budget. Over it the hook is dropped and they are told to slow down; never a fault. */
  function takeUserHook(modId: string): boolean {
    if (!userRate.take(modId, now(), today())) return true;
    deps.onUserHooksSlowed?.(modId);
    return false;
  }
}

const PANEL_KINDS: ReadonlySet<ModEventKind> = new Set(MOD_UI_EVENT_KINDS);
const isPanelKind = (kind: ModEventKind) => PANEL_KINDS.has(kind);

/* ── the running one ─────────────────────────────────────────────────── */

let current: ModRuntime | null = null;

/** ModHost's runtime while mods run in this tab, so Make's editor can say "saved" to it. */
export function activeModRuntime(): ModRuntime | null {
  return current;
}

export function setActiveModRuntime(runtime: ModRuntime): () => void {
  current = runtime;
  return () => {
    if (current === runtime) current = null;
  };
}

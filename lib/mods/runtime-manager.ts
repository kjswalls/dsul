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
} from './limits';
import {
  fault,
  type Fault,
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
  usesWidened,
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
}

type Work =
  | { kind: 'hook'; event: HookEvent; label: string }
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

type HookOutcome = { ok: true } | { ok: false; fault: Fault | null };
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
    if (code.enabled && row && !usesWidened(parseModManifest(row), manifest)) return true;
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
    s.queue = [];
    unload(s, true);
  }

  /** Logs the fault, counts it when it counts, and switches the mod off on a trip. */
  function onFault(s: ModState, hook: string, f: Fault, counts = true): void {
    logFault(s, hook, f, counts);
    if (f.code === 'rate') return switchOff(s, f.message);
    if (counts && counter.record(s.modId, now())) switchOff(s, faultReason(f.code, f.message));
  }

  /* ── loading ─────────────────────────────────────────────────────────── */

  function unload(s: ModState, clearTimers: boolean): void {
    // A hook in flight ends here, unfaulted: the frame kills its worker on
    // unload and answers nothing, so waiting would end in a false wall fault
    // and the backstop's remove() of every other mod's worker.
    const run = running.get(s.modId);
    if (run && run.hook.gen === s.loaded?.gen) run.resolve({ ok: false, fault: null });
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
          s.queue = [];
          unload(s, true);
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
        s.queue = [];
        unload(s, true);
        void flush(s);
        return;
      }
      const changed =
        hashSource(code.source) !== s.loaded.sourceHash || !manifestsEqual(code.manifest, s.loaded.manifest);
      if (changed) enqueue(s, { kind: 'reload' });
      else {
        s.loaded.updatedAt = code.updatedAt;
        if (s.knownHooks) s.knownHooks.updatedAt = code.updatedAt;
      }
    } finally {
      s.checking = false;
    }
  }

  /* ── hooks ───────────────────────────────────────────────────────────── */

  function enqueue(s: ModState, work: Work): void {
    if (stopped) return;
    if (s.queue.length >= MOD_QUEUE_MAX) {
      console.warn('[mods] a mod has too much waiting; an event was dropped.');
      return;
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
          s.queue = [];
          break;
        }
        if (work.kind === 'reload') {
          if (s.loaded) await load(s);
          continue;
        }
        if (!s.loaded || s.needsReload) {
          if (!(await load(s))) {
            // Whatever waited for this load cannot run either.
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

  async function runHook(s: ModState, work: Extract<Work, { kind: 'hook' }>): Promise<void> {
    const loaded = s.loaded;
    const userId = deps.userId();
    const row = rowOf(s.modId);
    if (!loaded || !userId || !row || !loaded.hooks.includes(work.event.kind)) return;

    const breach = rate.take(s.modId, now(), today());
    if (breach) return onFault(s, work.label, fault('rate', hookRateReason(breach)));

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
      if (!f) return;
      if (f.code === 'broken' && f.message === NOT_LOADED) {
        if (s.loaded?.gen === hook.gen) s.loaded = null;
        return;
      }
      let counts = true;
      if (f.code === 'wall') {
        counts = wallFaultCounts({
          hidden: hiddenAtStart || deps.hidden() || hiddenEpoch !== epoch,
          wallElapsedMs: Date.now() - wallStart,
          monoElapsedMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - monoStart,
        });
      }
      return onFault(s, work.label, f, counts);
    }

    const result = deps.apply(hook, {
      userId,
      stillCurrent: () => s.loaded?.gen === hook.gen,
      event: work.event,
      hookLabel: work.label,
      deps: deps.uiDeps,
    });
    if (result.status === 'stale') return;

    // The store overlay and the timers commit only now, on ok.
    for (const [key, value] of hook.storeOverlay) {
      if (value === DELETE) delete s.snapshot[key];
      else s.snapshot[key] = value;
      s.dirty.set(key, ++writeNo);
    }
    if (hook.storeOverlay.size > 0) scheduleFlush(s);
    for (const timer of hook.timers) schedule(s, timer);
    for (let i = 0; i < result.toasts; i++) s.toastTimes.push(now());
    if (result.fault) onFault(s, work.label, result.fault);
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
        run.resolve(m.ok ? { ok: true } : { ok: false, fault: m.fault });
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
          s.queue = [];
          unload(s, true);
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
    },

    enabled(modId) {
      counter.clear(modId);
      rate.clear(modId);
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
        s.queue = [];
        if (s.flushTimer) clearTimeout(s.flushTimer);
        s.flushTimer = null;
        unload(s, true);
      }
      await Promise.allSettled(flushes);
    },

    loadedIds: () => [...states.values()].filter((s) => s.loaded).map((s) => s.modId),
  };
}

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

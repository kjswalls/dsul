import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten';
import {
  MOD_ARGS_MAX_BYTES,
  MOD_CALLS_PER_HOOK,
  MOD_CPU_MS,
  MOD_HANDLERS_MAX,
  MOD_LOAD_CPU_MS,
  MOD_MANIFEST_MAX_BYTES,
  MOD_MEMORY_BYTES,
  MOD_REPLY_ERROR_MAX,
  MOD_STACK_BYTES,
} from '@/lib/mods/limits';
import {
  MOD_EVENT_KINDS,
  MOD_METHODS,
  fault,
  type Fault,
  type HookEvent,
  type ModEventKind,
  type ModMethod,
} from '@/lib/mods/protocol';
import { PRELUDE_JS } from './prelude';

/**
 * A mod's code in QuickJS: load it, run one hook at a time, and say how it
 * ended (memory/plans/mods.md, build order 8). Pure: the QuickJS module is
 * passed in, so the worker (./worker-entry.ts) and the node tests run the
 * same code, and `call` is the only way out.
 *
 * What holds a mod in:
 * - Memory and native stack are the runtime's limits.
 * - CPU is counted per slice of QuickJS work (eval, call, one pending job)
 *   against a per-hook or per-load budget; the interrupt fires inside regex
 *   backtracking or a sort comparator too, and the mod cannot catch it.
 * - `$` reaches `call` only while a hook is live, at most callsPerHook times,
 *   with its argument's length read before the string is copied out.
 * - A promise left waiting when the hook settles is disposed unanswered, and
 *   anything it would have called later is refused.
 *
 * Anything that throws on this side of the bridge (a host RangeError, a
 * QuickJS API misuse) marks the session broken: the worker reports it and
 * closes, because the wasm heap may no longer be trustworthy.
 */

export interface CoreLimits {
  memoryBytes: number;
  stackBytes: number;
  cpuMs: number;
  loadCpuMs: number;
  callsPerHook: number;
  handlersMax: number;
  argsMaxBytes: number;
  manifestMaxBytes: number;
}

export const CORE_LIMITS: CoreLimits = {
  memoryBytes: MOD_MEMORY_BYTES,
  stackBytes: MOD_STACK_BYTES,
  cpuMs: MOD_CPU_MS,
  loadCpuMs: MOD_LOAD_CPU_MS,
  callsPerHook: MOD_CALLS_PER_HOOK,
  handlersMax: MOD_HANDLERS_MAX,
  argsMaxBytes: MOD_ARGS_MAX_BYTES,
  manifestMaxBytes: MOD_MANIFEST_MAX_BYTES,
};

/** All the core needs of a QuickJS module; the tests pass a TestQuickJSWASMModule. */
export type QuickJSFactory = Pick<QuickJSWASMModule, 'newRuntime'>;

/** Answers a `$` call with the reply's JSON text, or rejects with the broker's error. */
export type HostCall = (method: ModMethod, argsJson: string) => Promise<string>;

export type HookOutcome = { ok: true } | { ok: false; fault: Fault };

export interface LoadedMod {
  ok: true;
  hooks: ModEventKind[];
  manifestJson: string;
  runHook(hookId: string, e: HookEvent): Promise<HookOutcome>;
  dispose(): void;
  readonly broken: boolean;
}

export type LoadResult = LoadedMod | { ok: false; fault: Fault };

export type ScratchResult = { ok: true; manifestJson: string; hooks: ModEventKind[] } | { ok: false; fault: Fault };

/** A thrown value's description gets its own budget, so a hostile getter costs only that. */
const DESCRIBE_CPU_MS = 10;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

class BrokenError extends Error {}

type Api = Record<'$' | 'wrap' | 'on' | 'seal' | 'handlers' | 'next' | 'stringify' | 'describe', QuickJSHandle>;
const API_KEYS = ['$', 'wrap', 'on', 'seal', 'handlers', 'next', 'stringify', 'describe'] as const;

class ModSession {
  private readonly rt: QuickJSRuntime;
  private readonly ctx: QuickJSContext;
  private api: Api | null = null;
  private hostFn: QuickJSHandle | null = null;
  private readonly handlerFns = new Map<ModEventKind, QuickJSHandle>();

  private used = 0;
  private budget = 0;
  private sliceStart = 0;

  private phase: 'loading' | 'ready' | 'disposed' = 'loading';
  private liveHookId: string | null = null;
  private calls = 0;
  private overCalls = false;
  private nextCallId = 0;
  private readonly outstanding = new Map<number, QuickJSDeferredPromise>();
  private wake: (() => void) | null = null;

  broken = false;
  private brokenMessage = '';

  constructor(
    qjs: QuickJSFactory,
    private readonly limits: CoreLimits,
    private readonly call: HostCall
  ) {
    this.rt = qjs.newRuntime({ memoryLimitBytes: limits.memoryBytes, maxStackSizeBytes: limits.stackBytes });
    this.rt.setInterruptHandler(() => this.used + (performance.now() - this.sliceStart) > this.budget);
    this.ctx = this.rt.newContext();
  }

  /** One slice of QuickJS work, timed against the budget. A throw out of it is the host's, so the session is broken. */
  private slice<T>(fn: () => T): T {
    this.sliceStart = performance.now();
    try {
      return fn();
    } catch (err) {
      this.markBroken(err);
      throw new BrokenError(this.brokenMessage);
    } finally {
      this.used += performance.now() - this.sliceStart;
    }
  }

  private markBroken(err: unknown) {
    if (!this.broken) {
      this.broken = true;
      this.brokenMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  private brokenFault(): Fault {
    return fault('broken', this.brokenMessage || 'the runtime stopped working');
  }

  /** "Name: message" for a thrown value, under its own small budget. Disposes the handle. */
  private describe(errH: QuickJSHandle): string {
    const [used, budget] = [this.used, this.budget];
    this.used = 0;
    this.budget = DESCRIBE_CPU_MS;
    try {
      if (!this.api) return 'Uncaught exception';
      const api = this.api;
      const r = this.slice(() => this.ctx.callFunction(api.describe, this.ctx.undefined, errH));
      if (r.error) {
        r.error.dispose();
        return 'Uncaught exception';
      }
      const text = this.ctx.typeof(r.value) === 'string' ? this.ctx.getString(r.value) : 'Uncaught exception';
      r.value.dispose();
      return text;
    } finally {
      errH.dispose();
      this.used = used;
      this.budget = budget;
    }
  }

  /** The fault for a thrown value. During a load, an ordinary error is a `load` fault. */
  private faultFrom(errH: QuickJSHandle, during: 'load' | 'hook'): Fault {
    const text = this.describe(errH);
    if (text.startsWith('InternalError: interrupted')) return fault('cpu', text);
    if (text.startsWith('InternalError: out of memory')) return fault('memory', text);
    return fault(during === 'load' ? 'load' : 'error', text);
  }

  private overBudget(): boolean {
    return this.used > this.budget;
  }

  /**
   * Runs queued jobs one at a time until none is left, or until `until`
   * says to stop. Checked between jobs too: a storm of tiny jobs never trips
   * the interrupt inside any one of them.
   */
  private drain(during: 'load' | 'hook', until?: () => boolean): Fault | null {
    while (this.rt.hasPendingJob()) {
      if (until?.()) return null;
      if (this.overBudget()) return fault('cpu', 'InternalError: interrupted');
      const r = this.slice(() => this.rt.executePendingJobs(1));
      if (r.error) return this.faultFrom(r.error, during);
      if (this.broken) throw new BrokenError(this.brokenMessage);
    }
    return null;
  }

  /** Whether a handle is a promise still pending. Disposes whatever the check hands back. */
  private pending(h: QuickJSHandle): boolean {
    const st = this.ctx.getPromiseState(h);
    if (st.type === 'pending') return true;
    if (st.type === 'rejected') st.error.dispose();
    else if (!st.notAPromise) st.value.dispose();
    return false;
  }

  /** A QuickJS string, refused by its length before it is copied out, then by its UTF-8 bytes. */
  private boundedString(h: QuickJSHandle, maxBytes: number): string | 'not-a-string' | 'too-large' {
    if (this.ctx.typeof(h) !== 'string') return 'not-a-string';
    const lengthH = this.ctx.getProp(h, 'length');
    const length = this.ctx.getNumber(lengthH);
    lengthH.dispose();
    if (!(length <= maxBytes)) return 'too-large';
    const s = this.ctx.getString(h);
    return utf8Bytes(s) > maxBytes ? 'too-large' : s;
  }

  /** A promise QuickJS sees already rejected. Returned from the bridge, which disposes it. */
  private rejected(message: string): QuickJSHandle {
    const d = this.ctx.newPromise();
    const err = this.ctx.newError(message);
    d.reject(err);
    err.dispose();
    return d.handle;
  }

  /** The bridge `$` calls through: host(method, argsJson) → promise of the reply's JSON text. */
  private onHostCall(methodH: QuickJSHandle, argsH: QuickJSHandle): QuickJSHandle {
    try {
      if (this.phase === 'loading') return this.rejected('not available while loading');
      const hookId = this.liveHookId;
      if (!hookId) return this.rejected('hook ended');
      const method = this.ctx.typeof(methodH) === 'string' ? this.ctx.getString(methodH) : '';
      if (!(MOD_METHODS as readonly string[]).includes(method)) return this.rejected('unknown method');
      const argsJson = this.boundedString(argsH, this.limits.argsMaxBytes);
      if (argsJson === 'not-a-string') return this.rejected('arguments must be JSON');
      if (argsJson === 'too-large') return this.rejected('args too large');
      this.calls += 1;
      if (this.calls > this.limits.callsPerHook) {
        this.overCalls = true;
        return this.rejected('too many calls in one hook');
      }
      const callId = this.nextCallId++;
      const deferred = this.ctx.newPromise();
      this.outstanding.set(callId, deferred);
      // A throw from `call` itself is the host's bug, not the mod's.
      this.call(method as ModMethod, argsJson).then(
        (value) => this.answer(hookId, callId, true, value),
        (err: unknown) => this.answer(hookId, callId, false, err instanceof Error ? err.message : String(err))
      );
      return deferred.handle;
    } catch (err) {
      this.markBroken(err);
      throw err;
    }
  }

  /** A reply for a call. One for a hook that has settled, or a call already answered, is dropped. */
  private answer(hookId: string, callId: number, ok: boolean, value: string) {
    const deferred = this.outstanding.get(callId);
    if (!deferred || this.liveHookId !== hookId || this.phase !== 'ready') return;
    this.outstanding.delete(callId);
    try {
      this.slice(() => {
        const h = ok
          ? this.ctx.newString(typeof value === 'string' ? value : JSON.stringify(value ?? null))
          : this.ctx.newError(String(value).slice(0, MOD_REPLY_ERROR_MAX));
        if (ok) deferred.resolve(h);
        else deferred.reject(h);
        h.dispose();
      });
    } catch {
      // markBroken already ran; the hook loop reads it when it wakes.
    }
    this.wake?.();
  }

  async load(source: string): Promise<LoadResult> {
    this.used = 0;
    this.budget = this.limits.loadCpuMs;
    try {
      const prelude = this.slice(() => this.ctx.evalCode(PRELUDE_JS, 'prelude.js'));
      if (prelude.error) {
        prelude.error.dispose();
        throw new BrokenError('the prelude failed');
      }
      this.hostFn = this.ctx.newFunction('host', (m, a) => this.onHostCall(m, a));
      const config = this.ctx.newString(
        JSON.stringify({ methods: MOD_METHODS, kinds: MOD_EVENT_KINDS, handlersMax: this.limits.handlersMax })
      );
      const hostFn = this.hostFn;
      const apiR = this.slice(() => this.ctx.callFunction(prelude.value, this.ctx.undefined, hostFn, config));
      prelude.value.dispose();
      config.dispose();
      if (apiR.error) {
        apiR.error.dispose();
        throw new BrokenError('the prelude failed');
      }
      const api = {} as Api;
      for (const key of API_KEYS) api[key] = this.ctx.getProp(apiR.value, key);
      apiR.value.dispose();
      this.api = api;

      const modR = this.slice(() => this.ctx.evalCode(source, 'mod.js', { type: 'module' }));
      if (modR.error) return { ok: false, fault: this.faultFrom(modR.error, 'load') };
      const ns = modR.value;
      try {
        // A module with top-level await evaluates to a promise, not its namespace.
        const st = this.ctx.getPromiseState(ns);
        if (st.type !== 'fulfilled' || !st.notAPromise) {
          if (st.type === 'fulfilled') st.value.dispose();
          else if (st.type === 'rejected') st.error.dispose();
          return { ok: false, fault: fault('load', 'top-level await is not supported') };
        }

        const manifestH = this.ctx.getProp(ns, 'manifest');
        const strR = this.slice(() => this.ctx.callFunction(api.stringify, this.ctx.undefined, manifestH));
        manifestH.dispose();
        if (strR.error) return { ok: false, fault: this.faultFrom(strR.error, 'load') };
        const manifestJson = this.boundedString(strR.value, this.limits.manifestMaxBytes);
        strR.value.dispose();
        if (manifestJson === 'not-a-string') return { ok: false, fault: fault('load', 'export a manifest') };
        if (manifestJson === 'too-large') return { ok: false, fault: fault('load', 'manifest too large') };

        const registerH = this.ctx.getProp(ns, 'register');
        if (this.ctx.typeof(registerH) !== 'function') {
          registerH.dispose();
          return { ok: false, fault: fault('load', 'export a register function') };
        }
        const regR = this.slice(() => this.ctx.callFunction(registerH, this.ctx.undefined, api.on));
        registerH.dispose();
        if (regR.error) return { ok: false, fault: this.faultFrom(regR.error, 'load') };
        try {
          const drained = this.drain('load');
          if (drained) return { ok: false, fault: drained };
          const st2 = this.ctx.getPromiseState(regR.value);
          if (st2.type === 'rejected') return { ok: false, fault: this.faultFrom(st2.error, 'load') };
          if (st2.type === 'pending') return { ok: false, fault: fault('load', 'register left work running') };
          if (!st2.notAPromise) st2.value.dispose();
        } finally {
          regR.value.dispose();
        }

        const sealR = this.slice(() => this.ctx.callFunction(api.seal, this.ctx.undefined));
        if (sealR.error) return { ok: false, fault: this.faultFrom(sealR.error, 'load') };
        sealR.value.dispose();
        for (const kind of MOD_EVENT_KINDS) {
          const h = this.ctx.getProp(api.handlers, kind);
          if (this.ctx.typeof(h) === 'function') this.handlerFns.set(kind, h);
          else h.dispose();
        }
        this.phase = 'ready';
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below has its own `this`
        const self = this;
        return {
          ok: true,
          hooks: [...this.handlerFns.keys()],
          manifestJson,
          runHook: (hookId, e) => this.runHook(hookId, e),
          dispose: () => this.dispose(),
          get broken() {
            return self.broken;
          },
        };
      } finally {
        ns.dispose();
      }
    } catch (err) {
      if (!(err instanceof BrokenError)) this.markBroken(err);
      return { ok: false, fault: this.brokenFault() };
    }
  }

  async runHook(hookId: string, e: HookEvent): Promise<HookOutcome> {
    if (this.broken) return { ok: false, fault: this.brokenFault() };
    if (this.phase !== 'ready' || this.liveHookId) {
      return { ok: false, fault: fault('protocol', 'a hook is already running') };
    }
    const fn = this.handlerFns.get(e.kind);
    if (!fn) return { ok: true };

    this.used = 0;
    this.budget = this.limits.cpuMs;
    this.calls = 0;
    this.overCalls = false;
    this.liveHookId = hookId;

    let outcome: HookOutcome;
    try {
      outcome = await this.drive(fn, e);
    } catch (err) {
      if (!(err instanceof BrokenError)) this.markBroken(err);
      outcome = { ok: false, fault: this.brokenFault() };
    }

    // Settled. Whatever is still waiting on a reply never gets one, and
    // whatever it would run next may not call out.
    this.liveHookId = null;
    const leftOver = this.outstanding.size > 0 || this.rt.hasPendingJob();
    for (const deferred of this.outstanding.values()) deferred.dispose();
    this.outstanding.clear();
    if (!this.broken) {
      try {
        const late = this.drain('hook');
        if (late && outcome.ok) outcome = { ok: false, fault: late };
      } catch {
        outcome = { ok: false, fault: this.brokenFault() };
      }
    }

    if (this.broken) return { ok: false, fault: this.brokenFault() };
    const hard = !outcome.ok && ['cpu', 'memory', 'broken'].includes(outcome.fault.code);
    if (this.overCalls && !hard) return { ok: false, fault: fault('calls', 'more than 50 $ calls in one hook') };
    if (leftOver && outcome.ok) return { ok: false, fault: fault('error', 'work left running after the hook') };
    return outcome;
  }

  private async drive(fn: QuickJSHandle, e: HookEvent): Promise<HookOutcome> {
    const api = this.api!;
    const eventText = this.ctx.newString(JSON.stringify(e));
    const evR = this.slice(() => this.ctx.callFunction(api.wrap, this.ctx.undefined, eventText));
    eventText.dispose();
    if (evR.error) return { ok: false, fault: this.faultFrom(evR.error, 'hook') };
    const r = this.slice(() => this.ctx.callFunction(fn, this.ctx.undefined, api.$, evR.value, api.next));
    evR.value.dispose();
    if (r.error) return { ok: false, fault: this.faultFrom(r.error, 'hook') };
    const result = r.value;
    try {
      for (;;) {
        const stopped = this.drain('hook', () => !this.pending(result));
        if (stopped) return { ok: false, fault: stopped };
        if (this.broken) throw new BrokenError(this.brokenMessage);
        const st = this.ctx.getPromiseState(result);
        if (st.type === 'rejected') return { ok: false, fault: this.faultFrom(st.error, 'hook') };
        if (st.type === 'fulfilled') {
          if (!st.notAPromise) st.value.dispose();
          return { ok: true };
        }
        if (this.outstanding.size === 0) {
          return { ok: false, fault: fault('error', 'the hook is waiting on something that never settles') };
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
    } finally {
      result.dispose();
    }
  }

  dispose() {
    if (this.phase === 'disposed') return;
    this.phase = 'disposed';
    this.liveHookId = null;
    try {
      for (const deferred of this.outstanding.values()) deferred.dispose();
      this.outstanding.clear();
      for (const h of this.handlerFns.values()) h.dispose();
      this.handlerFns.clear();
      if (this.api) for (const key of API_KEYS) this.api[key].dispose();
      this.api = null;
      this.hostFn?.dispose();
      this.hostFn = null;
      this.ctx.dispose();
      this.rt.dispose();
    } catch (err) {
      // A broken heap may refuse to free; the worker is closing either way.
      this.markBroken(err);
    }
  }
}

export async function loadMod(
  qjs: QuickJSFactory,
  source: string,
  limits: CoreLimits,
  call: HostCall
): Promise<LoadResult> {
  const s = new ModSession(qjs, limits, call);
  const result = await s.load(source);
  if (!result.ok) s.dispose();
  return result;
}

/** The editor's check before a save: load with no `$`, read the manifest and hooks, run nothing. */
export async function scratchEvaluate(
  qjs: QuickJSFactory,
  source: string,
  limits: CoreLimits
): Promise<ScratchResult> {
  const s = new ModSession(qjs, limits, () => Promise.reject(new Error('not available while loading')));
  const result = await s.load(source);
  s.dispose();
  return result.ok ? { ok: true, manifestJson: result.manifestJson, hooks: result.hooks } : result;
}

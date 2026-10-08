import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from 'quickjs-emscripten';
import { MOD_REPLY_ERROR_MAX } from '@/lib/mods/limits';
import { HostMessageSchema, fault, type Fault, type HostMessage, type ModMethod } from '@/lib/mods/protocol';
import { CORE_LIMITS, loadMod, scratchEvaluate, type LoadedMod } from './core';

/**
 * A mod's worker: one mod (or one scratch evaluation) per worker, spawned by
 * the sandbox frame from a blob that runs LOCKDOWN_JS first
 * (lib/mods/sandbox/frame-script.mjs). Built into one classic script by
 * scripts/build-mod-runtime.mjs, which is why it may import only QuickJS,
 * ./*, protocol and limits (tests/unit/mods-runtime-boundary.test.ts).
 *
 * The frame posts `init` with the WebAssembly.Module it compiled once, then
 * the request. Passing the module makes the glue instantiate it as it is: it
 * never fetches or compiles anything, which LOCKDOWN and the frame's CSP
 * would refuse anyway.
 *
 * Messages run one at a time, in order. The host never sends a second hook
 * before `done`, and the frame stamps modId and gen on whatever this posts,
 * so nothing here is trusted for identity.
 */

interface WorkerScope {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;

let qjsReady: Promise<QuickJSWASMModule> | null = null;
let mod: LoadedMod | null = null;
let modKey: { modId: string; gen: number } | null = null;
let liveHookId: string | null = null;
let nextCallId = 0;
const waiting = new Map<number, { hookId: string; resolve(v: string): void; reject(e: Error): void }>();

const post = (message: unknown) => scope.postMessage(message);

function quit(f: Fault) {
  if (modKey) post({ t: 'gone', ...modKey, fault: f });
  mod?.dispose();
  mod = null;
  scope.close();
}

async function handle(d: Exclude<HostMessage, { t: 'reply' }>) {
  const qjs = await qjsReady;
  if (!qjs) return;
  switch (d.t) {
    case 'load': {
      if (mod) return;
      const key = { modId: d.modId, gen: d.gen };
      const r = await loadMod(qjs, d.source, CORE_LIMITS, (method: ModMethod, argsJson: string) => {
        const hookId = liveHookId;
        if (!hookId) return Promise.reject(new Error('hook ended'));
        const callId = nextCallId++;
        return new Promise<string>((resolve, reject) => {
          waiting.set(callId, { hookId, resolve, reject });
          post({ t: 'call', ...key, hookId, callId, method, argsJson });
        });
      });
      if (r.ok) {
        mod = r;
        modKey = key;
        post({ t: 'loaded', ...key, ok: true, hooks: r.hooks, manifestJson: r.manifestJson });
      } else {
        post({ t: 'loaded', ...key, ok: false, fault: r.fault });
        if (r.fault.code === 'broken') scope.close();
      }
      return;
    }
    case 'hook': {
      if (!mod || !modKey || modKey.modId !== d.modId || modKey.gen !== d.gen) return;
      liveHookId = d.hookId;
      const outcome = await mod.runHook(d.hookId, d.event);
      liveHookId = null;
      for (const [id, w] of waiting) if (w.hookId === d.hookId) waiting.delete(id);
      post(
        outcome.ok
          ? { t: 'done', ...modKey, hookId: d.hookId, ok: true, ...(outcome.resultJson !== undefined && { resultJson: outcome.resultJson }) }
          : { t: 'done', ...modKey, hookId: d.hookId, ok: false, fault: outcome.fault }
      );
      if (mod.broken) quit(outcome.ok ? fault('broken', 'the runtime stopped working') : outcome.fault);
      return;
    }
    case 'unload': {
      mod?.dispose();
      mod = null;
      scope.close();
      return;
    }
    case 'scratch': {
      const r = await scratchEvaluate(qjs, d.source, CORE_LIMITS);
      post(r.ok ? { t: 'scratched', reqId: d.reqId, ok: true, manifestJson: r.manifestJson, hooks: r.hooks } : { t: 'scratched', reqId: d.reqId, ok: false, fault: r.fault });
      return;
    }
  }
}

/** A reply settles its call at once; it never waits behind the hook that is waiting for it. */
function reply(d: Extract<HostMessage, { t: 'reply' }>) {
  const w = waiting.get(d.callId);
  if (!w || w.hookId !== d.hookId || liveHookId !== d.hookId) return;
  waiting.delete(d.callId);
  if (d.ok) w.resolve(JSON.stringify(d.value ?? null));
  else w.reject(new Error(d.error.slice(0, MOD_REPLY_ERROR_MAX)));
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent) => {
  const data = e.data as { t?: unknown; module?: unknown } | null;
  if (data?.t === 'init') {
    if (!qjsReady && data.module instanceof WebAssembly.Module) {
      qjsReady = newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: data.module }));
    }
    return;
  }
  const parsed = HostMessageSchema.safeParse(data);
  if (!parsed.success) return;
  const d = parsed.data;
  if (d.t === 'reply') {
    reply(d);
    return;
  }
  queue = queue
    .then(() => handle(d))
    .catch((err: unknown) => quit(fault('broken', err instanceof Error ? `${err.name}: ${err.message}` : String(err))));
};

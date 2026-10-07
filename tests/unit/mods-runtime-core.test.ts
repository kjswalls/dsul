// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RELEASE_SYNC,
  newQuickJSWASMModuleFromVariant,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { CORE_LIMITS, loadMod, scratchEvaluate, type LoadedMod } from '@/lib/mods/runtime/core';
import type { HookEvent, ModMethod } from '@/lib/mods/protocol';
import { MOD_TEMPLATE, MOD_TEMPLATE_USES } from '@/lib/mods/template';
import { ModManifestSchema } from '@/lib/mods/schema';

// The real QuickJS, in node: the release variant loads its own wasm under the
// `import` condition. The worker builds the same thing from the frame's
// compiled module (lib/mods/runtime/worker-entry.ts).

let qjs: QuickJSWASMModule;
beforeAll(async () => {
  qjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
});

type Call = { method: ModMethod; args: unknown };

/** A fake broker: records every call and answers it on a later tick. */
function recorder(answer: (method: ModMethod, args: unknown) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const call = async (method: ModMethod, argsJson: string) => {
    const args = JSON.parse(argsJson);
    calls.push({ method, args });
    await Promise.resolve();
    return JSON.stringify(answer(method, args) ?? null);
  };
  return { calls, call };
}

const texts = (calls: Call[]) => calls.filter((c) => c.method === 'log').map((c) => (c.args as { text: string }).text);

const MANIFEST = 'export const manifest = { version: 1, uses: [] };';
const HOOK = '11111111-1111-4111-8111-111111111111';
const command: HookEvent = { kind: 'command', id: 'go' };

function modOn(body: string, kind = 'command') {
  return `${MANIFEST}\nexport function register(on) { on('${kind}', async ($, e, next) => { ${body} }); }`;
}

async function loaded(source: string, call = recorder().call, limits = CORE_LIMITS): Promise<LoadedMod> {
  const mod = await loadMod(qjs, source, limits, call);
  if (!mod.ok) throw new Error(`load failed: ${mod.fault.code} ${mod.fault.message}`);
  return mod;
}

async function hook(body: string, call = recorder().call, e: HookEvent = command, limits = CORE_LIMITS) {
  const mod = await loaded(modOn(body), call, limits);
  try {
    return await mod.runHook(HOOK, e);
  } finally {
    mod.dispose();
  }
}

describe('loadMod', () => {
  it('reads the manifest and the hooks register declares', async () => {
    const mod = await loaded(
      `export const manifest = { version: 1, uses: ['ui'], commands: [{ id: 'go', label: 'Go' }] };
       export function register(on) { on('command', () => {}); on('item.completed', () => {}); }`
    );
    expect(JSON.parse(mod.manifestJson)).toEqual({ version: 1, uses: ['ui'], commands: [{ id: 'go', label: 'Go' }] });
    expect(mod.hooks.sort()).toEqual(['command', 'item.completed']);
    mod.dispose();
  });

  it('awaits an async register', async () => {
    const mod = await loaded(`${MANIFEST} export async function register(on) { await null; on('timer', () => {}); }`);
    expect(mod.hooks).toEqual(['timer']);
    mod.dispose();
  });

  it.each([
    ['an import', `import x from 'y'; ${MANIFEST} export function register() {}`, /could not load module/],
    ['top-level await', `await 1; ${MANIFEST} export function register() {}`, /top-level await/],
    ['no register', MANIFEST, /register/],
    ['no manifest', 'export function register() {}', /manifest/],
    ['a duplicate on', `${MANIFEST} export function register(on) { on('timer', () => {}); on('timer', () => {}); }`, /already registered/],
    ['an unknown event', `${MANIFEST} export function register(on) { on('day.opened', () => {}); }`, /unknown event/],
    ['a throw in the body', `throw new Error('nope'); ${MANIFEST} export function register() {}`, /nope/],
    ['a syntax error', `export const = 1`, /SyntaxError/],
  ])('refuses %s as a load fault', async (_, source, message) => {
    const r = await loadMod(qjs, source, CORE_LIMITS, recorder().call);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fault.code).toBe('load');
      expect(r.fault.message).toMatch(message);
    }
  });

  it('refuses a manifest over 8KB', async () => {
    const r = await loadMod(
      qjs,
      `export const manifest = { version: 1, pad: 'x'.repeat(9000) }; export function register() {}`,
      CORE_LIMITS,
      recorder().call
    );
    expect(r).toEqual({ ok: false, fault: { code: 'load', message: 'manifest too large' } });
  });

  it('rejects $ during the module body and register, and does not hang', async () => {
    const { calls, call } = recorder();
    const r = await loadMod(
      qjs,
      `${MANIFEST}
       let early = $.today().catch((e) => e.message);
       export async function register(on) {
         if ((await early) !== 'not available while loading') throw new Error('body reached the host');
         await $.today();
       }`,
      CORE_LIMITS,
      call
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fault).toEqual({ code: 'load', message: 'Error: not available while loading' });
    expect(calls).toEqual([]);
  });

  it('gives a load 250ms of CPU, and a hook 50ms', async () => {
    const spin = 'const s = Date.now(); while (Date.now() - s < 120) {}';
    const mod = await loaded(`${spin}\n${modOn(spin)}`);
    const r = await mod.runHook(HOOK, command);
    expect(r).toMatchObject({ ok: false, fault: { code: 'cpu' } });
    mod.dispose();
  });

  it('faults a module body that never ends as cpu', async () => {
    const r = await loadMod(qjs, `while (true) {} ${MANIFEST} export function register() {}`, CORE_LIMITS, recorder().call);
    expect(r).toMatchObject({ ok: false, fault: { code: 'cpu' } });
  });

  it('leaves eval undefined while the prelude still runs', async () => {
    const { calls, call } = recorder();
    expect(await hook(`await $.log({ level: 'info', text: typeof globalThis.eval });`, call)).toEqual({ ok: true });
    expect(texts(calls)).toEqual(['undefined']);
  });
});

describe('runHook', () => {
  it('runs a handler with $ and the event, and answers calls', async () => {
    const { calls, call } = recorder((m) => (m === 'today' ? { date: '2026-10-07', time: '09:00', bucket: 'morning' } : null));
    const r = await hook(
      `const t = await $.today(); await $.log({ level: 'info', text: t.date + ' ' + e.id + ' ' + typeof next });`,
      call
    );
    expect(r).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(['today', 'log']);
    expect(texts(calls)).toEqual(['2026-10-07 go function']);
  });

  it('nests $ methods by their dotted names', async () => {
    const { calls, call } = recorder();
    await hook(`await $.items.query({ open: true }); await $.store.set({ key: 'n', value: 1 });`, call);
    expect(calls).toEqual([
      { method: 'items.query', args: { open: true } },
      { method: 'store.set', args: { key: 'n', value: 1 } },
    ]);
  });

  it('freezes what it hands the mod', async () => {
    const { calls, call } = recorder((m) => (m === 'today' ? { date: 'd', nested: { a: 1 } } : null));
    await hook(
      `const t = await $.today();
       await $.log({ level: 'info', text: [Object.isFrozen(t), Object.isFrozen(t.nested), Object.isFrozen(e), Object.isFrozen($)].join() });`,
      call
    );
    expect(texts(calls)).toEqual(['true,true,true,true']);
  });

  it('turns a rejected call into a rejection the mod can catch', async () => {
    const { calls, call } = (() => {
      const calls: Call[] = [];
      return {
        calls,
        call: async (method: ModMethod, argsJson: string) => {
          calls.push({ method, args: JSON.parse(argsJson) });
          if (method === 'ui.toast') throw new Error('needs "ui" in manifest.uses');
          return 'null';
        },
      };
    })();
    const r = await hook(
      `try { await $.ui.toast({ text: 'hi' }) } catch (err) { await $.log({ level: 'info', text: err.message }) }`,
      call
    );
    expect(r).toEqual({ ok: true });
    expect(texts(calls)).toEqual(['needs "ui" in manifest.uses']);
  });

  it('runs nothing for a kind the mod did not register', async () => {
    const { calls, call } = recorder();
    const mod = await loaded(modOn(`await $.today();`), call);
    expect(await mod.runHook(HOOK, { kind: 'timer', name: 'x' })).toEqual({ ok: true });
    expect(calls).toEqual([]);
    mod.dispose();
  });

  it('maps an uncaught throw to an error fault, name and message only', async () => {
    expect(await hook(`throw new TypeError('boom')`)).toEqual({ ok: false, fault: { code: 'error', message: 'TypeError: boom' } });
    expect(await hook(`throw 'plain'`)).toEqual({ ok: false, fault: { code: 'error', message: 'Uncaught plain' } });
  });

  it.each([
    ['an endless loop', 'while (true) {}'],
    ['a catastrophic regex', `/(a+)+$/.test('a'.repeat(40) + 'b')`],
    ['a slow sort comparator', 'const a = []; for (let i = 0; i < 1e5; i++) a.push(i); a.sort(() => { for (;;) {} })'],
    ['a caught endless loop', 'try { while (true) {} } catch (err) {}'],
    ['a storm of jobs', 'await new Promise(() => { const f = () => Promise.resolve().then(f); f(); })'],
  ])('faults %s as cpu within about 100ms', async (_, body) => {
    const start = performance.now();
    const r = await hook(body);
    expect(r).toMatchObject({ ok: false, fault: { code: 'cpu' } });
    expect(performance.now() - start).toBeLessThan(400);
  });

  it('faults an uncaught out of memory as memory, and lets a caught one carry on', async () => {
    // A roomier CPU budget than a real hook's: filling toward 16MB under a
    // loaded test run can take longer than 50ms, and then the fault is cpu.
    const roomy = { ...CORE_LIMITS, cpuMs: 2000 };
    expect(await hook('new Array(1e8).fill(1)', undefined, command, roomy)).toMatchObject({
      ok: false,
      fault: { code: 'memory' },
    });

    const { calls, call } = recorder();
    const mod = await loaded(
      modOn(`let r = 'none'; try { new Array(1e8).fill(1) } catch (err) { r = String(err) } await $.log({ level: 'info', text: r });`),
      call,
      roomy
    );
    expect(await mod.runHook(HOOK, command)).toEqual({ ok: true });
    expect(await mod.runHook(HOOK, command)).toEqual({ ok: true });
    expect(texts(calls)).toEqual(['InternalError: out of memory', 'InternalError: out of memory']);
    mod.dispose();
  });

  it('faults unbounded recursion as an error at 256KB of stack, not a host RangeError', async () => {
    expect(await hook('function f() { f() } f()')).toEqual({
      ok: false,
      fault: { code: 'error', message: 'InternalError: stack overflow' },
    });
  });

  it('marks the runtime broken when the host side throws', async () => {
    const mod = await loaded(modOn(`try { await $.today() } catch (err) {}`), () => {
      throw new RangeError('host blew up');
    });
    expect(await mod.runHook(HOOK, command)).toEqual({
      ok: false,
      fault: { code: 'broken', message: 'RangeError: host blew up' },
    });
    expect(mod.broken).toBe(true);
    expect(await mod.runHook(HOOK, command)).toMatchObject({ ok: false, fault: { code: 'broken' } });
    mod.dispose();
  });

  it('faults the 51st call as calls, even when the mod catches it', async () => {
    const { calls, call } = recorder();
    const r = await hook(`for (let i = 0; i < 51; i++) { try { await $.today() } catch (err) {} }`, call);
    expect(r).toMatchObject({ ok: false, fault: { code: 'calls' } });
    expect(calls).toHaveLength(50);
  });

  it('refuses a 7e6-character argument before copying it out', async () => {
    // Building and stringifying 7MB takes longer than a hook's 50ms, so this
    // one hook gets more CPU: the size check is what is under test.
    const { calls, call } = recorder();
    const mod = await loadMod(
      qjs,
      modOn(`try { await $.log({ level: 'info', text: 'x'.repeat(7e6) }) } catch (err) { await $.log({ level: 'info', text: err.message }) }`),
      { ...CORE_LIMITS, cpuMs: 5000 },
      call
    );
    if (!mod.ok) throw new Error('load failed');
    const r = await mod.runHook(HOOK, command);
    mod.dispose();
    expect(r).toEqual({ ok: true });
    expect(texts(calls)).toEqual(['args too large']);
  });

  it('faults work left running at settle, and refuses its later calls', async () => {
    const { calls, call } = recorder();
    const mod = await loaded(
      `${MANIFEST}
       export function register(on) {
         on('command', () => { Promise.resolve().then(() => $.log({ level: 'info', text: 'late' })); });
       }`,
      call
    );
    expect(await mod.runHook(HOOK, command)).toEqual({
      ok: false,
      fault: { code: 'error', message: 'work left running after the hook' },
    });
    expect(calls).toEqual([]);
    mod.dispose();
  });

  it('faults a call left unanswered at settle, and drops its reply', async () => {
    let answer: (v: string) => void = () => {};
    const call = () => new Promise<string>((resolve) => (answer = resolve));
    const mod = await loaded(
      `${MANIFEST}
       export function register(on) {
         on('command', ($) => { $.today().then(() => { throw new Error('should never run') }); });
         on('timer', () => {});
       }`,
      call
    );
    expect(await mod.runHook(HOOK, command)).toMatchObject({ ok: false, fault: { code: 'error' } });
    answer('{"date":"d"}');
    await new Promise((r) => setTimeout(r, 0));
    expect(await mod.runHook('22222222-2222-4222-8222-222222222222', { kind: 'timer', name: 't' })).toEqual({ ok: true });
    mod.dispose();
  });

  it('faults a hook waiting on a promise nothing can settle', async () => {
    expect(await hook('await new Promise(() => {})')).toMatchObject({ ok: false, fault: { code: 'error' } });
  });
});

describe('scratchEvaluate', () => {
  it('reads the manifest and hooks and runs nothing', async () => {
    expect(await scratchEvaluate(qjs, modOn('throw new Error("ran")', 'timer'), CORE_LIMITS)).toEqual({
      ok: true,
      manifestJson: '{"version":1,"uses":[]}',
      hooks: ['timer'],
    });
  });

  it('reports a load fault', async () => {
    expect(await scratchEvaluate(qjs, 'export const = 1', CORE_LIMITS)).toMatchObject({ ok: false, fault: { code: 'load' } });
  });
});

describe('handles', () => {
  // TestQuickJSWASMModule's runtime count never drops in 0.32 (its lifetimes
  // are not wired to dispose), so this counts runtimes itself. The release
  // build aborts JS_FreeRuntime on any leaked object, which kills the whole
  // wasm module: a leak shows up as a runtime still alive, a broken session,
  // and a module that can no longer make a runtime.
  it('frees every runtime it made, with no handle leaked', async () => {
    const made: QuickJSRuntime[] = [];
    const factory = {
      newRuntime: (options?: Parameters<QuickJSWASMModule['newRuntime']>[0]) => {
        const rt = qjs.newRuntime(options);
        made.push(rt);
        return rt;
      },
    };
    const mod = await loadMod(factory, modOn(`await $.today(); $.today();`), CORE_LIMITS, recorder().call);
    if (!mod.ok) throw new Error('load failed');
    await mod.runHook(HOOK, command);
    await mod.runHook(HOOK, command);
    mod.dispose();
    expect(mod.broken).toBe(false);
    await loadMod(factory, 'export const = 1', CORE_LIMITS, recorder().call);
    await loadMod(factory, modOn('while (true) {}'), CORE_LIMITS, recorder().call).then((m) => {
      if (m.ok) return m.runHook(HOOK, command).then(() => m.dispose());
    });
    await scratchEvaluate(factory, modOn(''), CORE_LIMITS);
    expect(made).toHaveLength(4);
    expect(made.every((rt) => !rt.alive)).toBe(true);
    const probeRt = qjs.newRuntime();
    const probe = probeRt.newContext();
    const two = probe.unwrapResult(probe.evalCode('1 + 1'));
    expect(probe.getNumber(two)).toBe(2);
    two.dispose();
    probe.dispose();
    probeRt.dispose();
  });
});

describe('the editor’s template', () => {
  it('scratch-evaluates to a manifest the schema takes, and counts a glass', async () => {
    const scratch = await scratchEvaluate(qjs, MOD_TEMPLATE, CORE_LIMITS);
    if (!scratch.ok) throw new Error(scratch.fault.message);
    const manifest = ModManifestSchema.parse(JSON.parse(scratch.manifestJson));
    expect(manifest.uses).toEqual(MOD_TEMPLATE_USES);
    expect(manifest.commands.map((c) => c.id)).toEqual(['add-glass']);

    const r = recorder((method) =>
      method === 'today' ? { date: '2026-10-07', time: '09:00', bucket: 'morning' } : method === 'store.get' ? { date: '2026-10-07', count: 2 } : { ok: true }
    );
    const mod = await loaded(MOD_TEMPLATE, r.call);
    try {
      expect(await mod.runHook(HOOK, { kind: 'command', id: 'add-glass' })).toEqual({ ok: true });
    } finally {
      mod.dispose();
    }
    expect(r.calls.map((c) => c.method)).toEqual(['today', 'store.get', 'store.set', 'ui.toast']);
    expect(r.calls[2].args).toEqual({ key: 'glasses', value: { date: '2026-10-07', count: 3 } });
    expect(r.calls[3].args).toEqual({ text: '3 of 8 glasses today' });
  });
});

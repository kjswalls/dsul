// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { WORKER_JS_B64 } from '@/lib/mods/sandbox/generated/worker';
import { LOCKDOWN_GLOBALS, LOCKDOWN_JS } from '@/lib/mods/sandbox/frame-script.mjs';
import { workerBundleProblems } from '../../scripts/build-mod-runtime.mjs';

// The worker bundle as postinstall wrote it (lib/mods/sandbox/generated/,
// gitignored). If this file fails to import, run `pnpm install` or
// `node scripts/build-mod-runtime.mjs`.

const workerJs = Buffer.from(WORKER_JS_B64, 'base64').toString('utf8');

function wasmBytes() {
  const umbrella = createRequire(createRequire(import.meta.url).resolve('quickjs-emscripten'));
  return readFileSync(umbrella.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'));
}

describe('the mod worker bundle', () => {
  it('exists and is one script', () => {
    expect(workerJs.length).toBeGreaterThan(10_000);
    expect(workerJs).toContain('dsul.invalid');
  });

  it('holds no importScripts, chunk or public-path runtime, import(), or app modules', () => {
    expect(workerBundleProblems(workerJs)).toEqual([]);
  });

  it('the check finds each of them when they are there', () => {
    const planted = [
      'importScripts("x")',
      '__webpack_require__.e(1)',
      '__webpack_require__.p + "x"',
      'import("x")',
      'require("zustand")',
      '"@supabase/ssr"',
      'createClient()',
    ];
    expect(workerBundleProblems(planted.join(';\n'))).toHaveLength(7);
    expect(workerBundleProblems('/* import() eager */ x.import_(1);\n  // import("y")')).toEqual([]);
  });

  it('LOCKDOWN names thirteen globals plus navigator.serviceWorker', () => {
    expect(LOCKDOWN_GLOBALS).toEqual([
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'WebSocketStream',
      'EventSource',
      'WebTransport',
      'importScripts',
      'indexedDB',
      'caches',
      'BroadcastChannel',
      'Worker',
      'SharedWorker',
      'Notification',
    ]);
    for (const name of LOCKDOWN_GLOBALS) expect(LOCKDOWN_JS).toContain(`"${name}"`);
    expect(LOCKDOWN_JS).toContain("'serviceWorker'");
  });

  it('runs behind LOCKDOWN: loads a mod from a compiled module and answers a hook', async () => {
    // A worker-shaped global in a fresh realm: no process, no require, and
    // fetch and friends present until LOCKDOWN takes them.
    class WorkerGlobalScope {}
    class Navigator {
      get serviceWorker() {
        return {};
      }
    }
    const posted: Array<Record<string, unknown>> = [];
    const self = Object.create(WorkerGlobalScope.prototype) as Record<string, unknown>;
    Object.assign(self, {
      self,
      WorkerGlobalScope,
      WebAssembly,
      TextEncoder,
      TextDecoder,
      performance,
      setTimeout,
      clearTimeout,
      console,
      navigator: new Navigator(),
      location: { href: 'blob:https://do.dsul.app/x' },
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      close: () => {},
      fetch: () => {
        throw new Error('fetch reached');
      },
      importScripts: () => {
        throw new Error('importScripts reached');
      },
    });
    const ctx = vm.createContext(self);
    vm.runInContext(`${LOCKDOWN_JS};\n${workerJs}`, ctx);
    expect(vm.runInContext('[typeof fetch, typeof importScripts, typeof navigator.serviceWorker].join()', ctx)).toBe(
      'undefined,undefined,undefined'
    );

    const send = (data: unknown) => (self.onmessage as (e: { data: unknown }) => void)({ data });
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const m = posted.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timed out');
    };

    const modId = '11111111-1111-4111-8111-111111111111';
    const hookId = '22222222-2222-4222-8222-222222222222';
    send({ t: 'init', module: await WebAssembly.compile(wasmBytes()) });
    send({
      t: 'load',
      modId,
      gen: 0,
      source: `export const manifest = { version: 1, uses: [] };
        export function register(on) {
          on('command', async ($, e) => { const t = await $.today(); await $.log({ level: 'info', text: t.date + ' ' + e.id }); });
        }`,
    });
    expect(await waitFor((m) => m.t === 'loaded')).toEqual({
      t: 'loaded',
      modId,
      gen: 0,
      ok: true,
      hooks: ['command'],
      manifestJson: '{"version":1,"uses":[]}',
    });

    send({ t: 'hook', modId, gen: 0, hookId, event: { kind: 'command', id: 'go' } });
    const today = await waitFor((m) => m.t === 'call' && m.method === 'today');
    send({ t: 'reply', modId, gen: 0, hookId, callId: today.callId, ok: true, value: { date: '2026-10-07' } });
    const log = await waitFor((m) => m.t === 'call' && m.method === 'log');
    expect(JSON.parse(log.argsJson as string)).toEqual({ level: 'info', text: '2026-10-07 go' });
    send({ t: 'reply', modId, gen: 0, hookId, callId: log.callId, ok: true, value: null });
    expect(await waitFor((m) => m.t === 'done')).toEqual({ t: 'done', modId, gen: 0, hookId, ok: true });
  });
});

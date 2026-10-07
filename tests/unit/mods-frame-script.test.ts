import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_SCRIPT_BODY } from '@/lib/mods/sandbox/frame-script.mjs';
import {
  MOD_ARGS_MAX_BYTES,
  MOD_FAULT_MESSAGE_MAX,
  MOD_LOAD_WALL_MS,
  MOD_MANIFEST_MAX_BYTES,
  MOD_WALL_MS,
  MOD_WALL_TOTAL_MS,
} from '@/lib/mods/limits';

// The sandbox frame's script, run against fakes for everything it touches:
// its parent, the DOM blocks, WebAssembly, Blob, URL and Worker. Timers are
// vitest's, so the wall clock is driven by hand.

const MOD = '11111111-1111-4111-8111-111111111111';
const HOOK = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  /** The worker speaking to the frame. */
  say(data: unknown) {
    this.onmessage?.({ data });
  }
}

type Sent = Record<string, unknown>;

function frame(version = 'v1') {
  let listener: ((e: unknown) => void) | null = null;
  const parent = { name: 'parent' };
  const blobs: unknown[][] = [];
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const blocks: Record<string, string> = { lockdown: b64('/*lockdown*/'), w: b64('/*worker*/'), wasm: b64('\0asm') };
  const run = new Function(
    'addEventListener',
    'parent',
    'document',
    'atob',
    'TextDecoder',
    'URL',
    'Blob',
    'Worker',
    'WebAssembly',
    'setTimeout',
    'clearTimeout',
    'Date',
    `const SANDBOX_VERSION='${version}';${FRAME_SCRIPT_BODY}`
  );
  run(
    (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listener = fn;
    },
    parent,
    { getElementById: (id: string) => ({ textContent: blocks[id] }) },
    (s: string) => Buffer.from(s, 'base64').toString('latin1'),
    TextDecoder,
    { createObjectURL: (blob: { parts: unknown[] }) => (blobs.push(blob.parts), 'blob:frame/1') },
    class {
      constructor(public parts: unknown[]) {}
    },
    FakeWorker,
    { compile: async () => ({ compiled: true }) },
    (fn: () => void, ms: number) => setTimeout(fn, ms),
    (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    Date
  );
  const makePort = () => {
    const sent: Sent[] = [];
    return { sent, port: { sent, onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (m: Sent) => sent.push(m) } };
  };
  return {
    parent,
    blobs,
    makePort,
    message: (e: unknown) => listener?.(e),
  };
}

/** A frame that has booted, with a helper to speak as the host. */
async function booted() {
  const f = frame();
  const { port, sent } = f.makePort();
  f.message({ source: f.parent, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [port] });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([{ t: 'ready', v: 'v1' }]);
  sent.length = 0;
  const host = (data: unknown) => port.onmessage!({ data });
  return { ...f, sent, host };
}

/** Booted, with one mod loaded and its worker. */
async function withMod() {
  const f = await booted();
  f.host({ t: 'load', modId: MOD, gen: 1, source: 'x' });
  const w = FakeWorker.all.at(-1)!;
  w.say({ t: 'loaded', modId: MOD, gen: 1, ok: true, hooks: ['command'], manifestJson: '{}' });
  f.sent.length = 0;
  return { ...f, w };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.all = [];
});
afterEach(() => vi.useRealTimers());

describe('frame boot', () => {
  it('ignores a message that is not from its parent, then takes the real one', async () => {
    const f = frame();
    const a = f.makePort();
    f.message({ source: { name: 'someone' }, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [a.port] });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.sent).toEqual([]);
    const b = f.makePort();
    f.message({ source: f.parent, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [b.port] });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.sent).toEqual([{ t: 'ready', v: 'v1' }]);
    expect(f.blobs).toEqual([['/*lockdown*/', ';\n', '/*worker*/']]);
  });

  it('takes only the first boot', async () => {
    const f = frame();
    const a = f.makePort();
    const b = f.makePort();
    f.message({ source: f.parent, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [a.port] });
    f.message({ source: f.parent, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [b.port] });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.sent).toEqual([{ t: 'ready', v: 'v1' }]);
    expect(b.sent).toEqual([]);
  });

  it('refuses a boot for another version', async () => {
    const f = frame('v2');
    const a = f.makePort();
    f.message({ source: f.parent, data: { ch: 'dsul-mods', t: 'boot', v: 'v1' }, ports: [a.port] });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.sent).toEqual([{ t: 'boot-failed', reason: 'version' }]);
  });
});

describe('frame relay', () => {
  it('spawns a worker per load, sends it the module and then the request', async () => {
    const f = await booted();
    f.host({ t: 'load', modId: MOD, gen: 1, source: 'x' });
    const w = FakeWorker.all[0];
    expect(w.url).toBe('blob:frame/1');
    expect(w.posted).toEqual([{ t: 'init', module: { compiled: true } }, { t: 'load', modId: MOD, gen: 1, source: 'x' }]);
  });

  it('overwrites a worker’s forged modId and gen', async () => {
    const f = await booted();
    f.host({ t: 'load', modId: MOD, gen: 1, source: 'x' });
    FakeWorker.all[0].say({ t: 'loaded', modId: REQ, gen: 9, ok: true, hooks: [], manifestJson: '{}' });
    expect(f.sent).toEqual([{ t: 'loaded', modId: MOD, gen: 1, ok: true, hooks: [], manifestJson: '{}' }]);
  });

  it('drops a worker message with an unknown t or a string over its cap', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    w.say({ t: 'ready', v: 'v1' });
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: HOOK, callId: 0, method: 'log', argsJson: 'x'.repeat(MOD_ARGS_MAX_BYTES + 1) });
    w.say({ t: 'done', modId: MOD, gen: 1, hookId: HOOK, ok: false, fault: { code: 'error', message: 'x'.repeat(MOD_FAULT_MESSAGE_MAX + 1) } });
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: HOOK, callId: 0, method: 'x'.repeat(301), argsJson: '{}' });
    expect(sent).toEqual([]);
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: HOOK, callId: 0, method: 'log', argsJson: 'x'.repeat(MOD_ARGS_MAX_BYTES) });
    expect(sent).toHaveLength(1);
  });

  it('drops a call for a hook that is not the live one', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: REQ, callId: 0, method: 'log', argsJson: '{}' });
    expect(sent).toEqual([]);
  });
});

describe('frame wall clock', () => {
  it('pauses while a call is out, then expires: terminates and posts done and gone', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    await vi.advanceTimersByTimeAsync(MOD_WALL_MS - 100);
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: HOOK, callId: 0, method: 'today', argsJson: 'null' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.terminated).toBe(false);
    host({ t: 'reply', modId: MOD, gen: 1, hookId: HOOK, callId: 0, ok: true, value: {} });
    expect(w.posted.at(-1)).toMatchObject({ t: 'reply', callId: 0 });
    await vi.advanceTimersByTimeAsync(99);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(w.terminated).toBe(true);
    const fault = { code: 'wall', message: 'the hook took too long' };
    expect(sent.slice(1)).toEqual([
      { t: 'done', modId: MOD, gen: 1, hookId: HOOK, ok: false, fault },
      { t: 'gone', modId: MOD, gen: 1, fault },
    ]);
  });

  it('still fires the total cap while a call is out', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    w.say({ t: 'call', modId: MOD, gen: 1, hookId: HOOK, callId: 0, method: 'today', argsJson: 'null' });
    await vi.advanceTimersByTimeAsync(MOD_WALL_TOTAL_MS - 1);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.terminated).toBe(true);
    expect(sent.at(-2)).toMatchObject({ t: 'done', ok: false, fault: { code: 'wall' } });
    expect(sent.at(-1)).toMatchObject({ t: 'gone', fault: { code: 'wall' } });
  });

  it('stops the clock at done', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    w.say({ t: 'done', modId: MOD, gen: 1, hookId: HOOK, ok: true });
    await vi.advanceTimersByTimeAsync(MOD_WALL_TOTAL_MS * 2);
    expect(w.terminated).toBe(false);
    expect(sent).toEqual([{ t: 'done', modId: MOD, gen: 1, hookId: HOOK, ok: true }]);
  });

  it('times out a load', async () => {
    const f = await booted();
    f.host({ t: 'load', modId: MOD, gen: 1, source: 'x' });
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(f.sent).toEqual([
      { t: 'loaded', modId: MOD, gen: 1, ok: false, fault: { code: 'wall', message: 'the mod took too long to load' } },
    ]);
  });

  it('times out a scratch, and ends a finished one’s worker', async () => {
    const f = await booted();
    f.host({ t: 'scratch', reqId: REQ, source: 'x' });
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(f.sent).toEqual([
      { t: 'scratched', reqId: REQ, ok: false, fault: { code: 'wall', message: 'the code took too long to load' } },
    ]);

    f.sent.length = 0;
    f.host({ t: 'scratch', reqId: REQ, source: 'y' });
    FakeWorker.all[1].say({ t: 'scratched', reqId: MOD, ok: true, manifestJson: '{}', hooks: [] });
    expect(FakeWorker.all[1].terminated).toBe(true);
    expect(f.sent).toEqual([{ t: 'scratched', reqId: REQ, ok: true, manifestJson: '{}', hooks: [] }]);
  });

  it('reports a crashed worker as broken and gone', async () => {
    const { w, sent, host } = await withMod();
    host({ t: 'hook', modId: MOD, gen: 1, hookId: HOOK, event: { kind: 'command', id: 'go' } });
    w.onerror!({ message: 'boom', preventDefault() {} });
    expect(w.terminated).toBe(true);
    expect(sent.map((m) => m.t)).toEqual(['done', 'gone']);
    expect(sent[1]).toMatchObject({ fault: { code: 'broken' } });
  });
});

describe('frame limits', () => {
  it('repeats lib/mods/limits.ts exactly', () => {
    const value = (name: string) => Number(FRAME_SCRIPT_BODY.match(new RegExp(`var ${name} = (\\d+);`))?.[1]);
    expect(value('WALL_MS')).toBe(MOD_WALL_MS);
    expect(value('WALL_TOTAL_MS')).toBe(MOD_WALL_TOTAL_MS);
    expect(value('LOAD_WALL_MS')).toBe(MOD_LOAD_WALL_MS);
    expect(value('ARGS_MAX')).toBe(MOD_ARGS_MAX_BYTES);
    expect(value('MANIFEST_MAX')).toBe(MOD_MANIFEST_MAX_BYTES);
    expect(value('TEXT_MAX')).toBe(MOD_FAULT_MESSAGE_MAX);
  });
});

describe('frame unload', () => {
  it('an unload with a gen retires only that generation, so a hot reload keeps the new one', async () => {
    const f = await withMod();
    f.host({ t: 'load', modId: MOD, gen: 2, source: 'y' });
    const next = FakeWorker.all.at(-1)!;
    next.say({ t: 'loaded', modId: MOD, gen: 2, ok: true, hooks: ['command'], manifestJson: '{}' });
    f.host({ t: 'unload', modId: MOD, gen: 1 });
    expect(f.w.terminated).toBe(true);
    expect(next.terminated).toBe(false);
    f.host({ t: 'unload', modId: MOD });
    expect(next.terminated).toBe(true);
  });
});

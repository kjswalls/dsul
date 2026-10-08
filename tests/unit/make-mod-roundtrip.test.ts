// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { CORE_LIMITS, loadMod, scratchEvaluate } from '@/lib/mods/runtime/core';
import { ECHO_COPY, finishModDraft, parseMakeDraft, type DraftEnv, type DraftResult } from '@/lib/make-draft';
import { MAKE_EXAMPLES } from '@/lib/ai-server/make-prompt';
import { MOD_TEMPLATE } from '@/lib/mods/template';

/**
 * "Write with AI" for a mod, end to end without the browser (build order 10):
 * the reply as the prompt's own example shapes it, read by parseMakeDraft,
 * run once by the real QuickJS core as the sandbox's scratch does, and
 * finished into a draft. What the card shows and Install saves comes from
 * that run, never from the reply's own say.
 */

let qjs: QuickJSWASMModule;
beforeAll(async () => {
  qjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
});

const ENV: DraftEnv = { recipe: { customTypeNames: [] }, rows: [] };

/** The reply text, through the reader, the scratch run and finishModDraft. */
async function roundTrip(reply: string): Promise<DraftResult> {
  const read = parseMakeDraft(reply, 'mod', ENV);
  if (read.ok !== 'scratch') return read;
  const scratch = await scratchEvaluate(qjs, read.source, CORE_LIMITS);
  return finishModDraft(read, scratch.ok ? scratch : { fault: scratch.fault });
}

const envelope = (name: string, source: string) => JSON.stringify({ kind: 'mod', name, source });

describe('a mod written from the prompt\'s example', () => {
  it('a changed copy of the example installs with no problems', async () => {
    const example = MAKE_EXAMPLES.mod;
    const source = example.source.replace('const GOAL = 8;', 'const GOAL = 6;');
    expect(source).not.toBe(example.source);
    const r = await roundTrip(`Here it is:\n${envelope('Six glasses', source)}`);
    expect(r).toMatchObject({
      ok: true,
      problems: [],
      draft: { kind: 'mod', name: 'Six glasses', source, manifest: { version: 1, uses: ['storage', 'ui'] } },
    });
    if (r.ok !== true || r.draft.kind !== 'mod') throw new Error('no draft');
    expect([...r.draft.hooks].sort()).toEqual(['command', 'ui.action', 'ui.resolve']);
  });

  it('the example sent back untouched is refused as an echo, before it is run', async () => {
    expect(MAKE_EXAMPLES.mod.source).toBe(MOD_TEMPLATE);
    expect(await roundTrip(JSON.stringify(MAKE_EXAMPLES.mod))).toEqual({
      ok: false,
      reason: 'unreadable',
      message: ECHO_COPY,
    });
  });
});

describe('a draft that reaches for $ while loading', () => {
  const MANIFEST = "export const manifest = { version: 1, uses: ['items:write'] };";
  const CREATE = "$.items.create({ type: 'task', title: 'x' })";

  /** The broker's side of a real load of the same code: every call that got past the core. */
  async function callsWhileLoading(source: string): Promise<number> {
    const call = vi.fn(async () => 'null');
    const mod = await loadMod(qjs, source, CORE_LIMITS, call);
    if (mod.ok) mod.dispose();
    return call.mock.calls.length;
  }

  it.each([
    ['awaited in register', `${MANIFEST}\nexport async function register(on) { await ${CREATE}; }`],
    ['a missing global at the top level', `${MANIFEST}\nfetch('/x');\nexport function register(on) {}`],
    ['top-level await', `${MANIFEST}\nawait ${CREATE};\nexport function register(on) {}`],
  ])('%s faults, is held with no manifest, and calls nothing', async (_label, source) => {
    const r = await roundTrip(envelope('Grabby', source));
    expect(r).toMatchObject({ ok: true, draft: { kind: 'mod', manifest: null, hooks: [] } });
    if (r.ok !== true) throw new Error('no draft');
    expect(r.problems[0]).toMatch(/^It would not load/);
    expect(await callsWhileLoading(source)).toBe(0);
  });

  it('a call left un-awaited at the top level or in register is refused by the core, never reaching the host', async () => {
    const source = `${MANIFEST}\n${CREATE}.catch(() => {});\nexport function register(on) { globalThis.${CREATE}.catch(() => {}); }`;
    expect(await callsWhileLoading(source)).toBe(0);
  });

  it('a handler that would call $ is registered, never run', async () => {
    // `on` is the only thing register gets; scratch runs no handler.
    const source = `${MANIFEST}\nexport function register(on) { on('item.completed', async ($) => { await ${CREATE}; }); }`;
    const r = await roundTrip(envelope('Adds one', source));
    expect(r).toMatchObject({ ok: true, problems: [], draft: { hooks: ['item.completed'] } });
    expect(await callsWhileLoading(source)).toBe(0);
  });
});

describe('hooks are as written now', () => {
  it('a register that branches on the clock still carries the manifest the warning reads', async () => {
    const source = `export const manifest = { version: 1, uses: ['items:write'] };
export function register(on) {
  if (Date.now() < 0) on('item.completed', async ($, e) => { await $.items.edit({ id: e.itemId, priority: 'high' }); });
}`;
    const r = await roundTrip(envelope('Sometimes', source));
    expect(r).toMatchObject({ ok: true, problems: [], draft: { hooks: [] } });
    if (r.ok !== true || r.draft.kind !== 'mod') throw new Error('no draft');
    // The card's unattended line reads `uses`, not the hooks this run saw.
    expect(r.draft.manifest?.uses).toEqual(['items:write']);
  });
});

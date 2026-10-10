import { describe, expect, it } from 'vitest';
import {
  BootMessageSchema,
  HookEventSchema,
  HostMessageSchema,
  MOD_EVENT_KINDS,
  MOD_ITEM_EVENT_KINDS,
  MOD_METHODS,
  MOD_UI_EVENT_KINDS,
  fault,
  parseFrameMessage,
} from '@/lib/mods/protocol';
import {
  MOD_ARGS_MAX_BYTES,
  MOD_MANIFEST_MAX_BYTES,
  MOD_SOURCE_MAX_BYTES,
  MOD_TREE_MAX_BYTES,
  MOD_WRITES_PER_HOOK,
} from '@/lib/mods/limits';
import { MOD_SOURCE_MAX_BYTES as SCHEMA_SOURCE_MAX, RECIPE_EVENT_TRIGGERS } from '@/lib/mods/schema';
import { RUN_WRITE_CAP } from '@/lib/recipes/limits';

const MOD = '11111111-1111-4111-8111-111111111111';
const HOOK = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const err = { code: 'error', message: 'TypeError: boom' };

const valid = [
  { t: 'ready', v: '0123456789abcdef' },
  { t: 'boot-failed', reason: 'version' },
  { t: 'boot-failed', reason: 'compile', message: 'no wasm' },
  { t: 'loaded', modId: MOD, gen: 0, ok: true, hooks: ['command', 'item.completed'], manifestJson: '{"version":1}' },
  { t: 'loaded', modId: MOD, gen: 2, ok: false, fault: { code: 'load', message: 'export a register function' } },
  { t: 'call', modId: MOD, gen: 0, hookId: HOOK, callId: 3, method: 'store.set', argsJson: '{"key":"n","value":1}' },
  { t: 'done', modId: MOD, gen: 0, hookId: HOOK, ok: true },
  { t: 'done', modId: MOD, gen: 0, hookId: HOOK, ok: true, resultJson: '{"type":"divider"}' },
  { t: 'done', modId: MOD, gen: 0, hookId: HOOK, ok: false, fault: err },
  { t: 'gone', modId: MOD, gen: 0, fault: { code: 'wall', message: 'the hook took too long' } },
  { t: 'scratched', reqId: REQ, ok: true, manifestJson: '{}', hooks: [] },
  { t: 'scratched', reqId: REQ, ok: false, fault: err },
];

describe('parseFrameMessage', () => {
  it.each(valid.map((m) => [`${m.t}${'ok' in m ? ` ok=${m.ok}` : ''}`, m]))('accepts %s', (_, m) => {
    expect(parseFrameMessage(m)).toEqual({ ok: true, message: m });
  });

  it('rejects an unknown t, and anything that is not a message', () => {
    expect(parseFrameMessage({ t: 'boot', v: 'x' })).toEqual({ ok: false });
    expect(parseFrameMessage({ t: 'toString' })).toEqual({ ok: false });
    expect(parseFrameMessage(null)).toEqual({ ok: false });
    expect(parseFrameMessage('ready')).toEqual({ ok: false });
  });

  it('rejects extra keys, and names the mod when it can', () => {
    expect(parseFrameMessage({ t: 'done', modId: MOD, gen: 0, hookId: HOOK, ok: true, extra: 1 })).toEqual({
      ok: false,
      modId: MOD,
    });
  });

  it('rejects oversize argsJson and manifestJson', () => {
    const call = valid[5];
    expect(parseFrameMessage({ ...call, argsJson: 'x'.repeat(MOD_ARGS_MAX_BYTES) }).ok).toBe(true);
    expect(parseFrameMessage({ ...call, argsJson: 'x'.repeat(MOD_ARGS_MAX_BYTES + 1) })).toEqual({ ok: false, modId: MOD });
    expect(parseFrameMessage({ ...valid[3], manifestJson: 'x'.repeat(MOD_MANIFEST_MAX_BYTES + 1) }).ok).toBe(false);
  });

  it("caps a resolve's resultJson at the tree's size", () => {
    expect(parseFrameMessage({ ...valid[6], resultJson: 'x'.repeat(MOD_TREE_MAX_BYTES) }).ok).toBe(true);
    expect(parseFrameMessage({ ...valid[6], resultJson: 'x'.repeat(MOD_TREE_MAX_BYTES + 1) })).toEqual({ ok: false, modId: MOD });
    expect(parseFrameMessage({ ...valid[8], resultJson: '{}' }).ok).toBe(false);
  });

  it('rejects bad uuids, without naming a mod', () => {
    expect(parseFrameMessage({ ...valid[6], modId: 'not-a-uuid' })).toEqual({ ok: false });
    expect(parseFrameMessage({ ...valid[6], hookId: 'x' })).toEqual({ ok: false, modId: MOD });
  });

  it('rejects the writes code, an unknown method and an unknown hook kind', () => {
    expect(parseFrameMessage({ ...valid[8], fault: { code: 'writes', message: '' } }).ok).toBe(false);
    expect(parseFrameMessage({ ...valid[5], method: 'items.delete' }).ok).toBe(false);
    expect(parseFrameMessage({ ...valid[3], hooks: ['day.opened'] }).ok).toBe(false);
    expect(parseFrameMessage({ ...valid[8], fault: { code: 'error', message: 'x'.repeat(301) } }).ok).toBe(false);
  });
});

describe('host messages', () => {
  it('parse the boot and every host → frame message', () => {
    expect(BootMessageSchema.safeParse({ ch: 'dsul-mods', t: 'boot', v: 'abc' }).success).toBe(true);
    for (const m of [
      { t: 'load', modId: MOD, gen: 0, source: 'export {}' },
      { t: 'unload', modId: MOD },
      { t: 'hook', modId: MOD, gen: 0, hookId: HOOK, event: { kind: 'command', id: 'go' } },
      { t: 'reply', modId: MOD, gen: 0, hookId: HOOK, callId: 0, ok: true, value: { a: 1 } },
      { t: 'reply', modId: MOD, gen: 0, hookId: HOOK, callId: 0, ok: false, error: 'needs "ui"' },
      { t: 'scratch', reqId: REQ, source: '' },
    ]) {
      expect(HostMessageSchema.safeParse(m).success).toBe(true);
    }
  });

  it('caps the source at 061’s byte limit, counted in UTF-8', () => {
    expect(HostMessageSchema.safeParse({ t: 'scratch', reqId: REQ, source: 'é'.repeat(MOD_SOURCE_MAX_BYTES / 2) }).success).toBe(true);
    expect(HostMessageSchema.safeParse({ t: 'scratch', reqId: REQ, source: 'é'.repeat(MOD_SOURCE_MAX_BYTES / 2 + 1) }).success).toBe(false);
  });

  it('carries undo as an origin on item.uncompleted only', () => {
    const base = { itemId: 'i', type: 'task', date: '2026-10-07' };
    expect(HookEventSchema.safeParse({ kind: 'item.uncompleted', origin: 'undo', ...base }).success).toBe(true);
    expect(HookEventSchema.safeParse({ kind: 'item.uncompleted', ...base }).success).toBe(false);
    expect(HookEventSchema.safeParse({ kind: 'item.completed', origin: 'undo', ...base }).success).toBe(false);
  });

  it("parses a panel's three events, strictly", () => {
    const ok = [
      { kind: 'ui.resolve', panelId: 'water' },
      { kind: 'ui.action', panelId: 'water', action: 'add', atoms: {} },
      { kind: 'ui.action', panelId: 'water', action: 'add', arg: '2', atoms: { done: true, n: 3, note: 'hi', day: null } },
      { kind: 'atom.changed', key: 'note', value: 'hi' },
    ];
    for (const e of ok) expect(HookEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    const bad = [
      { kind: 'ui.resolve', panelId: 'water', presentation: 'rail' },
      { kind: 'ui.resolve', panelId: 'Water' },
      { kind: 'ui.action', panelId: 'water', action: 'add', arg: 'x'.repeat(65), atoms: {} },
      { kind: 'ui.action', panelId: 'water', action: 'add', atoms: { n: Number.NaN } },
      { kind: 'ui.action', panelId: 'water', action: 'add', atoms: { t: 'x'.repeat(501) } },
      { kind: 'ui.action', panelId: 'water', action: 'add', atoms: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, i])) },
      { kind: 'atom.changed', panelId: 'water', key: 'note', value: 'hi' },
      { kind: 'atom.changed', key: 'note', value: { a: 1 } },
    ];
    for (const e of bad) expect(HookEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
  });
});

describe('protocol constants', () => {
  it('hears the recipe triggers first, then command and timer', () => {
    expect(MOD_ITEM_EVENT_KINDS).toEqual(RECIPE_EVENT_TRIGGERS);
    expect(MOD_UI_EVENT_KINDS).toEqual(['ui.resolve', 'ui.action', 'atom.changed']);
    expect(MOD_EVENT_KINDS).toEqual([...RECIPE_EVENT_TRIGGERS, 'command', 'timer', ...MOD_UI_EVENT_KINDS]);
  });

  it('only ever appends methods: the 19 build order 8 shipped stay a prefix', () => {
    const PR8 = ['today', 'log', 'after', 'items.get', 'items.query', 'containers.list', 'verbs.eligible', 'items.create', 'items.edit', 'verbs.run', 'store.get', 'store.keys', 'store.set', 'store.delete', 'ui.toast', 'ui.openItem', 'nav.go', 'nav.organize', 'look.set'];
    expect(MOD_METHODS.slice(0, PR8.length)).toEqual(PR8);
    expect(MOD_METHODS.slice(PR8.length)).toEqual(['ui.open', 'atom.get', 'atom.set', 'settings.get']);
  });

  it('repeats the caps limits.ts cannot import', () => {
    expect(MOD_WRITES_PER_HOOK).toBe(RUN_WRITE_CAP);
    expect(MOD_SOURCE_MAX_BYTES).toBe(SCHEMA_SOURCE_MAX);
  });

  it('clips a fault message', () => {
    expect(fault('cpu', 'x'.repeat(400)).message).toHaveLength(300);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * lib/mods/ui/panel-store.ts: when a mod panel resolves (only while shown,
 * coalesced, paced, budgeted, never after a fault on its own), what each
 * outcome leaves, the atoms, and the bridge the runtime reads.
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { useModsStore } from '@/lib/mods-store';
import { setModPanelRunner, type ModPanelRunner } from '@/lib/mods/ui/panel-run';
import { __resetPanelStoreForTests, panelBridge, panelKey, usePanelStore } from '@/lib/mods/ui/panel-store';
import type { SettleOutcome } from '@/lib/mods/runtime-manager';
import type { UserMod } from '@/lib/mods/schema';
import { MOD_RESOLVES_PER_MINUTE } from '@/lib/mods/limits';

const MOD = '00000000-0000-4000-8000-000000000001';
const REF = { modId: MOD, panelId: 'water' };
const KEY = panelKey(REF);

const row = (over: Partial<UserMod> = {}): UserMod => ({
  id: MOD,
  userId: 'u',
  kind: 'mod',
  slug: 'water',
  name: 'Water',
  enabled: true,
  manifest: { version: 1, uses: ['ui'], commands: [], panels: [{ id: 'water', label: 'Water', card: true }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

const TREE = JSON.stringify({
  type: 'stack',
  children: [
    { type: 'stat', value: '0 of 8', label: 'Glasses' },
    { type: 'button', label: '+1', action: 'add' },
    { type: 'checkbox', atom: 'big', label: 'Big glass', initial: true },
    { type: 'input', atom: 'note', kind: 'text', label: 'Note' },
  ],
});

const ok = (json = TREE): SettleOutcome => ({ ok: true, resultJson: json });

/** A runner whose resolves answer in order from `answers`, or ok(TREE). */
function runner(answers: SettleOutcome[] = []) {
  const r = {
    resolvePanel: vi.fn(async () => answers.shift() ?? ok()),
    runAction: vi.fn(async (): Promise<SettleOutcome> => ({ ok: true })),
    atomChanged: vi.fn(async (): Promise<SettleOutcome> => ({ ok: true })),
    panelFault: vi.fn(),
  } satisfies ModPanelRunner;
  return r;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const store = () => usePanelStore.getState();

let unslot: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-10T09:00:00Z'));
  useModsStore.setState({ rows: [row()], safeMode: false });
  __resetPanelStoreForTests();
});
afterEach(() => {
  unslot();
  __resetPanelStoreForTests();
  vi.useRealTimers();
});

function install(r: ReturnType<typeof runner>) {
  unslot = setModPanelRunner(r);
  return r;
}

describe('panel-store: when a panel resolves', () => {
  it('resolves on mount, caches the tree, and one ok resolve leads to no other', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    expect(store().status[KEY]).toBe('loading');
    await flush();
    expect(store().status[KEY]).toBe('ok');
    expect(store().trees[KEY].seq).toBeGreaterThan(0);
    expect(store().trees[KEY].rowUpdatedAt).toBe('2026-03-01T00:00:00Z');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a panel nothing shows, and runs the wanted draw on the next mount', async () => {
    const r = install(runner());
    store().invalidate(MOD, 'hook');
    await flush();
    expect(r.resolvePanel).not.toHaveBeenCalled();
    const off = store().mountPanel(REF);
    await flush();
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    off();
    store().invalidate(MOD, 'hook');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    // A cached tree and a want: the remount draws once.
    store().mountPanel(REF);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('remounting with the same cached tree and row draws nothing; a changed row draws', async () => {
    const r = install(runner());
    const off = store().mountPanel(REF);
    await flush();
    off();
    store().mountPanel(REF)();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    useModsStore.setState({ rows: [row({ updatedAt: '2026-03-02T00:00:00Z' })] });
    store().mountPanel(REF);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('a remount over a moved row leaves a panel in error alone', async () => {
    const r = install(runner([ok(), { fault: { code: 'error', message: 'boom' } }]));
    const off = store().mountPanel(REF);
    await flush();
    store().invalidate(MOD, 'hook');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store().status[KEY]).toBe('error');
    expect(store().trees[KEY]).toBeDefined();
    off();
    useModsStore.setState({ rows: [row({ updatedAt: '2026-03-02T00:00:00Z' })] });
    store().mountPanel(REF)();
    store().mountPanel(REF);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    expect(store().status[KEY]).toBe('error');
  });

  it('coalesces: requests during a resolve make exactly one more, at least 250ms after', async () => {
    let release!: (o: SettleOutcome) => void;
    const r = install(runner());
    r.resolvePanel.mockImplementationOnce(() => new Promise((res) => (release = res)));
    store().mountPanel(REF);
    await flush();
    store().invalidate(MOD, 'hook');
    store().invalidate(MOD, 'items');
    store().invalidate(MOD, 'hook');
    release(ok());
    await flush();
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('holds a mod to its resolves a minute, drops the rest without a fault, and says so', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    await flush();
    for (let i = 0; i < MOD_RESOLVES_PER_MINUTE + 5; i++) {
      store().invalidate(MOD, 'hook');
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(r.resolvePanel).toHaveBeenCalledTimes(MOD_RESOLVES_PER_MINUTE);
    expect(store().throttled[KEY]).toBe(true);
    expect(store().status[KEY]).toBe('ok');
    expect(r.panelFault).not.toHaveBeenCalled();
    // The minute out: the pause lifts and the panel draws once.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store().throttled[KEY]).toBeUndefined();
    expect(r.resolvePanel).toHaveBeenCalledTimes(MOD_RESOLVES_PER_MINUTE + 1);
  });

  it('retries a dropped resolve once after a second, then shows an error with no message', async () => {
    const r = install(runner(['dropped', 'dropped']));
    store().mountPanel(REF);
    await flush();
    expect(store().status[KEY]).toBe('loading');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    expect(store().status[KEY]).toBe('error');
    expect(store().errors[KEY]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('in error, only a save, a settings save, a changed row or Try again draw it', async () => {
    const r = install(runner([{ fault: { code: 'error', message: 'boom' } }]));
    store().mountPanel(REF);
    await flush();
    expect(store().status[KEY]).toBe('error');
    expect(store().errors[KEY]).toBe('boom');
    for (const why of ['hook', 'items', 'enabled'] as const) store().invalidate(MOD, why);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);

    store().invalidate(MOD, 'saved');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    expect(store().status[KEY]).toBe('ok');
  });

  it('Try again draws a panel in error, and a fault never starts a draw by itself', async () => {
    const fault: SettleOutcome = { fault: { code: 'error', message: 'boom' } };
    const r = install(runner([fault, fault]));
    store().mountPanel(REF);
    await flush();
    store().retry(REF);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    expect(store().status[KEY]).toBe('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('a tree the host refuses is the mod’s counted fault and an error', async () => {
    const r = install(runner([ok(JSON.stringify({ type: 'text', text: 'Sign in again' }))]));
    store().mountPanel(REF);
    await flush();
    expect(store().status[KEY]).toBe('error');
    expect(r.panelFault).toHaveBeenCalledWith(MOD, 'water', expect.stringMatching(/^the panel: /));
    expect(store().trees[KEY]).toBeUndefined();
  });

  it('an ok resolve with nothing is empty; off forgets the panel', async () => {
    const r = install(runner([{ ok: true }]));
    store().mountPanel(REF);
    await flush();
    expect(store().status[KEY]).toBe('empty');
    r.resolvePanel.mockResolvedValueOnce('off');
    store().retry(REF);
    await vi.advanceTimersByTimeAsync(300);
    expect(store().status[KEY]).toBeUndefined();
  });

  it('a hidden tab only marks the request, and coming back draws it', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    await flush();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    store().invalidate(MOD, 'hook');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(300);
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
    vis.mockRestore();
  });

  it('waits for the runner slot, then draws', async () => {
    store().mountPanel(REF);
    expect(store().status[KEY]).toBe('loading');
    const r = install(runner());
    await flush();
    expect(r.resolvePanel).toHaveBeenCalledTimes(1);
    expect(store().status[KEY]).toBe('ok');
  });

  it('reset clears trees, statuses and atoms, and the mounted panel draws again with a runner', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    await flush();
    store().setAtom(MOD, 'big', false, { fromUser: true });
    unslot();
    store().reset();
    expect(store().trees).toEqual({});
    expect(store().status[KEY]).toBe('loading');
    expect(store().atoms).toEqual({});
    install(r);
    await flush();
    expect(r.resolvePanel).toHaveBeenCalledTimes(2);
  });

  it('forgetMod drops the mod’s trees and atoms', async () => {
    install(runner());
    store().mountPanel(REF);
    await flush();
    store().forgetMod(MOD);
    expect(store().trees[KEY]).toBeUndefined();
    expect(store().atoms[MOD]).toBeUndefined();
  });
});

describe('panel-store: atoms and the bridge', () => {
  it('seeds an unset atom from its initial without telling the mod', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    await flush();
    expect(store().atoms[MOD]).toEqual({ big: true });
    expect(r.atomChanged).not.toHaveBeenCalled();
  });

  it('the person’s input reaches the mod; the mod’s own writes do not echo', async () => {
    const r = install(runner());
    store().mountPanel(REF);
    await flush();
    expect(store().setAtom(MOD, 'big', false, { fromUser: true })).toBe(true);
    expect(r.atomChanged).toHaveBeenCalledWith(MOD, 'big', false);
    panelBridge.commitAtoms(MOD, { big: true });
    expect(store().atoms[MOD].big).toBe(true);
    expect(r.atomChanged).toHaveBeenCalledTimes(1);
  });

  it('refuses a value that does not fit its node; the person may type ordinary words', async () => {
    install(runner());
    store().mountPanel(REF);
    await flush();
    expect(store().setAtom(MOD, 'big', 'yes', { fromUser: true })).toBe(false);
    expect(store().setAtom(MOD, 'note', 'chat with mom', { fromUser: true })).toBe(true);
    expect(store().setAtom(MOD, 'note', 'sk-abcdefghijkl', { fromUser: true })).toBe(false);
    // A mod's own text meets the surface rule.
    panelBridge.commitAtoms(MOD, { note: 'Sign in again' });
    expect(store().atoms[MOD].note).toBe('chat with mom');
  });

  it('actionShown holds a press to the tree at its seq', async () => {
    install(runner());
    store().mountPanel(REF);
    await flush();
    const seq = store().trees[KEY].seq;
    expect(panelBridge.actionShown(MOD, 'water', 'add', undefined, seq)).toBe(true);
    expect(panelBridge.actionShown(MOD, 'water', 'add', '', seq)).toBe(true);
    expect(panelBridge.actionShown(MOD, 'water', 'add', 'x', seq)).toBe(false);
    expect(panelBridge.actionShown(MOD, 'water', 'add', undefined, seq + 1)).toBe(false);
    expect(panelBridge.atomKinds(MOD)).toEqual({ big: { kind: 'checkbox' }, note: { kind: 'text' } });
  });
});

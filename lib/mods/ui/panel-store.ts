import { create } from 'zustand';
import { useModsStore } from '@/lib/mods-store';
import type { PanelBridge } from '../broker-core';
import { isSafeTypedValue } from '../labels';
import { MOD_ATOMS_MAX, MOD_ATOM_TEXT_MAX, MOD_RESOLVES_PER_MINUTE, MOD_RESOLVE_MIN_MS } from '../limits';
import type { AtomValue } from '../protocol';
import type { PanelsStaleReason } from '../runtime-manager';
import { parseModManifest } from '../schema';
import type { ModPanelRef } from './open-panel';
import {
  hasModPanelRunner,
  notifyAtomChanged,
  reportPanelFault,
  resolvePanel,
  subscribeModPanelRunner,
  type PanelRunOutcome,
} from './panel-run';
import { atomValueFits, parseModTree, treeHasAction, type AtomKind, type ModNode, type ModTreeAction } from './tree';

/**
 * What the mod panels show (memory/plans/mods.md, build order 9): the last
 * good tree per panel, each panel's status, and the mod-wide atoms. Memory
 * only: nothing here is persisted, and a reload starts from nothing.
 *
 * A panel resolves only while something shows it (`mountPanel`), and only
 * when there is a reason to:
 *  - it mounts with no cached tree, or the mod's row changed since;
 *  - the runtime says the mod's panels are stale (`invalidate`, wired from
 *    the manager's onPanelsStale in components/mods/mod-host.tsx): a hook
 *    other than a resolve settled ok, a save, a settings save, a switch-on,
 *    a row that changed under this tab;
 *  - the planner's items changed (ModHost, debounced);
 *  - the tab came back after a request arrived while it was hidden;
 *  - Try again (`retry`).
 * A fault never starts one. While a panel is in `error`, only a save, a
 * settings save, a changed row or Try again draw it again, so a resolve that
 * throws cannot trip the three-fault switch-off on its own. A request for a
 * panel nothing shows waits for its next mount.
 *
 * Resolves are coalesced per panel (one in flight; requests meanwhile are one
 * more run after it), at least MOD_RESOLVE_MIN_MS apart, and at most
 * MOD_RESOLVES_PER_MINUTE a minute per mod. Over that the panel keeps its
 * last tree and says "Paused, redrawing too often" until the minute is out,
 * then draws once. None of this is the hook rate, and none of it faults.
 *
 * The cache outlives an unmount, so the card and the rail share one tree and
 * one set of atoms per panel. It goes when the mod is switched off or deleted
 * (`forgetMod`) and on `reset`, which ModHost calls when the runtime stops and
 * when the account changes.
 */

export type PanelStatus = 'loading' | 'ok' | 'error' | 'empty';

/** Why panels should draw again: the runtime's reasons, plus the planner's items. */
export type PanelInvalidation = PanelsStaleReason | 'items';

export interface CachedTree {
  /** The host's number for this tree. A press counts only while it is still the current one. */
  seq: number;
  tree: ModNode;
  actions: ModTreeAction[];
  atomKinds: Record<string, AtomKind>;
  /** The mod row's updated_at when this tree was drawn. */
  rowUpdatedAt: string;
  at: number;
}

interface PanelStore {
  trees: Record<string, CachedTree>;
  status: Record<string, PanelStatus>;
  /** The fault message, for a panel in `error` that has one. */
  errors: Record<string, string>;
  /** Mod-wide, by mod id then atom key. */
  atoms: Record<string, Record<string, AtomValue>>;
  /** How many surfaces show each panel now. */
  visible: Record<string, number>;
  /** Panels over the redraw budget for the rest of the minute. */
  throttled: Record<string, true>;
  /** Mods whose person pressed or typed past their budget, for a few seconds. */
  slowed: Record<string, true>;

  /** A surface shows the panel. Returns the unmount. */
  mountPanel: (ref: ModPanelRef) => () => void;
  /**
   * Sets an atom when the value fits the node that shows it. `fromUser`: the
   * person's own input, which the mod hears as atom.changed. A mod's own
   * writes (the bridge's commitAtoms) are never echoed back to it.
   */
  setAtom: (modId: string, key: string, value: AtomValue, opts: { fromUser: boolean }) => boolean;
  /** The mod's panels should draw again. */
  invalidate: (modId: string, why?: PanelInvalidation) => void;
  /** Try again: draws the panel whatever its status. */
  retry: (ref: ModPanelRef) => void;
  /** "Slow down a little", for a few seconds. */
  slowDown: (modId: string) => void;
  /** The mod went off or away: its trees, statuses and atoms go. */
  forgetMod: (modId: string) => void;
  /** Everything but the mount counts, which belong to the surfaces still mounted. */
  reset: () => void;
}

const SLOWED_MS = 5000;
const DROPPED_RETRY_MS = 1000;
const MINUTE_MS = 60_000;

type Want = 'auto' | 'force';

/** One panel's run bookkeeping, outside React's state: nothing draws from it. */
interface KeyRun {
  inFlight: boolean;
  /** A resolve is wanted: `force` passes a panel in error, `auto` does not. */
  want: Want | null;
  lastRunAt: number;
  /** The tab was hidden when it was wanted. */
  pendingHidden: boolean;
  /** `dropped` answers in a row: the first retries once, the second is an error. */
  drops: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const runs = new Map<string, KeyRun>();
/** Resolve start times per mod, inside the last minute. */
const budgets = new Map<string, number[]>();
const liftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const slowTimers = new Map<string, ReturnType<typeof setTimeout>>();
let seqCounter = 0;
/** Bumped by reset, so an answer to a resolve from before it lands nowhere. */
let generation = 0;

const now = () => Date.now();
const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export const panelKey = (ref: ModPanelRef) => `${ref.modId}:${ref.panelId}`;
/** Mod ids are UUIDs and panel ids idents, so the first colon splits them. */
function refOf(key: string): ModPanelRef {
  const at = key.indexOf(':');
  return { modId: key.slice(0, at), panelId: key.slice(at + 1) };
}
const modOf = (key: string) => refOf(key).modId;

const rowOf = (modId: string) => useModsStore.getState().rows.find((r) => r.id === modId && r.kind === 'mod') ?? null;

function runOf(key: string): KeyRun {
  let r = runs.get(key);
  if (!r) {
    r = { inFlight: false, want: null, lastRunAt: -Infinity, pendingHidden: false, drops: 0, timer: null };
    runs.set(key, r);
  }
  return r;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(rec, key)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

/**
 * What the person typed or picked, against the node they used. Their own text
 * is held to isSafeTypedValue, not the surface rule a mod's text meets:
 * "chat with mom" is theirs to type, a pasted key is not the mod's to read.
 */
export function typedValueFits(kind: AtomKind | undefined, v: AtomValue): boolean {
  if (kind?.kind !== 'text') return atomValueFits(kind, v);
  return typeof v === 'string' && v.length <= MOD_ATOM_TEXT_MAX && isSafeTypedValue(v);
}

/** The atom-bound nodes' starting values, by atom. */
function initialsOf(tree: ModNode): Record<string, AtomValue> {
  const out: Record<string, AtomValue> = {};
  const stack: ModNode[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ('children' in n) stack.push(...n.children);
    else if ((n.type === 'checkbox' || n.type === 'input' || n.type === 'select') && n.initial !== undefined) {
      out[n.atom] = n.initial;
    }
  }
  return out;
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  trees: {},
  status: {},
  errors: {},
  atoms: {},
  visible: {},
  throttled: {},
  slowed: {},

  mountPanel(ref) {
    const key = panelKey(ref);
    set((s) => ({ visible: { ...s.visible, [key]: (s.visible[key] ?? 0) + 1 } }));
    watchVisibility();
    const cached = get().trees[key];
    const row = rowOf(ref.modId);
    // A moved row (a $.store write moves it too) draws again, but never a panel
    // in error: only a save, a settings save, a change or Try again may.
    if (cached && row && cached.rowUpdatedAt !== row.updatedAt) want(key, get().status[key] === 'error' ? 'auto' : 'force');
    else if (!cached && get().status[key] !== 'empty') want(key, 'auto');
    else pump(key);
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      set((s) => {
        const n = (s.visible[key] ?? 0) - 1;
        return { visible: n > 0 ? { ...s.visible, [key]: n } : without(s.visible, key) };
      });
    };
  },

  setAtom(modId, key, value, { fromUser }) {
    if (!(fromUser ? typedValueFits : atomValueFits)(atomKindsOf(modId)[key], value)) return false;
    const current = get().atoms[modId] ?? {};
    if (!Object.hasOwn(current, key) && Object.keys(current).length >= MOD_ATOMS_MAX) return false;
    set((s) => ({ atoms: { ...s.atoms, [modId]: { ...(s.atoms[modId] ?? {}), [key]: value } } }));
    if (fromUser) void notifyAtomChanged(modId, key, value);
    return true;
  },

  invalidate(modId, why = 'hook') {
    // A save, a settings save or a row that moved is new code or new values,
    // so it may draw a panel in error again. Nothing else may.
    const force = why === 'saved' || why === 'settings' || why === 'changed';
    for (const key of keysOfMod(modId)) {
      if (force) runOf(key).drops = 0;
      want(key, force ? 'force' : 'auto');
    }
  },

  retry(ref) {
    const key = panelKey(ref);
    runOf(key).drops = 0;
    want(key, 'force');
  },

  slowDown(modId) {
    set((s) => (s.slowed[modId] ? s : { slowed: { ...s.slowed, [modId]: true } }));
    const before = slowTimers.get(modId);
    if (before) clearTimeout(before);
    slowTimers.set(
      modId,
      setTimeout(() => {
        slowTimers.delete(modId);
        set((s) => ({ slowed: without(s.slowed, modId) }));
      }, SLOWED_MS)
    );
  },

  forgetMod(modId) {
    const keys = keysOfMod(modId);
    for (const key of keys) {
      const r = runs.get(key);
      if (r?.timer) clearTimeout(r.timer);
      runs.delete(key);
    }
    budgets.delete(modId);
    const lift = liftTimers.get(modId);
    if (lift) clearTimeout(lift);
    liftTimers.delete(modId);
    set((s) => {
      const drop = <T>(rec: Record<string, T>) => keys.reduce((next, k) => without(next, k), rec);
      return {
        trees: drop(s.trees),
        status: drop(s.status),
        errors: drop(s.errors),
        throttled: drop(s.throttled),
        atoms: without(s.atoms, modId),
      };
    });
  },

  reset() {
    generation++;
    for (const r of runs.values()) if (r.timer) clearTimeout(r.timer);
    runs.clear();
    budgets.clear();
    for (const t of [...liftTimers.values(), ...slowTimers.values()]) clearTimeout(t);
    liftTimers.clear();
    slowTimers.clear();
    set({ trees: {}, status: {}, errors: {}, atoms: {}, throttled: {}, slowed: {} });
    // What is still mounted draws again once there is a runtime to ask.
    for (const key of Object.keys(get().visible)) want(key, 'auto');
  },
}));

const state = () => usePanelStore.getState();

function setStatus(key: string, status: PanelStatus): void {
  usePanelStore.setState((s) => (s.status[key] === status ? s : { status: { ...s.status, [key]: status } }));
}

function setError(key: string, message: string | null): void {
  usePanelStore.setState((s) => ({
    status: { ...s.status, [key]: 'error' },
    errors: message ? { ...s.errors, [key]: message } : without(s.errors, key),
  }));
}

function keysOfMod(modId: string): string[] {
  const s = state();
  const keys = new Set([...runs.keys(), ...Object.keys(s.visible), ...Object.keys(s.trees), ...Object.keys(s.status)]);
  return [...keys].filter((k) => modOf(k) === modId);
}

/** Asks for a draw. An automatic one leaves a panel in error alone. */
function want(key: string, w: Want): void {
  if (w === 'auto' && state().status[key] === 'error') return;
  const r = runOf(key);
  r.want = r.want === 'force' ? 'force' : w;
  pump(key);
}

/** Runs a wanted draw when everything allows it, or leaves it wanted for whatever will. */
function pump(key: string): void {
  const r = runs.get(key);
  if (!r?.want) return;
  if ((state().visible[key] ?? 0) <= 0) return; // the next mount runs it
  if (tabHidden()) {
    r.pendingHidden = true;
    return;
  }
  if (!hasModPanelRunner()) {
    // The slot fills once the planner settles, and subscribeModPanelRunner pumps then.
    if (!state().trees[key]) setStatus(key, 'loading');
    return;
  }
  if (r.inFlight || r.timer) return; // the settle, or the booked run, pumps again
  const wait = r.lastRunAt + MOD_RESOLVE_MIN_MS - now();
  if (wait > 0) {
    r.timer = setTimeout(() => {
      r.timer = null;
      pump(key);
    }, wait);
    return;
  }
  if (!takeBudget(key)) return;
  const w = r.want;
  r.want = null;
  void start(key, r, w);
}

/** The mod's redraw budget. Over it the panel says so until the minute is out, then draws once. */
function takeBudget(key: string): boolean {
  const modId = modOf(key);
  const t = now();
  const times = (budgets.get(modId) ?? []).filter((at) => t - at < MINUTE_MS);
  budgets.set(modId, times);
  if (times.length < MOD_RESOLVES_PER_MINUTE) {
    times.push(t);
    return true;
  }
  usePanelStore.setState((s) => (s.throttled[key] ? s : { throttled: { ...s.throttled, [key]: true } }));
  if (!liftTimers.has(modId)) {
    liftTimers.set(
      modId,
      setTimeout(() => {
        liftTimers.delete(modId);
        const lifted = Object.keys(state().throttled).filter((k) => modOf(k) === modId);
        usePanelStore.setState((s) => ({ throttled: lifted.reduce((next, k) => without(next, k), s.throttled) }));
        for (const k of lifted) pump(k);
      }, times[0] + MINUTE_MS - t)
    );
  }
  return false;
}

async function start(key: string, r: KeyRun, w: Want): Promise<void> {
  r.inFlight = true;
  r.lastRunAt = now();
  const gen = generation;
  const ref = refOf(key);
  // Try again on an error shows the wait; otherwise the last good tree stays up meanwhile.
  if (!state().trees[key] || (w === 'force' && state().status[key] === 'error')) setStatus(key, 'loading');
  let outcome: PanelRunOutcome;
  try {
    outcome = await resolvePanel(ref);
  } catch (err) {
    console.error('[mods] panel resolve failed:', err);
    outcome = 'dropped';
  }
  if (gen !== generation) return;
  r.inFlight = false;
  settle(key, ref, r, outcome);
  // A fault is not a reason to draw again: only a forced want outlives one.
  if (state().status[key] === 'error' && r.want === 'auto') r.want = null;
  pump(key);
}

function settle(key: string, ref: ModPanelRef, r: KeyRun, o: PanelRunOutcome): void {
  if (o === 'unavailable') {
    // The slot emptied under the resolve: wanted again when it fills.
    r.want ??= 'auto';
    if (!state().trees[key]) setStatus(key, 'loading');
    return;
  }
  if (o === 'dropped') {
    if (r.drops === 0) {
      r.drops = 1;
      r.timer = setTimeout(() => {
        r.timer = null;
        r.want ??= 'force';
        pump(key);
      }, DROPPED_RETRY_MS);
      return;
    }
    r.drops = 0;
    setError(key, null);
    return;
  }
  r.drops = 0;
  if (o === 'off') {
    // The surface reads off from the mod's row; nothing of this panel stays.
    usePanelStore.setState((s) => ({
      trees: without(s.trees, key),
      status: without(s.status, key),
      errors: without(s.errors, key),
    }));
    return;
  }
  if ('fault' in o) {
    setError(key, o.fault.message);
    return;
  }
  if (o.resultJson === undefined) {
    usePanelStore.setState((s) => ({
      trees: without(s.trees, key),
      status: { ...s.status, [key]: 'empty' },
      errors: without(s.errors, key),
    }));
    return;
  }
  accept(key, ref, o.resultJson);
}

/** A resolve's tree, checked by the host before anything draws it. A refusal is the mod's counted fault. */
function accept(key: string, ref: ModPanelRef, json: string): void {
  const row = rowOf(ref.modId);
  const manifest = row ? parseModManifest(row) : null;
  if (!row || !manifest) {
    usePanelStore.setState((s) => ({ trees: without(s.trees, key), status: without(s.status, key) }));
    return;
  }
  const parsed = parseModTree(json, { uses: manifest.uses });
  if (!parsed.ok) {
    reportPanelFault(ref, parsed.message);
    setError(key, parsed.message);
    return;
  }
  const entry: CachedTree = {
    seq: ++seqCounter,
    tree: parsed.tree,
    actions: parsed.actions,
    atomKinds: parsed.atoms,
    rowUpdatedAt: row.updatedAt,
    at: now(),
  };
  // An unset atom starts at its node's initial value, in host state only: no atom.changed.
  const initials = initialsOf(parsed.tree);
  usePanelStore.setState((s) => {
    const current = s.atoms[ref.modId] ?? {};
    let atoms = current;
    for (const [k, v] of Object.entries(initials)) {
      if (Object.hasOwn(atoms, k) || Object.keys(atoms).length >= MOD_ATOMS_MAX) continue;
      if (atoms === current) atoms = { ...current };
      atoms[k] = v;
    }
    return {
      trees: { ...s.trees, [key]: entry },
      status: { ...s.status, [key]: 'ok' },
      errors: without(s.errors, key),
      ...(atoms !== current && { atoms: { ...s.atoms, [ref.modId]: atoms } }),
    };
  });
}

/** What each atom the mod's cached trees show accepts. */
function atomKindsOf(modId: string): Record<string, AtomKind> {
  const out: Record<string, AtomKind> = {};
  for (const [key, entry] of Object.entries(state().trees)) {
    if (modOf(key) === modId) Object.assign(out, entry.atomKinds);
  }
  return out;
}

/** The mod's atoms now, a copy. */
export function atomsOf(modId: string): Record<string, AtomValue> {
  return { ...(state().atoms[modId] ?? {}) };
}

/** Whether any surface shows a panel now (ModHost's items subscription waits on this). */
export function anyPanelVisible(): boolean {
  return Object.keys(state().visible).length > 0;
}

/**
 * The runtime's view of the panels (lib/mods/broker-core.ts PanelBridge),
 * bound by ModHost. A press counts only against the tree the person saw.
 */
export const panelBridge: PanelBridge = {
  atoms: atomsOf,
  atomKinds: atomKindsOf,
  actionShown(modId, panelId, action, arg, seq) {
    const entry = state().trees[panelKey({ modId, panelId })];
    return !!entry && entry.seq === seq && treeHasAction(entry.actions, action, arg);
  },
  commitAtoms(modId, values) {
    for (const [key, value] of Object.entries(values)) state().setAtom(modId, key, value, { fromUser: false });
  },
};

// A runtime arriving (the planner settled, a mod went on) draws what waited for it.
subscribeModPanelRunner(() => {
  for (const key of [...runs.keys()]) pump(key);
});

let watching = false;

/** The tab coming back draws what was wanted while it was hidden. Installed once, on the first mount. */
function watchVisibility(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (tabHidden()) return;
    for (const [key, r] of [...runs]) {
      if (!r.pendingHidden) continue;
      r.pendingHidden = false;
      pump(key);
    }
  });
}

/** Test-only: no trees, no mounts, no bookkeeping. */
export function __resetPanelStoreForTests(): void {
  state().reset();
  usePanelStore.setState({ visible: {} });
  runs.clear();
  seqCounter = 0;
}

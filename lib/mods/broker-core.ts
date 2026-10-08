import { z } from 'zod';
import { PrioritySchema, TimeBucketSchema } from '@dsul/types';
import { sameContainerName } from '@/lib/container-registry';
import { milestoneItemIds } from '@/lib/goals';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { isRecurring } from '@/lib/recurrence';
import { wantsDoingOn } from '@/lib/reminders/due';
import { clockBucket } from '@/lib/recipes/clock';
import { stakeEditRefusalWith, stakeRefusalWith, type StakeFacts } from '@/lib/recipes/stake-rule';
import type { RecipeVerbStep } from '@/lib/recipes/validate-core';
import { isDoneOn, isSkippedOn, occurrenceOn, VERB_GATES, type VerbContext } from '@/lib/verb-gates';
import type { Goal, Item, Routine, Season } from '@/lib/planner-types';
import {
  MOD_CALLS_PER_HOOK,
  MOD_QUERY_LIMIT,
  MOD_REPLY_ERROR_MAX,
  MOD_SCAN_PER_HOOK,
  MOD_STORE_VALUE_MAX_BYTES,
  MOD_TIMERS_PENDING,
  MOD_TIMER_MAX_MS,
  MOD_TIMER_MIN_MS,
  MOD_TOASTS_PER_HOOK,
  MOD_TOASTS_PER_MINUTE,
  MOD_WRITES_PER_HOOK,
  MOD_ATOMS_MAX,
} from './limits';
import {
  AtomValueSchema,
  ModIdentSchema,
  fault,
  type AtomValue,
  type Fault,
  type ModEventKind,
  type ModItem,
  type ModMethod,
} from './protocol';
import {
  ApplyLookStepSchema,
  GotoStepSchema,
  ModSlugSchema,
  ModTitleSchema,
  ModToastTextSchema,
  RECIPE_VERBS,
  SetThemeStepSchema,
  type ModManifest,
  type ModSettingValue,
  type ModUse,
} from './schema';
import { jsonbTextBytes } from './store-bytes';
import { atomValueFits, type AtomKind } from './ui/tree';

export type { AtomKind, AtomValue };

/**
 * The broker's rules, pure (memory/plans/mods.md, "Safety"; build order 8).
 * Every `$` call a mod makes lands here, and this is the wall: an allow-listed
 * method table, the manifest's `uses`, the context a method needs, Zod-parsed
 * arguments, projected results, and the per-hook caps. lib/mods/broker.ts
 * binds BrokerEnv to the real stores and applies what a hook held.
 *
 * Identity never comes from the frame. A call is answered only when its
 * (modId, gen, hookId) is the one live hook the runtime manager started, and
 * the HookState that answers it (its mod, `uses` and event kind) is the
 * manager's own record.
 *
 * Nothing a call does reaches the planner. Writes, UI effects, store writes
 * and timers are HELD on the hook and applied only when it settles ok, so a
 * faulted hook changes nothing. Reads see the live planner and, for the
 * store, the hook's own overlay over the snapshot loaded with the code.
 *
 * Refusals the mod can handle (`{ok: false, reason}`) are replies, not
 * faults: a 26th write (`cap`), a store value over 8KB (`too_big`), a
 * second toast (`rate`). A rejected call becomes a fault only if the mod
 * leaves it uncaught.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An overlay entry that deletes its key. */
export const DELETE: unique symbol = Symbol('delete');

/** Everything the broker reads, injected so the rules are testable without the stores. */
export interface PlannerView {
  items: readonly Item[];
  projects: readonly { name: string }[];
  routines: readonly Routine[];
  seasons: readonly Season[];
  goals: readonly Goal[];
  userTimezone: string;
}

export type ThemeStep = z.infer<typeof SetThemeStepSchema>;
export type LookStep = z.infer<typeof ApplyLookStepSchema>;
export type GotoStep = z.infer<typeof GotoStepSchema>;

export interface BrokerEnv {
  planner(): PlannerView;
  stakeFacts(): StakeFacts;
  /** lib/proposal.ts canCreateType against the hydrated custom types: never a habit. */
  canCreateType(type: string): boolean;
  /** The user's own today and hh:mm, now. */
  todayAndTime(): { today: string; hhmm: string };
  /** Whether a theme or Look ref names one this mode can take (lib/recipes/validate.ts's checks). */
  lookRefOk(step: ThemeStep | LookStep): boolean;
  log(level: 'info' | 'warn', slug: string, text: string): void;
}

export type RecipeVerb = (typeof RECIPE_VERBS)[number];

export type HeldWrite =
  | { kind: 'create'; type: string; title: string; project?: string; timeBucket?: z.infer<typeof TimeBucketSchema> }
  | {
      kind: 'edit';
      id: string;
      patch: { title?: string; priority?: z.infer<typeof PrioritySchema>; project?: string | null };
    }
  | { kind: 'verb'; id: string; verb: RecipeVerb; inDays?: number };

export type HeldUi =
  | { kind: 'toast'; text: string }
  | { kind: 'openItem'; id: string }
  | { kind: 'step'; step: GotoStep | { do: 'organize' } | ThemeStep | LookStep }
  /** One of the mod's own panels, through the panel router (lib/mods/ui/open-panel.ts). */
  | { kind: 'openPanel'; panelId: string };

export interface HeldTimer {
  ms: number;
  name: string;
}

export interface HookState {
  modId: string;
  gen: number;
  hookId: string;
  slug: string;
  hookKind: ModEventKind;
  /** `undo` only on item.uncompleted raised by ⌘Z; such a hook is read-only for items and Looks. */
  origin: 'user' | 'undo' | null;
  manifest: ModManifest;
  /** The store as loaded with the code plus every committed hook since. Read-only here. */
  snapshot: Readonly<Record<string, Json>>;
  /** Timers this mod already has scheduled. */
  pendingTimers: number;
  /** Toasts this mod showed in the last minute. */
  toastsLastMinute: number;
  /** The mod's atoms (panel UI state) when the hook started. Read-only here. */
  atoms: Readonly<Record<string, AtomValue>>;
  /** What each atom the mod's cached trees show accepts, by key. */
  atomKinds: Readonly<Record<string, AtomKind>>;
  /** The person's values for the mod's settings, parsed from the snapshot's `@settings` at hook start. */
  settings: Readonly<Record<string, ModSettingValue>>;

  calls: number;
  /** Items this hook's queries have looked at, against MOD_SCAN_PER_HOOK. */
  scanned: number;
  logs: number;
  toasts: number;
  /** Writes refused for the cap, logged as `stop:cap`. */
  stopped: number;
  writes: HeldWrite[];
  ui: HeldUi[];
  storeOverlay: Map<string, Json | typeof DELETE>;
  /** `$.atom.set` writes, committed (never as the person's) only when the hook settles ok. */
  atomOverlay: Map<string, AtomValue>;
  timers: HeldTimer[];
  /** Set when the broker ended the hook (too many calls): it applies nothing. */
  aborted: Fault | null;
}

export function createHookState(
  init: Pick<
    HookState,
    'modId' | 'gen' | 'hookId' | 'slug' | 'hookKind' | 'origin' | 'manifest' | 'snapshot' | 'pendingTimers' | 'toastsLastMinute'
  > &
    Partial<Pick<HookState, 'atoms' | 'atomKinds' | 'settings'>>
): HookState {
  return {
    atoms: {},
    atomKinds: {},
    settings: {},
    ...init,
    calls: 0,
    scanned: 0,
    logs: 0,
    toasts: 0,
    stopped: 0,
    writes: [],
    ui: [],
    storeOverlay: new Map(),
    atomOverlay: new Map(),
    timers: [],
    aborted: null,
  };
}

/**
 * The panels' state as the runtime reads and writes it (lib/mods/ui/panel-store.ts,
 * bound by components/mods/mod-host.tsx). Injected, so neither the broker nor
 * the runtime manager imports a store.
 */
export interface PanelBridge {
  /** The mod's atoms now. */
  atoms(modId: string): Record<string, AtomValue>;
  /** What each atom the mod's cached trees show accepts. */
  atomKinds(modId: string): Record<string, AtomKind>;
  /** Whether the panel's cached tree is still at `seq` and holds a button with (action, arg). */
  actionShown(modId: string, panelId: string, action: string, arg: string | undefined, seq: number): boolean;
  /** A hook's `$.atom.set` writes, committed as the mod's own: they fire no atom.changed. */
  commitAtoms(modId: string, values: Record<string, AtomValue>): void;
}

export type CallAnswer = { ok: true; value: Json } | { ok: false; error: string };

/** The call as the frame relayed it. Only the triple and the method's own text are read. */
export interface CallMessage {
  modId: string;
  gen: number;
  hookId: string;
  method: ModMethod;
  argsJson: string;
}

/** The live hook's triple, the only one whose calls are answered. */
export function isLiveCall(live: HookState | null, msg: Pick<CallMessage, 'modId' | 'gen' | 'hookId'>): live is HookState {
  return !!live && live.modId === msg.modId && live.gen === msg.gen && live.hookId === msg.hookId;
}

/* ── projections ───────────────────────────────────────────────────────── */

const NAME_MAX = 60;

type OpenContext = Parameters<typeof wantsDoingOn>[2];

/** What `open` is judged against, built once per call rather than once per item. */
function openContext(view: PlannerView): OpenContext {
  return { userTimezone: view.userTimezone, routines: [...view.routines], seasons: [...view.seasons] };
}

/** What a mod with items:read sees of an item: never the completion record, the habit counter, notes or the AI fields. */
export function projectItem(item: Item, today: string, view: PlannerView, ctx = openContext(view)): ModItem {
  const f = item as { project?: string; priority?: string; timeBucket?: string; startDate?: string };
  return {
    id: item.id,
    type: itemTypeName(item),
    title: item.title,
    project: f.project ?? null,
    priority: f.priority ?? null,
    timeBucket: f.timeBucket ?? null,
    startDate: f.startDate ?? null,
    recurring: item.type === 'habit' || isRecurring(item as { repeatFrequency?: string }),
    done: isDoneOn(item, today),
    skipped: isSkippedOn(item, today),
    open: wantsDoingOn(item, today, ctx),
  };
}

/** The context the verbs' gates read, for the real today. */
function verbContext(view: PlannerView, today: string): Omit<VerbContext, 'occurrence'> {
  return {
    dateStr: today,
    date: new Date(),
    todayStr: today,
    tz: view.userTimezone,
    milestoneIds: milestoneItemIds([...view.goals]),
  };
}

/** VERB_GATES with today's context and the item's own occurrence, as the recipe engine asks it. */
export function verbEligible(view: PlannerView, today: string, item: Item, verb: RecipeVerb): boolean {
  const base = verbContext(view, today);
  return VERB_GATES[verb](item, { ...base, occurrence: occurrenceOn(item, today, today, base.tz) });
}

/** The project's own spelling, when one by that name (case folded) exists. */
export function findProject(view: PlannerView, name: string): string | undefined {
  return view.projects.find((p) => sameContainerName('project', p.name, name))?.name;
}

/* ── argument schemas ──────────────────────────────────────────────────── */

const NoArgs = z.union([z.null(), z.object({}).strict()]);
const Id = z.string().uuid();
const ProjectName = z.string().min(1).max(NAME_MAX);
/** Keys starting with `@` are the host's (`@settings`): a mod can neither read nor write one through `$.store`. */
const StoreKey = z
  .string()
  .min(1)
  .max(64)
  .refine((k) => !/[\u0000-\u001f\u007f-\u009f]/.test(k), { message: 'No control characters in a key.' })
  .refine((k) => !k.startsWith('@'), { message: 'Keys starting with @ are the app\'s.' });
const Verb = z.enum(RECIPE_VERBS);

/**
 * Each method's arguments, parsed strict at every call. Exported so the
 * prompt "Write with AI" sends (make-prompt.ts, server-side) prints them as
 * they are.
 */
export const METHOD_ARGS = {
  today: NoArgs,
  log: z.object({ level: z.enum(['info', 'warn']), text: z.string().max(500) }).strict(),
  after: z
    .object({
      ms: z.number().int().min(MOD_TIMER_MIN_MS).max(MOD_TIMER_MAX_MS),
      name: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
    })
    .strict(),
  'items.get': z.object({ id: Id }).strict(),
  'items.query': z
    .object({
      type: ModSlugSchema.optional(),
      project: ProjectName.optional(),
      open: z.boolean().optional(),
      done: z.boolean().optional(),
      limit: z.number().int().min(1).max(MOD_QUERY_LIMIT).optional(),
    })
    .strict()
    .nullable(),
  'containers.list': NoArgs,
  'verbs.eligible': z.object({ id: Id, verb: Verb }).strict(),
  'items.create': z
    .object({
      type: ModSlugSchema,
      title: ModTitleSchema,
      project: ProjectName.optional(),
      timeBucket: TimeBucketSchema.optional(),
    })
    .strict(),
  // No notes and no dates (build order 8): notes would need the AI context's
  // "untrusted" marker, and a date write is a move verb's job.
  'items.edit': z
    .object({
      id: Id,
      title: ModTitleSchema.optional(),
      priority: PrioritySchema.optional(),
      project: ProjectName.nullable().optional(),
    })
    .strict()
    .refine((a) => a.title !== undefined || a.priority !== undefined || a.project !== undefined, {
      message: 'Say what to change.',
    }),
  'verbs.run': z
    .object({ id: Id, verb: Verb, inDays: z.number().int().min(0).max(365).optional() })
    .strict()
    .refine((a) => (a.verb === 'reschedule') === (a.inDays !== undefined), {
      message: 'inDays goes with reschedule, and only with it.',
    }),
  'store.get': z.object({ key: StoreKey }).strict(),
  'store.keys': NoArgs,
  'store.set': z.object({ key: StoreKey, value: z.unknown() }).strict(),
  'store.delete': z.object({ key: StoreKey }).strict(),
  'ui.toast': z.object({ text: ModToastTextSchema }).strict(),
  'ui.openItem': z.object({ id: Id }).strict(),
  'nav.go': GotoStepSchema.omit({ do: true }),
  'nav.organize': NoArgs,
  'look.set': z.union([
    z
      .object({ light: SetThemeStepSchema.shape.theme.optional(), dark: SetThemeStepSchema.shape.theme.optional() })
      .strict()
      .refine((a) => a.light !== undefined || a.dark !== undefined, { message: 'Name a theme.' }),
    z.object({ look: ApplyLookStepSchema.shape.look }).strict(),
  ]),
  'ui.open': z.object({ panelId: ModIdentSchema }).strict(),
  'atom.get': z.union([NoArgs, z.object({ key: ModIdentSchema }).strict()]),
  'atom.set': z.object({ key: ModIdentSchema, value: AtomValueSchema }).strict(),
  'settings.get': NoArgs,
} satisfies Record<ModMethod, z.ZodTypeAny>;

type Args<M extends ModMethod> = z.infer<(typeof METHOD_ARGS)[M]>;

/** Which `uses` each method needs. `today`, `log` and `after` need none. */
export const METHOD_USES: Readonly<Record<ModMethod, ModUse | null>> = {
  today: null,
  log: null,
  after: null,
  'items.get': 'items:read',
  'items.query': 'items:read',
  'containers.list': 'items:read',
  'verbs.eligible': 'items:read',
  'items.create': 'items:write',
  'items.edit': 'items:write',
  'verbs.run': 'items:write',
  'store.get': 'storage',
  'store.keys': 'storage',
  'store.set': 'storage',
  'store.delete': 'storage',
  'ui.toast': 'ui',
  'ui.openItem': 'ui',
  'nav.go': 'ui',
  'nav.organize': 'ui',
  'look.set': 'look',
  'ui.open': 'ui',
  'atom.get': 'ui',
  'atom.set': 'ui',
  'settings.get': null,
};

/**
 * Methods that move what the person is looking at: only when they acted, by
 * running a command or pressing a panel's button. Not atom.changed:
 * committing a field is not a request to move.
 */
export const USER_ACTED: ReadonlySet<ModMethod> = new Set(['ui.open', 'ui.openItem', 'nav.go', 'nav.organize', 'look.set']);
const ACTING_HOOKS: ReadonlySet<ModEventKind> = new Set(['command', 'ui.action']);
/**
 * What a panel's resolve may call: reads only. An allow-list, so a method
 * added later is refused while drawing until it is put here.
 */
export const RESOLVE_ALLOWED: ReadonlySet<ModMethod> = new Set([
  'today',
  'log',
  'items.get',
  'items.query',
  'containers.list',
  'verbs.eligible',
  'store.get',
  'store.keys',
  'atom.get',
  'settings.get',
]);
/** Writes an undo-raised hook may not make: any item write would wipe redo. */
const NOT_DURING_UNDO: ReadonlySet<ModMethod> = new Set(['items.create', 'items.edit', 'verbs.run', 'look.set']);

/**
 * The store's total as jsonb text, kept under 061's 65,536 with room for
 * what the count cannot see (./store-bytes.ts).
 */
export const MOD_STORE_TOTAL_MAX_BYTES = 60_000;
const LOGS_PER_HOOK = 20;

/* ── the call ──────────────────────────────────────────────────────────── */

const refused = (reason: string): CallAnswer => ({ ok: true, value: { ok: false, reason } });
const accepted: CallAnswer = { ok: true, value: { ok: true } };
const error = (message: string): CallAnswer => ({ ok: false, error: message.slice(0, MOD_REPLY_ERROR_MAX) });

/** The store as this hook sees it: the overlay over the snapshot. */
function storeView(hook: HookState): Record<string, Json> {
  const out: Record<string, Json> = { ...hook.snapshot };
  for (const [k, v] of hook.storeOverlay) {
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * Answers one call, or null when it is not the live hook's (dropped, never
 * answered). Mutates `live`: counts, held effects, the overlay.
 */
export function brokerCall(env: BrokerEnv, live: HookState | null, msg: CallMessage): CallAnswer | null {
  if (!isLiveCall(live, msg)) return null;
  const hook = live;
  if (hook.aborted) return error('the hook was stopped');

  // 1. Count it. The broker's count is the one that holds; the worker's is a courtesy.
  hook.calls++;
  if (hook.calls > MOD_CALLS_PER_HOOK) {
    hook.aborted = fault('calls', `more than ${MOD_CALLS_PER_HOOK} calls in one hook`);
    return error('too many calls');
  }

  // 2. The manifest's uses.
  const use = METHOD_USES[msg.method];
  if (use && !hook.manifest.uses.includes(use)) return error(`needs "${use}" in manifest.uses`);

  // 3. The context.
  if (USER_ACTED.has(msg.method) && !ACTING_HOOKS.has(hook.hookKind)) return error('only when the person acted');
  if (hook.hookKind === 'ui.resolve' && !RESOLVE_ALLOWED.has(msg.method)) return error('read-only while drawing a panel');
  if (hook.origin === 'undo' && NOT_DURING_UNDO.has(msg.method)) return error('not during undo');

  // 4. The arguments.
  let raw: unknown;
  try {
    raw = JSON.parse(msg.argsJson);
  } catch {
    return error('arguments are not JSON');
  }
  const parsed = METHOD_ARGS[msg.method].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return error(`bad arguments${issue ? `: ${issue.path.join('.') || 'value'} ${issue.message}` : ''}`);
  }

  // 5. The method.
  return run(env, hook, msg.method, parsed.data);
}

function run(env: BrokerEnv, hook: HookState, method: ModMethod, a: unknown): CallAnswer {
  switch (method) {
    case 'today': {
      const { today, hhmm } = env.todayAndTime();
      return { ok: true, value: { date: today, time: hhmm, bucket: clockBucket(hhmm) } };
    }
    case 'log': {
      const { level, text } = a as Args<'log'>;
      if (++hook.logs > LOGS_PER_HOOK) return error('too many log lines');
      env.log(level, hook.slug, text);
      return { ok: true, value: null };
    }
    case 'after': {
      const { ms, name } = a as Args<'after'>;
      if (hook.pendingTimers + hook.timers.length >= MOD_TIMERS_PENDING) return refused('too_many');
      hook.timers.push({ ms, name: name ?? 'timer' });
      return accepted;
    }
    case 'items.get': {
      const view = env.planner();
      const item = view.items.find((i) => i.id === (a as Args<'items.get'>).id);
      return { ok: true, value: item ? projectItem(item, env.todayAndTime().today, view) : null };
    }
    case 'items.query': {
      const q = (a as Args<'items.query'>) ?? {};
      const view = env.planner();
      const { today } = env.todayAndTime();
      const ctx = openContext(view);
      const out: ModItem[] = [];
      const limit = q.limit ?? MOD_QUERY_LIMIT;
      for (const item of view.items) {
        if (out.length >= limit) break;
        // Counted per item looked at, not per match, so a query that matches
        // nothing still costs what it scanned.
        if (++hook.scanned > MOD_SCAN_PER_HOOK) return error('too many items looked at in one hook');
        if (q.type && itemTypeName(item) !== q.type) continue;
        if (q.project) {
          const project = (item as { project?: string }).project;
          if (!project || !sameContainerName('project', project, q.project)) continue;
        }
        // The cheap test first: `open` is the costly one.
        if (q.done !== undefined && isDoneOn(item, today) !== q.done) continue;
        const p = projectItem(item, today, view, ctx);
        if (q.open !== undefined && p.open !== q.open) continue;
        out.push(p);
      }
      return { ok: true, value: out };
    }
    case 'containers.list': {
      const view = env.planner();
      const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name.slice(0, NAME_MAX));
      return {
        ok: true,
        value: {
          projects: names(view.projects),
          routines: names(view.routines),
          seasons: names(view.seasons),
          goals: names(view.goals),
        },
      };
    }
    case 'verbs.eligible': {
      const { id, verb } = a as Args<'verbs.eligible'>;
      const view = env.planner();
      const item = view.items.find((i) => i.id === id);
      return { ok: true, value: !!item && verbEligible(view, env.todayAndTime().today, item, verb) };
    }
    case 'items.create': {
      const c = a as Args<'items.create'>;
      if (hook.writes.length >= MOD_WRITES_PER_HOOK) return capped(hook);
      if (!env.canCreateType(c.type)) return refused('type');
      if (stakeRefusalWith({ do: 'create', type: c.type, title: c.title }, undefined, env.stakeFacts())) {
        return refused('stake');
      }
      let project: string | undefined;
      if (c.project) {
        project = findProject(env.planner(), c.project);
        if (!project) return refused('no-project');
      }
      hook.writes.push({
        kind: 'create',
        type: c.type,
        title: c.title,
        ...(project && { project }),
        ...(c.timeBucket && { timeBucket: c.timeBucket }),
      });
      return accepted;
    }
    case 'items.edit': {
      const e = a as Args<'items.edit'>;
      if (hook.writes.length >= MOD_WRITES_PER_HOOK) return capped(hook);
      const view = env.planner();
      const item = view.items.find((i) => i.id === e.id);
      if (!item) return refused('no-item');
      if (stakeEditRefusalWith(item, { title: e.title, project: e.project }, env.stakeFacts())) return refused('stake');
      const patch: Extract<HeldWrite, { kind: 'edit' }>['patch'] = {};
      if (e.title !== undefined) patch.title = e.title;
      if (e.priority !== undefined) patch.priority = e.priority;
      if (e.project !== undefined) {
        if (e.project === null) patch.project = null;
        else {
          const found = findProject(view, e.project);
          if (!found) return refused('no-project');
          patch.project = found;
        }
      }
      hook.writes.push({ kind: 'edit', id: item.id, patch });
      return accepted;
    }
    case 'verbs.run': {
      const v = a as Args<'verbs.run'>;
      if (hook.writes.length >= MOD_WRITES_PER_HOOK) return capped(hook);
      const view = env.planner();
      const item = view.items.find((i) => i.id === v.id);
      if (!item) return refused('no-item');
      if (stakeRefusalWith(verbStep(v.verb, v.inDays), item, env.stakeFacts())) return refused('stake');
      if (!verbEligible(view, env.todayAndTime().today, item, v.verb)) return refused('ineligible');
      hook.writes.push({ kind: 'verb', id: item.id, verb: v.verb, ...(v.inDays !== undefined && { inDays: v.inDays }) });
      return accepted;
    }
    case 'store.get': {
      const { key } = a as Args<'store.get'>;
      const v = storeView(hook)[key];
      return { ok: true, value: v === undefined ? null : v };
    }
    case 'store.keys':
      return { ok: true, value: Object.keys(storeView(hook)).filter((k) => !k.startsWith('@')) };
    case 'store.set':
    case 'store.delete': {
      const s = a as { key: string; value?: unknown };
      // JSON null deletes, as mod_store_set reads it.
      const value = method === 'store.delete' || s.value === null || s.value === undefined ? DELETE : (s.value as Json);
      if (value !== DELETE && jsonbTextBytes(value) > MOD_STORE_VALUE_MAX_BYTES) return refused('too_big');
      const next = storeView(hook);
      if (value === DELETE) delete next[s.key];
      else next[s.key] = value;
      if (jsonbTextBytes(next) > MOD_STORE_TOTAL_MAX_BYTES) return refused('too_big');
      hook.storeOverlay.set(s.key, value);
      return accepted;
    }
    case 'ui.toast': {
      if (hook.toasts >= MOD_TOASTS_PER_HOOK || hook.toastsLastMinute + hook.toasts >= MOD_TOASTS_PER_MINUTE) {
        return refused('rate');
      }
      hook.toasts++;
      hook.ui.push({ kind: 'toast', text: (a as Args<'ui.toast'>).text });
      return accepted;
    }
    case 'ui.openItem': {
      const { id } = a as Args<'ui.openItem'>;
      if (!env.planner().items.some((i) => i.id === id)) return refused('no-item');
      hook.ui.push({ kind: 'openItem', id });
      return accepted;
    }
    case 'nav.go': {
      const g = a as Args<'nav.go'>;
      hook.ui.push({ kind: 'step', step: { do: 'goto', scope: g.scope, layout: g.layout } });
      return accepted;
    }
    case 'nav.organize':
      hook.ui.push({ kind: 'step', step: { do: 'organize' } });
      return accepted;
    case 'look.set': {
      const l = a as Args<'look.set'>;
      const steps: (ThemeStep | LookStep)[] =
        'look' in l
          ? [{ do: 'applyLook', look: l.look }]
          : [
              ...(l.light ? [{ do: 'setTheme' as const, mode: 'light' as const, theme: l.light }] : []),
              ...(l.dark ? [{ do: 'setTheme' as const, mode: 'dark' as const, theme: l.dark }] : []),
            ];
      if (!steps.every((s) => env.lookRefOk(s))) return refused('no-look');
      for (const step of steps) hook.ui.push({ kind: 'step', step });
      return accepted;
    }
    case 'ui.open': {
      const { panelId } = a as Args<'ui.open'>;
      if (!hook.manifest.panels.some((p) => p.id === panelId)) return refused('no_panel');
      hook.ui.push({ kind: 'openPanel', panelId });
      return accepted;
    }
    case 'atom.get': {
      const g = a as Args<'atom.get'>;
      const atoms = atomView(hook);
      if (g && 'key' in g) return { ok: true, value: Object.hasOwn(atoms, g.key) ? atoms[g.key] : null };
      return { ok: true, value: atoms };
    }
    case 'atom.set': {
      const { key, value } = a as Args<'atom.set'>;
      // Held to the field that shows it; text, shown or not, to the surface rule.
      if (!atomValueFits(hook.atomKinds[key], value)) return refused('bad_value');
      const atoms = atomView(hook);
      if (!Object.hasOwn(atoms, key) && Object.keys(atoms).length >= MOD_ATOMS_MAX) return refused('too_many');
      hook.atomOverlay.set(key, value);
      return accepted;
    }
    case 'settings.get':
      return { ok: true, value: { ...hook.settings } };
  }
}

/** The atoms as this hook sees them: its own writes over the snapshot. */
function atomView(hook: HookState): Record<string, AtomValue> {
  const out: Record<string, AtomValue> = { ...hook.atoms };
  for (const [k, v] of hook.atomOverlay) out[k] = v;
  return out;
}

/** A verb as the recipe step the stake rule reads. */
export function verbStep(verb: RecipeVerb, inDays = 0): RecipeVerbStep {
  return verb === 'reschedule' ? { do: 'reschedule', item: 'trigger', inDays } : { do: verb, item: 'trigger' };
}

function capped(hook: HookState): CallAnswer {
  hook.stopped++;
  return refused('cap');
}

/** Whether a type adds items dated today (dateAnchored), for a held create at apply. */
export function datedOnCreate(type: string): boolean {
  return getItemTypeConfig(type).dateAnchored;
}

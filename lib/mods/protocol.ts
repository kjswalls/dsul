import { z } from 'zod';
import {
  MOD_ARGS_MAX_BYTES,
  MOD_FAULT_MESSAGE_MAX,
  MOD_HANDLERS_MAX,
  MOD_MANIFEST_MAX_BYTES,
  MOD_REPLY_ERROR_MAX,
  MOD_SOURCE_MAX_BYTES,
} from './limits';

/**
 * The messages between the host page, the sandbox frame and a mod's worker
 * (memory/plans/mods.md, build order 8).
 *
 * Self-contained on purpose: it imports only zod and ./limits, because the
 * worker bundle imports it, and lib/mods/schema.ts would bring @dsul/types and
 * the theme code in with it (tests/unit/mods-runtime-boundary.test.ts).
 *
 * The frame and the worker are untrusted from the host's side. Everything
 * they send goes through parseFrameMessage, strict, with every string capped,
 * and the JSON fields are parsed only after the cap.
 */

/** The item events a mod hears: RECIPE_EVENT_TRIGGERS (lib/mods/schema.ts), a test pins the two. */
export const MOD_ITEM_EVENT_KINDS = [
  'item.completed',
  'item.uncompleted',
  'item.skipped',
  'item.created',
  'review.saved',
] as const;
export const MOD_EVENT_KINDS = [...MOD_ITEM_EVENT_KINDS, 'command', 'timer'] as const;
export type ModEventKind = (typeof MOD_EVENT_KINDS)[number];

/** Every `$` method PR 8 ships (mods.md, build order 8, "Broker"). */
export const MOD_METHODS = [
  'today',
  'log',
  'after',
  'items.get',
  'items.query',
  'containers.list',
  'verbs.eligible',
  'items.create',
  'items.edit',
  'verbs.run',
  'store.get',
  'store.keys',
  'store.set',
  'store.delete',
  'ui.toast',
  'ui.openItem',
  'nav.go',
  'nav.organize',
  'look.set',
] as const;
export type ModMethod = (typeof MOD_METHODS)[number];

/** No `writes` code: a 26th write is refused at call time, not faulted. */
export const FAULT_CODES = [
  'load',
  'error',
  'cpu',
  'memory',
  'wall',
  'calls',
  'rate',
  'history',
  'protocol',
  'broken',
] as const;
export type FaultCode = (typeof FAULT_CODES)[number];

export const FaultSchema = z
  .object({
    code: z.enum(FAULT_CODES),
    message: z.string().max(MOD_FAULT_MESSAGE_MAX),
  })
  .strict();
export type Fault = z.infer<typeof FaultSchema>;

/** Clips a fault's message to the cap every hop enforces. */
export function fault(code: FaultCode, message: string): Fault {
  return { code, message: message.slice(0, MOD_FAULT_MESSAGE_MAX) };
}

/** What a mod with items:read sees of an item. Never completedDates, streak, notes or the AI fields. */
export const ModItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    project: z.string().nullable(),
    priority: z.string().nullable(),
    timeBucket: z.string().nullable(),
    startDate: z.string().nullable(),
    recurring: z.boolean(),
    done: z.boolean(),
    skipped: z.boolean(),
    open: z.boolean(),
  })
  .strict();
export type ModItem = z.infer<typeof ModItemSchema>;

const ItemRef = { itemId: z.string(), type: z.string(), item: ModItemSchema.nullable().optional() };

export const HookEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['item.completed', 'item.skipped']), date: z.string(), ...ItemRef }).strict(),
  z
    .object({ kind: z.literal('item.uncompleted'), origin: z.enum(['user', 'undo']), date: z.string(), ...ItemRef })
    .strict(),
  z.object({ kind: z.literal('item.created'), date: z.string().optional(), ...ItemRef }).strict(),
  z.object({ kind: z.literal('review.saved'), date: z.string() }).strict(),
  z.object({ kind: z.literal('command'), id: z.string() }).strict(),
  z.object({ kind: z.literal('timer'), name: z.string() }).strict(),
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

const Uuid = z.string().uuid();
const Gen = z.number().int().nonnegative();
const Version = z.string().max(64);
const Source = z.string().refine((s) => utf8Bytes(s) <= MOD_SOURCE_MAX_BYTES, 'source too large');
const Hooks = z.array(z.enum(MOD_EVENT_KINDS)).max(MOD_HANDLERS_MAX);
const ManifestJson = z.string().max(MOD_MANIFEST_MAX_BYTES);

// Host → frame, on the port. The host is the only writer, so these are types
// more than guards; the worker parses them all the same.

/** The one message on window.postMessage; everything after it is on the transferred port. */
export const BootMessageSchema = z.object({ ch: z.literal('dsul-mods'), t: z.literal('boot'), v: Version }).strict();
export type BootMessage = z.infer<typeof BootMessageSchema>;

export const HostMessageSchema = z.union([
  z.object({ t: z.literal('load'), modId: Uuid, gen: Gen, source: Source }).strict(),
  z.object({ t: z.literal('unload'), modId: Uuid }).strict(),
  z.object({ t: z.literal('hook'), modId: Uuid, gen: Gen, hookId: Uuid, event: HookEventSchema }).strict(),
  z
    .object({
      t: z.literal('reply'),
      modId: Uuid,
      gen: Gen,
      hookId: Uuid,
      callId: z.number().int().nonnegative(),
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      t: z.literal('reply'),
      modId: Uuid,
      gen: Gen,
      hookId: Uuid,
      callId: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: z.string().max(MOD_REPLY_ERROR_MAX),
    })
    .strict(),
  z.object({ t: z.literal('scratch'), reqId: Uuid, source: Source }).strict(),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// Frame → host. One schema per `t`, so an unknown `t` fails before any union
// is tried and a known one reports its own error.

const FRAME_SCHEMAS = {
  ready: z.object({ t: z.literal('ready'), v: Version }).strict(),
  'boot-failed': z
    .object({
      t: z.literal('boot-failed'),
      reason: z.enum(['version', 'compile']),
      message: z.string().max(MOD_FAULT_MESSAGE_MAX).optional(),
    })
    .strict(),
  loaded: z.union([
    z
      .object({ t: z.literal('loaded'), modId: Uuid, gen: Gen, ok: z.literal(true), hooks: Hooks, manifestJson: ManifestJson })
      .strict(),
    z.object({ t: z.literal('loaded'), modId: Uuid, gen: Gen, ok: z.literal(false), fault: FaultSchema }).strict(),
  ]),
  call: z
    .object({
      t: z.literal('call'),
      modId: Uuid,
      gen: Gen,
      hookId: Uuid,
      callId: z.number().int().nonnegative(),
      method: z.enum(MOD_METHODS),
      argsJson: z.string().max(MOD_ARGS_MAX_BYTES),
    })
    .strict(),
  done: z.union([
    z.object({ t: z.literal('done'), modId: Uuid, gen: Gen, hookId: Uuid, ok: z.literal(true) }).strict(),
    z.object({ t: z.literal('done'), modId: Uuid, gen: Gen, hookId: Uuid, ok: z.literal(false), fault: FaultSchema }).strict(),
  ]),
  gone: z.object({ t: z.literal('gone'), modId: Uuid, gen: Gen, fault: FaultSchema }).strict(),
  scratched: z.union([
    z
      .object({ t: z.literal('scratched'), reqId: Uuid, ok: z.literal(true), manifestJson: ManifestJson, hooks: Hooks })
      .strict(),
    z.object({ t: z.literal('scratched'), reqId: Uuid, ok: z.literal(false), fault: FaultSchema }).strict(),
  ]),
} as const;

type FrameSchemas = typeof FRAME_SCHEMAS;
export type FrameMessage = { [K in keyof FrameSchemas]: z.infer<FrameSchemas[K]> }[keyof FrameSchemas];
export type FrameMessageType = keyof FrameSchemas;
export const FRAME_MESSAGE_TYPES = Object.keys(FRAME_SCHEMAS) as FrameMessageType[];

export type ParsedFrameMessage =
  | { ok: true; message: FrameMessage }
  /** `modId` when the bad message carried one that reads as a uuid, so the host can fault the mod it issued. */
  | { ok: false; modId?: string };

export function parseFrameMessage(data: unknown): ParsedFrameMessage {
  const t = data && typeof data === 'object' ? (data as { t?: unknown }).t : undefined;
  const schema = typeof t === 'string' && Object.hasOwn(FRAME_SCHEMAS, t) ? FRAME_SCHEMAS[t as FrameMessageType] : null;
  const parsed = schema?.safeParse(data);
  if (parsed?.success) return { ok: true, message: parsed.data as FrameMessage };
  const modId = data && typeof data === 'object' ? (data as { modId?: unknown }).modId : undefined;
  return Uuid.safeParse(modId).success ? { ok: false, modId: modId as string } : { ok: false };
}

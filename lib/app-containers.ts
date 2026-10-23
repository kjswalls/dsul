import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SeasonStateSchema } from '@dsul/types';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import { DateStrSchema, UUID, invalid, notFound, ok, parseBody, pauseZone, refused } from './app-http';
import {
  findLiveProjectByName,
  itemDbType,
  listDeleted,
  restoreGoal,
  restoreItem,
  restoreProject,
  restoreRoutine,
  restoreSeason,
  routineFromRow,
  seasonFromRow,
  updateRoutine,
  updateSeason,
  type RoutineRow,
  type SeasonRow,
  type TrashEntry,
  type TrashKind,
} from './db';
import { resolvePauseWrite } from './active';
import { toDateStr } from './recurrence';
import type { Item, Routine, Season } from './planner-types';

/**
 * The iPhone app's container routes (memory/plans/ios-app.md, the Organize
 * series): the Trash, GET /api/app/trash and POST /api/app/trash/restore, and
 * one field of one routine, season, goal or project,
 * POST /api/app/containers/:kind/:id. The route files are thin facades over
 * the handlers here.
 *
 * Auth is lib/app-auth.ts, as for every /api/app/* route: a Supabase access
 * token as a bearer, and every statement runs on the caller's own client, so
 * RLS is the tenant guard. The service role is never used here.
 *
 * WRITES ARE INTENTS, NEVER ARRAYS, as in lib/app-api.ts. A restore names one
 * row by kind and id, and a field write one field of one container, and each
 * does what the web's own store action does for the same gesture
 * (planner-store.ts restoreFromTrash, setRoutinePaused, setSeasonState),
 * through the same lib/db.ts calls. Nothing here takes a membership list: a
 * container comes back with the join rows its soft delete left in place, and
 * a field write never names a member, so a phone write can never put back a
 * list a web tab changed.
 *
 * NO WEBHOOKS AND NO item_events, because the browser's container writes fire
 * neither: the restore* and update* functions called here notify no plugin
 * and write no event, and nothing here adds one.
 *
 * NO EXTENSION GATE. The Organize and Goals switches are display gates
 * (lib/extension-gates.ts, "These gates are BROWSER-ONLY"): the web writes a
 * routine pause and a season switch with Organize off (Paused's Resume, the
 * container menu), so these routes take every write whatever the switches
 * say, and never read user_extensions.
 *
 * The request and answer helpers are lib/app-http.ts's. lib/app-api.ts imports
 * this module for the payload's `trashWrites` and `containerWrites`; this
 * module never imports app-api.ts, or the two would load each other's schemas
 * in their temporal dead zone.
 */

type Client = SupabaseClient;

/**
 * What the Trash routes take, in the order the phone uses them: the planner
 * payload's `trashWrites`. The phone shows its Trash row only when the
 * payload lists both, so a build that reaches users before this server never
 * offers a bin it would be refused.
 */
export const TRASH_WRITES = ['list', 'restore'] as const;
export type TrashWrite = (typeof TRASH_WRITES)[number];

/**
 * The web's cap (lib/db.ts listDeleted): the bin's search is client-side, so
 * anything past it is unfindable. No one user's 30-day window is near it.
 */
const TRASH_LIMIT = 500;

// ── GET /api/app/trash ───────────────────────────────────────────────────────

/**
 * One row of the bin, trimmed to what the phone draws: what it was, what it
 * was called, when it went, its glyph and colour, and what comes back with it.
 * Never the whole entity: the phone rebuilds nothing from the bin, it refetches
 * the planner after a restore. Absent optionals are left out, never null.
 */
export interface AppTrashRow {
  kind: TrashKind;
  id: string;
  /** The item's title, or the container's name. */
  name: string;
  /** deleted_at, as Postgres wrote it. */
  deletedAt: string;
  /** A container's glyph token (a project's `emoji`); items have none. */
  icon?: string;
  color?: string;
  /** An item's type slug (items.type: `task`, `habit`, or a custom type's), which the phone words with its labels. */
  itemType?: string;
  /** The co-deleted subtasks that come back with an item; only when there are some. */
  childCount?: number;
  /**
   * The members a project re-files, or a goal reconnects: TrashEntry.memberIds,
   * which only those two arms set, so a routine or a season carries no count
   * the web never shows. Present for every project and goal, 0 included.
   */
  memberCount?: number;
}

/** GET /api/app/trash's answer. */
export interface AppTrashResponse {
  entries: AppTrashRow[];
}

/** A bin entry as the phone reads it. */
export function trashRow(entry: TrashEntry): AppTrashRow {
  const row: AppTrashRow = { kind: entry.kind, id: entry.id, name: entry.name, deletedAt: entry.deletedAt };
  if (entry.icon) row.icon = entry.icon;
  if (entry.color) row.color = entry.color;
  if (entry.kind === 'item') {
    row.itemType = itemDbType(entry.entity as Item);
    const children = entry.children?.length ?? 0;
    if (children > 0) row.childCount = children;
  }
  if (entry.memberIds) row.memberCount = entry.memberIds.length;
  return row;
}

/**
 * The bin, newest first, exactly as the web's Trash lists it (listDeleted, on
 * the caller's client): a subtask whose parent is in the bin too travels in
 * its parent's row, and a failure of any table fails the lot rather than
 * answering a bin with a hole in it. Never cached.
 */
export async function getTrash(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  try {
    const entries = await listDeleted(auth.userId, TRASH_LIMIT, auth.client);
    const body: AppTrashResponse = { entries: entries.map(trashRow) };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return dbErrorResponse(err, 'app/trash');
  }
}

// ── POST /api/app/trash/restore ──────────────────────────────────────────────

const Id = z
  .string()
  .regex(UUID, 'expected a uuid')
  .transform((s) => s.toLowerCase());

/** The five tables the bin spans, as lib/db.ts listDeleted reads them. */
const TABLES: Record<TrashKind, string> = {
  item: 'items',
  project: 'projects',
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
};

/**
 * Every kind the bin holds, read off TABLES, so a kind added to lib/db.ts
 * TrashKind is refused by the compiler until it has a table, and then taken
 * by the restore as soon as GET lists it, never answered 400.
 */
const TRASH_KINDS = Object.keys(TABLES) as [TrashKind, ...TrashKind[]];

/** `{kind, id}`: one row of the bin. */
export const TrashRestoreSchema = z.object({ kind: z.enum(TRASH_KINDS), id: Id }).strict();

/** What the restore decides on, and nothing more. */
const READ_COLUMNS: Record<TrashKind, string> = {
  item: 'id, type, parent_item_id, deleted_at',
  project: 'id, name, deleted_at',
  routine: 'id, deleted_at',
  season: 'id, deleted_at',
  goal: 'id, deleted_at',
};

interface RestoreRow {
  deleted_at: string | null;
  type?: string;
  parent_item_id?: string | null;
  name?: string;
}

/**
 * Put one row back where it was: the web's Restore (planner-store.ts
 * restoreFromTrash), with the same lib/db.ts call per kind. An item comes back
 * with its co-deleted subtasks (restoreItem's cascade); a container with the
 * join rows its soft delete kept, and a project's members re-file by the
 * project_id they never lost.
 *
 * The row is read first, by id and user:
 *   - none: 404 `not_found` (never one of this user's, or purged);
 *   - already live: 200 and no write, so a double tap or a retry whose first
 *     answer was lost lands once.
 *
 * Two refusals the web's store does not make, because the phone's list can be
 * staler than the console's and each would put a row somewhere wrong:
 *   - a project whose name a LIVE project already has, folding case (409
 *     `name_taken`, with that project's id and name). The unique index is
 *     exact-case and spans the bin, so only a case variant can clash, and
 *     restoring "Work" beside a live "work" would leave two rows the app
 *     treats as one container;
 *   - an item whose parent is in the bin (409 `parent_gone`). The web's list
 *     never offers it (listDeleted rolls it into the parent's row), but a list
 *     read before the parent went still does, and a subtask restored alone
 *     lands nowhere a user can see.
 *
 * A restored routine or season gives the laptop's overdue sweep no release
 * grace: the web records that grace in its own localStorage, which the phone
 * cannot reach (lib/sweep-grace.ts, accepted there as device-local).
 */
export async function postTrashRestore(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  const body = await parseBody(req, TrashRestoreSchema);
  if (body instanceof Response) return body;
  try {
    return await restore(auth.client, auth.userId, body.kind, body.id);
  } catch (err) {
    return dbErrorResponse(err, 'app/trash/restore');
  }
}

async function restore(client: Client, userId: string, kind: TrashKind, id: string): Promise<Response> {
  const { data, error } = await client
    .from(TABLES[kind])
    .select(READ_COLUMNS[kind])
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const row = data as RestoreRow | null;
  if (!row) return notFound();
  if (row.deleted_at == null) return ok();

  switch (kind) {
    case 'item': {
      if (row.parent_item_id && (await isTrashed(client, userId, row.parent_item_id))) {
        return refused('parent_gone', 409);
      }
      await restoreItem(id, row.type as string, client);
      return ok();
    }
    case 'project': {
      const clash = await findLiveProjectByName(userId, row.name ?? '', client, id);
      if (clash) {
        return NextResponse.json(
          { error: 'name_taken', project: { id: clash.id, name: clash.name } },
          { status: 409 },
        );
      }
      await restoreProject(userId, id, client);
      return ok();
    }
    case 'routine':
      await restoreRoutine(userId, id, client);
      return ok();
    case 'season':
      await restoreSeason(userId, id, client);
      return ok();
    case 'goal':
      await restoreGoal(userId, id, client);
      return ok();
  }
}

/** Whether `itemId` is one of this user's items, in the bin. A row that is live, or not there at all, is not. */
async function isTrashed(client: Client, userId: string, itemId: string): Promise<boolean> {
  const { data, error } = await client
    .from('items')
    .select('id, deleted_at')
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const parent = data as { deleted_at: string | null } | null;
  return !!parent && parent.deleted_at != null;
}

// ── POST /api/app/containers/:kind/:id ───────────────────────────────────────

/** The four containers Organize shows, each a table of its own: the route's `:kind`. */
export const ORGANIZE_KINDS = ['routine', 'season', 'goal', 'project'] as const;
export type OrganizeKind = (typeof ORGANIZE_KINDS)[number];

const isOrganizeKind = (value: string): value is OrganizeKind =>
  (ORGANIZE_KINDS as readonly string[]).includes(value);

/** Each kind's table. Ids are unique per table only, which is why the kind is a path segment. */
const CONTAINER_TABLES: Record<OrganizeKind, string> = {
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
  project: 'projects',
};

/**
 * A routine's field intents, one strict member each, kept apart from the
 * cross-field rule below so the planner payload can list their actions (the
 * item route's ItemWriteActions and ItemWriteSchema). Strict, so a key a
 * newer phone adds is refused by an older server instead of dropped while it
 * answers 200.
 */
const RoutineWriteActions = z.discriminatedUnion('action', [
  // Pause, Pause until and Resume (the routine's Status chip; Paused's Resume).
  z
    .object({
      action: z.literal('pause'),
      paused: z.boolean(),
      /** The exclusive resume day, with `paused: true` only. */
      pausedUntil: DateStrSchema.optional(),
      /** The device's zone, used only when the account has no usable one stored. */
      timeZone: z.string().max(100).optional(),
    })
    .strict(),
]);

/** A season's field intents, as RoutineWriteActions. */
const SeasonWriteActions = z.discriminatedUnion('action', [
  // On, Off and Dates (the season's Status chip), sent exactly as picked; and
  // Paused's "Turn on now", which the phone resolves with seasonStateForSwitch first.
  z.object({ action: z.literal('state'), state: SeasonStateSchema }).strict(),
]);

/**
 * The bodies the route takes per kind. Every cross-field rule is a
 * superRefine on the union, never on a member (zod 3 refuses a refined member
 * in a discriminated union).
 */
export const RoutineWriteSchema = RoutineWriteActions.superRefine((body, ctx) => {
  // "Resume on Oct 8" is the one reading the server cannot honour (a resume
  // is today), so it is refused rather than half-done, as the item pause is.
  if (body.action === 'pause' && body.pausedUntil !== undefined && !body.paused) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pausedUntil'], message: 'only with paused: true' });
  }
});
export const SeasonWriteSchema = SeasonWriteActions;

export type RoutineWrite = z.infer<typeof RoutineWriteSchema>;
export type SeasonWrite = z.infer<typeof SeasonWriteSchema>;

const actionsOf = <A extends string>(union: { options: readonly { shape: { action: z.ZodLiteral<A> } }[] }): A[] =>
  union.options.map((option) => option.shape.action.value);

/**
 * The field intents this server takes, per kind, in declaration order: the
 * planner payload's `containerWrites`. Read off the unions, so an intent
 * cannot be taken and unlisted; a kind with none yet lists none. The phone
 * hides every control whose action is not listed, so a build that reaches
 * users before this server hides an editor rather than offer one it would be
 * refused. Later parts add actions by adding union members, never here by hand.
 */
export const CONTAINER_WRITES = {
  routine: actionsOf(RoutineWriteActions),
  season: actionsOf(SeasonWriteActions),
  goal: [] as string[],
  project: [] as string[],
} satisfies Record<OrganizeKind, readonly string[]>;
export type ContainerWrites = Record<OrganizeKind, string[]>;

/** The payload's copy: fresh arrays, so nothing downstream can grow the constant. */
export function containerWrites(): ContainerWrites {
  return {
    routine: [...CONTAINER_WRITES.routine],
    season: [...CONTAINER_WRITES.season],
    goal: [...CONTAINER_WRITES.goal],
    project: [...CONTAINER_WRITES.project],
  };
}

/** A kind with no intent yet takes no body: any action is unknown, so 400. */
const NO_INTENTS = z.custom<never>(() => false, {
  path: ['action'],
  message: 'no field intent is taken for this kind yet',
});

const WRITE_SCHEMAS: Record<OrganizeKind, z.ZodType<ContainerWriteBody, z.ZodTypeDef, unknown>> = {
  routine: RoutineWriteSchema,
  season: SeasonWriteSchema,
  goal: NO_INTENTS,
  project: NO_INTENTS,
};

type ContainerWriteBody = RoutineWrite | SeasonWrite;

/** One intent on one container, as the pure rule below takes it. */
export type ContainerIntentTarget =
  | { kind: 'routine'; container: Routine; intent: RoutineWrite }
  | { kind: 'season'; container: Season; intent: SeasonWrite };

/**
 * What an intent does to a container: the fields to write, or a refusal.
 * An empty patch is "already so": the route answers 200 and writes nothing.
 */
export type ContainerIntentResult =
  | { patch: Partial<Routine> | Partial<Season> }
  | { refused: 'pause_refused'; status: 409 };

/**
 * The write an intent makes, decided on the container as stored. Pure, and
 * the one statement of the rule: the route runs it on the row it read, and
 * the phone's port (DsulCore ContainerIntent.swift, pinned by
 * tests/fixtures/organize/container-writes.json) runs it on its own copy to
 * step optimistically and to replay a landed write at the instant it was sent.
 *
 *   routine `pause`  the web's setRoutinePaused (planner-store.ts): today in
 *                    `timeZone` and the stamp, both off the one `now`, through
 *                    resolvePauseWrite (lib/active.ts). Already so is an empty
 *                    patch, so a retry never restamps `pausedAt`; a resume
 *                    keeps the interval on the row (`pausedUntil` = today), the
 *                    sweep's grace; a resume day not after today on a live
 *                    routine is `pause_refused`.
 *   season `state`   the web's setSeasonState: the state picked, stored raw
 *                    (never through seasonStateForSwitch, which is a binary
 *                    switch's rule). The state it already has is an empty
 *                    patch, as setSeasonState writes nothing then: a second
 *                    write would restamp `updated_at`, which the laptop's
 *                    overdue sweep reads as a season just switched (its grace
 *                    (c), lib/sweep-grace.ts), granting a grace nobody earned.
 *
 * A pause's cleared resume day is `pausedUntil: undefined`, present as a key:
 * updateRoutine writes it as null.
 */
export function containerIntentPatch(
  target: ContainerIntentTarget,
  ctx: { now: Date; timeZone: string },
): ContainerIntentResult {
  if (target.kind === 'routine') {
    const { container, intent } = target;
    switch (intent.action) {
      case 'pause': {
        const write = resolvePauseWrite(
          container,
          { paused: intent.paused, pausedUntil: intent.pausedUntil },
          toDateStr(ctx.now, ctx.timeZone),
          ctx.now.toISOString(),
          ctx.timeZone,
        );
        if ('reason' in write) return { refused: 'pause_refused', status: 409 };
        return { patch: write.patch as Partial<Routine> };
      }
    }
  }
  const { container, intent } = target;
  switch (intent.action) {
    case 'state':
      return { patch: container.state === intent.state ? {} : { state: intent.state } };
  }
}

/**
 * One field of one container, from the phone: the web's own store action for
 * the same gesture, through the same lib/db.ts update.
 *
 * In order:
 *   - auth (401);
 *   - `:kind` one of ORGANIZE_KINDS and `:id` a uuid, else 404 `not_found`,
 *     as any missing route (a malformed id is the item route's 404 too);
 *   - the body, one strict intent of that kind's union, else 400 `invalid`;
 *   - the container read by id and user, LIVE: none (never the caller's, in
 *     the Trash, or purged) is 404 `not_found`. The read is load-bearing:
 *     updateRoutine and updateSeason filter on id and user but not on
 *     deleted_at, and a zero-row update answers 200, so without it a write to
 *     a trashed container would land in the bin and say so;
 *   - containerIntentPatch on the row; a refusal is 409 with its code, an
 *     empty patch 200 with no write;
 *   - the update, then 200 `{ok: true}`.
 *
 * A pause reads the account's zone (pauseZone: the stored one, else the
 * device's from the body, else UTC), the frame the phone says "today" in; no
 * other intent reads anything but the row.
 */
export async function postContainerWrite(req: Request, rawKind: string, rawId: string): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  if (!isOrganizeKind(rawKind) || !UUID.test(rawId)) return notFound();
  const kind = rawKind;
  const id = rawId.toLowerCase();

  const body = await parseBody(req, WRITE_SCHEMAS[kind]);
  if (body instanceof Response) return body;

  try {
    return await runContainerWrite(auth.client, auth.userId, kind, id, body);
  } catch (err) {
    return dbErrorResponse(err, 'app/containers/:kind/:id');
  }
}

async function runContainerWrite(
  client: Client,
  userId: string,
  kind: OrganizeKind,
  id: string,
  body: ContainerWriteBody,
): Promise<Response> {
  const { data, error } = await client
    .from(CONTAINER_TABLES[kind])
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound();

  const now = new Date();
  if (kind === 'routine' && body.action === 'pause') {
    const container = routineFromRow(data as RoutineRow, []);
    const timeZone = await pauseZone(client, userId, body.timeZone);
    const result = containerIntentPatch({ kind, container, intent: body }, { now, timeZone });
    if ('refused' in result) return refused(result.refused, result.status);
    if (Object.keys(result.patch).length > 0) {
      await updateRoutine(userId, id, result.patch as Partial<Routine>, client);
    }
    return ok();
  }
  if (kind === 'season' && body.action === 'state') {
    const container = seasonFromRow(data as SeasonRow, [], []);
    const result = containerIntentPatch({ kind, container, intent: body }, { now, timeZone: 'UTC' });
    if ('refused' in result) return refused(result.refused, result.status);
    if (Object.keys(result.patch).length > 0) {
      await updateSeason(userId, id, result.patch as Partial<Season>, client);
    }
    return ok();
  }
  // Unreachable: each kind's schema takes only its own actions.
  return invalid();
}

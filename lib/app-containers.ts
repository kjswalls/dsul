import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GoalStateSchema, SeasonStateSchema } from '@dsul/types';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import {
  DateStrSchema,
  TimeStrSchema,
  UUID,
  errorCode,
  notFound,
  ok,
  parseBody,
  pauseZone,
  refused,
} from './app-http';
import {
  findLiveProjectByName,
  goalFromRow,
  itemDbType,
  listDeleted,
  projectFromRow,
  renameContainerMembers,
  restoreGoal,
  restoreItem,
  restoreProject,
  restoreRoutine,
  restoreSeason,
  routineFromRow,
  seasonFromRow,
  updateGoal,
  updateProject,
  updateRoutine,
  updateSeason,
  type GoalRow,
  type ProjectRow,
  type RoutineRow,
  type SeasonRow,
  type TrashEntry,
  type TrashKind,
} from './db';
import { resolvePauseWrite } from './active';
import { resolveGoalStateWrite } from './goals';
import { ACCENT_RAMP } from './accent-colors';
import { OUTER_LIMITS, cleanNotes } from './item-edit';
import { toDateStr } from './recurrence';
import type { Goal, Item, Project, Routine, Season } from './planner-types';

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
 * row by kind and id, and a field write one field of one container (a
 * routine's pause, usual time or note; a season's state, dates or note; a
 * goal's state, window or why; a project's note; and the name, glyph and
 * colour of any of the four), and each does what the web's own store action
 * does for the same gesture (planner-store.ts restoreFromTrash,
 * setRoutinePaused, setSeasonState, setGoalState, updateRoutine, updateSeason,
 * updateGoal, updateProject), through the same lib/db.ts calls. Nothing here
 * takes a membership list: a container comes back with the join rows its soft
 * delete left in place, and a field write never names a member, so a phone
 * write can never put back a list a web tab changed. The one write that
 * reaches items is a project rename's, which re-files its members' name
 * column by project_id, as the web's does.
 *
 * NO WEBHOOKS AND NO item_events, because the browser's container writes fire
 * neither: the restore* and update* functions called here write no event, the
 * project ones are called with `notify: false` (on a server, with its service
 * key, they would otherwise fire two webhooks the browser never fires), and
 * nothing here adds one.
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
 * A container's name, stored trimmed and never blank. The cap is the item
 * route's outer bound for a title: the web and the agent API write any length,
 * so this only refuses a body no one could mean.
 */
const Name = z.string().trim().min(1).max(OUTER_LIMITS.title);

/**
 * A glyph, as the web's icon picker stores it (lib/category-icons.ts
 * makeIconToken: `icon:` and a Lucide name). Never null: the web never clears
 * a glyph (a project's `emoji` is NOT NULL), so neither does the phone.
 */
const IconToken = z.string().regex(/^icon:[A-Za-z0-9]{1,64}$/, 'expected icon:<Name>');

/**
 * One of the eight ramp tokens the web's colour picker offers
 * (lib/accent-colors.ts ACCENT_RAMP, `var(--accent-1)` to `var(--accent-8)`).
 * Null is the picker's Automatic: the stored colour is cleared and the name
 * hash colours it again.
 */
const AccentToken = z.string().refine((color) => ACCENT_RAMP.includes(color), 'expected var(--accent-N)');

/**
 * Free text: a routine's, season's or project's note, or a goal's why. Stored
 * as the web stores it (`next.trim() || undefined`, lib/item-edit.ts
 * cleanNotes): trimmed, and null or text that trims to nothing clears it.
 */
const Note = z.string().max(OUTER_LIMITS.notes).nullable();

// The intents every kind takes (O9's rename, icon and colour), and the note
// three of them take (O8b). One schema each, shared by the unions below.
const RenameIntent = z.object({ action: z.literal('rename'), name: Name }).strict();
const IconIntent = z.object({ action: z.literal('icon'), icon: IconToken }).strict();
const ColorIntent = z.object({ action: z.literal('color'), color: AccentToken.nullable() }).strict();
const NotesIntent = z.object({ action: z.literal('notes'), notes: Note }).strict();

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
  // Usual time: the hour it labels and orders by (047). Null clears it.
  z.object({ action: z.literal('usualTime'), usualTime: TimeStrSchema.nullable() }).strict(),
  NotesIntent,
  RenameIntent,
  IconIntent,
  ColorIntent,
]);

/** A season's field intents, as RoutineWriteActions. */
const SeasonWriteActions = z.discriminatedUnion('action', [
  // On, Off and Dates (the season's Status chip), sent exactly as picked; and
  // Paused's "Turn on now", which the phone resolves with seasonStateForSwitch first.
  z.object({ action: z.literal('state'), state: SeasonStateSchema }).strict(),
  // Runs: both ends together, either one null (open on that side), so the
  // range rule below sees the whole range and no stored half can invert it.
  z
    .object({ action: z.literal('dates'), startsOn: DateStrSchema.nullable(), endsOn: DateStrSchema.nullable() })
    .strict(),
  NotesIntent,
  RenameIntent,
  IconIntent,
  ColorIntent,
]);

/** A goal's field intents, as RoutineWriteActions. A goal has no note: its free text is the why. */
const GoalWriteActions = z.discriminatedUnion('action', [
  // Active, Achieved and Set aside (the goal's Status chip).
  z.object({ action: z.literal('state'), state: GoalStateSchema }).strict(),
  // The window: both ends together, as a season's dates are.
  z
    .object({ action: z.literal('window'), startsOn: DateStrSchema.nullable(), targetOn: DateStrSchema.nullable() })
    .strict(),
  z.object({ action: z.literal('why'), why: Note }).strict(),
  RenameIntent,
  IconIntent,
  ColorIntent,
]);

/** A project's field intents, as RoutineWriteActions. Its time block stays the web's (§1.2). */
const ProjectWriteActions = z.discriminatedUnion('action', [NotesIntent, RenameIntent, IconIntent, ColorIntent]);

/**
 * A range whose start is after its end, refused as the agent API refuses it
 * (packages/types/src/schemas.ts rejectInvertedRange): an `auto` season so
 * dated is live on no date at all, and a goal's window never opens. Equal
 * ends are a one-day range.
 */
function rejectInverted(start: string | null, end: string | null, endKey: string, ctx: z.RefinementCtx): void {
  if (start && end && start > end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [endKey], message: 'must not be before startsOn' });
  }
}

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
export const SeasonWriteSchema = SeasonWriteActions.superRefine((body, ctx) => {
  if (body.action === 'dates') rejectInverted(body.startsOn, body.endsOn, 'endsOn', ctx);
});
export const GoalWriteSchema = GoalWriteActions.superRefine((body, ctx) => {
  if (body.action === 'window') rejectInverted(body.startsOn, body.targetOn, 'targetOn', ctx);
});
export const ProjectWriteSchema = ProjectWriteActions;

export type RoutineWrite = z.infer<typeof RoutineWriteSchema>;
export type SeasonWrite = z.infer<typeof SeasonWriteSchema>;
export type GoalWrite = z.infer<typeof GoalWriteSchema>;
export type ProjectWrite = z.infer<typeof ProjectWriteSchema>;

const actionsOf = <A extends string>(union: { options: readonly { shape: { action: z.ZodLiteral<A> } }[] }): A[] =>
  union.options.map((option) => option.shape.action.value);

/**
 * The field intents this server takes, per kind, in declaration order: the
 * planner payload's `containerWrites`. Read off the unions, so an intent
 * cannot be taken and unlisted. The phone hides every control whose action is
 * not listed, so a build that reaches users before this server hides an
 * editor rather than offer one it would be refused. Later parts add actions
 * by adding union members, never here by hand.
 */
export const CONTAINER_WRITES = {
  routine: actionsOf(RoutineWriteActions),
  season: actionsOf(SeasonWriteActions),
  goal: actionsOf(GoalWriteActions),
  project: actionsOf(ProjectWriteActions),
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

type ContainerWriteBody = RoutineWrite | SeasonWrite | GoalWrite | ProjectWrite;

/** The body each kind takes: what the route parses `:kind`'s body with. */
export const CONTAINER_WRITE_SCHEMAS: Record<OrganizeKind, z.ZodType<ContainerWriteBody, z.ZodTypeDef, unknown>> = {
  routine: RoutineWriteSchema,
  season: SeasonWriteSchema,
  goal: GoalWriteSchema,
  project: ProjectWriteSchema,
};

/** One intent on one container, as the pure rule below takes it. */
export type ContainerIntentTarget =
  | { kind: 'routine'; container: Routine; intent: RoutineWrite }
  | { kind: 'season'; container: Season; intent: SeasonWrite }
  | { kind: 'goal'; container: Goal; intent: GoalWrite }
  | { kind: 'project'; container: Project; intent: ProjectWrite };

/** The fields an intent writes, in the kind's own shape. */
export type ContainerPatch = Partial<Routine> | Partial<Season> | Partial<Goal> | Partial<Project>;

/**
 * What an intent does to a container: the fields to write, or a refusal.
 * An empty patch is "already so": the route answers 200 and writes nothing.
 */
export type ContainerIntentResult = { patch: ContainerPatch } | { refused: 'pause_refused'; status: 409 };

type IdentityIntent = z.infer<typeof RenameIntent> | z.infer<typeof IconIntent> | z.infer<typeof ColorIntent>;

/** Rename, icon and colour, on a container whose glyph column is `icon` (all but a project). */
function identityPatch(intent: IdentityIntent): { name?: string; icon?: string; color?: string } {
  switch (intent.action) {
    case 'rename':
      return { name: intent.name };
    case 'icon':
      return { icon: intent.icon };
    case 'color':
      return { color: intent.color ?? undefined };
  }
}

/**
 * The write an intent makes, decided on the container as stored. Pure, and
 * the one statement of the rule: the route runs it on the row it read, and
 * the phone's port (DsulCore ContainerIntent.swift, pinned by
 * tests/fixtures/organize/container-writes.json) runs it on its own copy to
 * step optimistically and to replay a landed write at the instant it was sent.
 *
 *   routine `pause`   the web's setRoutinePaused (planner-store.ts): today in
 *                     `timeZone` and the stamp, both off the one `now`, through
 *                     resolvePauseWrite (lib/active.ts). Already so is an empty
 *                     patch, so a retry never restamps `pausedAt`; a resume
 *                     keeps the interval on the row (`pausedUntil` = today), the
 *                     sweep's grace; a resume day not after today on a live
 *                     routine is `pause_refused`.
 *   season `state`    the web's setSeasonState: the state picked, stored raw
 *                     (never through seasonStateForSwitch, which is a binary
 *                     switch's rule). The state it already has is an empty
 *                     patch, as setSeasonState writes nothing then: a second
 *                     write would restamp `updated_at`, which the laptop's
 *                     overdue sweep reads as a season just switched (its grace
 *                     (c), lib/sweep-grace.ts), granting a grace nobody earned.
 *   goal `state`      the web's setGoalState: resolveGoalStateWrite
 *                     (lib/goals.ts) at `now`. Achieved stamps `achievedAt`,
 *                     Active clears it, Set aside keeps it; the state it
 *                     already has is an empty patch, so a goal achieved twice
 *                     keeps its first stamp.
 *   routine `usualTime`, season `dates`, goal `window`
 *                     the field as sent, a null half cleared, as the web's
 *                     chips write them (updateRoutine, updateSeason,
 *                     updateGoal). Both ends of a range travel together.
 *   `notes`, goal `why`
 *                     trimmed, and blank clears it (cleanNotes), as the web's
 *                     note fields commit (`next.trim() || undefined`).
 *   `rename`, `icon`, `color`
 *                     the name (trimmed by the schema), the glyph (a
 *                     project's is its `emoji` column) and the colour (null
 *                     clears it), as the web's title row and colour chip
 *                     write them. A project rename's fan-out to its members
 *                     is the route's (renameContainerMembers), not the patch's.
 *
 * Every field intent but a pause and the two states writes its value again
 * when it already has it: the same value, so a retry is harmless.
 *
 * A cleared field is present with value `undefined` (`{ pausedUntil:
 * undefined }`): the lib/db.ts update functions write it as null.
 */
export function containerIntentPatch(
  target: ContainerIntentTarget,
  ctx: { now: Date; timeZone: string },
): ContainerIntentResult {
  switch (target.kind) {
    case 'routine': {
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
        case 'usualTime':
          return { patch: { usualTime: intent.usualTime ?? undefined } };
        case 'notes':
          return { patch: { notes: cleanNotes(intent.notes) } };
        default:
          return { patch: identityPatch(intent) };
      }
    }
    case 'season': {
      const { container, intent } = target;
      switch (intent.action) {
        case 'state':
          return { patch: container.state === intent.state ? {} : { state: intent.state } };
        case 'dates':
          return { patch: { startsOn: intent.startsOn ?? undefined, endsOn: intent.endsOn ?? undefined } };
        case 'notes':
          return { patch: { notes: cleanNotes(intent.notes) } };
        default:
          return { patch: identityPatch(intent) };
      }
    }
    case 'goal': {
      const { container, intent } = target;
      switch (intent.action) {
        case 'state':
          return { patch: resolveGoalStateWrite(container, intent.state, ctx.now.toISOString()) };
        case 'window':
          return { patch: { startsOn: intent.startsOn ?? undefined, targetOn: intent.targetOn ?? undefined } };
        case 'why':
          return { patch: { why: cleanNotes(intent.why) } };
        default:
          return { patch: identityPatch(intent) };
      }
    }
    case 'project': {
      const { intent } = target;
      switch (intent.action) {
        case 'notes':
          return { patch: { notes: cleanNotes(intent.notes) } };
        case 'icon':
          // A project's glyph column is `emoji`: the name it had before icons.
          return { patch: { emoji: intent.icon } };
        default:
          return { patch: identityPatch(intent) };
      }
    }
  }
}

/** One parsed body with the kind it was parsed for. */
type ContainerWrite =
  | { kind: 'routine'; intent: RoutineWrite }
  | { kind: 'season'; intent: SeasonWrite }
  | { kind: 'goal'; intent: GoalWrite }
  | { kind: 'project'; intent: ProjectWrite };

/** No intent but a pause reads a day, so none reads a zone: UTC stands in, unread. */
const NO_ZONE = 'UTC';

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
 *     updateRoutine, updateSeason and updateGoal filter on id and user but
 *     not on deleted_at, updateProject on the id alone, and a zero-row update
 *     answers 200, so without it a write to a trashed container would land in
 *     the bin and say so;
 *   - containerIntentPatch on the row; a refusal is 409 with its code, an
 *     empty patch 200 with no write;
 *   - the update, then 200 `{ok: true}`.
 *
 * A pause reads the account's zone (pauseZone: the stored one, else the
 * device's from the body, else UTC), the frame the phone says "today" in; no
 * other intent reads anything but the row.
 *
 * A project rename does the web's three steps (labels.tsx takenBy, then
 * planner-store.ts updateProject's chained fan-out), see renameProject.
 * Every project write passes `notify: false`: the web's own project writes
 * reach no webhook, so the phone's do not either.
 */
export async function postContainerWrite(req: Request, rawKind: string, rawId: string): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  if (!isOrganizeKind(rawKind) || !UUID.test(rawId)) return notFound();
  const kind = rawKind;
  const id = rawId.toLowerCase();

  const body = await parseBody(req, CONTAINER_WRITE_SCHEMAS[kind]);
  if (body instanceof Response) return body;
  // CONTAINER_WRITE_SCHEMAS[kind] takes only that kind's intents.
  const write = { kind, intent: body } as ContainerWrite;

  try {
    return await runContainerWrite(auth.client, auth.userId, id, write);
  } catch (err) {
    return dbErrorResponse(err, 'app/containers/:kind/:id');
  }
}

const hasFields = (patch: object) => Object.keys(patch).length > 0;

async function runContainerWrite(client: Client, userId: string, id: string, write: ContainerWrite): Promise<Response> {
  const { data, error } = await client
    .from(CONTAINER_TABLES[write.kind])
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound();

  const now = new Date();
  switch (write.kind) {
    case 'routine': {
      const container = routineFromRow(data as RoutineRow, []);
      const intent = write.intent;
      const timeZone = intent.action === 'pause' ? await pauseZone(client, userId, intent.timeZone) : NO_ZONE;
      const result = containerIntentPatch({ kind: 'routine', container, intent }, { now, timeZone });
      if ('refused' in result) return refused(result.refused, result.status);
      if (hasFields(result.patch)) await updateRoutine(userId, id, result.patch as Partial<Routine>, client);
      return ok();
    }
    case 'season': {
      const container = seasonFromRow(data as SeasonRow, [], []);
      const result = containerIntentPatch({ kind: 'season', container, intent: write.intent }, { now, timeZone: NO_ZONE });
      if ('refused' in result) return refused(result.refused, result.status);
      if (hasFields(result.patch)) await updateSeason(userId, id, result.patch as Partial<Season>, client);
      return ok();
    }
    case 'goal': {
      const container = goalFromRow(data as GoalRow, { memberIds: [], milestoneIds: [], checkinIds: [] });
      const result = containerIntentPatch({ kind: 'goal', container, intent: write.intent }, { now, timeZone: NO_ZONE });
      if ('refused' in result) return refused(result.refused, result.status);
      if (hasFields(result.patch)) await updateGoal(userId, id, result.patch as Partial<Goal>, client);
      return ok();
    }
    case 'project': {
      const container = projectFromRow(data as ProjectRow);
      const result = containerIntentPatch({ kind: 'project', container, intent: write.intent }, { now, timeZone: NO_ZONE });
      if ('refused' in result) return refused(result.refused, result.status);
      const patch = result.patch as Partial<Project>;
      if (write.intent.action === 'rename') return renameProject(client, userId, id, write.intent.name, container.name);
      if (hasFields(patch)) await updateProject(userId, id, patch, client, { notify: false });
      return ok();
    }
  }
}

/**
 * A project rename, as the web does it (planner-store.ts updateProject, the
 * agent route's PATCH), in three steps that must not fail apart:
 *
 *   1. The folded clash: a LIVE project other than this one whose name folds
 *      to the same (findLiveProjectByName, `exceptId` so a project can change
 *      its own case) is 409 `name_taken`, with that project's id and name.
 *      The unique index is exact-case, so without this "work" would sit
 *      beside "Work" as two rows the app reads as one container.
 *   2. The project's own row. A 23505 here is projects_user_id_name_key,
 *      which spans the bin: a project in the Trash still holds this exact
 *      name, so 409 `name_in_trash` and nothing else is written.
 *   3. AWAITED after it, the members' name column, by project_id
 *      (renameContainerMembers, trashed members included). Never first, never
 *      beside it: a refused rename that had already rewritten its members
 *      would read as the items having moved into another project.
 *
 * If step 3 fails, the row goes back to `previous` before the 500. The phone
 * never re-sends a failed write, and never sends the name a project already
 * has, so a split left here (the project called House, its items still
 * saying Home) would stand until the next rename, and every device would
 * show the items as filed under no live project. Putting the name back makes
 * the 500 match the phone's revert. It is only best effort: if that write
 * fails too, the split stays and the first error still answers; and if step
 * 3 had in fact committed with its answer lost, this makes the inverse split
 * (the items say House under a project called Home), which the next rename
 * heals the same way, by project_id.
 *
 * The fan-out runs even when the name is unchanged, unlike the web store's:
 * the route cannot tell a repeat from a no-op, rewriting a member's name with
 * the one it already has changes nothing, and a repeat heals any split.
 */
async function renameProject(
  client: Client,
  userId: string,
  id: string,
  name: string,
  previous: string,
): Promise<Response> {
  const clash = await findLiveProjectByName(userId, name, client, id);
  if (clash) {
    return NextResponse.json({ error: 'name_taken', project: { id: clash.id, name: clash.name } }, { status: 409 });
  }
  try {
    await updateProject(userId, id, { name }, client, { notify: false });
  } catch (err) {
    if (errorCode(err) === '23505') return refused('name_in_trash', 409);
    throw err;
  }
  try {
    await renameContainerMembers(userId, id, name, client);
  } catch (err) {
    try {
      await updateProject(userId, id, { name: previous }, client, { notify: false });
    } catch {
      // Best effort: the fan-out's own error is the answer.
    }
    throw err;
  }
  return ok();
}

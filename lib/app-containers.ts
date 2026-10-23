import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import { UUID, notFound, ok, parseBody, refused } from './app-http';
import {
  findLiveProjectByName,
  itemDbType,
  listDeleted,
  restoreGoal,
  restoreItem,
  restoreProject,
  restoreRoutine,
  restoreSeason,
  type TrashEntry,
  type TrashKind,
} from './db';
import type { Item } from './planner-types';

/**
 * The iPhone app's container routes: today the Trash, GET /api/app/trash and
 * POST /api/app/trash/restore (memory/plans/ios-app.md, the Organize series).
 * The route files are thin facades over the handlers here.
 *
 * Auth is lib/app-auth.ts, as for every /api/app/* route: a Supabase access
 * token as a bearer, and every statement runs on the caller's own client, so
 * RLS is the tenant guard. The service role is never used here.
 *
 * WRITES ARE INTENTS, NEVER ARRAYS, as in lib/app-api.ts. A restore names one
 * row by kind and id and does what the web's own store action does for the
 * same gesture (planner-store.ts restoreFromTrash), through the same lib/db.ts
 * calls. Nothing here takes a membership list: a container comes back with
 * the join rows its soft delete left in place, never with an array the phone
 * sends.
 *
 * NO WEBHOOKS AND NO item_events, because the browser's restore fires neither:
 * the restore* functions notify no plugin and write no event, and nothing here
 * adds one.
 *
 * The request and answer helpers are lib/app-http.ts's. lib/app-api.ts imports
 * this module for the payload's `trashWrites`; this module never imports
 * app-api.ts, or the two would load each other's schemas in their temporal
 * dead zone.
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

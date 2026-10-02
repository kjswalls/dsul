import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import {
  createItem,
  fetchItems,
  fetchProjects,
  fetchRoutines,
  fetchSeasons,
  loadPlannerData,
  setItemCompletion,
  updateItem,
  type PlannerData,
} from './db';
import { getItemTypeConfig } from './item-registry';
import { getBucketForTime } from './time-bucket';
import { reportLiveCompletion } from './stakes/live';
import { createServiceClient } from './supabase-service';
import type { HabitItem, Item, Project, Routine, Season, Task, TaskItem } from './planner-types';

/**
 * The iPhone app's API: /api/app/planner, /api/app/items, /api/app/items/:id.
 * The route files are thin facades over the handlers here.
 *
 * Auth is lib/app-auth.ts: a Supabase access token as a bearer, and every
 * statement below runs on the caller's own client, so RLS is the tenant guard.
 *
 * WRITES ARE INTENTS, NEVER ARRAYS. The phone does three things (tick a row,
 * drop a braindump row on an hour, capture), and each is one verb here that
 * does what the web's own store action does for the same gesture, through the
 * same lib/db.ts calls. Nothing accepts an absolute completedDates or
 * dailyCounts: the phone reads a 400-day window, and an array written back from
 * a window deletes what the window did not show.
 *
 * WEBHOOKS MATCH THE BROWSER UI, WHICH FIRES NONE. The store never passes a
 * userId to updateItem (planner-store.ts updateItemAction), and notifyPlugins
 * is a no-op without a service key, so a tick or a capture typed on the web
 * reaches no plugin. These calls keep it that way: updateItem gets no userId,
 * and createItem gets `notify: false`. The item_events rows are written exactly
 * as the web writes them.
 */

type Client = SupabaseClient;

const invalid = (details?: unknown) =>
  NextResponse.json(details === undefined ? { error: 'invalid' } : { error: 'invalid', details }, {
    status: 400,
  });
const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });
const ok = () => NextResponse.json({ ok: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A real calendar day. The shape alone accepts 2026-02-31, and a date is data
 * here, not decoration: it is the day a completion is credited to.
 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const DateStrSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-MM-dd')
  .refine(isCalendarDate, 'not a calendar date');

const TimeStrSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

/** POST /api/app/items. The id is the phone's own, so a retry is the same row. */
export const CaptureSchema = z.object({
  id: z
    .string()
    .regex(UUID, 'expected a uuid')
    .transform((id) => id.toLowerCase()),
  title: z.string().trim().min(1).max(500),
});

/** POST /api/app/items/:id. */
export const ItemWriteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete'),
    date: DateStrSchema,
    done: z.boolean(),
    /** A habit's tally for `date`, for a habit with a daily target. */
    count: z.number().int().min(0).max(1000).optional(),
  }),
  z.object({
    action: z.literal('schedule'),
    date: DateStrSchema,
    startTime: TimeStrSchema,
  }),
]);

/** Parse + validate a JSON body, or the 400 to send instead. */
async function parseBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.flatten());
  return parsed.data;
}

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;

// ── GET /api/app/planner ─────────────────────────────────────────────────────

/** What the phone reads on sign-in, on foreground and on pull-to-refresh. */
export interface AppPlannerPayload {
  v: 1;
  userId: string;
  fetchedAt: string;
  settings: { timezone: string | null; showCompletedTasks: boolean };
  items: Item[];
  projects: Project[];
  routines: Routine[] | null;
  seasons: Season[] | null;
}

/**
 * Named columns, never `*`: the same row holds `openclaw_api_key`, a plaintext
 * key with service-role power that RLS lets this token read.
 */
const SETTINGS_COLUMNS = 'timezone, show_completed_tasks';

/**
 * The per-table fallback for a database without load_planner (050), with the
 * caller's client. Item types and goals are left out: Today needs neither, and
 * null is their "unreachable" value, which the phone never reads.
 */
async function perTable(userId: string, client: Client): Promise<PlannerData> {
  const [items, projects, routines, seasons] = await Promise.all([
    fetchItems(userId, undefined, client),
    fetchProjects(userId, client),
    fetchRoutines(userId, client),
    fetchSeasons(userId, client),
  ]);
  return { items, projects, itemTypes: null, routines, seasons, goals: null };
}

export async function getPlanner(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  const { userId, client } = auth;

  try {
    // The same loader the web's initializeStore uses, so items arrive mapped by
    // itemFromRow (the custom-type envelope, the habit `group` fallback, the
    // 400-day completion window) and cannot drift from what the web shows. It
    // falls back to the per-table read rather than answering 503 on a missing
    // RPC, so its module-level latch can slow an instance but never fail one.
    const [data, settingsResult] = await Promise.all([
      loadPlannerData(userId, () => perTable(userId, client), client),
      client.from('user_settings').select(SETTINGS_COLUMNS).eq('user_id', userId).maybeSingle(),
    ]);
    if (settingsResult.error) throw settingsResult.error;
    const settings = settingsResult.data as { timezone?: string | null; show_completed_tasks?: boolean | null } | null;

    const payload: AppPlannerPayload = {
      v: 1,
      userId,
      fetchedAt: new Date().toISOString(),
      settings: {
        timezone: settings?.timezone ?? null,
        // The web's default when the row or the column is missing.
        showCompletedTasks: settings?.show_completed_tasks ?? true,
      },
      items: data.items,
      projects: data.projects,
      routines: data.routines,
      seasons: data.seasons,
    };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return dbErrorResponse(err, 'app/planner');
  }
}

// ── POST /api/app/items (capture) ────────────────────────────────────────────

/**
 * Capture to the braindump: the web's addTask with no bucket (planner-store.ts
 * addTask), so an unscheduled, undated pending task appended after every other
 * task-like row.
 *
 * Idempotent by the phone's id. A retry after a lost response hits the primary
 * key (23505); if the row it collides with is this user's live task, the first
 * attempt landed and the retry answers 200. Anything else under that id is a
 * conflict, and is not described further: another user's row is invisible
 * under RLS, so "not yours" and "trashed" read alike, which is the point.
 */
export async function postCapture(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  const { userId, client } = auth;

  const body = await parseBody(req, CaptureSchema);
  if (body instanceof Response) return body;
  const { id, title } = body;

  // `order` is the web's `tasks.length`: every live task-like row that is not
  // a subtask, which is the store's `tasks` projection.
  const { count, error: countError } = await client
    .from('items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('type', 'habit')
    .is('parent_item_id', null)
    .is('deleted_at', null);
  if (countError) return dbErrorResponse(countError, 'app/items');

  const item: TaskItem = {
    type: 'task',
    id,
    title,
    status: 'pending',
    isScheduled: false,
    order: count ?? 0,
  };

  try {
    await createItem(userId, item, client, { notify: false });
  } catch (err) {
    if (errorCode(err) === '23505') return captureRetry(client, id);
    return dbErrorResponse(err, 'app/items');
  }
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

async function captureRetry(client: Client, id: string): Promise<Response> {
  const { data, error } = await client
    .from('items')
    .select('id, type, deleted_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return dbErrorResponse(error, 'app/items');
  const row = data as { type?: string; deleted_at?: string | null } | null;
  if (row && row.type === 'task' && row.deleted_at == null) {
    return NextResponse.json({ ok: true, id }, { status: 200 });
  }
  return NextResponse.json({ error: 'conflict' }, { status: 409 });
}

// ── POST /api/app/items/:id ──────────────────────────────────────────────────

interface WriteRow {
  id: string;
  type: string;
  repeat_frequency: string | null;
  skipped_dates: string[] | null;
  daily_counts: Record<string, number> | null;
  current_day_count: number | null;
}

/**
 * Report a completion to a live stake once the response is sent, as the
 * browser does after every set_item_completion (db.ts reportCompletion) and
 * /api/reminders/act does after its own. With a service client, which the
 * report scopes by user_id itself. It never throws, and the completion it
 * reports is already written.
 */
function reportStake(userId: string, itemId: string, dateStr: string, completed: boolean): void {
  after(async () => {
    try {
      const result = await reportLiveCompletion(createServiceClient(), {
        userId,
        itemId,
        dateStr,
        completed,
      });
      if (!result.ok) console.error('[app/items] stake report failed:', result.detail);
    } catch (err) {
      console.error('[app/items] stake report failed:', err instanceof Error ? err.message : err);
    }
  });
}

/**
 * One verb on one item. `complete` mirrors the web's tick (lib/item-toggle.ts
 * and the store's toggleHabitStatus / toggleTaskStatus), and `schedule` the
 * web's drop of a braindump row onto an hour (handle-drag-end → scheduleTask).
 *
 * The row is read first, under RLS, and a missing one is a 404. That read is
 * load-bearing, not politeness: set_item_completion filters on id and type
 * only, so under the user's client someone else's id is a silent no-op that
 * would otherwise answer 200.
 */
export async function postItemWrite(req: Request, rawId: string): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  const { userId, client } = auth;

  // Not a uuid, so not an item: answered before Postgres rejects the cast.
  if (!UUID.test(rawId)) return notFound();
  const id = rawId.toLowerCase();

  const body = await parseBody(req, ItemWriteSchema);
  if (body instanceof Response) return body;

  const { data, error } = await client
    .from('items')
    .select('id, type, repeat_frequency, skipped_dates, daily_counts, current_day_count')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return dbErrorResponse(error, 'app/items/:id');
  const row = data as WriteRow | null;
  if (!row) return notFound();

  const type = row.type;
  const config = getItemTypeConfig(type);

  try {
    if (body.action === 'schedule') {
      // The write sets a start date, which only a date-anchored type reads. A
      // habit is not one, and its column allowlist would drop every field but
      // the bucket and time while the event still recorded them all.
      if (!config.dateAnchored) {
        return NextResponse.json({ error: 'not_schedulable' }, { status: 400 });
      }
      // The web's scheduleTask with the hour drop's arguments: a grid drop
      // passes an hour bucket, never 'anytime', so autoCorrectBucket always
      // lands on the time's own bucket. The date is the day the row was
      // dropped on, which is the anchor a braindump row needs to show there.
      const updates: Partial<Task> = {
        isScheduled: true,
        timeBucket: getBucketForTime(body.startTime),
        startTime: body.startTime,
        inProjectBlock: false,
        previousStartTime: undefined,
        previousStartDate: undefined,
        startDate: body.date,
      };
      await updateItem(id, type, updates, undefined, client);
      return ok();
    }

    const { date, done, count } = body;
    // A skipped occurrence is refused outright, as toggleRowDone refuses it
    // (lib/item-toggle.ts): ticking it would leave a date both skipped and
    // done, and on a habit it would turn a deliberate skip back into an open
    // loop that settles as a miss.
    const skipped = (row.skipped_dates ?? []).includes(date);

    if (config.skipStatus) {
      // A habit: the store's toggleHabitStatus. The RPC owns the per-date
      // array and the streak; the companion update writes the status snapshot
      // and the day's tally, never the arrays. `dailyCounts` is written whole
      // by the column, so the stored map is merged with this one date rather
      // than replaced by a phone's copy of it.
      if (skipped) return NextResponse.json({ error: 'skipped' }, { status: 409 });
      await setItemCompletion(id, type, date, done, true, client);
      reportStake(userId, id, date, done);
      const updates: Partial<HabitItem> = {
        status: done ? 'done' : 'pending',
        ...(count !== undefined ? { dailyCounts: { ...(row.daily_counts ?? {}), [date]: count } } : {}),
        currentDayCount: count ?? row.current_day_count ?? 0,
      };
      await updateItem(id, type, updates, undefined, client);
      return ok();
    }

    // A tally belongs to a habit's daily target; nothing else has one.
    if (count !== undefined) return invalid({ count: ['only a habit takes a count'] });
    if (skipped) return NextResponse.json({ error: 'skipped' }, { status: 409 });

    // Through the registry, not the raw column: repeat_frequency has no
    // default, and NULL means the type's default (the itemFromRow fallback).
    const frequency = row.repeat_frequency ?? config.defaultFrequency;
    const recurring = Boolean(frequency) && frequency !== 'none';
    if (recurring) {
      // toggleTaskStatus's recurring branch: the per-date RPC and nothing
      // else. No status write and no event, as on the web.
      await setItemCompletion(id, type, date, done, true, client);
      reportStake(userId, id, date, done);
      return ok();
    }

    // A one-off: the scalar status, which stamps completed_at by trigger.
    await updateItem(id, type, { status: done ? config.doneStatus : 'pending' } as Partial<Task>, undefined, client);
    return ok();
  } catch (err) {
    return dbErrorResponse(err, 'app/items/:id');
  }
}

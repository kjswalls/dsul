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
  isMissingColumnError,
  loadPlannerData,
  setItemCompletion,
  setItemSkip,
  updateItem,
  type PlannerData,
} from './db';
import { getItemTypeConfig, type ItemTypeConfig } from './item-registry';
import { isPausableRow, resolveItemPause } from './item-pause';
import { DEFAULT_APP_ICON, isAppIcon, type AppIcon } from './app-icons';
import { isRecurring } from './recurrence';
import { canMoveToNextDay } from './row-moves';
import { getBucketForTime } from './time-bucket';
import { reportLiveCompletion } from './stakes/live';
import { createServiceClient } from './supabase-service';
import type { WeekStartDay } from './container-schedule';
import type { TimeFormat } from './reminders/copy';
import type { HabitItem, Item, Project, Routine, Season, Task, TaskItem } from './planner-types';

/**
 * The iPhone app's API: /api/app/planner, /api/app/items, /api/app/items/:id.
 * The route files are thin facades over the handlers here.
 *
 * Auth is lib/app-auth.ts: a Supabase access token as a bearer, and every
 * statement below runs on the caller's own client, so RLS is the tenant guard.
 *
 * WRITES ARE INTENTS, NEVER ARRAYS. Each thing the phone does (capture; tick,
 * skip or unskip a day; drop a braindump row on an hour; carry an item to
 * another day; pause or resume one) is one verb here that does what the web's
 * own store action does for the same gesture, through the same lib/db.ts
 * calls. Nothing accepts an absolute completedDates, skippedDates or
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
/** A well-formed intent the row's state refuses: a bare code, which the phone words. */
const refused = (error: string, status: 400 | 409) => NextResponse.json({ error }, { status });

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

/**
 * POST /api/app/items/:id, one member per intent. Kept apart from the
 * cross-field rule below so the planner payload can list its actions.
 */
const ItemWriteActions = z.discriminatedUnion('action', [
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
  z.object({
    action: z.literal('skip'),
    date: DateStrSchema,
    /** true skips the occurrence on `date`, false unskips it. */
    skipped: z.boolean(),
  }),
  z.object({
    action: z.literal('move'),
    /** The day to carry the item to. The phone picks it, as the web's verbs do. */
    date: DateStrSchema,
  }),
  z.object({
    action: z.literal('pause'),
    paused: z.boolean(),
    /** The exclusive resume day, with `paused: true` only. Never null: nothing clears an end yet. */
    pausedUntil: DateStrSchema.optional(),
    /** The device's zone, used only when the account has no usable one stored. */
    timeZone: z.string().max(100).optional(),
  }),
]);

export const ItemWriteSchema = ItemWriteActions.superRefine((body, ctx) => {
  // "Resume on Oct 8" is the one reading of this the server cannot honour (a
  // resume is today), so it is refused rather than half-done, as the agent
  // schemas refuse it.
  if (body.action === 'pause' && body.pausedUntil !== undefined && !body.paused) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pausedUntil'], message: 'only with paused: true' });
  }
});

/**
 * Every intent this server takes, in declaration order: the planner payload's
 * `writes`. Read off the union, so an intent cannot be accepted and unlisted.
 */
export const ITEM_WRITES = ItemWriteActions.options.map((option) => option.shape.action.value);
export type ItemWriteAction = (typeof ITEM_WRITES)[number];

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
  settings: {
    timezone: string | null;
    showCompletedTasks: boolean;
    /** The day the week starts on (week_start_day): the streak chip's week, Reschedule's "Next week". */
    weekStartDay: WeekStartDay;
    /** How a clock time reads (time_format): the chips' times and the reminder. */
    timeFormat: TimeFormat;
    /**
     * The App icon pick (lib/app-icons.ts), which the iPhone's home-screen
     * icon follows. Null means never chosen on any device (or a database
     * without migration 056), so the phone leaves its icon as it is.
     */
    appIcon: AppIcon | null;
  };
  /**
   * The item-write intents this server takes (ITEM_WRITES). The phone hides
   * a verb whose write is not listed, so a build that reaches users before
   * the server it talks to never offers a verb it would be refused. Absent,
   * from an older server, means ['complete', 'schedule'].
   */
  writes: ItemWriteAction[];
  items: Item[];
  projects: Project[];
  routines: Routine[] | null;
  seasons: Season[] | null;
}

/**
 * Named columns, never `*`: the same row holds `openclaw_api_key`, a plaintext
 * key with service-role power that RLS lets this token read.
 *
 * `app_icon` is migration 056, which may not be applied yet (it sits in
 * lib/settings-service.ts PENDING_SCHEMA_COLUMNS): PostgREST refuses the whole
 * select over one unknown column, so a missing one is read again without it.
 * The week start and the time format are migration 008, and stable.
 */
const STABLE_SETTINGS_COLUMNS = 'timezone, show_completed_tasks, week_start_day, time_format';
const SETTINGS_COLUMNS = `${STABLE_SETTINGS_COLUMNS}, app_icon`;

interface SettingsRow {
  timezone?: string | null;
  show_completed_tasks?: boolean | null;
  week_start_day?: string | null;
  time_format?: string | null;
  app_icon?: string | null;
}

async function readSettings(userId: string, client: Client): Promise<SettingsRow | null> {
  const read = (columns: string) =>
    client.from('user_settings').select(columns).eq('user_id', userId).maybeSingle();
  let result = await read(SETTINGS_COLUMNS);
  if (result.error && isMissingColumnError(result.error)) result = await read(STABLE_SETTINGS_COLUMNS);
  if (result.error) throw result.error;
  return result.data as SettingsRow | null;
}

/** The web's rule (migration 056): an unknown slug is Aurora, null is unchosen. */
function appIconFrom(value: string | null | undefined): AppIcon | null {
  if (value == null) return null;
  return isAppIcon(value) ? value : DEFAULT_APP_ICON;
}

/** The column's own default, Sunday, for a missing row or a value the app has no case for. */
function weekStartDayFrom(value: string | null | undefined): WeekStartDay {
  return value === 'monday' || value === 'saturday' ? value : 'sunday';
}

/** Anything but '24h' is 12-hour, as the reminder scan reads it (lib/reminders/scan.ts). */
function timeFormatFrom(value: string | null | undefined): TimeFormat {
  return value === '24h' ? '24h' : '12h';
}

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
    const [data, settings] = await Promise.all([
      loadPlannerData(userId, () => perTable(userId, client), client),
      readSettings(userId, client),
    ]);

    const payload: AppPlannerPayload = {
      v: 1,
      userId,
      fetchedAt: new Date().toISOString(),
      settings: {
        timezone: settings?.timezone ?? null,
        // The web's default when the row or the column is missing.
        showCompletedTasks: settings?.show_completed_tasks ?? true,
        weekStartDay: weekStartDayFrom(settings?.week_start_day),
        timeFormat: timeFormatFrom(settings?.time_format),
        appIcon: appIconFrom(settings?.app_icon),
      },
      writes: ITEM_WRITES,
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

/**
 * The row every intent decides on. Never completed_dates: no intent reads it
 * (a skip clears the day's completion through the idempotent RPC, unasked),
 * and it is the column that grows without bound.
 */
const WRITE_ROW_COLUMNS =
  'id, type, parent_item_id, repeat_frequency, status, start_date, time_bucket, in_project_block, ' +
  'skipped_dates, daily_counts, current_day_count, paused_at, paused_until';

interface WriteRow {
  id: string;
  type: string;
  parent_item_id: string | null;
  repeat_frequency: string | null;
  status: string | null;
  start_date: string | null;
  time_bucket: string | null;
  in_project_block: boolean | null;
  skipped_dates: string[] | null;
  daily_counts: Record<string, number> | null;
  current_day_count: number | null;
  paused_at: string | null;
  paused_until: string | null;
}

type ItemWrite = z.infer<typeof ItemWriteSchema>;
type IntentBody<A extends ItemWriteAction> = Extract<ItemWrite, { action: A }>;

/** What every intent knows once the row is read. */
interface WriteContext {
  userId: string;
  client: Client;
  id: string;
  /** The stored slug, never 'custom': every write filters on it. */
  type: string;
  config: ItemTypeConfig;
  row: WriteRow;
  /**
   * Through the registry, not the raw column: repeat_frequency has no
   * default, and NULL means the type's default (the itemFromRow fallback),
   * so a habit stored with NULL recurs daily rather than reading as one-shot.
   */
  frequency: string;
  recurring: boolean;
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
 * One verb on one item, each doing what the web's store action does for the
 * same gesture:
 *   complete  the row's tick (lib/item-toggle.ts → toggleHabitStatus / toggleTaskStatus)
 *   schedule  a braindump row dropped on an hour (handle-drag-end → scheduleTask)
 *   skip      Skip today / Unskip today (setItemSkipped)
 *   move      Tomorrow and Reschedule (moveTaskToDate)
 *   pause     Pause, Pause until and Resume (setItemPaused)
 *
 * The row is read first, under RLS, and a missing one is a 404. That read is
 * load-bearing, not politeness: set_item_completion, set_item_skip and
 * updateItem all filter on id and type only, so under the user's client
 * someone else's id is a silent no-op that would otherwise answer 200.
 *
 * Each gate is the server's copy of the web verb's capability check
 * (lib/item-verbs.ts), asked of the registry. Whether the day is due, done or
 * drawn at all is the surface's question, on the phone as on the web.
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
    .select(WRITE_ROW_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return dbErrorResponse(error, 'app/items/:id');
  const row = data as WriteRow | null;
  if (!row) return notFound();

  const config = getItemTypeConfig(row.type);
  const frequency = row.repeat_frequency ?? config.defaultFrequency;
  const ctx: WriteContext = {
    userId,
    client,
    id,
    type: row.type,
    config,
    row,
    frequency,
    recurring: isRecurring({ repeatFrequency: frequency }),
  };

  try {
    switch (body.action) {
      case 'complete':
        return await complete(ctx, body);
      case 'schedule':
        return await schedule(ctx, body);
      case 'skip':
        return await skip(ctx, body);
      case 'move':
        return await move(ctx, body);
      case 'pause':
        return await pause(ctx, body);
    }
  } catch (err) {
    return dbErrorResponse(err, 'app/items/:id');
  }
}

/**
 * `complete`: the web's tick.
 *
 * A skipped occurrence is refused outright, as toggleRowDone refuses it
 * (lib/item-toggle.ts): ticking it would leave a date both skipped and done,
 * and on a habit it would turn a deliberate skip back into an open loop that
 * settles as a miss. Its answer is `skip` with `skipped: false`.
 */
async function complete(ctx: WriteContext, body: IntentBody<'complete'>): Promise<Response> {
  const { userId, client, id, type, config, row } = ctx;
  const { date, done, count } = body;
  const skipped = (row.skipped_dates ?? []).includes(date);

  if (config.skipStatus) {
    // A habit: the store's toggleHabitStatus. The RPC owns the per-date
    // array and the streak; the companion update writes the status snapshot
    // and the day's tally, never the arrays. `dailyCounts` is written whole
    // by the column, so the stored map is merged with this one date rather
    // than replaced by a phone's copy of it.
    if (skipped) return refused('skipped', 409);
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
  if (skipped) return refused('skipped', 409);

  if (ctx.recurring) {
    // toggleTaskStatus's recurring branch: the per-date RPC and nothing
    // else. No status write and no event, as on the web.
    await setItemCompletion(id, type, date, done, true, client);
    reportStake(userId, id, date, done);
    return ok();
  }

  // A one-off: the scalar status, which stamps completed_at by trigger.
  await updateItem(id, type, { status: done ? config.doneStatus : 'pending' } as Partial<Task>, undefined, client);
  return ok();
}

/**
 * `schedule`: the web's drop of a braindump row onto an hour, scheduleTask
 * with the hour drop's arguments.
 */
async function schedule(ctx: WriteContext, body: IntentBody<'schedule'>): Promise<Response> {
  const { client, id, type, config } = ctx;
  // The write sets a start date, which only a date-anchored type reads. A
  // habit is not one, and its column allowlist would drop every field but
  // the bucket and time while the event still recorded them all.
  if (!config.dateAnchored) return refused('not_schedulable', 400);
  // A grid drop passes an hour bucket, never 'anytime', so autoCorrectBucket
  // always lands on the time's own bucket. The date is the day the row was
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

/**
 * `skip`: Skip today and Unskip today, the store's setItemSkipped, which
 * splits on whether the type's status vocabulary has a skip in it.
 *
 * Gate: the registry's isSkippable (a skippable type that recurs), and never
 * a subtask, which has no occurrence of its own. A one-off is completed,
 * cancelled or deleted, never skipped.
 *
 * Order: the day's completion is cleared BEFORE the skip is set, so a write
 * that fails halfway leaves the day open, never skipped-and-done.
 */
async function skip(ctx: WriteContext, body: IntentBody<'skip'>): Promise<Response> {
  const { userId, client, id, type, config, row } = ctx;
  if (!config.skippable || !ctx.recurring || row.parent_item_id) return refused('not_skippable', 400);
  const { date, skipped } = body;
  const changes = (row.skipped_dates ?? []).includes(date) !== skipped;

  if (config.skipStatus) {
    // A habit: toggleHabitStatus(skipped ? 'skipped' : 'pending'). Neither is
    // 'done', so the day's completion is cleared either way (an unskip on a
    // ticked day unticks it, as on the web), through the RPC that takes the
    // streak down only if the day was done. In the browser that RPC reports
    // to a live stake, so a skip retracts a datapoint already posted; this
    // reports it too. The skip RPC runs only when the skip changes. The
    // companion update is the status snapshot and the tally the row already
    // has: never the arrays, and never dailyCounts, which the web writes
    // whole from its copy and the phone only holds a window of.
    await setItemCompletion(id, type, date, false, true, client);
    reportStake(userId, id, date, false);
    if (changes) await setItemSkip(id, type, date, skipped, client);
    const updates: Partial<HabitItem> = {
      status: (skipped ? config.skipStatus : 'pending') as HabitItem['status'],
      currentDayCount: row.current_day_count ?? 0,
    };
    await updateItem(id, type, updates, undefined, client);
    return ok();
  }

  // Task-like: skippedDates and nothing else. `pending|completed|cancelled`
  // is an external contract with no skip in it, so no status write, no
  // updateItem and no event, and an unchanged skip is no write at all.
  if (!changes) return ok();
  if (skipped) {
    // A skipped occurrence is not a completed one. The store clears a done
    // day first; this clears it unasked, since the RPC is idempotent and the
    // row read leaves completed_dates out.
    await setItemCompletion(id, type, date, false, true, client);
    reportStake(userId, id, date, false);
  }
  await setItemSkip(id, type, date, skipped, client);
  return ok();
}

/**
 * `move`: Tomorrow and Reschedule, the store's moveTaskToDate. The phone picks
 * the day (nextDayTarget, or the one picked), as the web's verbs pass it in.
 *
 * Gate: lib/row-moves.ts canMoveToNextDay, asked of the row: a date-addressable
 * type, never recurring (startDate is the series anchor, with no per-occurrence
 * override), never inside a project block (nothing here clears it, so the item
 * would land nowhere visible), never finished. And never a subtask, which
 * shows only inside its parent. Refused is a 409: the row said no, not the body.
 */
async function move(ctx: WriteContext, body: IntentBody<'move'>): Promise<Response> {
  const { client, id, type, row } = ctx;
  const movable = {
    id,
    type: type === 'task' || type === 'habit' ? type : 'custom',
    customType: type,
    status: row.status as Task['status'],
    repeatFrequency: ctx.frequency as Task['repeatFrequency'],
    inProjectBlock: !!row.in_project_block,
    // Never read: a recurring row is refused before its days are asked about.
    completedDates: [] as string[],
  };
  const kind = type === 'habit' ? 'habit' : 'task';
  if (row.parent_item_id || !canMoveToNextDay(movable, kind, row.start_date ?? body.date)) {
    return refused('not_movable', 409);
  }
  // The bucket fallback is load-bearing: a day view lists only rows that have
  // a bucket, so a carry that wrote the date alone would land out of sight.
  // startTime is kept, as the web keeps it for a one-item carry.
  const updates: Partial<Task> = {
    startDate: body.date,
    timeBucket: (row.time_bucket ?? 'anytime') as Task['timeBucket'],
  };
  await updateItem(id, type, updates, undefined, client);
  return ok();
}

/**
 * `pause`: Pause, Pause until and Resume, the store's setItemPaused, resolved
 * by the code the agent API's PATCH uses (lib/item-pause.ts), so the two doors
 * cannot disagree about what pausing writes.
 *
 * Refused (a resume day that is not after today) is a 409. A request already
 * satisfied (pausing a paused item, resuming a live one) writes nothing and
 * answers 200, so a retried pause never restamps pausedAt, which would drag
 * the interval's start forward and un-hide the days between.
 */
async function pause(ctx: WriteContext, body: IntentBody<'pause'>): Promise<Response> {
  const { userId, client, id, type, row } = ctx;
  if (!isPausableRow(row)) return refused('not_pausable', 400);
  const zone = await pauseZone(client, userId, body.timeZone);
  const resolved = resolveItemPause(row, { paused: body.paused, pausedUntil: body.pausedUntil }, zone, new Date());
  if ('reason' in resolved) return refused('pause_refused', 409);
  if (Object.keys(resolved.patch).length === 0) return ok();
  await updateItem(id, type, resolved.patch, undefined, client);
  return ok();
}

/** A zone this runtime can resolve a day in. */
function isTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a pause resolves "today" in: the user's stored zone, else the
 * device's, else UTC. That is the rule the phone uses to say "today", so the
 * resume day it shows is the one written. Each candidate counts only if Intl
 * knows it, so a junk value falls through rather than throwing mid-write.
 *
 * A failed read throws, unlike the agent API's silent UTC: the phone retries a
 * failed write, and a pause resolved in the wrong zone is a wrong write.
 */
async function pauseZone(client: Client, userId: string, deviceZone: string | undefined): Promise<string> {
  const { data, error } = await client.from('user_settings').select('timezone').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const stored = (data as { timezone?: string | null } | null)?.timezone?.trim();
  for (const zone of [stored, deviceZone?.trim()]) {
    if (zone && isTimeZone(zone)) return zone;
  }
  return 'UTC';
}

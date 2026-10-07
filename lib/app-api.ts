import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PrioritySchema, RepeatFrequencySchema, TimeBucketSchema } from '@dsul/types';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import {
  createItem,
  deleteItem,
  fetchItems,
  fetchItemTypes,
  fetchProjects,
  fetchRoutines,
  fetchSeasons,
  fetchUserExtensions,
  isMissingColumnError,
  loadPlannerData,
  setItemCompletion,
  setItemSkip,
  updateItem,
  type PlannerData,
} from './db';
import { getItemTypeConfig, type ItemTypeConfig } from './item-registry';
import {
  editPatch,
  editRefusal,
  editShapeFromRow,
  MAX_DURATION_MINUTES,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  resetStreakPatch,
  resetStreakRefusal,
  scheduleTaskPatch,
  subtaskRefusal,
  TIMES_PER_DAY_MAX,
} from './item-edit';
import { demoteInvalidGoalRoles } from './goal-roles';
import { EXT_STREAKS, resolveEnabled } from './extension-registry';
import { isPausableRow, resolveItemPause } from './item-pause';
import { DEFAULT_APP_ICON, isAppIcon, type AppIcon } from './app-icons';
import { isRecurring } from './recurrence';
import { canReschedule } from './row-moves';
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
 * another day; pause or resume one; retitle it, rewrite its notes or delete
 * it; add a subtask under it, reset its streak; set its priority, a habit's
 * times a day, its reminder, its part of day, time and length, or how it
 * repeats; or file it under a project) is one verb here that does what the
 * web's own store action does for the same gesture, through the same lib/db.ts
 * calls.
 * Nothing accepts an absolute completedDates, skippedDates or dailyCounts: the
 * phone reads a 400-day window, and an array written back from a window
 * deletes what the window did not show. Nor is there a generic
 * `edit`: each field is its own action, so a server that doesn't take one
 * refuses it (400) rather than dropping the key and answering 200, and the
 * phone hides any editor whose action `writes` doesn't list.
 *
 * WEBHOOKS MATCH THE BROWSER UI, WHICH FIRES NONE. The store never passes a
 * userId to updateItem or deleteItem (planner-store.ts updateItemAction,
 * deleteTask), and notifyPlugins is a no-op without a service key, so a tick
 * or a capture typed on the web reaches no plugin. These calls keep it that
 * way: updateItem and deleteItem get no userId, and createItem gets
 * `notify: false`. The item_events rows are written exactly as the web writes
 * them.
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
  title: z.string().trim().min(1).max(NEW_TITLE_LIMIT),
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
  // The sheet's edits (lib/item-edit.ts). Strict, so a key a newer phone adds
  // is refused by an older server instead of dropped while it answers 200.
  // These bounds are only what a request may carry; the caps that matter are
  // growth caps, which need the row (editRefusal).
  z
    .object({
      action: z.literal('title'),
      title: z.string().trim().min(1).max(OUTER_LIMITS.title),
    })
    .strict(),
  z
    .object({
      action: z.literal('notes'),
      /** null clears them, as does text that trims to nothing. */
      notes: z.string().max(OUTER_LIMITS.notes).nullable(),
    })
    .strict(),
  z.object({ action: z.literal('delete') }).strict(),
  // A new subtask under this item, with the phone's own id, so a retry is the
  // same row. New text, so the plain cap: there is nothing stored to grow from.
  z
    .object({
      action: z.literal('addSubtask'),
      id: z
        .string()
        .regex(UUID, 'expected a uuid')
        .transform((id) => id.toLowerCase()),
      title: z.string().trim().min(1).max(NEW_TITLE_LIMIT),
    })
    .strict(),
  z.object({ action: z.literal('resetStreak') }).strict(),
  // The chips (2c). Each is one property, decided on the row by
  // lib/item-edit.ts as the typed fields are.
  z.object({ action: z.literal('priority'), priority: PrioritySchema.nullable() }).strict(),
  z
    .object({
      action: z.literal('timesPerDay'),
      timesPerDay: z.number().int().min(1).max(TIMES_PER_DAY_MAX),
    })
    .strict(),
  z
    .object({
      action: z.literal('reminder'),
      /** HH:mm, or null to turn the reminder off, which clears the anchor too. */
      time: TimeStrSchema.nullable(),
      /** The cue words. Absent keeps the stored ones; null or blank clears them. Only with a time. */
      anchor: z.string().max(OUTER_LIMITS.anchor).nullable().optional(),
    })
    .strict(),
  // The Time chip (2d): part of day, a specific time and a length, each only when it changed.
  z
    .object({
      action: z.literal('time'),
      /** null is none: a habit's "No specific bucket". A task's none reads as Anytime. */
      timeBucket: TimeBucketSchema.nullable().optional(),
      /** HH:mm, or null for no specific time. Only beside a part of day that holds one. */
      startTime: TimeStrSchema.nullable().optional(),
      /** Minutes. */
      duration: z.number().int().min(1).max(MAX_DURATION_MINUTES).optional(),
    })
    .strict(),
  // The Repeat chip (2e): a frequency, with its days or its day of the month.
  z
    .object({
      action: z.literal('repeat'),
      frequency: RepeatFrequencySchema,
      /** 0 = Sun … 6 = Sat. Custom days only; ascending, each day once (the superRefine). */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      /** Monthly only. A short month takes its last day (lib/recurrence.ts). */
      monthDay: z.number().int().min(1).max(31).optional(),
    })
    .strict(),
  // The project chip (2f): a project by id, or null for No project. The route reads its name.
  z
    .object({
      action: z.literal('project'),
      projectId: z
        .string()
        .regex(UUID, 'expected a uuid')
        .transform((id) => id.toLowerCase())
        .nullable(),
    })
    .strict(),
]);

export const ItemWriteSchema = ItemWriteActions.superRefine((body, ctx) => {
  // "Resume on Oct 8" is the one reading of this the server cannot honour (a
  // resume is today), so it is refused rather than half-done, as the agent
  // schemas refuse it.
  if (body.action === 'pause' && body.pausedUntil !== undefined && !body.paused) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pausedUntil'], message: 'only with paused: true' });
  }
  // Off clears the cue words with the time, so words sent with no time would
  // be dropped while the answer said 200. The phone never builds this body.
  if (body.action === 'reminder' && body.time === null && body.anchor !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['anchor'], message: 'only with a time' });
  }
  if (body.action === 'time') {
    // An empty time edit would answer 200 having done nothing; the phone never sends one.
    if (body.timeBucket === undefined && body.startTime === undefined && body.duration === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'nothing to change' });
    }
    // Anytime and none hold no time (the dialog's Anytime row clears it).
    if (typeof body.startTime === 'string' && (body.timeBucket === 'anytime' || body.timeBucket === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'only with a part of day' });
    }
  }
  if (body.action === 'repeat') {
    // The days belong to Custom days and the day to Monthly, as the chip shows them; beside
    // another frequency the server would drop them while answering 200. The phone never
    // builds such a body.
    const custom = body.frequency === 'custom';
    if (custom !== (body.days !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['days'], message: custom ? 'required' : 'only with custom' });
    }
    // Refused, never coerced: the dialog's keys sort as they toggle and never hold a day twice.
    const days = body.days ?? [];
    if (days.some((day, i) => i > 0 && day <= days[i - 1])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['days'], message: 'ascending, each day once' });
    }
    const monthly = body.frequency === 'monthly';
    if (monthly !== (body.monthDay !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['monthDay'], message: monthly ? 'required' : 'only with monthly' });
    }
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
    /**
     * The Streaks extension (lib/extension-registry.ts EXT_STREAKS, on unless
     * the user turned it off): off hides the sheet's streak chip and the flame
     * on Today's rows. Absent, from an older server, reads as on.
     */
    streaksEnabled: boolean;
    /**
     * Habit reminders (Settings → Rituals; habit_reminders_enabled, migration
     * 032), the switch that lets any reminder through. False when off or never
     * set, as the reminder scan reads it (lib/reminders/scan.ts counts only
     * true). Null when the column couldn't be read (a database behind on its
     * migrations), so the phone says nothing rather than "off". Absent, from an
     * older server, means the same.
     */
    remindersEnabled: boolean | null;
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
  /**
   * The user's own item types (item_types, migration 021), named as the web
   * names them: a custom item's eyebrow, its title placeholder and its delete
   * words read the label. Null when the table is unreachable, which the phone
   * reads as no custom labels (the slug, capitalised, as getItemTypeConfig's
   * fallback does). Absent, from an older server, means the same.
   */
  itemTypes: AppItemType[] | null;
}

/** One custom type's names, and nothing of its config: the phone's capabilities come from the registry port. */
export interface AppItemType {
  name: string;
  label: string;
  labelPlural: string;
}

/**
 * Named columns, never `*`: the same row holds `openclaw_api_key`, a plaintext
 * key with service-role power that RLS lets this token read.
 *
 * The week start and the time format are migration 008, and stable.
 */
const STABLE_SETTINGS_COLUMNS = 'timezone, show_completed_tasks, week_start_day, time_format';
/**
 * `app_icon` is migration 056 and `habit_reminders_enabled` 032; both sit in
 * lib/settings-service.ts PENDING_SCHEMA_COLUMNS. PostgREST refuses the whole
 * select over one unknown column, so a missing one is read again without
 * either (`full` is then false).
 */
const SETTINGS_COLUMNS = `${STABLE_SETTINGS_COLUMNS}, app_icon, habit_reminders_enabled`;

interface SettingsRow {
  timezone?: string | null;
  show_completed_tasks?: boolean | null;
  week_start_day?: string | null;
  time_format?: string | null;
  app_icon?: string | null;
  habit_reminders_enabled?: boolean | null;
}

interface SettingsRead {
  row: SettingsRow | null;
  /** False when the newer columns couldn't be read and the stable set was read instead. */
  full: boolean;
}

async function readSettings(userId: string, client: Client): Promise<SettingsRead> {
  const read = (columns: string) =>
    client.from('user_settings').select(columns).eq('user_id', userId).maybeSingle();
  let full = true;
  let result = await read(SETTINGS_COLUMNS);
  if (result.error && isMissingColumnError(result.error)) {
    full = false;
    result = await read(STABLE_SETTINGS_COLUMNS);
  }
  if (result.error) throw result.error;
  return { row: result.data as SettingsRow | null, full };
}

/**
 * Whether the Streaks extension is on, as the web's gate reads it
 * (lib/extension-gates.ts streaksEnabled): the user's row, else the manifest's
 * default. fetchUserExtensions answers null for a missing table and rethrows
 * anything else, which is caught here: a flame shown by mistake costs less
 * than a planner that won't load.
 */
async function readStreaksEnabled(userId: string, client: Client): Promise<boolean> {
  try {
    return resolveEnabled((await fetchUserExtensions(userId, client)) ?? {}, EXT_STREAKS);
  } catch (err) {
    console.error('[app/planner] extensions read failed:', err instanceof Error ? err.message : err);
    return resolveEnabled({}, EXT_STREAKS); // the manifest default, true
  }
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
 * caller's client. Goals are left out: the phone doesn't read them yet, and
 * null is their "unreachable" value. Item types are read, since the sheet
 * words a custom item by its label; fetchItemTypes answers null rather than
 * throwing when its table is missing, so the load still answers.
 */
async function perTable(userId: string, client: Client): Promise<PlannerData> {
  const [items, projects, itemTypes, routines, seasons] = await Promise.all([
    fetchItems(userId, undefined, client),
    fetchProjects(userId, client),
    fetchItemTypes(userId, client),
    fetchRoutines(userId, client),
    fetchSeasons(userId, client),
  ]);
  return { items, projects, itemTypes, routines, seasons, goals: null };
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
    const [data, { row: settings, full }, streaksEnabled] = await Promise.all([
      loadPlannerData(userId, () => perTable(userId, client), client),
      readSettings(userId, client),
      readStreaksEnabled(userId, client),
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
        streaksEnabled,
        // Only true lets a reminder through (the scan's own test), so a missing
        // row or a null column is off. Unread is unknown, never off.
        remindersEnabled: full ? settings?.habit_reminders_enabled === true : null,
      },
      writes: ITEM_WRITES,
      items: data.items,
      projects: data.projects,
      routines: data.routines,
      seasons: data.seasons,
      // Named fields only: a def also carries its icon, colour and config.
      itemTypes: data.itemTypes?.map(({ name, label, labelPlural }) => ({ name, label, labelPlural })) ?? null,
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

  let order: number;
  try {
    order = await nextTaskOrder(client, userId);
  } catch (err) {
    return dbErrorResponse(err, 'app/items');
  }

  const item: TaskItem = {
    type: 'task',
    id,
    title,
    status: 'pending',
    isScheduled: false,
    order,
  };

  try {
    await createItem(userId, item, client, { notify: false });
  } catch (err) {
    if (errorCode(err) === '23505') return captureRetry(client, id);
    return dbErrorResponse(err, 'app/items');
  }
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

/**
 * The `order` the web's addTask gives a new task: `tasks.length`, every live
 * task-like row that is not a subtask, which is the store's `tasks`
 * projection. A capture and a new subtask both take it. Throws a failed count.
 */
async function nextTaskOrder(client: Client, userId: string): Promise<number> {
  const { count, error } = await client
    .from('items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('type', 'habit')
    .is('parent_item_id', null)
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
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

/**
 * What an edit reads on top: only the column it decides on. A tick never reads
 * the notes, which can run to 200,000 characters.
 */
const EDIT_COLUMNS: Partial<Record<ItemWriteAction, string>> = {
  title: 'title',
  notes: 'notes',
  resetStreak: 'streak',
  priority: 'priority',
  timesPerDay: 'times_per_day',
  reminder: 'reminder_time, reminder_anchor',
  // start_date, time_bucket and in_project_block are in every read.
  time: 'start_time, is_scheduled, duration',
  // repeat_frequency is in every read.
  repeat: 'repeat_days, repeat_month_day',
  // in_project_block is in every read.
  project: 'project, project_id, previous_start_time, previous_start_date',
};

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
  /** EDIT_COLUMNS: present only when the action read it. */
  title?: string | null;
  notes?: string | null;
  streak?: number | null;
  priority?: string | null;
  times_per_day?: number | null;
  reminder_time?: string | null;
  reminder_anchor?: string | null;
  start_time?: string | null;
  is_scheduled?: boolean | null;
  duration?: number | null;
  repeat_days?: number[] | null;
  repeat_month_day?: number | null;
  project?: string | null;
  project_id?: string | null;
  previous_start_time?: string | null;
  previous_start_date?: string | null;
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
 *   title     the title, typed (the dialog's title field → updateTask / updateHabit)
 *   notes     the notes, typed or cleared (the dialog's notes field, likewise)
 *   delete    Delete (deleteTask, with its subtasks / deleteHabit)
 *   addSubtask  a new subtask, typed (SubtasksSection → addTask) or one line of a paste (→ addTasksBulk)
 *   resetStreak Reset streak (resetHabitStreak)
 *   priority     the priority chip (the dialog's priority → updateTask)
 *   timesPerDay  a habit's times a day (the dialog's chip → updateHabit)
 *   reminder     Remind, its time and cue words together, or off (the dialog's chip, reminderPatch)
 *   time         part of day, a specific time and a length (the dialog's Time chip, commitEdit)
 *   repeat       how it repeats, its three keys together (the dialog's Repeat chip, repeatPatch),
 *                then any goal role it left untrue demoted (lib/goal-roles.ts)
 *   project      its project, by id, the name read here (the bulk Move to project's rule,
 *                projectRefilePatch), leaving a project block it no longer belongs to
 *
 * The row is read first, under RLS, and a missing one is a 404. That read is
 * load-bearing, not politeness: set_item_completion, set_item_skip,
 * updateItem and deleteItem all filter on id and type only, so under the
 * user's client someone else's id is a silent no-op that would otherwise
 * answer 200. A delete reads once more on a miss (deleteTrashed), since an
 * item already in the Trash is a delete that has landed.
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

  const extra = EDIT_COLUMNS[body.action];
  const { data, error } = await client
    .from('items')
    .select(extra ? `${WRITE_ROW_COLUMNS}, ${extra}` : WRITE_ROW_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return dbErrorResponse(error, 'app/items/:id');
  const row = data as WriteRow | null;
  if (!row) return body.action === 'delete' ? deleteTrashed(client, userId, id) : notFound();

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
      case 'title':
      case 'notes':
      case 'priority':
      case 'timesPerDay':
      case 'reminder':
      case 'time':
      case 'repeat':
      case 'project':
        return await edit(ctx, body);
      case 'delete':
        return await del(client, userId, id, row.type);
      case 'addSubtask':
        return await addSubtask(ctx, body);
      case 'resetStreak':
        return await resetStreak(ctx);
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
  // dropped on, which is the anchor a braindump row needs to show there. The
  // rest is the store's own patch, so the block release is stated once.
  const updates: Partial<Task> = {
    ...scheduleTaskPatch(getBucketForTime(body.startTime), body.startTime),
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
 * Gate: lib/row-moves.ts canReschedule, the looser of the two verbs' gates,
 * asked of the row: a date-addressable type, never inside a project block
 * (nothing here clears it, so the item would land nowhere visible), never
 * finished. A recurring task may move: the picked day becomes the series
 * start, which always shows as an occurrence. Tomorrow's own refusal of a
 * series (canMoveToNextDay) is the phone's to keep, since the write is the
 * same. And never a subtask, which shows only inside its parent. Refused is a
 * 409: the row said no, not the body.
 */
async function move(ctx: WriteContext, body: IntentBody<'move'>): Promise<Response> {
  const { userId, client, id, type, row } = ctx;
  const kind = type === 'habit' ? 'habit' : 'task';
  // The day the gate asks about, as the web's rowDateOf does: the row's own
  // date, or the target for an undated one.
  const dateStr = row.start_date ?? body.date;
  // Whether that day is done matters only for a series (isOpenOn), so only
  // then is it asked, and of that one date: the row read leaves
  // completed_dates out.
  let completedDates: string[] = [];
  if (kind === 'task' && ctx.recurring && !row.parent_item_id) {
    const { data, error } = await client
      .from('items')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .contains('completed_dates', [dateStr])
      .maybeSingle();
    if (error) throw error;
    if (data) completedDates = [dateStr];
  }
  const movable = {
    id,
    type: type === 'task' || type === 'habit' ? type : 'custom',
    customType: type,
    status: row.status as Task['status'],
    repeatFrequency: ctx.frequency as Task['repeatFrequency'],
    inProjectBlock: !!row.in_project_block,
    completedDates,
  };
  if (row.parent_item_id || !canReschedule(movable, kind, dateStr)) {
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

/**
 * `title` and `notes`, the dialog's typed fields, and `priority`, `timesPerDay`
 * and `reminder`, its chips: one key each (the reminder's two together, as
 * reminderPatch writes them), through lib/item-edit.ts. Already so is 200 with
 * no write, as the dialog's autosave skips a draft that didn't change, so a
 * retried edit writes no second event. updateItem takes the row's own type, so
 * a custom item's priority goes through taskUpdatesToRow and a habit's count
 * through habitUpdatesToRow. Nothing here clears reminder_sent_key (a new time
 * re-arms itself; lib/db.ts says why) or a snooze.
 *
 * `time`, the Time chip, is the dialog's commitEdit over the keys sent
 * (timeEditPatch): one updateItem where the web makes up to two, the same end
 * row, and a project block released when the part of day moves
 * (scheduleTaskPatch). It never writes the date; the Date chip is `move`.
 *
 * `repeat`, the Repeat chip, is the dialog's save over the keys sent
 * (repeatEditPatch): all three keys whenever any moved, never the date, the
 * status or the streak. Then `demoteRoles`.
 *
 * `project`, the project chip, is the bulk Move to project's write
 * (`projectRefilePatch`) for the project the route reads first: its own name
 * and id, and a parked task released from the block it no longer belongs to;
 * nothing when the item is already there by folded name and id. A project
 * missing, trashed or another user's is `project_gone`.
 */
async function edit(
  ctx: WriteContext,
  body: IntentBody<'title' | 'notes' | 'priority' | 'timesPerDay' | 'reminder' | 'time' | 'repeat' | 'project'>,
): Promise<Response> {
  const { client, id, type, config, row } = ctx;
  const shape = editShapeFromRow(row);
  const refusal = editRefusal(shape, body, config);
  if (refusal) return refused(refusal.code, refusal.status);
  let project: { id: string; name: string } | null | undefined;
  if (body.action === 'project') {
    const target = await projectTarget(ctx, body.projectId);
    if (target === 'gone') return refused('project_gone', 409);
    project = target;
  }
  const patch = editPatch(shape, body, config, { project });
  if (Object.keys(patch).length > 0) {
    try {
      await updateItem(id, type, patch, undefined, client);
    } catch (err) {
      // items.project_id references projects: one purged between the read and this write.
      if (body.action === 'project' && errorCode(err) === '23503') return refused('project_gone', 409);
      throw err;
    }
  }
  if (body.action === 'repeat') await demoteRoles(ctx);
  return ok();
}

/**
 * The project a `project` edit names, read live under RLS: null for No project, 'gone' for one
 * that is missing, in the Trash or another user's (all three read as no row). Its own name is what
 * the item is filed under, as the web's pickers file it.
 */
async function projectTarget(
  ctx: WriteContext,
  projectId: string | null,
): Promise<{ id: string; name: string } | null | 'gone'> {
  if (projectId === null) return null;
  const { data, error } = await ctx.client
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', ctx.userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  const found = data as { id: string; name: string } | null;
  return found ? { id: found.id, name: found.name } : 'gone';
}

/**
 * A repeat can leave a goal role untrue: a milestone that now repeats, or a check-in that no
 * longer does. The web's store takes it back in the same gesture (planGoalRoleDemotion); the
 * phone holds no goals, so the route does it here, through the rule the agent PATCH runs
 * (lib/goal-roles.ts), on the user's own client, once the write has landed. Also when the edit
 * changed nothing, so a demotion that failed after an earlier write is put right by the next.
 * A failure is logged and swallowed: the item write landed, and an error here would make the
 * phone undo a change the server kept.
 */
async function demoteRoles(ctx: WriteContext): Promise<void> {
  try {
    await demoteInvalidGoalRoles(ctx.client, ctx.userId, ctx.id);
  } catch (err) {
    console.error('[app/items] goal role demotion failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * `addSubtask`: the web's new subtask, SubtasksSection's addTask({title,
 * parentItemId}), under the item this route names. A `task` even under a
 * custom item, pending and unscheduled, with nothing of its parent's
 * inherited: the store's addTask with no bucket, as capture is.
 *
 * `order` is capture's (nextTaskOrder), the web's `tasks.length`, which a
 * subtask doesn't count itself in. A pasted list arrives as one add per line,
 * so its subtasks share that order and list in the order they were inserted
 * (load_planner sorts by order, then created_at); the web's addTasksBulk writes
 * base+i in one INSERT instead. Same list, either way.
 *
 * Idempotent by the phone's id, as capture is (addSubtaskRetry). And the parent
 * is read again once the child is in: one deleted on another device between
 * the two reads would leave a live child under a parent in the Trash, out of
 * every view, so the child follows it there and the answer is 409
 * `parent_gone`.
 */
async function addSubtask(ctx: WriteContext, body: IntentBody<'addSubtask'>): Promise<Response> {
  const { userId, client, id, config, row } = ctx;
  const refusal = subtaskRefusal(editShapeFromRow(row), config);
  if (refusal) return refused(refusal.code, refusal.status);

  const order = await nextTaskOrder(client, userId);
  const child: TaskItem = {
    type: 'task',
    id: body.id,
    title: body.title,
    status: 'pending',
    isScheduled: false,
    order,
    parentItemId: id,
  };
  try {
    await createItem(userId, child, client, { notify: false });
  } catch (err) {
    if (errorCode(err) === '23505') return addSubtaskRetry(client, body.id, id);
    throw err;
  }

  const { data, error } = await client
    .from('items')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    await deleteItem(body.id, 'task', undefined, client);
    return refused('parent_gone', 409);
  }
  return NextResponse.json({ ok: true, id: body.id }, { status: 201 });
}

/**
 * A new subtask whose id is taken: the first try landed when the row under it
 * is this user's live task under this parent, and the retry answers 200.
 * Anything else is a conflict, said no more about than capture's
 * (captureRetry): another user's row is invisible under RLS.
 */
async function addSubtaskRetry(client: Client, childId: string, parentId: string): Promise<Response> {
  const { data, error } = await client
    .from('items')
    .select('id, type, parent_item_id, deleted_at')
    .eq('id', childId)
    .maybeSingle();
  if (error) throw error;
  const found = data as { type?: string; parent_item_id?: string | null; deleted_at?: string | null } | null;
  if (found && found.type === 'task' && found.parent_item_id === parentId && found.deleted_at == null) {
    return NextResponse.json({ ok: true, id: childId }, { status: 200 });
  }
  return refused('conflict', 409);
}

/**
 * `resetStreak`: Reset streak, the store's resetHabitStreak, through
 * lib/item-edit.ts. The counter alone (habitUpdatesToRow writes `streak` and
 * nothing else), never completed_dates or daily_counts, the completion history
 * a reset keeps. A streak already 0 is 200 with no write and no event. The
 * Streaks extension isn't asked, as the store doesn't ask it: the phone hides
 * the control when it is off.
 */
async function resetStreak(ctx: WriteContext): Promise<Response> {
  const { client, id, type, config, row } = ctx;
  const refusal = resetStreakRefusal(config);
  if (refusal) return refused(refusal.code, refusal.status);
  const patch = resetStreakPatch(editShapeFromRow(row));
  if (Object.keys(patch).length === 0) return ok();
  await updateItem(id, type, patch, undefined, client);
  return ok();
}

/**
 * `delete`: the web's Delete, deleteTask for anything that can hold subtasks
 * and deleteHabit for the rest. To the Trash, as there: deleteItem stamps
 * deleted_at, and the Trash restores for 30 days.
 *
 * The children are read BEFORE the parent goes, as deleteTask takes them from
 * the store before it removes anything, and each gets its own deleteItem and
 * its own 'delete' event after the parent's, in the store's order. deleteItem
 * cascades by itself too (lib/db.ts), so this is the web's belt and braces,
 * not a second rule: a parent deleted alone still takes its subtasks along.
 */
async function del(client: Client, userId: string, id: string, type: string): Promise<Response> {
  const children = getItemTypeConfig(type).subtasks ? await liveChildren(client, userId, id) : [];
  await deleteItem(id, type, undefined, client);
  for (const child of children) await deleteItem(child.id, child.type, undefined, client);
  return ok();
}

/**
 * A delete whose item has no live row: answered 200 when it is in the Trash
 * (the delete landed, perhaps from an earlier try whose answer was lost, or
 * from another device), and 404 `not_found` when there is no such row of this
 * user's at all. The phone counts that 404 as landed too, by its code: the row
 * is gone either way.
 *
 * A trashed parent's live subtasks are deleted on the way, which is what a
 * retry is for: deleteItem's own cascade only logs a failure (lib/db.ts), so a
 * parent can reach the Trash with children left behind, unreachable.
 */
async function deleteTrashed(client: Client, userId: string, id: string): Promise<Response> {
  try {
    const { data, error } = await client
      .from('items')
      .select('id, type, deleted_at')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { type: string; deleted_at: string | null } | null;
    if (!row) return notFound();
    // Restored between the two reads: it is live again, and this is its delete.
    if (row.deleted_at == null) return await del(client, userId, id, row.type);
    if (!getItemTypeConfig(row.type).subtasks) return ok();
    for (const child of await liveChildren(client, userId, id)) {
      await deleteItem(child.id, child.type, undefined, client);
    }
    return ok();
  } catch (err) {
    return dbErrorResponse(err, 'app/items/:id');
  }
}

/**
 * deleteTask's children: the live task-like rows under `id`, in the order the
 * planner loads them (load_planner, fetchItems), so their events land in the
 * order the web's would.
 */
async function liveChildren(client: Client, userId: string, id: string): Promise<{ id: string; type: string }[]> {
  const { data, error } = await client
    .from('items')
    .select('id, type')
    .eq('parent_item_id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .neq('type', 'habit')
    .order('order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as { id: string; type: string }[];
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

import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PrioritySchema, RepeatFrequencySchema, TimeBucketSchema } from '@dsul/types';
import { authenticateAppRequest, dbErrorResponse } from './app-auth';
import {
  addContainerMember,
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
  removeContainerMember,
  updateItem,
  type PlannerData,
} from './db';
import {
  applyComplete,
  applyMove,
  applySkip,
  completedOn,
  nextTaskOrder,
  writeContextFor,
  WRITE_ROW_COLUMNS,
  type IntentResult,
  type WriteContext,
  type WriteRow,
} from './item-intents';
import { getItemTypeConfig, isCollectible } from './item-registry';
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
import { capabilityShape, isPausableRow, resolveItemPause } from './item-pause';
import { DEFAULT_APP_ICON, isAppIcon, type AppIcon } from './app-icons';
import { getBucketForTime } from './time-bucket';
import { reportLiveCompletion } from './stakes/live';
import { notifyPlugins } from './openclaw-registry';
import { createServiceClient } from './supabase-service';
import { SNOOZE_MINUTES } from './reminders/channels/push';
import { REMINDER_GRACE_MINUTES } from './reminders/due';
import { snoozeFireInstant } from './reminders/snooze';
import { saveTimezone } from './user-timezone';
import type { WeekStartDay } from './container-schedule';
import type { TimeFormat } from './reminders/copy';
import type { Item, Project, Routine, Season, Task, TaskItem } from './planner-types';

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
 * repeats; file it under a project, or add it to a routine or a season, or
 * take it out) is one verb here that does what the web's own store action does
 * for the same gesture, through the same lib/db.ts calls.
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

/**
 * The longest snooze a request may ask for. The buttons promise SNOOZE_MINUTES;
 * this only bounds a body, and the day gate cuts any snooze at local midnight.
 */
export const SNOOZE_MAX_MINUTES = 240;

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
  // Routines and seasons (2f): join or leave one, a single membership row, never a list.
  z
    .object({
      action: z.literal('collect'),
      kind: z.enum(['routine', 'season']),
      containerId: z
        .string()
        .regex(UUID, 'expected a uuid')
        .transform((id) => id.toLowerCase()),
      member: z.boolean(),
    })
    .strict(),
  // A notification's Snooze on the phone (reminders Phase 2): the web's
  // /api/reminders/act snooze, behind the bearer, with the day gate the web's
  // lacks. Its Done is `complete`, which clears the snooze.
  z
    .object({
      action: z.literal('snooze'),
      /** The day the notification was about, which the snooze belongs to (habit-reminders.md decision 8). */
      date: DateStrSchema,
      /** Absent is SNOOZE_MINUTES, the length the button promises. */
      minutes: z.number().int().min(1).max(SNOOZE_MAX_MINUTES).optional(),
      /** The device's zone, used only when the account has no usable one stored. */
      timeZone: z.string().max(100).optional(),
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
    /**
     * The last call (habit_last_call_enabled, migration 032), as the scan reads
     * it: only true is on. Null when unread, as remindersEnabled is. The phone
     * never rings it (server-only until APNs, reminders-platforms.md §2.3); it
     * reads it to say so.
     */
    lastCallEnabled: boolean | null;
    /** habit_last_call_time, 'HH:mm', as stored; null when unset or unread. */
    lastCallTime: string | null;
    /** The end-of-day review's switch (eod_review_enabled): only true is on, as the scan reads it. */
    eodReviewEnabled: boolean;
    /** eod_review_time as stored, 'HH:mm' or the looser 'H:mm' lib/eod.ts reads; null when unset. */
    eodReviewTime: string | null;
    /** last_eod_review_date: the day the last review was FOR (lib/eod.ts reviewedDay). */
    lastEodReviewDate: string | null;
    /**
     * How long after its minute a missed cue may still ring (the scan's
     * REMINDER_GRACE_MINUTES): the phone's catch-up window, so the two agree.
     */
    reminderGraceMinutes: number;
  };
  /**
   * Every pending snooze on a live item (reminder_snooze_until/date, migration
   * 032), as lib/reminders/plan.ts's PlanSnooze: the phone arms each one that
   * still rings on its own day (ringsOnDay). Stale ones are sent as stored;
   * the plan gates them, as the scan does. Null when the columns couldn't be
   * read (a database behind on its migrations), which the phone reads as
   * none. Absent, from an older server, means the same.
   */
  snoozes: AppSnooze[] | null;
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

/** A pending snooze: lib/reminders/plan.ts PlanSnooze. */
export interface AppSnooze {
  itemId: string;
  /** reminder_snooze_until: an ISO instant. */
  until: string;
  /** reminder_snooze_date: the local day the snooze belongs to, yyyy-MM-dd. */
  date: string;
}

/** One custom type's names, and nothing of its config: the phone's capabilities come from the registry port. */
export interface AppItemType {
  name: string;
  label: string;
  labelPlural: string;
}

/**
 * Named columns, never `*`: the row is the user's own and RLS lets this token
 * read all of it. It held the plaintext agent key until migration 059 moved it
 * to user_secrets; the habit stays.
 *
 * The week start and the time format are migration 008, and the review's
 * three columns 002/010, all stable.
 */
const STABLE_SETTINGS_COLUMNS =
  'timezone, show_completed_tasks, week_start_day, time_format, eod_review_enabled, eod_review_time, last_eod_review_date';
/**
 * `app_icon` is migration 056 and the three reminder switches 032; all sit in
 * lib/settings-service.ts PENDING_SCHEMA_COLUMNS. PostgREST refuses the whole
 * select over one unknown column, so a missing one is read again without
 * any of them (`full` is then false).
 */
const SETTINGS_COLUMNS =
  `${STABLE_SETTINGS_COLUMNS}, app_icon, habit_reminders_enabled, habit_last_call_enabled, habit_last_call_time`;

interface SettingsRow {
  timezone?: string | null;
  show_completed_tasks?: boolean | null;
  week_start_day?: string | null;
  time_format?: string | null;
  app_icon?: string | null;
  habit_reminders_enabled?: boolean | null;
  habit_last_call_enabled?: boolean | null;
  habit_last_call_time?: string | null;
  eod_review_enabled?: boolean | null;
  eod_review_time?: string | null;
  last_eod_review_date?: string | null;
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

/**
 * Every live item's pending snooze, by the three columns that say it. Sparse:
 * a snooze lives fifteen minutes, and the scan sweeps the stale ones. A row
 * with no day is left out, since the plan can't gate it ("an unreadable
 * snooze is no snooze"). Null on a database without migration 032's columns,
 * and on any other failed read, logged: a snooze the phone misses rings on
 * the web's push all the same, and the planner must still load.
 */
async function readSnoozes(userId: string, client: Client): Promise<AppSnooze[] | null> {
  const { data, error } = await client
    .from('items')
    .select('id, reminder_snooze_until, reminder_snooze_date')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('reminder_snooze_until', 'is', null);
  if (error) {
    if (!isMissingColumnError(error)) {
      console.error('[app/planner] snooze read failed:', error.message ?? error);
    }
    return null;
  }
  const rows = (data ?? []) as { id: string; reminder_snooze_until: string | null; reminder_snooze_date: string | null }[];
  return rows.flatMap((row) =>
    row.reminder_snooze_until && row.reminder_snooze_date
      ? [{ itemId: row.id, until: row.reminder_snooze_until, date: row.reminder_snooze_date }]
      : [],
  );
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
    const [data, { row: settings, full }, streaksEnabled, snoozes] = await Promise.all([
      loadPlannerData(userId, () => perTable(userId, client), client),
      readSettings(userId, client),
      readStreaksEnabled(userId, client),
      readSnoozes(userId, client),
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
        lastCallEnabled: full ? settings?.habit_last_call_enabled === true : null,
        lastCallTime: (full && settings?.habit_last_call_time) || null,
        eodReviewEnabled: settings?.eod_review_enabled === true,
        eodReviewTime: settings?.eod_review_time || null,
        lastEodReviewDate: settings?.last_eod_review_date || null,
        reminderGraceMinutes: REMINDER_GRACE_MINUTES,
      },
      snoozes,
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

// ── POST /api/app/timezone ───────────────────────────────────────────────────

/**
 * The phone's zone, stored as the account's (lib/user-timezone.ts, the web's
 * PATCH /api/user/timezone's own write): the scan reads the day and the
 * minute of every cue, last call and review in it, so a phone that travels
 * keeps the server's pushes on the phone's clock. Already so is 200 with
 * `unchanged: true` and no write. Body: `{ timezone }`, an IANA name.
 */
export async function postTimezone(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;
  const { userId, client } = auth;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid();
  }
  const timezone = raw && typeof raw === 'object' ? (raw as { timezone?: unknown }).timezone : undefined;
  try {
    const result = await saveTimezone(client, userId, timezone);
    if ('invalid' in result) return invalid({ formErrors: [], fieldErrors: { timezone: [result.invalid] } });
    return NextResponse.json(result.unchanged ? { ok: true, unchanged: true } : { ok: true });
  } catch (err) {
    return dbErrorResponse(err, 'app/timezone');
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
export async function postCapture(req: Request, opts: AppWriteOptions = {}): Promise<Response> {
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
  // Only a capture that made the row: a retry that found it raises nothing.
  committed(opts, { kind: 'item.created', userId, itemId: id, type: 'task' });
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

type ItemWrite = z.infer<typeof ItemWriteSchema>;
type IntentBody<A extends ItemWriteAction> = Extract<ItemWrite, { action: A }>;

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
 *   collect      join or leave one routine or season: one membership row
 *                (addContainerMember / removeContainerMember)
 *   snooze       a notification's Snooze (/api/reminders/act's snooze), held to its day
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
export async function postItemWrite(req: Request, rawId: string, opts: AppWriteOptions = {}): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;

  // Not a uuid, so not an item: answered before Postgres rejects the cast.
  if (!UUID.test(rawId)) return notFound();

  const body = await parseBody(req, ItemWriteSchema);
  if (body instanceof Response) return body;

  return runItemWrite({ userId: auth.userId, client: auth.client }, rawId.toLowerCase(), body, opts);
}

/**
 * The intents an agent may send (POST /api/agent/items/:id/act). The verbs
 * whose absolute-array or whole-list form is the only one the agent API's
 * PATCH has: a tick or skip for ONE day, a carry, a streak reset, and one
 * routine or season membership. Everything else the phone sends one key at a
 * time, the agent PATCH already takes as a key.
 */
export const AGENT_ITEM_ACTIONS = ['complete', 'skip', 'move', 'resetStreak', 'collect'] as const satisfies readonly ItemWriteAction[];

/**
 * POST /api/agent/items/:id/act: one of the phone's intents, sent by an agent,
 * through the very code the phone's door runs (runItemWrite), so an agent's
 * tick is the phone's tick, which is the web's. The caller has resolved the
 * agent key; the client is the service role, so every write is owner-scoped
 * (WriteContext.ownerScoped) and every read filters on the user.
 */
export async function postAgentItemAction(
  req: Request,
  rawId: string,
  scope: { userId: string; client: Client },
  opts: AppWriteOptions = {},
): Promise<Response> {
  if (!UUID.test(rawId)) return notFound();
  const body = await parseBody(req, ItemWriteSchema);
  if (body instanceof Response) return body;
  if (!(AGENT_ITEM_ACTIONS as readonly string[]).includes(body.action)) {
    return invalid({ formErrors: [`action must be one of: ${AGENT_ITEM_ACTIONS.join(', ')}`], fieldErrors: {} });
  }
  return runItemWrite({ ...scope, ownerScoped: true, webhook: true }, rawId.toLowerCase(), body, opts);
}

/**
 * One intent on one item, once the caller is known and the body parsed. A
 * service-role caller (the agent door) passes `ownerScoped`, which adds
 * `user_id` to every row update, since RLS does not scope that client.
 */
async function runItemWrite(
  scope: { userId: string; client: Client; ownerScoped?: boolean; webhook?: boolean },
  id: string,
  body: ItemWrite,
  opts: AppWriteOptions,
): Promise<Response> {
  const { userId, client } = scope;
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

  // The id as the route was asked, which the row read matched.
  const ctx: WriteContext = { ...writeContextFor(userId, client, row, { ownerScoped: scope.ownerScoped }), id };

  const res = await dispatchItemWrite(ctx, body, opts);
  // The agent door's webhook (the PATCH routes' tasks.updated / habits.updated):
  // the OpenClaw plugin only drops its cached context on it, so the payload
  // names the item and nothing else. After the response, as other agent writes
  // fire theirs; never on a refusal, which changed nothing.
  if (scope.webhook && res.ok) {
    const event = ctx.config.webhookEvent;
    after(() => notifyPlugins(userId, event, { action: 'update', id, updates: {} }));
  }
  return res;
}

async function dispatchItemWrite(ctx: WriteContext, body: ItemWrite, opts: AppWriteOptions): Promise<Response> {
  const { userId, client, id, row } = ctx;
  const raise = opts.onCommitted;
  try {
    switch (body.action) {
      case 'complete':
        return await complete(ctx, body, raise);
      case 'schedule':
        return await schedule(ctx, body);
      case 'skip':
        return await skip(ctx, body, raise);
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
      case 'collect':
        return await collect(ctx, body);
      case 'snooze':
        return await snooze(ctx, body);
    }
  } catch (err) {
    return dbErrorResponse(err, 'app/items/:id');
  }
}

/**
 * A write the phone made that the web raises an item event for
 * (lib/mod-events.ts): one per real transition, after the write committed.
 * Generic on purpose: this module knows nothing about who listens (the route
 * files pass the listener).
 */
export interface AppWriteEvent {
  kind: 'item.completed' | 'item.uncompleted' | 'item.skipped' | 'item.created';
  userId: string;
  itemId: string;
  /** The stored slug. */
  type: string;
  /** The occurrence date; a one-off's is its start date, or the day acted on. */
  date?: string;
}

export interface AppWriteOptions {
  /**
   * Called once per real transition, after the write committed. Never
   * awaited, and a throw is swallowed: the user's write landed, and nothing a
   * listener does may fail it.
   */
  onCommitted?: (e: AppWriteEvent) => void;
}

function committed(opts: AppWriteOptions, e: AppWriteEvent): void {
  try {
    opts.onCommitted?.(e);
  } catch (err) {
    console.error('[app/items] write listener failed:', err instanceof Error ? err.message : err);
  }
}

/** An intent's result as the phone's Response. */
function answer(result: IntentResult): Response {
  if ('refused' in result) return refused(result.refused, result.status);
  if ('invalid' in result) return invalid(result.invalid);
  return ok();
}

/**
 * `complete`: the web's tick (lib/item-intents.ts applyComplete). With a
 * listener, whether the day was already done is read first, so a repeat
 * `done` (a retry, a stale phone) raises nothing, as the web raises only on a
 * real transition: a one-off's scalar status, a recurring row's one date.
 */
async function complete(
  ctx: WriteContext,
  body: IntentBody<'complete'>,
  onCommitted?: AppWriteOptions['onCommitted'],
): Promise<Response> {
  let wasDone: boolean | undefined;
  const result = await applyComplete(ctx, body, {
    onStake: (itemId, date, done) => reportStake(ctx.userId, itemId, date, done),
    ...(onCommitted && {
      beforeWrite: async () => {
        if (!ctx.recurring) {
          wasDone = ctx.row.status === ctx.config.doneStatus;
          return;
        }
        // Only the listener needs this read, so its failure must not fail the
        // tick: an unknown before raises nothing, in either direction.
        try {
          wasDone = await completedOn(ctx, body.date);
        } catch (err) {
          console.error('[app/items] transition read failed:', err instanceof Error ? err.message : err);
          wasDone = undefined;
        }
      },
    }),
  });
  if ('ok' in result && body.done) await clearSnooze(ctx, body.date);
  if (onCommitted && 'ok' in result && wasDone !== undefined && body.done !== wasDone) {
    committed(
      { onCommitted },
      {
        kind: body.done ? 'item.completed' : 'item.uncompleted',
        userId: ctx.userId,
        itemId: ctx.id,
        type: ctx.type,
        date: ctx.recurring ? body.date : (ctx.row.start_date ?? body.date),
      },
    );
  }
  return answer(result);
}

/**
 * A done day must not be asked about again by a snooze armed before it, as
 * /api/reminders/act clears it after its own Done. A recurring row's snooze is
 * cleared only when it belongs to the day ticked: ticking yesterday late must
 * not silence the snooze tapped on today's cue. A one-off has one occurrence,
 * so its snooze goes whatever day it names. The filter on a live snooze makes
 * the common tick, with none, match no row and write nothing.
 *
 * Never fatal: the tick has landed, and a snooze left behind is about a done
 * day, which the scan's open-loop check and the phone's plan both pass over.
 */
async function clearSnooze(ctx: WriteContext, date: string): Promise<void> {
  let query = ctx.client
    .from('items')
    .update({ reminder_snooze_until: null, reminder_snooze_date: null })
    .eq('id', ctx.id)
    .eq('user_id', ctx.userId)
    .not('reminder_snooze_until', 'is', null);
  if (ctx.recurring) query = query.eq('reminder_snooze_date', date);
  try {
    const { error } = await query;
    if (error) console.error('[app/items] snooze clear failed:', error.message);
  } catch (err) {
    console.error('[app/items] snooze clear failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * `snooze`: a notification's Snooze, the write /api/reminders/act makes for
 * the web's: `reminder_snooze_until` at the tap plus the button's minutes, and
 * `reminder_snooze_date`, the day the notification was about, never the day
 * it matures on (habit-reminders.md decision 8). The scan rings it on the
 * first tick after it matures, and the phone's plan arms it as `#snooze`.
 *
 * Held to its day, as the phone's own snooze is (lib/reminders/snooze.ts): a
 * snooze that would ring past that day's local midnight, in the zone the scan
 * reads (the stored one, else the device's), writes nothing and answers
 * `snoozedUntil: null`. The web's stores it anyway and the scan expires it at
 * maturity; here it never exists, so no device arms a ring about a day that is
 * over. A notification left in the shade from yesterday snoozes to nothing.
 *
 * Gate: a type that takes reminders, and never a subtask (editRefusal's
 * `reminder` rule). No `reminder_time` is needed: a last call's Snooze asks
 * again about an item with no cue of its own (lib/reminders/scan.ts).
 */
async function snooze(ctx: WriteContext, body: IntentBody<'snooze'>): Promise<Response> {
  const { client, userId, id, config, row } = ctx;
  if (!config.remindable || row.parent_item_id) return refused('not_remindable', 400);
  const zone = await pauseZone(client, userId, body.timeZone);
  const fireMs = snoozeFireInstant(Date.now(), body.minutes ?? SNOOZE_MINUTES, zone, body.date);
  if (fireMs === null) return NextResponse.json({ ok: true, snoozedUntil: null });
  const until = new Date(fireMs).toISOString();
  const { error } = await client
    .from('items')
    .update({ reminder_snooze_until: until, reminder_snooze_date: body.date })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
  return NextResponse.json({ ok: true, snoozedUntil: until });
}

/**
 * `skip`: Skip today and Unskip today (lib/item-intents.ts applySkip). A skip
 * that changed the day raises `item.skipped`; an unskip raises nothing, as on
 * the web.
 */
async function skip(
  ctx: WriteContext,
  body: IntentBody<'skip'>,
  onCommitted?: AppWriteOptions['onCommitted'],
): Promise<Response> {
  const result = await applySkip(ctx, body, {
    onStake: (itemId, date, done) => reportStake(ctx.userId, itemId, date, done),
  });
  if (onCommitted && 'ok' in result && result.changed && body.skipped) {
    committed(
      { onCommitted },
      { kind: 'item.skipped', userId: ctx.userId, itemId: ctx.id, type: ctx.type, date: body.date },
    );
  }
  return answer(result);
}

/** `move`: Tomorrow and Reschedule (lib/item-intents.ts applyMove). */
async function move(ctx: WriteContext, body: IntentBody<'move'>): Promise<Response> {
  return answer(await applyMove(ctx, body));
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
  await updateItem(id, type, patch, undefined, client, ctx.ownerScoped ? { ownerId: ctx.userId } : undefined);
  return ok();
}

/**
 * `collect`: join or leave one routine or season for one item, the end list
 * the web's routine and season chips (item-dialog.tsx toggleRoutine /
 * toggleSeason, through updateRoutine / updateSeason) and the bulk bar's Add
 * to / Remove from (the store's setItemsCollected) both write. One membership
 * row added or removed (lib/db.ts addContainerMember / removeContainerMember),
 * never the container's whole list, so a write from another device in between
 * is kept. An add puts the item last in a routine's order. Already so is 200
 * with nothing written. No webhook and no item_events row, as the browser's
 * membership writes have none.
 *
 * A routine or season in the Trash is `container_gone`, as one that is missing
 * or another user's: the web's chip lists only live ones, and a trashed one's
 * members come back with it on a restore (its join rows survive a soft
 * delete), so writing into it would change what a restore brings back with
 * nothing showing it.
 */
async function collect(ctx: WriteContext, body: IntentBody<'collect'>): Promise<Response> {
  const { client, userId, id, row } = ctx;
  if (!isCollectible(capabilityShape(row))) return refused('not_collectible', 400);
  const { data, error } = await client
    .from(body.kind === 'routine' ? 'routines' : 'seasons')
    .select('id')
    .eq('id', body.containerId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return refused('container_gone', 409);
  try {
    if (body.member) await addContainerMember(userId, body.kind, body.containerId, id, client);
    else await removeContainerMember(userId, body.kind, body.containerId, id, client);
  } catch (err) {
    // The join rows reference the container: one purged between the read and this write.
    if (errorCode(err) === '23503') return refused('container_gone', 409);
    throw err;
  }
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
 * The zone a pause resolves "today" in, and a snooze's day gate is held in:
 * the user's stored zone, else the device's, else UTC. That is the rule the
 * phone uses to say "today", so the resume day it shows is the one written.
 * Each candidate counts only if Intl knows it, so a junk value falls through
 * rather than throwing mid-write.
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

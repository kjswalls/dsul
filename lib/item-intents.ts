import type { SupabaseClient } from '@supabase/supabase-js';
import { setItemCompletion, setItemSkip, updateItem } from './db';
import { UNSCHEDULE_TASK_PATCH } from './item-edit';
import { getItemTypeConfig, type ItemTypeConfig } from './item-registry';
import { isRecurring } from './recurrence';
import { canReschedule, canSendToBraindump } from './row-moves';
import type { HabitItem, Task } from './planner-types';

/**
 * Four of the iPhone's item intents, the writes themselves. The tick, skip and
 * carry are shared by the two server doors that make them: lib/app-api.ts (the
 * phone, which maps each result to the same Response it always sent) and the
 * recipe runner (lib/recipes/server/, which maps it to a run-log code). One
 * write path, so a recipe's tick on the server is the phone's tick, which is
 * the web's (lib/app-api.ts says which store action each one mirrors). The
 * phone's Move to Braindump (`applyUnschedule`) sits beside the carry; only
 * lib/app-api.ts calls it.
 *
 * applyComplete, applySkip and applyMove moved out of lib/app-api.ts unchanged
 * (applyMove's gate input is now `movableOf`, which applyUnschedule shares).
 * Nothing here answers a request, reads a session or knows about recipes.
 */

type Client = SupabaseClient;

/**
 * The row every intent decides on. Never completed_dates: no intent reads it
 * (a skip clears the day's completion through the idempotent RPC, unasked),
 * and it is the column that grows without bound.
 */
export const WRITE_ROW_COLUMNS =
  'id, type, parent_item_id, repeat_frequency, status, start_date, time_bucket, in_project_block, ' +
  'skipped_dates, daily_counts, current_day_count, paused_at, paused_until';

export interface WriteRow {
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
  /** lib/app-api.ts EDIT_COLUMNS: present only when the action read it. */
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

/** What every intent knows once the row is read. */
export interface WriteContext {
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
  /**
   * Adds `user_id = userId` to every row update. A service-role caller (the
   * recipe runner) sets it, since RLS does not scope it; the phone's own
   * client is scoped by RLS and leaves it unset.
   */
  ownerScoped?: boolean;
}

export function writeContextFor(
  userId: string,
  client: Client,
  row: WriteRow,
  opts: { ownerScoped?: boolean } = {},
): WriteContext {
  const config = getItemTypeConfig(row.type);
  const frequency = row.repeat_frequency ?? config.defaultFrequency;
  return {
    userId,
    client,
    id: row.id,
    type: row.type,
    config,
    row,
    frequency,
    recurring: isRecurring({ repeatFrequency: frequency }),
    ...(opts.ownerScoped && { ownerScoped: true }),
  };
}

/** The row, read as `userId`, live only; null when it is not theirs or not live. */
export async function readWriteRow(client: Client, userId: string, id: string): Promise<WriteRow | null> {
  const { data, error } = await client
    .from('items')
    .select(WRITE_ROW_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as WriteRow | null) ?? null;
}

/** What an intent did: wrote, was refused by the row (a code the caller words), or was malformed. */
export type IntentResult =
  | { ok: true; changed?: boolean }
  | { refused: string; status: 400 | 409 }
  | { invalid: Record<string, string[]> };

export interface IntentHooks {
  /** A per-date completion landed: tell a live stake. Never awaited. */
  onStake?: (itemId: string, dateStr: string, completed: boolean) => void;
  /** Called once, after every check and before the first write. */
  beforeWrite?: () => Promise<void>;
}

const OK: IntentResult = { ok: true };
const refuse = (code: string, status: 400 | 409): IntentResult => ({ refused: code, status });

function update(ctx: WriteContext, updates: Partial<Task> | Partial<HabitItem>): Promise<void> {
  return updateItem(
    ctx.id,
    ctx.type,
    updates,
    undefined,
    ctx.client,
    ctx.ownerScoped ? { ownerId: ctx.userId } : undefined,
  );
}

/**
 * `complete`: the web's tick.
 *
 * A skipped occurrence is refused outright, as toggleRowDone refuses it
 * (lib/item-toggle.ts): ticking it would leave a date both skipped and done,
 * and on a habit it would turn a deliberate skip back into an open loop that
 * settles as a miss. Its answer is `skip` with `skipped: false`.
 */
export async function applyComplete(
  ctx: WriteContext,
  body: { date: string; done: boolean; count?: number },
  hooks: IntentHooks = {},
): Promise<IntentResult> {
  const { id, type, config, row, client } = ctx;
  const { date, done, count } = body;
  const skipped = (row.skipped_dates ?? []).includes(date);

  if (config.skipStatus) {
    // A habit: the store's toggleHabitStatus. The RPC owns the per-date
    // array and the streak; the companion update writes the status snapshot
    // and the day's tally, never the arrays. `dailyCounts` is written whole
    // by the column, so the stored map is merged with this one date rather
    // than replaced by a phone's copy of it.
    if (skipped) return refuse('skipped', 409);
    await hooks.beforeWrite?.();
    await setItemCompletion(id, type, date, done, true, client);
    hooks.onStake?.(id, date, done);
    const updates: Partial<HabitItem> = {
      status: done ? 'done' : 'pending',
      ...(count !== undefined ? { dailyCounts: { ...(row.daily_counts ?? {}), [date]: count } } : {}),
      currentDayCount: count ?? row.current_day_count ?? 0,
    };
    await update(ctx, updates);
    return OK;
  }

  // A tally belongs to a habit's daily target; nothing else has one.
  if (count !== undefined) return { invalid: { count: ['only a habit takes a count'] } };
  if (skipped) return refuse('skipped', 409);

  if (ctx.recurring) {
    // toggleTaskStatus's recurring branch: the per-date RPC and nothing
    // else. No status write and no event, as on the web.
    await hooks.beforeWrite?.();
    await setItemCompletion(id, type, date, done, true, client);
    hooks.onStake?.(id, date, done);
    return OK;
  }

  // A one-off: the scalar status, which stamps completed_at by trigger.
  await hooks.beforeWrite?.();
  await update(ctx, { status: done ? config.doneStatus : 'pending' } as Partial<Task>);
  return OK;
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
 *
 * `changed` says whether the day's skip changed.
 */
export async function applySkip(
  ctx: WriteContext,
  body: { date: string; skipped: boolean },
  hooks: IntentHooks = {},
): Promise<IntentResult> {
  const { id, type, config, row, client } = ctx;
  if (!config.skippable || !ctx.recurring || row.parent_item_id) return refuse('not_skippable', 400);
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
    await hooks.beforeWrite?.();
    await setItemCompletion(id, type, date, false, true, client);
    hooks.onStake?.(id, date, false);
    if (changes) await setItemSkip(id, type, date, skipped, client);
    const updates: Partial<HabitItem> = {
      status: (skipped ? config.skipStatus : 'pending') as HabitItem['status'],
      currentDayCount: row.current_day_count ?? 0,
    };
    await update(ctx, updates);
    return { ok: true, changed: changes };
  }

  // Task-like: skippedDates and nothing else. `pending|completed|cancelled`
  // is an external contract with no skip in it, so no status write, no
  // updateItem and no event, and an unchanged skip is no write at all.
  if (!changes) return { ok: true, changed: false };
  await hooks.beforeWrite?.();
  if (skipped) {
    // A skipped occurrence is not a completed one. The store clears a done
    // day first; this clears it unasked, since the RPC is idempotent and the
    // row read leaves completed_dates out.
    await setItemCompletion(id, type, date, false, true, client);
    hooks.onStake?.(id, date, false);
  }
  await setItemSkip(id, type, date, skipped, client);
  return { ok: true, changed: true };
}

/**
 * Whether `id` is completed on `dateStr`, asked of that one date: the row read
 * leaves completed_dates out. Scoped by user_id.
 */
export async function completedOn(ctx: WriteContext, dateStr: string): Promise<boolean> {
  const { data, error } = await ctx.client
    .from('items')
    .select('id')
    .eq('id', ctx.id)
    .eq('user_id', ctx.userId)
    .contains('completed_dates', [dateStr])
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * `move`: Tomorrow and Reschedule, the store's moveTaskToDate. The caller
 * picks the day (nextDayTarget, or the one picked), as the web's verbs pass it in.
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
export async function applyMove(
  ctx: WriteContext,
  body: { date: string },
  hooks: IntentHooks = {},
): Promise<IntentResult> {
  const { type, row } = ctx;
  const kind = type === 'habit' ? 'habit' : 'task';
  // The day the gate asks about, as the web's rowDateOf does: the row's own
  // date, or the target for an undated one.
  const dateStr = row.start_date ?? body.date;
  // Whether that day is done matters only for a series (isOpenOn), so only
  // then is it asked, and of that one date: the row read leaves
  // completed_dates out.
  let completedDates: string[] = [];
  if (kind === 'task' && ctx.recurring && !row.parent_item_id) {
    if (await completedOn(ctx, dateStr)) completedDates = [dateStr];
  }
  const movable = movableOf(ctx, completedDates);
  if (row.parent_item_id || !canReschedule(movable, kind, dateStr)) {
    return refuse('not_movable', 409);
  }
  // The bucket fallback is load-bearing: a day view lists only rows that have
  // a bucket, so a carry that wrote the date alone would land out of sight.
  // startTime is kept, as the web keeps it for a one-item carry.
  const updates: Partial<Task> = {
    startDate: body.date,
    timeBucket: (row.time_bucket ?? 'anytime') as Task['timeBucket'],
  };
  await hooks.beforeWrite?.();
  await update(ctx, updates);
  return OK;
}

/**
 * The row in the shape lib/row-moves.ts's gates read: the stored slug as the
 * custom envelope, the frequency the registry resolved (a NULL is the type's
 * default), and the one completed date the caller asked about, if any.
 */
function movableOf(ctx: WriteContext, completedDates: string[]) {
  const { id, type, row } = ctx;
  return {
    id,
    type: type === 'task' || type === 'habit' ? type : 'custom',
    customType: type,
    status: row.status as Task['status'],
    repeatFrequency: ctx.frequency as Task['repeatFrequency'],
    inProjectBlock: !!row.in_project_block,
    completedDates,
  };
}

const NO_MILESTONES: ReadonlySet<string> = new Set();

/**
 * `unschedule`: Move to Braindump, the store's unscheduleTask
 * (lib/planner-store.ts), which writes UNSCHEDULE_TASK_PATCH through
 * updateItem: not scheduled, and no part of day, time or date. Nothing else:
 * no `order` (the row shows in the braindump at its stored place), no
 * duration, no project or block flag. One item_events row, as the web's.
 *
 * Needs `start_time` and `is_scheduled` read (lib/app-api.ts EDIT_COLUMNS):
 * the shared row read has neither.
 *
 * In this order:
 * 1. What no write can change, 409 `not_unschedulable`: a type that is not
 *    braindumpEligible (a habit is not), or a subtask, which shows only inside
 *    its parent.
 * 2. Already in the braindump's shape (not scheduled, and no date, time or
 *    part of day): 200 and no write, so a retry of a write that landed
 *    succeeds. After 1, so a habit with no bucket is still refused. A null
 *    is_scheduled reads as false, as itemFromRow reads it.
 * 3. The web verb's gate (lib/verb-gates.ts VERB_GATES.braindump: a start
 *    date, then lib/row-moves.ts canSendToBraindump) asked of the row on its
 *    own start date, 409 `not_unschedulable`: never a series (the frequency
 *    through the registry), never inside a project block, never done or
 *    cancelled, and never a milestone of a goal that is not in the Trash
 *    (`isLiveMilestone`). The milestone read runs last, only for a row every
 *    other check let through.
 *
 * `changed` says whether it wrote.
 */
export async function applyUnschedule(ctx: WriteContext, hooks: IntentHooks = {}): Promise<IntentResult> {
  const { type, config, row } = ctx;
  if (!config.braindumpEligible || row.parent_item_id) return refuse('not_unschedulable', 409);
  if (!row.is_scheduled && !row.start_date && !row.start_time && !row.time_bucket) return { ok: true, changed: false };
  const dateStr = row.start_date;
  const kind = type === 'habit' ? 'habit' : 'task';
  // isOpenOn asks a series about its day, and a series is refused first, so
  // no completed date is read.
  if (!dateStr || !canSendToBraindump(movableOf(ctx, []), kind, dateStr, NO_MILESTONES)) {
    return refuse('not_unschedulable', 409);
  }
  if (await isLiveMilestone(ctx)) return refuse('not_unschedulable', 409);
  await hooks.beforeWrite?.();
  await update(ctx, { ...UNSCHEDULE_TASK_PATCH });
  return { ok: true, changed: true };
}

/** fetchGoals' missing-table codes (lib/db.ts `unavailable`): migration 036 not applied. */
const isMissingTable = (error: { code?: string }) => error.code === '42P01' || error.code === 'PGRST205';

/**
 * Whether the item is a milestone of a goal that is not in the Trash: the set
 * the web's verb asks (lib/goals.ts milestoneItemIds over the store's goals,
 * which fetchGoals and load_planner read with `deleted_at is null`). A raw
 * goal_items read would also count a trashed goal's milestones, which the web
 * lets go. A goal's state is not asked: an abandoned goal's milestone keeps its
 * date, as on the web. Both reads are scoped by user_id, for the service role.
 *
 * Without migration 036 there are no goals, as the web's store reads it, so no
 * milestone; any other failed read throws, and the write is not made.
 */
async function isLiveMilestone(ctx: WriteContext): Promise<boolean> {
  const { client, userId, id } = ctx;
  const held = await client
    .from('goal_items')
    .select('goal_id')
    .eq('user_id', userId)
    .eq('item_id', id)
    .eq('role', 'milestone');
  if (held.error) {
    if (isMissingTable(held.error)) return false;
    throw held.error;
  }
  const goalIds = ((held.data ?? []) as { goal_id: string }[]).map((r) => r.goal_id);
  if (goalIds.length === 0) return false;
  const live = await client
    .from('goals')
    .select('id')
    .eq('user_id', userId)
    .in('id', goalIds)
    .is('deleted_at', null)
    .limit(1);
  if (live.error) {
    if (isMissingTable(live.error)) return false;
    throw live.error;
  }
  return ((live.data ?? []) as unknown[]).length > 0;
}

/**
 * The `order` the web's addTask gives a new task: `tasks.length`, every live
 * task-like row that is not a subtask, which is the store's `tasks`
 * projection. A capture, a new subtask and a recipe's create all take it.
 * Throws a failed count.
 */
export async function nextTaskOrder(client: Client, userId: string): Promise<number> {
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

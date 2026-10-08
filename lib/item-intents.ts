import type { SupabaseClient } from '@supabase/supabase-js';
import { setItemCompletion, setItemSkip, updateItem } from './db';
import { getItemTypeConfig, type ItemTypeConfig } from './item-registry';
import { isRecurring } from './recurrence';
import { canReschedule } from './row-moves';
import type { HabitItem, Task } from './planner-types';

/**
 * Three of the iPhone's item intents, the writes themselves, shared by the two
 * server doors that tick, skip and carry an item: lib/app-api.ts (the phone,
 * which maps each result to the same Response it always sent) and the recipe
 * runner (lib/recipes/server/, which maps it to a run-log code). One write
 * path, so a recipe's tick on the server is the phone's tick, which is the
 * web's (lib/app-api.ts says which store action each one mirrors).
 *
 * Moved out of lib/app-api.ts unchanged. Nothing here answers a request, reads
 * a session or knows about recipes.
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
  const { id, type, row } = ctx;
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

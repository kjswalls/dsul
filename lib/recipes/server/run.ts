import { createItem, fetchItemById } from '@/lib/db';
import { getItemTypeConfig } from '@/lib/item-registry';
import { canCreateType } from '@/lib/proposal';
import { sameContainerName } from '@/lib/container-registry';
import { addDaysToDateStr } from '@/lib/goals';
import { autoCorrectBucket } from '@/lib/time-bucket';
import { occurrenceOn, VERB_GATES, type VerbContext } from '@/lib/verb-gates';
import {
  applyComplete,
  applyMove,
  applySkip,
  nextTaskOrder,
  readWriteRow,
  writeContextFor,
  type IntentResult,
} from '@/lib/item-intents';
import type { Item, TaskItem } from '@/lib/planner-types';
import type { RecipeManifest } from '@/lib/mods/schema';
import { MOD_RUN_SUMMARY_MAX_BYTES, RUN_WRITE_CAP, rateReason } from '../limits';
import type { RunSummary } from '../runs';
import { stakeRefusalWith } from '../stake-rule';
import type { UndoOp } from '../undo';
import { isServerStep, isWriteStep, type RecipeWriteStep } from '../validate-core';
import { claimServerRun, logServerRun, rateBreach, switchOffServer } from './claim';
import type { UserContext } from './context';

/**
 * One recipe run on the server (memory/plans/mods.md, "On the server"): a
 * phone or reminder tick, or a time of day. The browser engine's twin
 * (../engine.ts), with what the server can and cannot do:
 *
 *  - Rate limit first (the account's runs, from mod_runs): a breach switches
 *    the recipe off with a reason and claims nothing.
 *  - Claim, then act: the run's key is inserted against 061's unique
 *    (mod_id, claim_key) before any step, and only a run THIS call claimed
 *    goes on. A tick is at-least-once; the claim makes the run once.
 *  - Only create, complete, skip and reschedule run, through the same write
 *    path the iPhone uses (lib/item-intents.ts, lib/db.ts createItem). Each
 *    re-reads its item with the user scope and re-checks the verb's gate
 *    (lib/verb-gates.ts) for the user's real today, and the stake lock.
 *    Other verbs are the browser's (`skip:browser-only`); screen steps
 *    (toast, go to, Organize, theme, Look) are counted into `ui`, since
 *    there is no screen.
 *  - At most RUN_WRITE_CAP writes, and none started past the tick's deadline
 *    (`stop:deadline`), so a claimed run always reaches its result row.
 *  - No cascade: nothing here raises an item event. The writes go straight to
 *    lib/db.ts, never through /api/app or /api/reminders/act, which are the
 *    only server doors that start recipes.
 *  - The result row carries the inverse of each write, for Revert in Make
 *    (../revert.ts), since a server run has no ⌘Z.
 */

export interface ServerTrigger {
  /** The item that started it, for an item trigger. */
  itemId?: string;
  /** The trigger's name, as the run log shows it. */
  on: string;
}

export interface ServerRunMod {
  id: string;
}

export type ServerRunOutcome =
  | { ran: true; summary: RunSummary }
  | { ran: false; why: 'rate' | 'claim-lost' | 'claim-error' };

interface StepOutcome {
  code: string;
  undo?: UndoOp;
}

const codeOf = (r: Exclude<IntentResult, { ok: true }>) => ('refused' in r ? `refuse:${r.refused}` : 'refuse:invalid');

async function runVerbStep(
  ctx: UserContext,
  step: Extract<RecipeWriteStep, { item: unknown }>,
  triggerItemId: string | undefined
): Promise<StepOutcome> {
  if (step.do !== 'complete' && step.do !== 'skip' && step.do !== 'reschedule') {
    return { code: 'skip:browser-only' };
  }
  const { service, userId, today, tz } = ctx;
  const id = step.item === 'trigger' ? triggerItemId : step.item.id;
  // Re-read with the user scope: a manifest's id is owner-asserted, and the
  // completion and skip RPCs filter on id and type alone.
  const item: Item | null = id ? await fetchItemById(userId, id, service) : null;
  if (!item) return { code: 'refuse:no-item' };
  if (stakeRefusalWith(step, item, ctx.stake)) return { code: 'refuse:stake' };
  const vctx: VerbContext = {
    dateStr: today,
    todayStr: today,
    tz,
    date: ctx.now,
    milestoneIds: new Set(),
    occurrence: occurrenceOn(item, today, today, tz),
  };
  if (!VERB_GATES[step.do](item, vctx)) return { code: 'skip:ineligible' };

  const row = await readWriteRow(service, userId, item.id);
  if (!row) return { code: 'refuse:no-item' };
  const wctx = writeContextFor(userId, service, row, { ownerScoped: true });

  // No onStake: the lock above refuses every stake-eligible item while an
  // adapter is on, and with none on there is nothing to report.
  if (step.do === 'complete') {
    const r = await applyComplete(wctx, { date: today, done: true });
    if (!('ok' in r)) return { code: codeOf(r) };
    return { code: 'done', undo: ['uncomplete', item.id, wctx.recurring ? today : null] };
  }
  if (step.do === 'skip') {
    const r = await applySkip(wctx, { date: today, skipped: true });
    if (!('ok' in r)) return { code: codeOf(r) };
    return { code: 'done', undo: ['unskip', item.id, today] };
  }
  if (step.do !== 'reschedule') return { code: 'skip:browser-only' };
  const target = addDaysToDateStr(today, step.inDays);
  const r = await applyMove(wctx, { date: target });
  if (!('ok' in r)) return { code: codeOf(r) };
  return { code: 'done', undo: ['move', item.id, row.start_date, target] };
}

async function runCreateStep(
  ctx: UserContext,
  step: Extract<RecipeWriteStep, { do: 'create' }>
): Promise<StepOutcome> {
  const { service, userId, today } = ctx;
  if (!canCreateType(step.type, { customTypeNames: ctx.customTypeNames })) return { code: 'refuse:type' };
  if (stakeRefusalWith(step, undefined, ctx.stake)) return { code: 'refuse:stake' };
  let project: { name: string; id: string } | undefined;
  if (step.project) {
    const wanted = step.project;
    const found = ctx.projects.find((p) => sameContainerName('project', p.name, wanted));
    if (!found) return { code: 'refuse:no-project' };
    project = { name: found.name, id: found.id };
  }
  const config = getItemTypeConfig(step.type);
  const timeBucket = autoCorrectBucket(undefined, step.bucket);
  const isTask = step.type === 'task';
  // What the store's addTask / addItem build (lib/planner-store.ts), minted here.
  const base = {
    id: crypto.randomUUID(),
    title: step.title,
    status: 'pending' as const,
    isScheduled: !!timeBucket,
    ...(timeBucket && { timeBucket }),
    ...(project && { project: project.name, projectId: project.id }),
    ...(config.dateAnchored && { startDate: today }),
  };
  const item = (
    isTask
      ? ({ ...base, type: 'task', order: await nextTaskOrder(service, userId) } satisfies Partial<TaskItem>)
      : // Custom types aren't manually orderable (created_at sorts), as addItem.
        { ...base, type: 'custom', customType: step.type, order: 0 }
  ) as unknown as Item;
  // notify: false, as the phone's capture: a recipe's add reaches no webhook.
  await createItem(userId, item, service, { notify: false });
  return { code: 'done', undo: ['delete', base.id] };
}

/** Rate check, claim, steps, log. Never throws. */
export async function runRecipeOnServer(
  ctx: UserContext,
  mod: ServerRunMod,
  m: RecipeManifest,
  trigger: ServerTrigger,
  claimKey: string,
  notes: string[] = [],
  opts: { deadlineMs?: number } = {}
): Promise<ServerRunOutcome> {
  const { service, userId, today } = ctx;
  const over = await rateBreach(service, userId, mod.id, today, ctx.now);
  if (over) {
    const why = rateReason(over);
    await switchOffServer(service, userId, mod.id, why);
    notes.push(`${userId}: recipe ${mod.id} switched off — ${why}`);
    return { ran: false, why: 'rate' };
  }

  const claim = await claimServerRun(service, userId, mod.id, claimKey);
  if (claim !== 'won') return { ran: false, why: claim === 'lost' ? 'claim-lost' : 'claim-error' };

  const writes = m.steps.filter(isWriteStep);
  const summary: RunSummary = {
    kind: 'run',
    server: true,
    day: today,
    trigger: trigger.on,
    did: 0,
    of: writes.length,
    skipped: 0,
    refused: 0,
    stopped: 0,
    ui: m.steps.filter((s) => !isWriteStep(s)).length,
    steps: [],
  };
  const undo: UndoOp[] = [];
  const deadline = opts.deadlineMs ?? Number.POSITIVE_INFINITY;

  for (const [i, step] of writes.entries()) {
    let out: StepOutcome;
    if (i >= RUN_WRITE_CAP) out = { code: 'stop:cap' };
    // Past the tick's deadline the rest stop, so the claimed run still gets
    // its result row (and its Revert) before the function's time runs out.
    else if (Date.now() > deadline) out = { code: 'stop:deadline' };
    else if (!isServerStep(step)) out = { code: 'skip:browser-only' };
    else {
      try {
        out = step.do === 'create' ? await runCreateStep(ctx, step) : await runVerbStep(ctx, step, trigger.itemId);
      } catch (err) {
        console.error('[recipes/server] step failed:', err instanceof Error ? err.message : err);
        out = { code: 'refuse:error' };
      }
    }
    summary.steps.push(out.code);
    if (out.code === 'done') summary.did++;
    else if (out.code.startsWith('stop:')) summary.stopped++;
    else if (out.code.startsWith('skip:')) summary.skipped++;
    else summary.refused++;
    if (out.undo) undo.unshift(out.undo);
  }

  if (undo.length > 0) summary.undo = undo;
  // 061's CHECK would refuse the row; the log line matters more than Revert,
  // and the counts more than the per-step codes.
  // The CHECK measures jsonb's text, which puts a space after every `:` and
  // `,` that compact JSON leaves out, so the budget keeps a tenth in hand.
  // (Today's caps, 25 ops of about 60 bytes, never come near it.)
  const budget = Math.floor(MOD_RUN_SUMMARY_MAX_BYTES * 0.9);
  const bytes = () => new TextEncoder().encode(JSON.stringify(summary)).length;
  if (bytes() > budget && summary.undo) {
    delete summary.undo;
    summary.revertable = false;
  }
  if (bytes() > budget) summary.steps = summary.steps.slice(0, RUN_WRITE_CAP);
  await logServerRun(service, userId, mod.id, `${claimKey}:done`, summary);
  return { ran: true, summary };
}

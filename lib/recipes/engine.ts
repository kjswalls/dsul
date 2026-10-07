'use client';

import { toast } from 'sonner';
import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useModsStore } from '@/lib/mods-store';
import { subscribeModEvents, withSuppressed, type ModEvent } from '@/lib/mod-events';
import { ITEM_VERBS, isDoneOn, isSkippedOn, occurrenceOn, type VerbContext } from '@/lib/item-verbs';
import { getItemTypeConfig } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';
import { sameContainerName } from '@/lib/container-registry';
import { canCreateType } from '@/lib/proposal';
import { addDaysToDateStr, milestoneItemIds } from '@/lib/goals';
import { modLabel, type RecipeManifest, type UserMod } from '@/lib/mods/schema';
import { bucketClaimKey, clockBucket, dayClaimKey, localDayAndTime } from './clock';
import { matchesTrigger, passesFilters, type FilterEnv, type RecipeFire } from './filters';
import { claimRun, logRun, type RunSummary } from './runs';
import { stakeRefusal } from './stake-lock';
import { runUiStep, type UiStepDeps } from './ui-steps';
import { setRecipeCommandRunner } from './command-run';
import {
  currentRecipeEnv,
  isWriteStep,
  parseRecipe,
  type RecipeUiStep,
  type RecipeWriteStep,
} from './validate';

/**
 * The recipe engine, browser half (memory/plans/mods.md, "Recipes", build
 * order 4). Timed triggers and ticks that never pass through a browser are the
 * server runner's (build order 6).
 *
 * What starts a run:
 *  - the user's own actions, through lib/mod-events.ts (ticked, unticked,
 *    skipped, added, the review saved);
 *  - ⌘K ("Run recipe: <name>", lib/commands/registry.ts);
 *  - one app-level clock (components/recipes/recipe-host.tsx): a new day, and
 *    a part of day starting. A clock run is claimed in mod_runs before any step
 *    runs, so two tabs or two devices run it once.
 *
 * How a run behaves:
 *  - Steps that write go through ITEM_VERBS (each re-checks `eligible` for the
 *    real today) or, for create, through canCreateType and the store's own add.
 *    Nothing here writes an item field directly.
 *  - One run is one synchronous quiet batchHistory('Recipe: <name>') inside
 *    withSuppressed, so it is one ⌘Z, it is undone before the tick that started
 *    it (dispatch is a task queued after that tick's entry), and nothing it
 *    writes starts another recipe.
 *  - At most RUN_WRITE_CAP writes. More than RATE_PER_MINUTE runs a minute or
 *    RATE_PER_DAY a day (counted in this tab) switches the recipe off and says
 *    why.
 *  - Safe mode, a switched-off recipe or a planner that has not loaded runs
 *    nothing. The stake lock (./stake-lock.ts) refuses steps per step.
 *  - UI steps run after the batch, in order.
 */

export const RUN_WRITE_CAP = 25;
export const RATE_PER_MINUTE = 10;
export const RATE_PER_DAY = 100;

const planner = () => usePlannerStore.getState();

const fallbackDeps: UiStepDeps = {
  navigate: (href) => {
    if (typeof window !== 'undefined') window.location.assign(href);
  },
};
let deps: UiStepDeps = fallbackDeps;

/** Per recipe: run times in the last minute, and today's count. Per tab. */
const minuteRuns = new Map<string, number[]>();
const dayRuns = new Map<string, { day: string; n: number }>();
/**
 * `${modId}|${claimKey}` the clock has tried in this tab, so a claim is inserted
 * once, not every minute. False again after a claim that errored, so the next
 * tick retries it.
 */
const attempted = new Map<string, boolean>();

/* ── guards ────────────────────────────────────────────────────────────── */

/** Everything outside one recipe that must hold before any recipe runs. */
function engineReady(): boolean {
  const mods = useModsStore.getState();
  const p = planner();
  if (mods.safeMode || !mods.available || !mods.loaded) return false;
  if (!p.userId || mods.hydratedUserId !== p.userId) return false;
  return selectPlannerSettled(p) && p.loadFailedUserId !== p.userId;
}

/** The row as the store holds it now, only while it is a switched-on recipe. */
function liveRecipe(id: string): UserMod | undefined {
  return useModsStore.getState().rows.find((r) => r.id === id && r.kind === 'recipe' && r.enabled);
}

function enabledRecipes(): UserMod[] {
  return useModsStore.getState().rows.filter((r) => r.kind === 'recipe' && r.enabled);
}

function zone(): string {
  return planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function filterEnv(dateStr: string, today: string, tz: string): FilterEnv {
  const { routines, seasons } = planner();
  return { dateStr, todayStr: today, tz, routines, seasons };
}

/* ── rate limit ────────────────────────────────────────────────────────── */

/** Counts this run, or says which limit it would break. */
function takeRateSlot(id: string, today: string, nowMs: number): 'minute' | 'day' | null {
  const recent = (minuteRuns.get(id) ?? []).filter((t) => nowMs - t < 60_000);
  const day = dayRuns.get(id);
  const todayCount = day && day.day === today ? day.n : 0;
  if (recent.length >= RATE_PER_MINUTE) return 'minute';
  if (todayCount >= RATE_PER_DAY) return 'day';
  recent.push(nowMs);
  minuteRuns.set(id, recent);
  dayRuns.set(id, { day: today, n: todayCount + 1 });
  return null;
}

function switchOff(mod: UserMod, over: 'minute' | 'day'): void {
  const why =
    over === 'minute'
      ? `It ran more than ${RATE_PER_MINUTE} times in a minute.`
      : `It ran more than ${RATE_PER_DAY} times today.`;
  void useModsStore.getState().disable(mod.id, why);
  toast(`Switched off ${modLabel(mod)}. ${why}`);
}

/* ── one run ───────────────────────────────────────────────────────────── */

function verbContext(today: string, tz: string): Omit<VerbContext, 'occurrence'> {
  return {
    dateStr: today,
    date: new Date(),
    todayStr: today,
    tz,
    milestoneIds: milestoneItemIds(planner().goals ?? []),
  };
}

/** One write step. Returns its short log code. */
function runWriteStep(
  step: RecipeWriteStep,
  triggerItemId: string | undefined,
  base: Omit<VerbContext, 'occurrence'>
): string {
  const today = base.todayStr;
  if (step.do === 'create') {
    // Asked again at run time: a custom type may have gone since the save.
    if (!canCreateType(step.type, currentRecipeEnv())) return 'refuse:type';
    if (stakeRefusal(step)) return 'refuse:stake';
    let project: string | undefined;
    if (step.project) {
      const wanted = step.project;
      const found = planner().projects.find((p) => sameContainerName('project', p.name, wanted));
      if (!found) return 'refuse:no-project';
      project = found.name;
    }
    const anchored = getItemTypeConfig(step.type).dateAnchored;
    // The store's single-row path: addTasksBulk delegates one row to
    // addTask / addItem, the same create every surface uses.
    planner().addTasksBulk(step.type, [
      {
        title: step.title,
        ...(step.bucket && { timeBucket: step.bucket }),
        ...(project && { project }),
        ...(anchored && { startDate: today }),
      },
    ]);
    return 'done';
  }

  const id = step.item === 'trigger' ? triggerItemId : step.item.id;
  // Re-read from the store: an undo or another run may have moved it since.
  const item = id ? planner().items.find((i) => i.id === id) : undefined;
  if (!item) return 'refuse:no-item';
  if (stakeRefusal(step, item)) return 'refuse:stake';
  const verb = ITEM_VERBS[step.do];
  const ctx: VerbContext = { ...base, occurrence: occurrenceOn(item, today, today, base.tz) };
  if (!verb.eligible(item, ctx)) return 'skip:ineligible';
  verb.run(item, ctx, step.do === 'reschedule' ? addDaysToDateStr(today, step.inDays) : undefined);
  return 'done';
}

/**
 * Runs a parsed recipe's steps once, with no trigger matching, rate check or
 * log (fire() does those). Exported for tests. The schema caps a recipe at
 * RECIPE_MAX_STEPS (25) steps and each writes at most once, so the cap below is
 * out of reach today; it stays as the second line of defence.
 */
export function executeRecipe(
  mod: Pick<UserMod, 'name' | 'slug'>,
  m: RecipeManifest,
  triggerItemId?: string
): RunSummary {
  const label = modLabel(mod);
  const writes = m.steps.filter(isWriteStep);
  const ui = m.steps.filter((s): s is RecipeUiStep => !isWriteStep(s));
  const summary: RunSummary = {
    kind: 'run',
    trigger: m.trigger.on,
    did: 0,
    of: writes.length,
    skipped: 0,
    refused: 0,
    stopped: 0,
    steps: [],
  };

  if (writes.length > 0) {
    const tz = zone();
    const { today } = localDayAndTime(new Date(), tz);
    const base = verbContext(today, tz);
    withSuppressed(() =>
      batchHistory(
        `Recipe: ${label}`,
        Math.min(writes.length, RUN_WRITE_CAP),
        () => {
          writes.forEach((step, i) => {
            let code: string;
            if (i >= RUN_WRITE_CAP) code = 'stop:cap';
            else {
              try {
                code = runWriteStep(step, triggerItemId, base);
              } catch (err) {
                console.error('[recipes] step failed:', err);
                code = 'refuse:error';
              }
            }
            summary.steps.push(code);
            if (code === 'done') summary.did++;
            else if (code === 'stop:cap') summary.stopped++;
            else if (code.startsWith('skip:')) summary.skipped++;
            else summary.refused++;
          });
        },
        { quiet: true }
      )
    );
  }

  // After the batch, so nothing navigates while its entry is open.
  for (const step of ui) {
    try {
      runUiStep(step, label, deps);
    } catch (err) {
      console.error('[recipes] step failed:', err);
    }
  }

  if (summary.stopped > 0) toast(`${label} did ${summary.did} of ${summary.of} steps.`);
  return summary;
}

/** Rate check, run, log. Callers hold the suppression. */
function fire(mod: UserMod, m: RecipeManifest, triggerItemId: string | undefined, logKey: string): RunSummary | null {
  const { today } = localDayAndTime(new Date(), zone());
  const over = takeRateSlot(mod.id, today, Date.now());
  if (over) {
    switchOff(mod, over);
    return null;
  }
  const summary = executeRecipe(mod, m, triggerItemId);
  const userId = planner().userId;
  if (userId) void logRun(userId, mod.id, logKey, summary);
  return summary;
}

const runKey = () => `run:${crypto.randomUUID()}`;

/* ── triggers ──────────────────────────────────────────────────────────── */

/**
 * The event, asked again of the store as it is now (lib/mod-events.ts: a
 * consumer re-checks live state). Dispatch is a task after the action, so a ⌘Z
 * or a delete may have landed in between: then the event no longer holds and
 * nothing runs, not even the steps that never touch the item.
 */
function stillHolds(e: ModEvent, item: Item | undefined): boolean {
  switch (e.kind) {
    case 'item.completed':
      return !!item && isDoneOn(item, e.date);
    case 'item.uncompleted':
      return !!item && !isDoneOn(item, e.date);
    case 'item.skipped':
      return !!item && isSkippedOn(item, e.date);
    case 'item.created':
      return !!item;
    case 'review.saved':
      return true;
  }
}

/** A mod-events listener. Already inside withSuppressed (lib/mod-events.ts flush). */
function onEvent(e: ModEvent): void {
  if (!engineReady()) return;
  const tz = zone();
  const { today } = localDayAndTime(new Date(), tz);
  const itemId = 'itemId' in e ? e.itemId : undefined;
  const item = itemId ? planner().items.find((i) => i.id === itemId) : undefined;
  if (!stillHolds(e, item)) return;
  for (const mod of enabledRecipes()) {
    const m = parseRecipe(mod);
    if (!m || !matchesTrigger(m.trigger, e)) continue;
    if (!passesFilters(m.filters, item, filterEnv(e.date ?? today, today, tz))) continue;
    withSuppressed(() => fire(mod, m, itemId, runKey()));
  }
}

/** "Run recipe: <name>" from ⌘K. */
export function runRecipeFromCommand(modId: string): void {
  if (!engineReady()) return;
  const mod = liveRecipe(modId);
  const m = mod && parseRecipe(mod);
  if (!mod || !m || !matchesTrigger(m.trigger, { kind: 'command' })) return;
  const tz = zone();
  const { today } = localDayAndTime(new Date(), tz);
  if (!passesFilters(m.filters, undefined, filterEnv(today, today, tz))) return;
  withSuppressed(() => fire(mod, m, undefined, runKey()));
}

/**
 * One clock tick: a new day and the part of day, claimed before acting. Safe
 * to call every minute: a recipe's claim key is tried once per tab, and a
 * claim another tab or device already holds runs nothing here.
 */
export async function runClock(now: Date = new Date()): Promise<void> {
  if (!engineReady()) return;
  const userId = planner().userId as string;
  const tz = zone();
  const { today, hhmm } = localDayAndTime(now, tz);
  const bucket = clockBucket(hhmm);

  const jobs: Promise<void>[] = [];
  for (const mod of enabledRecipes()) {
    const m = parseRecipe(mod);
    if (!m) continue;
    let fireEvent: RecipeFire;
    let key: string;
    if (m.trigger.on === 'day.opened') {
      fireEvent = { kind: 'day.opened' };
      key = dayClaimKey(today);
    } else if (m.trigger.on === 'bucket.changed' && bucket) {
      fireEvent = { kind: 'bucket.changed', bucket };
      key = bucketClaimKey(today, bucket);
    } else continue;
    if (!matchesTrigger(m.trigger, fireEvent)) continue;
    if (!passesFilters(m.filters, undefined, filterEnv(today, today, tz))) continue;

    const tag = `${mod.id}|${key}`;
    if (attempted.get(tag)) continue;
    attempted.set(tag, true);

    const on = m.trigger.on;
    jobs.push(
      claimRun(userId, mod.id, key).then((claim) => {
        // A failed claim (offline, a server error) is tried again next minute;
        // a lost one belongs to another tab or device.
        if (claim === 'error') attempted.set(tag, false);
        if (claim !== 'won') return;
        // Everything is asked again after the await: safe mode, the account,
        // the switch, the manifest. And the suppression is taken afresh, since
        // a depth can never be held across an await. A claim won and then
        // dropped here (switched off, the planner reloading) does not run that
        // day anywhere (memory/plans/mods.md, "Built so far").
        if (!engineReady() || planner().userId !== userId) return;
        const live = liveRecipe(mod.id);
        const again = live && parseRecipe(live);
        if (!live || !again || again.trigger.on !== on) return;
        withSuppressed(() => fire(live, again, undefined, `${key}:done`));
      })
    );
  }
  await Promise.all(jobs);
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

/** Starts listening. Returns the stop. Mounted once, by RecipeHost. */
export function startRecipeEngine(d: UiStepDeps): () => void {
  deps = d;
  const unsubscribe = subscribeModEvents(onEvent);
  const unslot = setRecipeCommandRunner(runRecipeFromCommand);
  return () => {
    unsubscribe();
    unslot();
    if (deps === d) deps = fallbackDeps;
  };
}

/** Test-only. */
export function __resetRecipeEngineForTests(): void {
  minuteRuns.clear();
  dayRuns.clear();
  attempted.clear();
  deps = fallbackDeps;
}

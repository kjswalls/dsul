'use client';

import { toast } from 'sonner';
import { batchHistory, getActionLog, usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useModsStore } from '@/lib/mods-store';
import { withSuppressed } from '@/lib/mod-events';
import { ITEM_VERBS, isHabit, occurrenceOn, type VerbContext } from '@/lib/item-verbs';
import { canCreateType } from '@/lib/proposal';
import { addDaysToDateStr, milestoneItemIds } from '@/lib/goals';
import { openEditFor } from '@/lib/ui-store';
import { isDarkLook, isLightLook } from '@/lib/theme-looks';
import { isUserThemeSlug } from '@/lib/user-themes/css';
import { lookById } from '@/lib/looks';
import { isUserLookRef } from '@/lib/user-looks';
import { localDayAndTime } from '@/lib/recipes/clock';
import { logRun, type RunSummary } from '@/lib/recipes/runs';
import { stakeEditRefusal, stakeFactsNow, stakeRefusal } from '@/lib/recipes/stake-lock';
import { runUiStep, type UiStepDeps } from '@/lib/recipes/ui-steps';
import { currentRecipeEnv, stillHolds } from '@/lib/recipes/validate';
import type { HabitItem, Item, Task } from '@/lib/planner-types';
import { datedOnCreate, findProject, verbStep, type BrokerEnv, type HeldWrite, type HookState, type PlannerView } from './broker-core';
import { createHistoryWindow } from './rate';
import { modDisplayLabel } from './labels';
import { fault, type Fault, type HookEvent } from './protocol';
import type { UserMod } from './schema';

/**
 * The broker, bound to the app (memory/plans/mods.md, "Safety"; build order
 * 8). ./broker-core.ts answers a hook's calls and holds its effects; this file
 * gives it the real stores and applies what a hook held once it settles ok.
 *
 * Applying is the recipe engine's discipline (lib/recipes/engine.ts):
 *  - Everything that started the hook is asked again first: the runtime is
 *    still ready for the same account, the row is still on and at the gen that
 *    ran, and an item event still holds (a ⌘Z may have landed since). If not,
 *    nothing applies and the run logs `skip:stale`.
 *  - The writes are one synchronous quiet batchHistory under a host-built
 *    label, `Mod: <name> · <hook>`, inside withSuppressed, so they are one ⌘Z
 *    and start nothing. Each write re-reads its item and asks its gate and the
 *    stake lock again.
 *  - A mod may add MOD_HISTORY_PER_WINDOW real entries in the window, and
 *    every mod together MOD_HISTORY_ALL_PER_WINDOW (./rate.ts). Over that the
 *    writes are dropped and the hook faults with `history`.
 *  - UI effects run after the batch, in order.
 * The store overlay and the timers are the runtime manager's to commit.
 */

const planner = () => usePlannerStore.getState();

function zone(): string {
  return planner().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Shared across every mod in this tab. */
let historyWindow = createHistoryWindow();

/** Everything outside one mod that must hold before any mod runs: the recipe engine's guard. */
export function modRuntimeReady(): boolean {
  const mods = useModsStore.getState();
  const p = planner();
  if (mods.safeMode || !mods.available || !mods.loaded) return false;
  if (!p.userId || mods.hydratedUserId !== p.userId) return false;
  return selectPlannerSettled(p) && p.loadFailedUserId !== p.userId;
}

/** The row as the store holds it now, only while it is a switched-on mod. */
export function liveModRow(id: string): UserMod | undefined {
  return useModsStore.getState().rows.find((r) => r.id === id && r.kind === 'mod' && r.enabled);
}

function plannerView(): PlannerView {
  const p = planner();
  return {
    items: p.items,
    projects: p.projects,
    routines: p.routines,
    seasons: p.seasons,
    goals: p.goals ?? [],
    userTimezone: zone(),
  };
}

/** BrokerEnv over the real stores. */
export function realBrokerEnv(): BrokerEnv {
  return {
    planner: plannerView,
    stakeFacts: stakeFactsNow,
    canCreateType: (type) => canCreateType(type, currentRecipeEnv()),
    todayAndTime: () => localDayAndTime(new Date(), zone()),
    lookRefOk: (step) =>
      step.do === 'setTheme'
        ? (step.mode === 'light' ? isLightLook(step.theme) : isDarkLook(step.theme)) || isUserThemeSlug(step.theme)
        : !!lookById(step.look) || isUserLookRef(step.look),
    log: (level, slug, text) => console[level](`[mod ${slug}]`, text),
  };
}

export interface ApplyContext {
  /** The planner's user when the hook started. */
  userId: string;
  /** False when the mod has been reloaded or unloaded since the hook started. */
  stillCurrent: () => boolean;
  event: HookEvent;
  hookLabel: string;
  deps: UiStepDeps;
}

export type ApplyResult =
  | { status: 'stale' }
  /** `fault` is the history rule's, when it dropped the writes. */
  | { status: 'applied'; fault: Fault | null; toasts: number };

/** The event, asked again of the planner as it is now. */
function eventStillHolds(e: HookEvent): boolean {
  if (e.kind === 'command' || e.kind === 'timer' || e.kind === 'review.saved') return true;
  const item = planner().items.find((i) => i.id === e.itemId);
  return stillHolds(e, item);
}

function baseContext(today: string, tz: string): Omit<VerbContext, 'occurrence'> {
  return { dateStr: today, date: new Date(), todayStr: today, tz, milestoneIds: milestoneItemIds(planner().goals ?? []) };
}

/** One held write, asked again against the live planner. Returns its log code. */
function applyWrite(w: HeldWrite, base: Omit<VerbContext, 'occurrence'>): string {
  const today = base.todayStr;
  if (w.kind === 'create') {
    // A custom type may have gone, or the lock come on, since the call.
    if (!canCreateType(w.type, currentRecipeEnv())) return 'refuse:type';
    if (stakeRefusal({ do: 'create', type: w.type, title: w.title })) return 'refuse:stake';
    let project: string | undefined;
    if (w.project) {
      project = findProject(plannerView(), w.project);
      if (!project) return 'refuse:no-project';
    }
    planner().addTasksBulk(w.type, [
      {
        title: w.title,
        ...(w.timeBucket && { timeBucket: w.timeBucket }),
        ...(project && { project }),
        ...(datedOnCreate(w.type) && { startDate: today }),
      },
    ]);
    return 'done';
  }

  const item = planner().items.find((i) => i.id === w.id);
  if (!item) return 'refuse:no-item';

  if (w.kind === 'edit') {
    if (stakeEditRefusal(item, w.patch)) return 'refuse:stake';
    const updates: Partial<Task> = {};
    if (w.patch.title !== undefined) updates.title = w.patch.title;
    if (w.patch.priority !== undefined) updates.priority = w.patch.priority;
    if (w.patch.project !== undefined) {
      if (w.patch.project === null) updates.project = undefined;
      else {
        const found = findProject(plannerView(), w.patch.project);
        if (!found) return 'refuse:no-project';
        updates.project = found;
      }
    }
    if (isHabit(item)) planner().updateHabit(item.id, updates as Partial<HabitItem>);
    else planner().updateTask(item.id, updates);
    return 'done';
  }

  if (stakeRefusal(verbStep(w.verb, w.inDays), item)) return 'refuse:stake';
  const verb = ITEM_VERBS[w.verb];
  const ctx: VerbContext = { ...base, occurrence: occurrenceOn(item, today, today, base.tz) };
  if (!verb.eligible(item, ctx)) return 'skip:ineligible';
  verb.run(item, ctx, w.verb === 'reschedule' ? addDaysToDateStr(today, w.inDays ?? 0) : undefined);
  return 'done';
}

function count(summary: RunSummary, code: string): void {
  summary.steps.push(code);
  if (code === 'done') summary.did++;
  else if (code.startsWith('stop:')) summary.stopped++;
  else if (code.startsWith('skip:')) summary.skipped++;
  else summary.refused++;
}

/**
 * Applies a hook that settled ok. Never call it for a faulted hook: a fault
 * applies nothing (the runtime manager's rule).
 */
export function applyHeld(hook: HookState, ctx: ApplyContext): ApplyResult {
  const row = liveModRow(hook.modId);
  const tz = zone();
  const { today } = localDayAndTime(new Date(), tz);
  const planned = hook.writes.length + hook.stopped;
  const summary: RunSummary = {
    kind: 'run',
    trigger: ctx.hookLabel,
    day: today,
    did: 0,
    of: planned,
    skipped: 0,
    refused: 0,
    stopped: 0,
    steps: [],
  };
  const log = () => {
    if (planned > 0) void logRun(ctx.userId, hook.modId, `run:${crypto.randomUUID()}`, summary);
  };

  const current =
    modRuntimeReady() &&
    planner().userId === ctx.userId &&
    !!row &&
    ctx.stillCurrent() &&
    eventStillHolds(ctx.event);
  if (!current || !row) {
    for (let i = 0; i < planned; i++) count(summary, 'skip:stale');
    log();
    return { status: 'stale' };
  }

  const label = modDisplayLabel(row);
  let historyFault: Fault | null = null;

  if (hook.writes.length > 0) {
    const now = Date.now();
    if (!historyWindow.allows(hook.modId, now)) {
      historyFault = fault('history', 'It made more changes in 10 minutes than a mod may.');
      hook.writes.forEach(() => count(summary, 'refuse:history'));
    } else {
      const head = getActionLog()[0]?.id;
      const base = baseContext(today, tz);
      withSuppressed(() =>
        batchHistory(
          `Mod: ${label} · ${ctx.hookLabel}`,
          hook.writes.length,
          () => {
            for (const w of hook.writes) {
              let code: string;
              try {
                code = applyWrite(w, base);
              } catch (err) {
                console.error('[mods] write failed:', err);
                code = 'refuse:error';
              }
              count(summary, code);
            }
          },
          { quiet: true }
        )
      );
      // Only a real entry counts: a batch whose writes were all refused adds none.
      if (getActionLog()[0]?.id !== head) historyWindow.record(hook.modId, now);
    }
  }
  for (let i = 0; i < hook.stopped; i++) count(summary, 'stop:cap');

  // After the batch, so nothing navigates while its entry is open.
  let toasts = 0;
  for (const effect of hook.ui) {
    try {
      if (effect.kind === 'toast') {
        // The mod's name is host chrome its text cannot remove.
        toast(effect.text, { description: `Your mod: ${label}` });
        toasts++;
      } else if (effect.kind === 'openItem') {
        const item: Item | undefined = planner().items.find((i) => i.id === effect.id);
        if (item) openEditFor(item as unknown as Task, isHabit(item) ? 'habit' : 'task');
      } else runUiStep(effect.step, label, ctx.deps);
    } catch (err) {
      console.error('[mods] effect failed:', err);
    }
  }

  log();
  return { status: 'applied', fault: historyFault, toasts };
}

/** Test-only. */
export function __resetBrokerForTests(): void {
  historyWindow = createHistoryWindow();
}
